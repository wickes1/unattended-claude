import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "../config.ts"
import { Layout } from "../layout.ts"
import { ConsoleLogger } from "../logger.ts"
import { RealClock } from "../clock.ts"
import { WeeklyLimitGate } from "../orchestrator/rate-limit.ts"
import { isProcessAlive } from "../orchestrator/lifecycle.ts"
import { runOrchestrator, type RunResult } from "../orchestrator/main.ts"
import { activeWindow, windowEndsAt, parseHHMM } from "../schedule.ts"
import { InteractiveZellijRuntime } from "../runtime/claude-session.ts"
import type { TaskDoc, PausedReason } from "../types.ts"

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

/** Build a prompt file for episode N. For resume, returns a file with the wake-up text. */
export function buildPromptFile(
  task: TaskDoc,
  episode: number,
  resume: boolean,
  layout: Layout,
): string {
  const dir = mkdtempSync(join(tmpdir(), `ucl-prompt-`))
  const path = join(dir, `${task.id}-ep${episode}.md`)
  if (resume) {
    // Resume prompt: short continuation cue (orchestrator passes the wake-up via wakeUpPrompt too).
    writeFileSync(path, `Continue from where you left off in the previous episode.\n`)
  } else {
    // First episode: paste the task doc contents.
    writeFileSync(path, readFileSync(task.file, "utf8"))
  }
  return path
}

/** Build a wake-up prompt by paused reason. Returns null if not resuming. */
export function buildWakeUpPrompt(task: TaskDoc, pausedReason: PausedReason | null): string | null {
  if (!pausedReason) return null
  switch (pausedReason) {
    case "schedule-boundary":
      return "Schedule window ended. Time to continue — pick up from where you stopped."
    case "rate-limit-5h":
      return "The 5-hour rate limit window has reset. Continue from where you stopped."
    case "weekly-limit":
      return "The weekly limit has cleared. Continue from where you stopped."
    case "context-full":
      // Context-full triggers HANDOFF, the new session is fresh, no wake-up — handled separately by orchestrator.
      return null
    case "user-stop":
      return "Manual stop ended. Continue from where you stopped."
    case "user-stop-now":
      return "Previously interrupted forcibly. Continue, but please first verify current file/test state to avoid duplication."
    case "orphan":
      return "Previous session was interrupted unexpectedly (machine reboot or process death). Continue, but please first verify current file/test state."
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
  return runOrchestrator(
    {
      cfg,
      layout,
      log,
      clock,
      runtime,
      loadTaskDocs: () => loadTaskDocs(layout),
      buildPromptFile: (t, e, r) => buildPromptFile(t, e, r, layout),
      buildWakeUpPrompt,
    },
    {
      windowEndsAt: windowEnd,
      parentSession: "unattended-claude",
    },
  )
}
