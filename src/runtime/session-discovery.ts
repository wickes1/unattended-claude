/**
 * Post-launch claude session-UUID discovery via the /status slash command.
 *
 * Background (F01, 2026-05-23): Happy 1.1.8 silently swallows --session-id in
 * hook mode (its only mode), so we cannot pre-generate the UUID for bin=happy.
 * The user-facing /status panel always renders `Session ID: <uuid>` and is the
 * only stable contract that survives across claude versions. We send /status,
 * scrape the panel, dismiss it with Esc, and return the UUID for the
 * orchestrator to persist on TaskRuntimeState.
 *
 * Pure side effects against ZellijOps; no zellij module import — keeps the
 * function trivially unit-testable with the same fake used by claude-session.
 */
import { stripAnsi } from "./zellij.ts"
import type { Clock, Logger } from "../types.ts"
import type { ZellijOps } from "./claude-session.ts"

/**
 * Strict UUID-on-same-line-as-label regex. Case-insensitive on the hex digits
 * (claude renders lowercase but defensive). The label form is exactly
 * "Session ID:" + whitespace + UUID as observed in claude 2.1.150 /status.
 *
 * Same-line only: a UUID on a different line from the label must NOT match,
 * otherwise we'd risk picking up unrelated UUIDs from elsewhere in the pane.
 */
const SESSION_ID_RE =
  /Session ID:[ \t]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i

const POLL_INTERVAL_MS = 500
const PANEL_RENDER_DELAY_MS = 1000
const CAPTURE_LINES = 2000

/**
 * Discover the underlying claude session UUID by reading the /status panel.
 *
 * Contract:
 *   1. Send `/status` + Enter to the TUI.
 *   2. Wait PANEL_RENDER_DELAY_MS for the panel to render.
 *   3. Capture pane (large window), strip ANSI, regex for the UUID on the
 *      same line as the `Session ID:` label.
 *   4. Send Esc to dismiss the panel.
 *   5. Return the UUID.
 *
 * Polls every POLL_INTERVAL_MS up to timeoutMs. Throws on timeout — the
 * orchestrator turns this into an episode-level failure so the user sees
 * the breakage instead of a silently un-resumable task.
 */
export async function discoverViaStatus(
  z: ZellijOps,
  parent: string,
  tab: string,
  clock: Clock,
  log: Logger,
  timeoutMs: number = 10_000,
): Promise<string> {
  // 1. Inject the /status slash command. sendText auto-presses Enter on
  //    submit, which is what we want.
  await z.sendText(parent, tab, "/status")

  // 2. Brief render delay before first capture.
  await clock.sleep(PANEL_RENDER_DELAY_MS)

  // 3 + 4. Poll the pane for the UUID until found or timeout.
  const deadline = clock.now().getTime() + timeoutMs
  let lastError: string | null = null

  while (clock.now().getTime() < deadline) {
    const raw = await z.capture(parent, tab, CAPTURE_LINES)
    const clean = stripAnsi(raw)
    const m = SESSION_ID_RE.exec(clean)
    if (m) {
      const uuid = m[1]!.toLowerCase()
      log.log("info", `discovered claude session id via /status: ${uuid}`)
      // 5. Dismiss the panel. Best-effort: an Esc failure should not
      //    invalidate a successful discovery.
      try {
        await z.sendKeys(parent, tab, "Esc")
      } catch (e) {
        log.log("warn", `/status panel Esc dismiss failed: ${String(e)}`)
      }
      return uuid
    }
    lastError = clean.length === 0 ? "empty pane" : "no Session ID line"
    await clock.sleep(POLL_INTERVAL_MS)
  }

  throw new Error(
    `discoverViaStatus: failed to parse Session ID from /status panel within ${timeoutMs}ms (last: ${lastError ?? "unknown"})`,
  )
}
