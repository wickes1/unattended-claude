/**
 * Episode loop (per-task runner).
 *
 * Two pieces, intentionally separated:
 *   - runEpisode: build InvokeOpts from current state, write task_started, invoke Runtime, return result.
 *   - applyResult: take the EpisodeResult, mutate TaskRuntimeState, write the corresponding events.
 *
 * Together they're "what happens for one episode". DESIGN §五 / §八.
 */
import { randomUUID } from "node:crypto"
import { ensureDir } from "../fs-utils.ts"
import { appendEvent } from "../events.ts"
import type { Layout } from "../layout.ts"
import { RateLimitGate, WeeklyLimitGate } from "./rate-limit.ts"
import { TaskStateStore } from "./state-store.ts"
import type {
  Clock,
  EpisodeResult,
  InvokeOpts,
  Logger,
  Runtime,
  TaskDoc,
  TaskRuntimeState,
} from "../types.ts"

export interface EpisodeCtx {
  runtime: Runtime
  layout: Layout
  log: Logger
  clock: Clock
  store: TaskStateStore
  rateLimitGate: RateLimitGate
  weeklyLimitGate: WeeklyLimitGate
  /** Wall-clock time when the run window ends (graceful pause boundary). null = unbounded. */
  windowEndsAt: Date | null
  /** Lead time before windowEndsAt to inject wind-down. */
  windDownLeadMs: number
  /** Parent zellij session for this run. */
  parentSession: string
  /** Token-equivalent threshold for forcing context-full path. */
  contextCompactThreshold: number
  /** Hard per-episode timeout in ms (cfg.execution.episodeHardTimeoutMs). */
  episodeHardTimeoutMs: number
}

/** Build InvokeOpts for the next episode of a task. */
export function buildInvokeOpts(
  task: TaskDoc,
  state: TaskRuntimeState,
  ctx: EpisodeCtx,
  promptFile: string,
  sentinelFile: string,
  rawLogFile: string,
  wakeUpPrompt: string | null,
): InvokeOpts {
  const windDownAt = ctx.windowEndsAt
    ? new Date(ctx.windowEndsAt.getTime() - ctx.windDownLeadMs)
    : null
  return {
    workdir: state.workdir,
    promptFile,
    sentinelFile,
    timeoutMs: ctx.episodeHardTimeoutMs,
    parentSession: ctx.parentSession,
    tabName: task.id,
    rawLogFile,
    claudeSessionId: state.claude_session_id,
    resume: state.current_episode > 0,
    windDownAt,
    wakeUpPrompt,
    handoffPath: ctx.layout.handoffFile(task.id),
    handoffTimeoutMs: 120_000,
  }
}

/**
 * Run one episode for a task. Returns the raw EpisodeResult from runtime.
 * State updates happen in applyResult — keep concerns separated.
 */
export async function runEpisode(
  task: TaskDoc,
  state: TaskRuntimeState,
  ctx: EpisodeCtx,
  promptFile: string,
  wakeUpPrompt: string | null,
): Promise<EpisodeResult> {
  const epNum = state.current_episode + 1
  const sentinelFile = ctx.layout.sentinelFile(task.id, epNum)
  const rawLogFile = ctx.layout.episodeLogFile(task.id, epNum)
  ensureDir(ctx.layout.logsDir)
  ensureDir(ctx.layout.stateDir)

  appendEvent(ctx.layout, {
    ts: ctx.clock.now().toISOString(),
    event: "task_started",
    task: task.id,
    episode: epNum,
    resumed: state.current_episode > 0,
  })

  const opts = buildInvokeOpts(task, state, ctx, promptFile, sentinelFile, rawLogFile, wakeUpPrompt)
  const result = await ctx.runtime.invoke(opts)
  return result
}

/**
 * Apply the EpisodeResult to state + events.jsonl per DESIGN §五 and §八.
 * - completed → state=done, event task_done
 * - rate_limited → trip rateLimitGate, state=paused/rate-limit-5h, event task_paused + rate_limit
 * - weekly_limited → trip weeklyLimitGate, state=paused/weekly-limit, event task_paused + weekly_limit
 * - context_full → regen claude_session_id, context_compactions++, state=paused/context-full, event task_paused + context_compaction
 * - timeout / error / lost → state=failed, event task_failed
 *
 * Always increments current_episode.
 */
export async function applyResult(
  task: TaskDoc,
  result: EpisodeResult,
  ctx: EpisodeCtx,
): Promise<void> {
  await ctx.store.update(task.id, (s) => {
    s.current_episode += 1
    const epNum = s.current_episode
    const ts = ctx.clock.now().toISOString()
    // Episode launched; the handoff (if any) has been consumed. The
    // context_full branch below may re-set handoff_pending=true with a
    // fresh handoff written by THIS episode.
    s.handoff_pending = false

    // F01: persist discovered session UUID (only the Happy first-launch path
    // populates this; for bin=claude / resume it's null/undefined). Doing this
    // before the switch ensures the next episode resumes off the real UUID
    // even on context_full (which regenerates the id below — we'd overwrite
    // discovered with random in that branch, which is correct: context_full
    // intentionally starts a fresh claude session).
    if (result.discoveredSessionId) {
      s.claude_session_id = result.discoveredSessionId
    }

    switch (result.status) {
      case "completed":
        s.state = "done"
        s.paused_reason = null
        appendEvent(ctx.layout, { ts, event: "task_done", task: task.id, episode: epNum })
        return
      case "rate_limited":
        ctx.rateLimitGate.trip(result.resumeAt)
        s.state = "paused"
        s.paused_reason = "rate-limit-5h"
        appendEvent(ctx.layout, {
          ts,
          event: "rate_limit",
          task: task.id,
          episode: epNum,
          resume_at: result.resumeAt.toISOString(),
        })
        appendEvent(ctx.layout, {
          ts,
          event: "task_paused",
          task: task.id,
          episode: epNum,
          reason: "rate-limit-5h",
        })
        return
      case "weekly_limited":
        ctx.weeklyLimitGate.trip(result.resumeAt)
        s.state = "paused"
        s.paused_reason = "weekly-limit"
        appendEvent(ctx.layout, {
          ts,
          event: "weekly_limit",
          resume_at: result.resumeAt.toISOString(),
        })
        appendEvent(ctx.layout, {
          ts,
          event: "task_paused",
          task: task.id,
          episode: epNum,
          reason: "weekly-limit",
        })
        return
      case "context_full":
        // Regenerate claude session id — next episode starts fresh, reading HANDOFF.
        s.claude_session_id = randomUUID()
        s.context_compactions += 1
        s.state = "paused"
        s.paused_reason = "context-full"
        s.handoff_pending = result.handoffWritten
        if (result.handoffWritten) {
          appendEvent(ctx.layout, {
            ts,
            event: "handoff_written",
            task: task.id,
            path: ctx.layout.handoffFile(task.id),
          })
        }
        appendEvent(ctx.layout, {
          ts,
          event: "context_compaction",
          task: task.id,
          episode: epNum,
        })
        appendEvent(ctx.layout, {
          ts,
          event: "task_paused",
          task: task.id,
          episode: epNum,
          reason: "context-full",
        })
        return
      case "timeout":
      case "error":
      case "lost":
        s.state = "failed"
        s.paused_reason = null
        appendEvent(ctx.layout, {
          ts,
          event: "task_failed",
          task: task.id,
          reason: result.status === "timeout" ? "timeout" : (result as { reason: string }).reason,
        })
        return
    }
  })
}
