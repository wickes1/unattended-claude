/**
 * Detectors — pure-function unit tests.
 *
 * Covers the text-detection helpers used by claude-session.ts: stripAnsi
 * re-export sanity check, nonEmptyLines, hasInputPrompt, matchRateLimit
 * (ported from v1's rate-limit + word-wrap tests), matchContextLimit,
 * matchWeeklyLimit (new), and estimateTokensFromJsonl.
 */
import { describe, expect, test } from "bun:test"
import {
  estimateTokensFromJsonl,
  hasInputPrompt,
  matchContextLimit,
  matchRateLimit,
  matchWeeklyLimit,
  nonEmptyLines,
  stripAnsi,
} from "../src/runtime/detectors.ts"

// ── stripAnsi (regression coverage; full suite lives in zellij.test.ts) ──
describe("stripAnsi (re-export)", () => {
  test("strips CSI sequences", () => {
    const ESC = "\x1b"
    expect(stripAnsi(`${ESC}[1;31mhello${ESC}[0m world`)).toBe("hello world")
  })
  test("strips CR", () => {
    expect(stripAnsi("abc\rdef")).toBe("abcdef")
  })
})

// ── nonEmptyLines ───────────────────────────────────────────────────
describe("nonEmptyLines", () => {
  test("splits, trims trailing whitespace, drops empties", () => {
    const text = "first   \n\n  second  \n\t\nthird\n"
    expect(nonEmptyLines(text)).toEqual(["first", "  second", "third"])
  })
  test("empty input → empty array", () => {
    expect(nonEmptyLines("")).toEqual([])
    expect(nonEmptyLines("\n\n\n")).toEqual([])
  })
})

// ── hasInputPrompt ──────────────────────────────────────────────────
describe("hasInputPrompt", () => {
  test("true when ❯ is in the last 6 lines (not necessarily the last)", () => {
    // Real-world TUI: ❯ is followed by a separator and a status line.
    const lines = nonEmptyLines(
      [
        "▐▛███▜▌   Claude Code v2.1.146",
        "  ▘▘ ▝▝    ~/Fonds/Workshop/foo",
        "────────────────────────────────",
        "❯ ",
        "────────────────────────────────",
        "  ⏵⏵ bypass permissions on",
      ].join("\n"),
    )
    expect(hasInputPrompt(lines)).toBe(true)
  })

  test("false when ❯ is older than the last 6 lines", () => {
    const lines = [
      "❯ ",
      "line2",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7", // 6 lines after the prompt → outside the slice
    ]
    expect(hasInputPrompt(lines)).toBe(false)
  })

  test("false when there is no ❯ at all", () => {
    expect(hasInputPrompt(["just", "some", "output"])).toBe(false)
  })
})

// ── matchRateLimit (ported from v1 unit.test.ts + rate-limit.test.ts) ──
describe("matchRateLimit", () => {
  const now = new Date("2026-05-21T03:00:00")

  test("non-rate-limit text → null", () => {
    expect(matchRateLimit("just some normal output", now, 3_600_000)).toBeNull()
  })

  test("absolute time 'Try again at 4:18 AM'", () => {
    const r = matchRateLimit(
      "You've reached your usage limit. Try again at 4:18 AM",
      now,
      3_600_000,
    )
    expect(r).not.toBeNull()
    expect(r!.getHours()).toBe(4)
    expect(r!.getMinutes()).toBe(18)
  })

  test("AM/PM 12-hour wrap: 'Try again at 3:00 PM'", () => {
    const r = matchRateLimit(
      "You've reached your usage limit. Try again at 3:00 PM",
      now,
      3_600_000,
    )
    expect(r).not.toBeNull()
    expect(r!.getHours()).toBe(15)
    expect(r!.getMinutes()).toBe(0)
  })

  test("AM at midnight: '12:00 AM' → hour 0, next day", () => {
    // now is 03:00 → reset 00:00 same day is in the past → wrap to tomorrow.
    const r = matchRateLimit(
      "You've reached your usage limit. Try again at 12:00 AM",
      now,
      3_600_000,
    )
    expect(r).not.toBeNull()
    expect(r!.getHours()).toBe(0)
    expect(r!.getMinutes()).toBe(0)
    expect(r!.getDate()).toBe(now.getDate() + 1)
  })

  test("relative 'N minutes until reset'", () => {
    const r = matchRateLimit("Rate limit reached. 45 minutes until reset", now, 3_600_000)
    expect(r).not.toBeNull()
    expect(Math.round((r!.getTime() - now.getTime()) / 60_000)).toBe(45)
  })

  test("matches rate-limit phrase but cannot parse reset → conservative fallback", () => {
    const r = matchRateLimit("usage limit reached", now, 3_600_000)
    expect(r).not.toBeNull()
    expect(Math.round((r!.getTime() - now.getTime()) / 60_000)).toBe(60)
  })

  test("word-wrap: rate-limit phrase split across lines still matches + parses", () => {
    const wrapped = "You've reached your\nusage limit. Try again\nat 6:30 AM"
    const earlier = new Date("2026-05-21T01:00:00")
    const r = matchRateLimit(wrapped, earlier, 3_600_000)
    expect(r).not.toBeNull()
    expect(r!.getHours()).toBe(6)
    expect(r!.getMinutes()).toBe(30)
  })
})

// ── matchContextLimit ───────────────────────────────────────────────
describe("matchContextLimit", () => {
  test("'Conversation too long' → true", () => {
    expect(matchContextLimit("Conversation too long. /compact to continue.")).toBe(true)
  })

  test("'Context window exceeded' → true", () => {
    expect(matchContextLimit("Error: Context window exceeded — please /compact")).toBe(true)
  })

  test("'This conversation is too long' → true", () => {
    expect(matchContextLimit("This conversation is too long for the model")).toBe(true)
  })

  test("normal output → false", () => {
    expect(matchContextLimit("just some normal claude reply text")).toBe(false)
  })

  test("word-wrap: context-full phrase split across lines still matches", () => {
    const wrapped = "Context window\nexceeded for this\nmodel"
    expect(matchContextLimit(wrapped)).toBe(true)
  })
})

// ── matchWeeklyLimit ────────────────────────────────────────────────
describe("matchWeeklyLimit", () => {
  test("non-weekly text → null", () => {
    const now = new Date(2026, 9, 5, 0, 0, 0)
    expect(matchWeeklyLimit("Rate limit reached. Try again at 4:00 AM", now)).toBeNull()
  })

  test("parses 'Weekly limit reached · resets Oct 9 at 10:30am'", () => {
    const now = new Date(2026, 9, 5, 0, 0, 0) // Oct 5 2026
    const text = "Weekly limit reached · resets Oct 9 at 10:30am\n/upgrade to ..."
    const reset = matchWeeklyLimit(text, now)
    expect(reset).toEqual(new Date(2026, 9, 9, 10, 30, 0))
  })

  test("pm handling: 'resets Oct 9 at 1:30pm' → hour 13", () => {
    const now = new Date(2026, 9, 5, 0, 0, 0)
    const text = "Weekly limit reached · resets Oct 9 at 1:30pm"
    const reset = matchWeeklyLimit(text, now)
    expect(reset).toEqual(new Date(2026, 9, 9, 13, 30, 0))
  })

  test("year rollover: parsed reset earlier-in-year-than-now bumps to next year", () => {
    // now = Dec 15 2026; "resets Jan 5 at 10:30am" should be Jan 5 2027.
    const now = new Date(2026, 11, 15, 0, 0, 0)
    const text = "Weekly limit reached · resets Jan 5 at 10:30am"
    const reset = matchWeeklyLimit(text, now)
    expect(reset).toEqual(new Date(2027, 0, 5, 10, 30, 0))
  })

  test("weekly phrase matches but reset unparseable → now + 24h fallback", () => {
    const now = new Date(2026, 9, 5, 0, 0, 0)
    const reset = matchWeeklyLimit("Weekly limit reached — please upgrade", now)
    expect(reset).not.toBeNull()
    expect(reset!.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  test("word-wrap: weekly phrase + reset clause split across lines still parses", () => {
    const now = new Date(2026, 9, 5, 0, 0, 0)
    const wrapped = "Weekly limit\nreached · resets\nOct 9 at 10:30am"
    const reset = matchWeeklyLimit(wrapped, now)
    expect(reset).toEqual(new Date(2026, 9, 9, 10, 30, 0))
  })
})

// ── estimateTokensFromJsonl ─────────────────────────────────────────
describe("estimateTokensFromJsonl", () => {
  test("600_000 bytes → 150_000 tokens (1 token ≈ 4 chars)", () => {
    expect(estimateTokensFromJsonl(600_000)).toBe(150_000)
  })
  test("0 bytes → 0 tokens", () => {
    expect(estimateTokensFromJsonl(0)).toBe(0)
  })
})
