/** Unit tests — RateLimitGate + WeeklyLimitGate. */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Layout } from "../src/layout.ts"
import { RateLimitGate, WeeklyLimitGate } from "../src/orchestrator/rate-limit.ts"
import { ensureDir } from "../src/fs-utils.ts"
import type { Clock } from "../src/types.ts"

// ── RateLimitGate ─────────────────────────────────────────────────

/** Fake clock: sleep resolves immediately, now() does not advance on its own after sleep (the test advances it manually). */
class FakeClock implements Clock {
  private current: number
  constructor(start: Date) {
    this.current = start.getTime()
  }
  now(): Date {
    return new Date(this.current)
  }
  /** sleep does not actually wait; it advances the virtual clock directly (same semantics as SimClock). */
  sleep(ms: number): Promise<void> {
    this.current += Math.max(0, ms)
    return Promise.resolve()
  }
  /** Advance the virtual clock directly (for test use). */
  advance(ms: number): void {
    this.current += Math.max(0, ms)
  }
}

describe("RateLimitGate", () => {
  test("initial state: not limited", () => {
    const gate = new RateLimitGate()
    const now = new Date("2026-05-21T03:00:00")
    expect(gate.resumeAt).toBeNull()
    expect(gate.blockedAt(now)).toBe(false)
  })

  test("after trip, blockedAt is true (before resumeAt)", () => {
    const gate = new RateLimitGate()
    const resumeAt = new Date("2026-05-21T05:00:00")
    gate.trip(resumeAt)
    const before = new Date("2026-05-21T04:59:59")
    expect(gate.blockedAt(before)).toBe(true)
  })

  test("blockedAt is false after resumeAt", () => {
    const gate = new RateLimitGate()
    const resumeAt = new Date("2026-05-21T05:00:00")
    gate.trip(resumeAt)
    const after = new Date("2026-05-21T05:00:01")
    expect(gate.blockedAt(after)).toBe(false)
  })

  test("trip with an earlier time does not move resumeAt backwards (keeps the later one)", () => {
    const gate = new RateLimitGate()
    const later = new Date("2026-05-21T06:00:00")
    const earlier = new Date("2026-05-21T05:00:00")
    gate.trip(later)
    gate.trip(earlier) // earlier, should not overwrite
    expect(gate.resumeAt!.getTime()).toBe(later.getTime())
  })

  test("trip with a later time updates resumeAt", () => {
    const gate = new RateLimitGate()
    const first = new Date("2026-05-21T05:00:00")
    const second = new Date("2026-05-21T07:00:00")
    gate.trip(first)
    gate.trip(second)
    expect(gate.resumeAt!.getTime()).toBe(second.getTime())
  })

  test("waitIfNeeded: returns immediately when not limited", async () => {
    const gate = new RateLimitGate()
    const clock = new FakeClock(new Date("2026-05-21T03:00:00"))
    await gate.waitIfNeeded(clock)
    // The virtual clock did not advance.
    expect(clock.now().getTime()).toBe(new Date("2026-05-21T03:00:00").getTime())
  })

  test("waitIfNeeded: when limited, sleeps until resumeAt, then resumeAt is cleared to null", async () => {
    const gate = new RateLimitGate()
    const startMs = new Date("2026-05-21T03:00:00").getTime()
    const resumeAt = new Date("2026-05-21T05:00:00")
    const clock = new FakeClock(new Date(startMs))
    gate.trip(resumeAt)
    await gate.waitIfNeeded(clock)
    // The virtual clock should have advanced to resumeAt.
    expect(clock.now().getTime()).toBe(resumeAt.getTime())
    // The limit should be cleared.
    expect(gate.resumeAt).toBeNull()
    expect(gate.blockedAt(clock.now())).toBe(false)
  })
})

// ── WeeklyLimitGate ──────────────────────────────────────────────

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-weekly-gate-"))
  return new Layout(dir)
}

describe("WeeklyLimitGate", () => {
  test("pausedUntil returns null when file doesn't exist", () => {
    const layout = freshLayout()
    const gate = new WeeklyLimitGate(layout)
    expect(gate.pausedUntil()).toBeNull()
  })

  test("trip then pausedUntil round-trip (ISO 8601 equality)", () => {
    const layout = freshLayout()
    const gate = new WeeklyLimitGate(layout)
    // Use a date with no sub-second component so ISO round-trip is exact.
    const resumeAt = new Date("2026-05-28T03:00:00.000Z")
    gate.trip(resumeAt)
    const got = gate.pausedUntil()
    expect(got).not.toBeNull()
    expect(got!.toISOString()).toBe(resumeAt.toISOString())
    expect(got!.getTime()).toBe(resumeAt.getTime())
  })

  test("blocked(t) true when t < resumeAt", () => {
    const layout = freshLayout()
    const gate = new WeeklyLimitGate(layout)
    const resumeAt = new Date("2026-05-28T03:00:00.000Z")
    gate.trip(resumeAt)
    const before = new Date("2026-05-28T02:59:59.000Z")
    expect(gate.blocked(before)).toBe(true)
  })

  test("blocked(t) false when t >= resumeAt", () => {
    const layout = freshLayout()
    const gate = new WeeklyLimitGate(layout)
    const resumeAt = new Date("2026-05-28T03:00:00.000Z")
    gate.trip(resumeAt)
    const exactly = new Date("2026-05-28T03:00:00.000Z")
    const after = new Date("2026-05-28T03:00:01.000Z")
    expect(gate.blocked(exactly)).toBe(false)
    expect(gate.blocked(after)).toBe(false)
  })

  test("blocked(t) false when not tripped", () => {
    const layout = freshLayout()
    const gate = new WeeklyLimitGate(layout)
    expect(gate.blocked(new Date("2026-05-28T03:00:00.000Z"))).toBe(false)
  })

  test("clearIfExpired returns true and removes file when expired", () => {
    const layout = freshLayout()
    const gate = new WeeklyLimitGate(layout)
    const resumeAt = new Date("2026-05-28T03:00:00.000Z")
    gate.trip(resumeAt)
    expect(existsSync(layout.weeklyPausedFile)).toBe(true)

    const now = new Date("2026-05-28T03:00:01.000Z")
    expect(gate.clearIfExpired(now)).toBe(true)
    expect(existsSync(layout.weeklyPausedFile)).toBe(false)
    expect(gate.pausedUntil()).toBeNull()
  })

  test("clearIfExpired returns false when not expired (file remains)", () => {
    const layout = freshLayout()
    const gate = new WeeklyLimitGate(layout)
    const resumeAt = new Date("2026-05-28T03:00:00.000Z")
    gate.trip(resumeAt)

    const now = new Date("2026-05-28T02:00:00.000Z")
    expect(gate.clearIfExpired(now)).toBe(false)
    expect(existsSync(layout.weeklyPausedFile)).toBe(true)
    expect(gate.pausedUntil()!.getTime()).toBe(resumeAt.getTime())
  })

  test("clearIfExpired returns false when file doesn't exist", () => {
    const layout = freshLayout()
    const gate = new WeeklyLimitGate(layout)
    expect(gate.clearIfExpired(new Date("2026-05-28T03:00:00.000Z"))).toBe(false)
  })

  test("pausedUntil returns null when file content is malformed garbage", () => {
    const layout = freshLayout()
    const gate = new WeeklyLimitGate(layout)
    // Manually write garbage to the file.
    ensureDir(layout.stateDir)
    writeFileSync(layout.weeklyPausedFile, "not-a-date-garbage\n")
    expect(gate.pausedUntil()).toBeNull()
  })
})
