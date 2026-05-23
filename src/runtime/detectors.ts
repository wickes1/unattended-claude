/**
 * Claude TUI text detectors.
 *
 * Detects rate-limit, weekly-limit, and context-full conditions from the
 * captured TUI text. Pure functions — no side effects, no zellij calls.
 * Used by claude-session.ts (T09) and the orchestrator.
 */
import { stripAnsi } from "./zellij.ts"

// Calibrated against Claude Code 2.1.146 (2026-05-20). When the TUI text
// format changes, update only PATTERNS / PATTERNS_EXT.
export const PATTERNS = {
  TRUST_DIALOG: /trust this folder/i,
  INPUT_PROMPT: /^[│|]?\s*[❯>]\s*$/,
  QUESTION: /\?\s*$/,
  RATE_LIMIT: [
    /You'?ve reached your usage limit/i,
    /Rate limit reached/i,
    /usage limit reached/i,
  ],
  RESET_TIME: [
    /Try again at (\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
    /(\d+)\s*minutes?\s*until reset/i,
    /You'?ll be able to continue (?:at|in)\s*(.+)/i,
  ],
}

// Confirmed format from real-world screenshot (2026):
// "Weekly limit reached · resets Oct 9 at 10:30am"
export const PATTERNS_EXT = {
  CONTEXT_FULL: [
    /Conversation (?:too long|exceeds|reached the max)/i,
    /Context (?:window|limit) (?:exceeded|reached|full)/i,
    /This conversation is too long/i,
  ],
  WEEKLY_LIMIT: [
    /Weekly limit reached/i,
    /weekly (?:usage )?limit/i,
  ],
  WEEKLY_RESET: [
    /resets?\s+(\w{3,9})\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i,
  ],
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/** Split into trimmed, non-empty lines. */
export function nonEmptyLines(text: string): string[] {
  return text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)
}

/** True when the captured pane has an idle Claude input prompt in the last few lines. */
export function hasInputPrompt(lines: string[]): boolean {
  return lines.slice(-6).some((l) => PATTERNS.INPUT_PROMPT.test(l))
}

/**
 * Parse rate-limit text → reset Date.
 * Returns null when no rate-limit is detected. If detected but reset time
 * unparseable, returns now + parseFailFallbackMs (conservative wait).
 */
export function matchRateLimit(
  text: string,
  now: Date,
  parseFailFallbackMs: number,
): Date | null {
  const flat = text.replace(/\s+/g, " ")
  if (!PATTERNS.RATE_LIMIT.some((re) => re.test(flat))) return null

  for (const re of PATTERNS.RESET_TIME) {
    const m = re.exec(flat)
    if (!m) continue
    const captured = (m[1] ?? "").trim()

    const abs = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(captured)
    if (abs) {
      let h = Number(abs[1])
      const min = Number(abs[2])
      const ap = abs[3]?.toUpperCase()
      if (ap === "PM" && h < 12) h += 12
      if (ap === "AM" && h === 12) h = 0
      const cand = new Date(now)
      cand.setHours(h, min, 0, 0)
      if (cand.getTime() <= now.getTime()) cand.setDate(cand.getDate() + 1)
      return cand
    }
    const mins = /^(\d+)$/.exec(captured)
    if (mins && /minute/i.test(re.source)) {
      return new Date(now.getTime() + Number(mins[1]) * 60_000)
    }
  }
  return new Date(now.getTime() + parseFailFallbackMs)
}

/** True when the captured TUI text shows Claude's context is full. */
export function matchContextLimit(text: string): boolean {
  const flat = text.replace(/\s+/g, " ")
  return PATTERNS_EXT.CONTEXT_FULL.some((re) => re.test(flat))
}

/**
 * Parse weekly-limit text → reset Date.
 * Returns null when no weekly-limit detected. If detected but reset time
 * unparseable, returns now + 24h (conservative — weekly resets are at most
 * 7 days out; 24h means we'll re-check tomorrow).
 */
export function matchWeeklyLimit(text: string, now: Date): Date | null {
  const flat = text.replace(/\s+/g, " ")
  if (!PATTERNS_EXT.WEEKLY_LIMIT.some((re) => re.test(flat))) return null
  const m = PATTERNS_EXT.WEEKLY_RESET[0]!.exec(flat)
  if (m) {
    const monthKey = (m[1] ?? "").toLowerCase().slice(0, 3)
    const month = MONTHS[monthKey]
    const day = Number(m[2])
    let hour = Number(m[3])
    const minute = Number(m[4])
    const meridiem = m[5]?.toLowerCase()
    if (month !== undefined && Number.isFinite(day) && Number.isFinite(hour)) {
      if (meridiem === "pm" && hour < 12) hour += 12
      if (meridiem === "am" && hour === 12) hour = 0
      const reset = new Date(now.getFullYear(), month, day, hour, minute, 0, 0)
      if (reset.getTime() < now.getTime()) reset.setFullYear(now.getFullYear() + 1)
      return reset
    }
  }
  return new Date(now.getTime() + 24 * 60 * 60 * 1000)
}

/**
 * Rough token-count estimate from jsonl byte size.
 * Heuristic: 1 token ≈ 4 chars; jsonl adds ~20% structural overhead.
 * Used by context-compact threshold checks. Acceptable to overestimate
 * (compacts slightly earlier than strictly necessary).
 */
export function estimateTokensFromJsonl(jsonlBytes: number): number {
  return Math.floor(jsonlBytes / 4)
}

// Re-export stripAnsi from zellij.ts for callers that want one import.
export { stripAnsi } from "./zellij.ts"
