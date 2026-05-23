// src/types.ts

// ── Runtime adapter (port verbatim from v1, with v2 additions) ─────────────────
export interface InvokeOpts {
  workdir: string
  promptFile: string
  sentinelFile: string
  timeoutMs: number
  parentSession: string
  tabName: string
  rawLogFile: string
  /** NEW v2: pre-generated claude session UUID, passed as --session-id. */
  claudeSessionId: string
  /** NEW v2: when true, launch with --resume <claudeSessionId>. */
  resume: boolean
  /** NEW v2: wall-clock time after which wind-down prompt should be injected; null = no wind-down. */
  windDownAt: Date | null
  /** NEW v2: short prompt injected on resume after dialogs settle; null = no wake-up. */
  wakeUpPrompt: string | null
  /** NEW v2 (F02): where the running session should write its HANDOFF.md
   * when context-full is detected. Always set; runtime ignores when no
   * context-full path is taken. */
  handoffPath: string
  /** NEW v2 (F02): max ms to wait for HANDOFF.md to be written after
   * context-full is detected. */
  handoffTimeoutMs: number
}

/**
 * Side-channel info pollUntilDone reports back about wind-down injection so
 * applyResult can emit a `wind_down_injected` event without re-deriving the
 * boundary. `null`/absent = the wind-down branch was never taken this episode.
 */
export interface WindDownInfo {
  /** Wall-clock minutes between the boundary and the actual injection.
   * Negative when injection lagged past the boundary (typical); 0 when
   * injection landed exactly on the boundary. */
  atMinutesBeforeBoundary: number
}

export type EpisodeResult =
  | { status: "completed"; durationMs: number; discoveredSessionId?: string | null; windDownInjected?: WindDownInfo | null }
  | { status: "rate_limited"; resumeAt: Date; discoveredSessionId?: string | null; windDownInjected?: WindDownInfo | null }
  | { status: "weekly_limited"; resumeAt: Date; discoveredSessionId?: string | null; windDownInjected?: WindDownInfo | null }      // NEW v2
  | { status: "context_full"; handoffWritten: boolean; discoveredSessionId?: string | null; windDownInjected?: WindDownInfo | null }  // NEW v2 (F02)
  | { status: "timeout"; discoveredSessionId?: string | null; windDownInjected?: WindDownInfo | null }
  | { status: "error"; reason: string; discoveredSessionId?: string | null; windDownInjected?: WindDownInfo | null }
  | { status: "lost"; reason: string; discoveredSessionId?: string | null; windDownInjected?: WindDownInfo | null }

export interface Runtime {
  invoke(opts: InvokeOpts): Promise<EpisodeResult>
}

// ── Task state machine (NEW v2 — replaces v1 OvernightState) ───────
export type TaskState = "planned" | "running" | "paused" | "done" | "failed" | "archived"

export type PausedReason =
  | "schedule-boundary"
  | "rate-limit-5h"
  | "weekly-limit"
  | "context-full"
  | "user-stop"
  | "user-stop-now"
  | "orphan"

/** Per-task mutable state. Lives at ~/unattended/state/tasks/<id>.json. */
export interface TaskRuntimeState {
  schema_version: 1
  task_id: string
  state: TaskState
  paused_reason: PausedReason | null
  claude_session_id: string                      // pre-generated UUID
  current_episode: number                        // 0-based episode counter
  context_compactions: number                    // count of HANDOFF-based restarts
  created_at: string                             // ISO 8601
  last_updated: string                           // ISO 8601
  workdir: string                                // absolute path
  /** NEW v2 (F02): true after context-full when HANDOFF.md was written and
   * the next episode should resume from it. Cleared by the orchestrator
   * once the next episode commits. */
  handoff_pending: boolean
}

// ── Task doc (parsed from tasks/<id>.md frontmatter) ───────
export interface TaskDoc {
  id: string                                     // "YYYY-MM-DD-NN-slug"
  title: string
  workdir: string
  serial: boolean                                // §九 serial flag
  file: string                                   // absolute path to the .md
}

// ── events.jsonl events ──────────────────────────
export type Event =
  | { ts: string; event: "run_start"; until: string | null }
  | { ts: string; event: "run_end"; reason: string }
  | { ts: string; event: "task_started"; task: string; episode: number; resumed: boolean }
  | { ts: string; event: "task_paused"; task: string; episode: number; reason: PausedReason }
  | { ts: string; event: "task_done"; task: string; episode: number }
  | { ts: string; event: "task_failed"; task: string; reason: string }
  | { ts: string; event: "rate_limit"; task: string; episode: number; resume_at: string }
  | { ts: string; event: "weekly_limit"; resume_at: string }
  | { ts: string; event: "context_compaction"; task: string; episode: number }
  | { ts: string; event: "handoff_written"; task: string; path: string }
  | { ts: string; event: "handoff_resumed"; task: string; path: string }
  | { ts: string; event: "wind_down_injected"; task: string; episode: number; at_minutes_before_boundary: number }
  | { ts: string; event: "queued_due_to_concurrency_cap"; task: string }
  | { ts: string; event: "usage_snapshot"; task: string; episode: number; tokens_used: number; source_path: string }
  | { ts: string; event: "archive_moved"; task: string }
  | { ts: string; event: "error"; reason: string }

// ── Cross-cutting (port from v1) ────────────────────
export interface Clock {
  now(): Date
  sleep(ms: number): Promise<void>
}
export type LogLevel = "debug" | "info" | "warn" | "error"
export interface Logger {
  log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void
}
