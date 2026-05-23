/**
 * Orchestrator main loop — one call per `ucl run` invocation.
 *
 * Responsibilities (DESIGN §五 / §六 / §九):
 *   1. Acquire single-process lock + install signal handlers.
 *   2. Preflight: clear expired weekly gate, run orphan recovery.
 *   3. Build run queue from paused-resumable (FIFO) + planned tasks (sorted by id).
 *   4. Decompose into lanes by workdir (or per-id when serial: true).
 *   5. Run lanes concurrently up to execution.maxParallelTabs.
 *   6. Each lane runs its tasks serially; each task loops episodes until terminal.
 *   7. On SIGTERM/SIGINT or window-end: gracefully pause running tasks.
 *   8. Always emit run_start / run_end, always release lock + kill zellij session.
 */
import { randomUUID } from "node:crypto"
import { appendEvent } from "../events.ts"
import type { Config } from "../config.ts"
import type { Layout } from "../layout.ts"
import type {
  Clock,
  Logger,
  PausedReason,
  Runtime,
  TaskDoc,
  TaskRuntimeState,
} from "../types.ts"
import { TaskStateStore } from "./state-store.ts"
import { RateLimitGate, WeeklyLimitGate } from "./rate-limit.ts"
import {
  acquireLock,
  findOrphans,
  findResumableTasks,
  installSignalHandlers,
  releaseLock,
  suspendForShutdown,
} from "./lifecycle.ts"
import { applyResult, runEpisode, type EpisodeCtx } from "./episode.ts"
import { archiveOne, findArchiveCandidates } from "../commands/archive.ts"
import * as zellij from "../runtime/zellij.ts"

export interface RunOptions {
  /** Wall-clock end-of-window. null = run until queue empty. */
  windowEndsAt: Date | null
  /** Required parent zellij session name (typically "unattended-claude"). */
  parentSession: string
  /**
   * When true, skip the real zellij session create/kill calls. Tests with
   * MockRuntime should set this; production code leaves it false.
   */
  skipZellij?: boolean
}

export type RunReason =
  | "queue_empty"
  | "window_end"
  | "signal"
  | "weekly_limited"
  | "lock_held"
  | "weekly_paused"

export interface RunResult {
  reason: RunReason
  /** Episode invocations performed (not unique task count). */
  taskCount: number
}

export interface OrchestratorDeps {
  cfg: Config
  layout: Layout
  log: Logger
  clock: Clock
  runtime: Runtime
  /** Returns currently-planned task docs from tasks/. */
  loadTaskDocs: () => TaskDoc[]
  /** Build the prompt file for a fresh episode. Returns the prompt file path.
   *  `state` carries handoff_pending etc. so the implementation can choose
   *  between continuation cue, resumeWithHandoff, or fresh task paste. */
  buildPromptFile: (
    task: TaskDoc,
    episode: number,
    resume: boolean,
    state: TaskRuntimeState,
  ) => string
  /** Build the wake-up prompt for a resumed episode (or null). */
  buildWakeUpPrompt: (task: TaskDoc, pausedReason: PausedReason | null) => string | null
  /**
   * Test injection: bypass installSignalHandlers (which mutates process state).
   * Production code leaves this undefined.
   */
  installSignals?: (handler: (sig: NodeJS.Signals) => Promise<void>) => void
}

/** Main orchestrator entrypoint. */
export async function runOrchestrator(
  deps: OrchestratorDeps,
  opts: RunOptions,
): Promise<RunResult> {
  // 1. Lock
  if (!acquireLock(deps.layout)) {
    deps.log.log("warn", "another orchestrator is already running")
    return { reason: "lock_held", taskCount: 0 }
  }

  // 2. Preflight: weekly gate
  const weeklyGate = new WeeklyLimitGate(deps.layout)
  weeklyGate.clearIfExpired(deps.clock.now())
  if (weeklyGate.blocked(deps.clock.now())) {
    deps.log.log(
      "warn",
      `weekly limit active until ${weeklyGate.pausedUntil()?.toISOString()}; aborting`,
    )
    releaseLock(deps.layout)
    return { reason: "weekly_paused", taskCount: 0 }
  }

  // 3. Signal handlers (injectable for tests)
  let signalled: NodeJS.Signals | null = null
  const signalHandler = async (sig: NodeJS.Signals) => {
    signalled = sig
    deps.log.log("warn", `received ${sig}; suspending running tasks`)
  }
  if (deps.installSignals) deps.installSignals(signalHandler)
  else installSignalHandlers((s) => signalHandler(s as NodeJS.Signals))

  // 4. run_start
  appendEvent(deps.layout, {
    ts: deps.clock.now().toISOString(),
    event: "run_start",
    until: opts.windowEndsAt?.toISOString() ?? null,
  })

  // 5. Orphan recovery — at preflight, no zellij tabs exist yet for this run,
  //    so any state.state="running" is an orphan from a prior crashed run.
  const store = new TaskStateStore(deps.layout, deps.clock)
  for (const id of findOrphans(store, new Set())) {
    await store.update(id, (s) => {
      s.state = "paused"
      s.paused_reason = "orphan"
    })
    appendEvent(deps.layout, {
      ts: deps.clock.now().toISOString(),
      event: "task_paused",
      task: id,
      episode: 0,
      reason: "orphan",
    })
  }

  // 5b. Auto-archive preflight (F10): move done/failed tasks older than
  //     cfg.archive.autoAfterDays into archive/. Disabled when value <= 0.
  //     A per-task failure must not abort the run.
  if (deps.cfg.archive.autoAfterDays > 0) {
    const candidates = findArchiveCandidates(
      deps.layout,
      deps.cfg.archive.autoAfterDays,
      deps.clock.now(),
    )
    for (const s of candidates) {
      try {
        const moved = archiveOne(deps.layout, s.task_id, deps.clock.now())
        if (moved) {
          appendEvent(deps.layout, {
            ts: deps.clock.now().toISOString(),
            event: "archive_auto",
            task: s.task_id,
          })
        }
      } catch (e) {
        deps.log.log(
          "warn",
          `auto-archive failed for ${s.task_id}: ${String(e)}; continuing`,
        )
      }
    }
  }

  // 6. Create zellij session (best-effort)
  if (!opts.skipZellij) {
    try {
      await zellij.newSession(opts.parentSession, deps.cfg)
    } catch (e) {
      deps.log.log("warn", `zellij newSession failed: ${String(e)}; continuing`)
    }
  }

  // 7. Build run queue: paused-resumable (FIFO) + planned (sorted by id).
  const docs = deps.loadTaskDocs()
  const docById = new Map(docs.map((d) => [d.id, d] as const))
  const resumable = findResumableTasks(store, weeklyGate, deps.clock.now())
  const planned = docs
    .filter((d) => {
      const s = store.load(d.id)
      return !s || s.state === "planned"
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  const queue: TaskDoc[] = [
    ...resumable
      .map((s) => docById.get(s.task_id))
      .filter((d): d is TaskDoc => d !== undefined),
    ...planned,
  ]

  // 8. Initialize state for fresh planned tasks
  for (const d of planned) {
    if (!store.load(d.id)) store.init(d.id, d.workdir, randomUUID())
  }

  // 9. Episode context (shared by all lanes)
  const rateLimitGate = new RateLimitGate(deps.cfg.rateLimit.safetyMarginMs)
  const epCtx: EpisodeCtx = {
    runtime: deps.runtime,
    layout: deps.layout,
    log: deps.log,
    clock: deps.clock,
    store,
    rateLimitGate,
    weeklyLimitGate: weeklyGate,
    windowEndsAt: opts.windowEndsAt,
    windDownLeadMs: deps.cfg.execution.windDownLeadMinutes * 60_000,
    parentSession: opts.parentSession,
    contextCompactThreshold: deps.cfg.execution.contextCompactThreshold,
    episodeHardTimeoutMs: deps.cfg.execution.episodeHardTimeoutMs,
  }

  // 10. Lane decomposition: group by workdir (or per-id for serial tasks).
  const lanes = new Map<string, TaskDoc[]>()
  for (const d of queue) {
    const key = d.serial ? `__serial_${d.id}` : d.workdir || `__nowd_${d.id}`
    const arr = lanes.get(key) ?? []
    arr.push(d)
    lanes.set(key, arr)
  }
  const laneEntries = [...lanes.values()]

  // 11. Stop-condition checker (reused by lane loop + outer scheduler)
  const stopReason = (): RunReason | null => {
    if (signalled) return "signal"
    if (
      opts.windowEndsAt &&
      deps.clock.now().getTime() >= opts.windowEndsAt.getTime()
    ) {
      return "window_end"
    }
    if (weeklyGate.blocked(deps.clock.now())) return "weekly_limited"
    // Rate-limit gate set past windowEndsAt → effectively window-bound exit.
    if (
      opts.windowEndsAt &&
      rateLimitGate.resumeAt &&
      rateLimitGate.resumeAt.getTime() > opts.windowEndsAt.getTime()
    ) {
      return "window_end"
    }
    return null
  }

  // 12. Per-lane runner: serial within a lane.
  //
  //   Auto-resume policy (within a single run):
  //     - rate_limited     → wait on the gate, re-mark running, continue.
  //     - context_full     → episode boundary; re-mark running, continue.
  //     - weekly_limited   → never auto-resume in this run; exit lane.
  //     - completed/failed → terminal; exit lane.
  //
  //   If waiting would push past the window, stopReason() returns "window_end"
  //   on the next iteration and the task stays paused.
  let episodeCount = 0
  const AUTO_RESUME_REASONS = new Set<PausedReason>(["rate-limit-5h", "context-full"])

  const runLane = async (tasks: TaskDoc[]): Promise<void> => {
    for (const task of tasks) {
      if (stopReason()) return

      await store.update(task.id, (s) => {
        s.state = "running"
      })

      while (true) {
        if (stopReason()) return
        const cur = store.load(task.id)
        if (!cur || cur.state !== "running") break

        await rateLimitGate.waitIfNeeded(deps.clock)
        if (stopReason()) return

        const wakeUp =
          cur.current_episode > 0
            ? deps.buildWakeUpPrompt(task, cur.paused_reason)
            : null
        const promptFile = deps.buildPromptFile(
          task,
          cur.current_episode + 1,
          cur.current_episode > 0,
          cur,
        )
        const result = await runEpisode(task, cur, epCtx, promptFile, wakeUp)
        await applyResult(task, result, epCtx)
        episodeCount++

        // Decide whether to auto-resume within this run.
        const next = store.load(task.id)
        if (!next) break
        if (next.state !== "paused") break
        if (!next.paused_reason || !AUTO_RESUME_REASONS.has(next.paused_reason)) break

        // For rate-limit: if resumeAt > windowEndsAt, exit now (waitIfNeeded
        // would push us past the boundary and stopReason would fire anyway).
        if (
          next.paused_reason === "rate-limit-5h" &&
          opts.windowEndsAt &&
          rateLimitGate.resumeAt &&
          rateLimitGate.resumeAt.getTime() > opts.windowEndsAt.getTime()
        ) {
          return
        }

        // Re-mark running for next iteration. waitIfNeeded handles rate-limit;
        // context-full requires no wait.
        await store.update(task.id, (s) => {
          s.state = "running"
        })
      }
    }
  }

  // 13. Concurrency-capped lane scheduler.
  const cap = Math.max(1, deps.cfg.execution.maxParallelTabs)
  const running = new Set<Promise<void>>()
  let nextLaneIdx = 0
  let queuedLogged = false

  while (nextLaneIdx < laneEntries.length || running.size > 0) {
    if (stopReason()) break

    // Fill empty slots.
    while (nextLaneIdx < laneEntries.length && running.size < cap) {
      const tasks = laneEntries[nextLaneIdx]!
      nextLaneIdx++
      const p = runLane(tasks).finally(() => {
        running.delete(p)
      })
      running.add(p)
    }

    // If lanes remain queued and slots are full, emit queueing event(s) once.
    if (!queuedLogged && nextLaneIdx < laneEntries.length) {
      queuedLogged = true
      for (let i = nextLaneIdx; i < laneEntries.length; i++) {
        for (const t of laneEntries[i]!) {
          appendEvent(deps.layout, {
            ts: deps.clock.now().toISOString(),
            event: "queued_due_to_concurrency_cap",
            task: t.id,
          })
        }
      }
    }

    if (running.size > 0) await Promise.race(running)
    else break
  }

  // Drain remaining lanes (only when stop-condition fired and we want them to
  // observe the stop). They check stopReason() at the top of each iteration.
  await Promise.all(running)

  // 14. Determine exit reason + graceful shutdown.
  const exitReason: RunReason = stopReason() ?? "queue_empty"
  if (exitReason === "signal" || exitReason === "window_end") {
    const reason: PausedReason =
      exitReason === "signal" ? "user-stop" : "schedule-boundary"
    await suspendForShutdown(store, deps.layout, reason, deps.log)
  }

  // 15. Cleanup (best-effort)
  if (!opts.skipZellij) {
    try {
      await zellij.killSession(opts.parentSession)
    } catch (e) {
      deps.log.log("warn", `zellij killSession failed: ${String(e)}`)
    }
  }
  appendEvent(deps.layout, {
    ts: deps.clock.now().toISOString(),
    event: "run_end",
    reason: exitReason,
  })
  releaseLock(deps.layout)
  return { reason: exitReason, taskCount: episodeCount }
}
