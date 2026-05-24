import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Config } from "../config.ts"
import { Layout } from "../layout.ts"
import { ConsoleLogger } from "../logger.ts"
import { RealClock } from "../clock.ts"
import { appendEvent } from "../events.ts"
import { ensureDir } from "../fs-utils.ts"
import { WeeklyLimitGate } from "../orchestrator/rate-limit.ts"
import { isProcessAlive } from "../orchestrator/lifecycle.ts"
import { runOrchestrator, type RunResult } from "../orchestrator/main.ts"
import { PromptBuilder } from "../orchestrator/prompt-builder.ts"
import { activeWindow, windowEndsAt, parseHHMM } from "../schedule.ts"
import { InteractiveZellijRuntime } from "../runtime/claude-session.ts"
import type { Clock, Logger, PausedReason, TaskDoc, TaskRuntimeState } from "../types.ts"

export const helpText = `Usage: ucl run [--until <time>] [--force] [--foreground]

Start the unattended worker. Default: detaches (daemonizes) and returns
the shell prompt immediately; orchestrator log goes to
<runtime>/logs/orchestrator-<ts>.log. Use --foreground for live JSON
log stream (debug / first-time use).

  --until <time>     end the run window at this time (otherwise: until queue empty)
                     accepts HH:MM (24h clock), +Nm (N minutes from now),
                     or +Nh (N hours from now); HH:MM rolls to tomorrow if past
                     if omitted, derived from active schedule window in config
  --force            bypass preflight (weekly-paused / lockfile alive checks)
  --foreground       run in the current terminal; do not detach
`

interface RunArgs {
  /** "HH:MM" or null */
  until: string | null
  force: boolean
  foreground: boolean
}

export function parseRunArgs(argv: string[]): RunArgs {
  let until: string | null = null
  let force = false
  let foreground = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--until" && argv[i + 1]) {
      until = argv[i + 1]!
      i++
    } else if (argv[i] === "--force") {
      force = true
    } else if (argv[i] === "--foreground") {
      foreground = true
    }
  }
  return { until, force, foreground }
}

/**
 * Resolve an `--until` flag value to an absolute Date.
 *
 * Accepts:
 *   - `HH:MM` (24h clock) → today at that wall-clock time; rolls to tomorrow if past
 *   - `+Nm`  (N integer ≥ 1) → `now + N minutes`
 *   - `+Nh`  (N integer ≥ 1) → `now + N hours`
 *
 * Throws a clear error for anything else.
 */
export function parseUntil(input: string, now: Date): Date {
  const rel = /^\+(\d+)([mh])$/.exec(input)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    if (n >= 1) {
      const ms = unit === "h" ? n * 3600 * 1000 : n * 60 * 1000
      return new Date(now.getTime() + ms)
    }
  } else if (/^\d{1,2}:\d{2}$/.test(input)) {
    const { h, m } = parseHHMM(input)
    const end = new Date(now)
    end.setHours(h, m, 0, 0)
    if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1)
    return end
  }
  throw new Error(`Invalid --until value: '${input}'. Use HH:MM, +Nm, or +Nh.`)
}

/** Compute the window end Date from CLI flag or active schedule. Returns null = unbounded. */
export function deriveWindowEnd(cfg: Config, argUntil: string | null, now: Date): Date | null {
  if (argUntil) return parseUntil(argUntil, now)
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
    const sentinelFile = layout.sentinelFile(task.id, episode)
    if (!resume) return pb.initial(task, episode, sentinelFile).path!

    if (state.handoff_pending) {
      const handoffPath = layout.handoffFile(task.id)
      if (existsSync(handoffPath)) {
        const built = pb.resumeWithHandoff(task, handoffPath, episode, sentinelFile)
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

    // Plain continuation cue: paste the cue line + the sentinel/summary postamble
    // (same completion contract as initial/resumeWithHandoff). Without it,
    // resumed episodes wouldn't know to write the sentinel either.
    const path = join(promptsDir, `${task.id}-ep${episode}.md`)
    writeFileSync(
      path,
      `Continue from where you left off in the previous episode.\n\n---\n\n` +
        `When you finish the task, complete these two steps before stopping:\n\n` +
        `1. Append a \`## Summary\` section to \`${task.file}\` with 3-5 bullets ` +
        `covering: what you did, what is working, what is left or blocked.\n\n` +
        `2. Write the file \`${sentinelFile}\` containing the single line "done" ` +
        `to signal completion to the unattended-claude orchestrator.\n\n` +
        `Stop only after both files exist.\n`,
    )
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

/**
 * Create a fresh prompts tmpdir, run `fn` inside it, and clean up the dir
 * afterward — on normal return, exception, AND on `process.exit()` (which
 * fires for the SIGINT/SIGTERM path because lifecycle's signal handler ends
 * by calling `process.exit(0)`, and Node's 'exit' event runs synchronously
 * just before the process dies).
 *
 * This prevents per-run leaks of `mkdtempSync` directories under the OS
 * tmpdir — relevant for long unattended runs.
 */
export async function withPromptsDir<T>(
  fn: (promptsDir: string) => Promise<T>,
): Promise<T> {
  const promptsDir = mkdtempSync(join(tmpdir(), "ucl-prompt-"))
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    rmSync(promptsDir, { recursive: true, force: true })
  }
  // Synchronous exit-handler covers the signal path (lifecycle calls process.exit
  // after marking tasks paused, which bypasses any try/finally above us).
  process.on("exit", cleanup)
  try {
    return await fn(promptsDir)
  } finally {
    process.off("exit", cleanup)
    cleanup()
  }
}

/**
 * Poll for the lockfile that the daemonized child writes during `acquireLock`.
 * Returns true once the file exists AND its contents match `expectedPid`.
 *
 * Why: parent spawns child and immediately returns the shell prompt. If the
 * user pipes `ucl run && ucl stop` (or runs `ucl stop` very quickly), stop
 * would race the child's `acquireLock` and report "no worker running". A
 * brief wait closes that gap.
 */
async function waitForChildLockfile(
  layout: Layout,
  expectedPid: number,
  timeoutMs: number = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(layout.lockFile)) {
      try {
        const pid = Number(readFileSync(layout.lockFile, "utf8").trim())
        if (pid === expectedPid) return true
      } catch {
        /* lockfile read raced with child write; retry */
      }
    }
    await Bun.sleep(50)
  }
  return false
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

  // Daemonize unless --foreground or already a daemon child (re-exec'd by parent).
  const isDaemonChild = process.env.UCL_DAEMON_CHILD === "1"
  if (!args.foreground && !isDaemonChild) {
    const logPath = layout.daemonLogFile(clock.now())
    ensureDir(dirname(logPath))
    const fd = openSync(logPath, "a")
    try {
      const child = Bun.spawn({
        cmd: process.argv,
        env: { ...process.env, UCL_DAEMON_CHILD: "1" },
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        // detached: true → child becomes its own session/process-group leader
        // (setsid()), so it survives SIGHUP when the parent shell closes.
        detached: true,
      })
      // unref(): parent's event loop won't keep running just to wait on child.
      child.unref()
      // Wait briefly for the child to claim the lockfile so an immediate
      // `ucl stop` after `ucl run` sees the daemon, not "no worker running".
      const claimed = await waitForChildLockfile(layout, child.pid!, 5000)
      if (claimed) {
        console.log(`orchestrator detached as PID ${child.pid}, logs at ${logPath}`)
      } else {
        console.log(
          `orchestrator spawned (PID ${child.pid}) but did not claim lockfile within 5s; check ${logPath} for errors`,
        )
      }
      return { reason: "daemonized", taskCount: 0 }
    } finally {
      closeSync(fd)
    }
  }
  // Foreground or daemon-child path continues below.
  log.log("info", `run starting; window ends ${windowEnd ? windowEnd.toISOString() : "(unbounded)"}`)

  const runtime = new InteractiveZellijRuntime(cfg, log, clock)
  return withPromptsDir((promptsDir) => {
    const pb = new PromptBuilder({ promptsDir, bin: cfg.runtime.bin })
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
  })
}
