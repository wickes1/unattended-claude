/**
 * PromptBuilder — single seam for every prompt the orchestrator injects into a
 * Claude session.
 *
 * The four prompt kinds in v2 are:
 *   1. initial            — first episode of a task; paste the task doc body.
 *   2. wakeUp             — short cue injected when resuming a paused task
 *                           (one of: schedule-boundary, rate-limit-5h,
 *                           weekly-limit, user-stop, user-stop-now, orphan).
 *                           Returns null for context-full because that path
 *                           uses resumeWithHandoff instead of a wake-up cue.
 *   3. windDown           — fired once when the wind-down boundary is reached;
 *                           asks the AI to stop cleanly.
 *   4. resumeWithHandoff  — after a context-full pause, the next episode is a
 *                           fresh session that reads HANDOFF.md to pick up.
 *                           (F02 will switch the orchestrator over.)
 *
 * One PromptBuilder is created per `ucl run` invocation. The caller passes a
 * pre-created temp dir; all prompt files for the run land there so they can
 * be inspected post-mortem and cleaned up as a group.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { WIND_DOWN_PROMPT } from "../runtime/claude-session.ts"
import type { PausedReason, TaskDoc } from "../types.ts"

export type PromptKind = "initial" | "wakeUp" | "windDown" | "resumeWithHandoff"

/**
 * Result of building a prompt.
 *   - text: the prompt body (used by `sendText` for inline prompts, or echoed
 *     for testability when a file is also written).
 *   - path: populated only when the prompt is large/structured enough to be
 *     pasted as a file (initial, resumeWithHandoff). undefined for one-liners.
 */
export interface PromptResult {
  text: string
  path?: string
}

export interface PromptBuilderDeps {
  /** Pre-created temp dir for prompt files. One per orchestrator run. */
  promptsDir: string
}

/**
 * Wake-up cue text per PausedReason. context-full is NOT in this map — that
 * path goes through resumeWithHandoff instead.
 */
const WAKE_UP_TEXT: Record<Exclude<PausedReason, "context-full">, string> = {
  "schedule-boundary":
    "Schedule window ended. Time to continue — pick up from where you stopped.",
  "rate-limit-5h":
    "The 5-hour rate limit window has reset. Continue from where you stopped.",
  "weekly-limit":
    "The weekly limit has cleared. Continue from where you stopped.",
  "user-stop": "Manual stop ended. Continue from where you stopped.",
  "user-stop-now":
    "Previously interrupted forcibly. Continue, but please first verify current file/test state to avoid duplication.",
  orphan:
    "Previous session was interrupted unexpectedly (machine reboot or process death). Continue, but please first verify current file/test state.",
}

export class PromptBuilder {
  constructor(private deps: PromptBuilderDeps) {}

  /** First-episode prompt: paste the task doc body. */
  initial(task: TaskDoc, episode: number): PromptResult {
    const text = readFileSync(task.file, "utf8")
    const path = join(this.deps.promptsDir, `${task.id}-ep${episode}.md`)
    writeFileSync(path, text)
    return { text, path }
  }

  /**
   * Wake-up cue for a resumed episode. Returns null for context-full because
   * that path uses resumeWithHandoff instead.
   */
  wakeUp(task: TaskDoc, pausedReason: PausedReason): PromptResult | null {
    if (pausedReason === "context-full") return null
    return { text: WAKE_UP_TEXT[pausedReason] }
  }

  /** Wind-down cue injected once when the wind-down boundary is reached. */
  windDown(): PromptResult {
    return { text: WIND_DOWN_PROMPT }
  }

  /**
   * Post-context-full resume: build a fresh prompt that wraps the HANDOFF.md
   * body so the new session can pick up. Writes the composed prompt into
   * promptsDir.
   */
  resumeWithHandoff(
    task: TaskDoc,
    handoffPath: string,
    episode: number,
  ): PromptResult {
    const handoff = readFileSync(handoffPath, "utf8")
    const text =
      "The previous session ran out of context and was ended. Read the handoff below " +
      "and continue from where the previous session left off. Verify current file/test " +
      "state before making changes.\n\n" +
      "## HANDOFF.md\n\n" +
      handoff
    const path = join(this.deps.promptsDir, `${task.id}-ep${episode}.md`)
    writeFileSync(path, text)
    return { text, path }
  }
}
