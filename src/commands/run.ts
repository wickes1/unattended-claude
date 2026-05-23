import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "../config.ts"
import { Layout } from "../layout.ts"
import { ConsoleLogger } from "../logger.ts"
import { RealClock } from "../clock.ts"
import { appendEvent } from "../events.ts"
import { WeeklyLimitGate } from "../orchestrator/rate-limit.ts"
import { isProcessAlive } from "../orchestrator/lifecycle.ts"
import { runOrchestrator, type RunResult } from "../orchestrator/main.ts"
import { PromptBuilder } from "../orchestrator/prompt-builder.ts"
import { activeWindow, windowEndsAt, parseHHMM } from "../schedule.ts"
import { InteractiveZellijRuntime } from "../runtime/claude-session.ts"
import type { Clock, Logger, PausedReason, TaskDoc, TaskRuntimeState } from "../types.ts"

export const helpText = `Usage: ucl run [--until HH:MM] [--force]

Start the unattended worker.
  --until HH:MM    end the run window at this time (otherwise: until queue empty)
                   if omitted, derived from active schedule window in config
  --force          bypass preflight (weekly-paused / lockfile alive checks)

The orchestrator runs in the foreground. Detach via Ctrl-C (graceful pause).
`

interface RunArgs {
  /** "HH:MM" or null */
  until: string | null
  force: boolean
}

export function parseRunArgs(argv: string[]): RunArgs {
  let until: string | null = null
  let force = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--until" && argv[i + 1]) {
      until = argv[i + 1]!
      i++
    } else if (argv[i] === "--force") {
      force = true
    }
  }
  return { until, force }
}

/** Compute the window end Date from CLI flag or active schedule. Returns null = unbounded. */
export function deriveWindowEnd(cfg: Config, argUntil: string | null, now: Date): Date | null {
  if (argUntil) {
    const { h, m } = parseHHMM(argUntil)
    const end = new Date(now)
    end.setHours(h, m, 0, 0)
    if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1)
    return end
  }
  const window = activeWindow(cfg, now)
  if (window) return windowEndsAt(window, now)
  return null
}

/** Load task docs from <runtimeDir>/tasks/<id>.md. Parses YAML-like frontmatter. */
export function loadTaskDocs(layout: Layout): TaskDoc[] {
  if (!existsSync(layout.tasksDir)) return []
  const out: TaskDoc[] = []
  for (const f of readdirSync(layout.tasksDir)) {
    if (!f.endsWith(".md")) continue
    const id = f.replace(/\.md$/, "")
    const file = join(layout.tasksDir, f)
    const content = readFileSync(file, "utf8")
    // Parse simple frontmatter (YAML-ish, between leading ---/--- pair)
    const fm = parseFrontmatter(content)
    out.push({
      id,
      title: typeof fm.title === "string" ? fm.title : id,
      workdir: typeof fm.workdir === "string" ? fm.workdir : layout.taskWorkdir(id),
      serial: fm.serial === true,
      file,
    })
  }
  return out
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---/.exec(content)
  if (!m) return {}
  const result: Record<string, unknown> = {}
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-z_]+):\s*(.+)$/.exec(line)
    if (!kv) continue
    let v: unknown = kv[2]!.trim()
    if (v === "true") v = true
    else if (v === "false") v = false
    else if (typeof v === "string" && /^\d+$/.test(v)) v = Number(v)
    result[kv[1]!] = v
  }
  return result
}

/**
 * Bind a PromptBuilder to the orchestrator's
 * `(task, episode, resume, state) → path` callback shape.
 *
 * Branches:
 *   - resume=false → fresh episode, paste task doc.
 *   - resume=true + handoff_pending + handoff file exists → resumeWithHandoff
 *     (read HANDOFF.md, emit handoff_resumed event).
 *   - resume=true otherwise (or handoff file missing) → plain continuation cue.
 *
 * The handoff_pending flag itself is cleared by applyResult after the
 * episode finishes — that way a crash between here and runtime.invoke
 * leaves the flag set so the retry still uses the handoff.
 */
export function makeBuildPromptFile(
  pb: PromptBuilder,
  promptsDir: string,
  layout: Layout,
  clock: Clock,
  log?: Logger,
): (task: TaskDoc, episode: number, resume: boolean, state: TaskRuntimeState) => string {
  return (task, episode, resume, state) => {
    if (!resume) return pb.initial(task, episode).path!

    if (state.handoff_pending) {
      const handoffPath = layout.handoffFile(task.id)
      if (existsSync(handoffPath)) {
        const built = pb.resumeWithHandoff(task, handoffPath, episode)
        appendEvent(layout, {
          ts: clock.now().toISOString(),
          event: "handoff_resumed",
          task: task.id,
          path: handoffPath,
        })
        // handoff_pending is cleared by applyResult once the episode finishes;
        // this keeps the flag set across a crash between here and runtime.invoke
        // so the retry still uses the handoff.
        return built.path!
      }
      log?.log(
        "warn",
        `handoff_pending=true but ${handoffPath} is missing; falling back to plain continuation cue`,
      )
    }

    const path = join(promptsDir, `${task.id}-ep${episode}.md`)
    writeFileSync(path, `Continue from where you left off in the previous episode.\n`)
    return path
  }
}

/**
 * Bind a PromptBuilder to the orchestrator's
 * `(task, pausedReason | null) → string | null` wake-up callback shape.
 */
export function makeBuildWakeUpPrompt(
  pb: PromptBuilder,
): (task: TaskDoc, pausedReason: PausedReason | null) => string | null {
  return (task, pausedReason) => {
    if (!pausedReason) return null
    return pb.wakeUp(task, pausedReason)?.text ?? null
  }
}

/** Main `ucl run` entry. */
export async function cmdRun(cfg: Config, argv: string[]): Promise<RunResult> {
  const args = parseRunArgs(argv)
  const layout = new Layout(cfg.runtimeDir)
  const log = new ConsoleLogger()
  const clock = new RealClock()

  // Preflight (unless --force)
  if (!args.force) {
    const weekly = new WeeklyLimitGate(layout)
    weekly.clearIfExpired(clock.now())
    if (weekly.blocked(clock.now())) {
      log.log("warn", `Weekly limit active until ${weekly.pausedUntil()?.toISOString()}; skipping run. Use --force to override.`)
      return { reason: "weekly_paused", taskCount: 0 }
    }
    if (existsSync(layout.lockFile)) {
      const pid = Number(readFileSync(layout.lockFile, "utf8").trim())
      if (isProcessAlive(pid) && pid !== process.pid) {
        log.log("warn", `Another orchestrator alive (PID ${pid}). Use --force to override.`)
        return { reason: "lock_held", taskCount: 0 }
      }
    }
  }

  const windowEnd = deriveWindowEnd(cfg, args.until, clock.now())
  log.log("info", `run starting; window ends ${windowEnd ? windowEnd.toISOString() : "(unbounded)"}`)

  const runtime = new InteractiveZellijRuntime(cfg, log, clock)
  const promptsDir = mkdtempSync(join(tmpdir(), "ucl-prompt-"))
  const pb = new PromptBuilder({ promptsDir })
  return runOrchestrator(
    {
      cfg,
      layout,
      log,
      clock,
      runtime,
      loadTaskDocs: () => loadTaskDocs(layout),
      buildPromptFile: makeBuildPromptFile(pb, promptsDir, layout, clock, log),
      buildWakeUpPrompt: makeBuildWakeUpPrompt(pb),
    },
    {
      windowEndsAt: windowEnd,
      parentSession: "unattended-claude",
    },
  )
}
