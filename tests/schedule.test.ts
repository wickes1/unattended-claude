/** Unit tests — schedule window math. */
import { describe, expect, test } from "bun:test"
import { activeWindow, nextWindowStart, parseHHMM, windowEndsAt } from "../src/schedule.ts"
import { testConfig } from "./helpers.ts"
import type { Config, ScheduleWindow } from "../src/config.ts"

function cfgWith(windows: ScheduleWindow[]): Config {
  return testConfig({ schedule: { windows } })
}

describe("parseHHMM", () => {
  test("parses HH:MM", () => {
    expect(parseHHMM("22:30")).toEqual({ h: 22, m: 30 })
    expect(parseHHMM("06:30")).toEqual({ h: 6, m: 30 })
    expect(parseHHMM("0:00")).toEqual({ h: 0, m: 0 })
  })

  test("throws on garbage", () => {
    expect(() => parseHHMM("bad")).toThrow(/invalid HH:MM/)
    expect(() => parseHHMM("25-30")).toThrow(/invalid HH:MM/)
    expect(() => parseHHMM("")).toThrow(/invalid HH:MM/)
  })
})

describe("activeWindow — same-day window", () => {
  const cfg = cfgWith([{ start: "09:00", end: "17:00", days: ["mon"] }])

  test("time inside the window returns it", () => {
    // 2026-05-18 is a Monday; 12:00 local is inside 09:00-17:00.
    const now = new Date(2026, 4, 18, 12, 0, 0)
    expect(activeWindow(cfg, now)?.start).toBe("09:00")
  })

  test("time before window start returns null", () => {
    const now = new Date(2026, 4, 18, 8, 59, 0)
    expect(activeWindow(cfg, now)).toBeNull()
  })

  test("time at/after window end returns null", () => {
    const now = new Date(2026, 4, 18, 17, 0, 0)
    expect(activeWindow(cfg, now)).toBeNull()
  })

  test("wrong day returns null", () => {
    // 2026-05-19 is a Tuesday.
    const now = new Date(2026, 4, 19, 12, 0, 0)
    expect(activeWindow(cfg, now)).toBeNull()
  })
})

describe("activeWindow — overnight window 22:30-06:30", () => {
  const monOnly = cfgWith([{ start: "22:30", end: "06:30", days: ["mon"] }])
  const friOnly = cfgWith([{ start: "22:30", end: "06:30", days: ["fri"] }])

  test("23:00 Mon, days=[mon] → returns window (today after start)", () => {
    // 2026-05-18 is a Monday.
    const now = new Date(2026, 4, 18, 23, 0, 0)
    expect(activeWindow(monOnly, now)?.start).toBe("22:30")
  })

  test("03:00 Tue, days=[mon] → returns window (yesterday Mon active)", () => {
    // 2026-05-19 is a Tuesday.
    const now = new Date(2026, 4, 19, 3, 0, 0)
    expect(activeWindow(monOnly, now)?.start).toBe("22:30")
  })

  test("03:00 Tue, days=[fri] → null", () => {
    const now = new Date(2026, 4, 19, 3, 0, 0)
    expect(activeWindow(friOnly, now)).toBeNull()
  })

  test("07:00 Tue, days=[mon] → null (past end)", () => {
    const now = new Date(2026, 4, 19, 7, 0, 0)
    expect(activeWindow(monOnly, now)).toBeNull()
  })
})

describe("activeWindow — empty schedule", () => {
  test("returns null", () => {
    const cfg = cfgWith([])
    expect(activeWindow(cfg, new Date(2026, 4, 18, 12, 0, 0))).toBeNull()
  })
})

describe("windowEndsAt", () => {
  test("same-day window: end is today at HH:MM", () => {
    const w: ScheduleWindow = { start: "09:00", end: "17:00", days: ["mon"] }
    const now = new Date(2026, 4, 18, 12, 0, 0)
    const end = windowEndsAt(w, now)
    expect(end.getFullYear()).toBe(2026)
    expect(end.getMonth()).toBe(4)
    expect(end.getDate()).toBe(18)
    expect(end.getHours()).toBe(17)
    expect(end.getMinutes()).toBe(0)
  })

  test("overnight: end rolls to next day when end-time has already passed today", () => {
    const w: ScheduleWindow = { start: "22:30", end: "06:30", days: ["mon"] }
    // It's 23:00 Mon — 06:30 today already passed, so end should be tomorrow.
    const now = new Date(2026, 4, 18, 23, 0, 0)
    const end = windowEndsAt(w, now)
    expect(end.getDate()).toBe(19)
    expect(end.getHours()).toBe(6)
    expect(end.getMinutes()).toBe(30)
  })
})

describe("nextWindowStart", () => {
  test("returns null for empty schedule", () => {
    expect(nextWindowStart(cfgWith([]), new Date(2026, 4, 18, 12, 0, 0))).toBeNull()
  })

  test("returns earliest future start", () => {
    const cfg = cfgWith([
      { start: "09:00", end: "17:00", days: ["mon", "tue", "wed", "thu", "fri"] },
      { start: "22:30", end: "06:30", days: ["mon", "tue", "wed", "thu", "fri"] },
    ])
    // 2026-05-18 Mon 08:00 — next start should be 09:00 same day.
    const next = nextWindowStart(cfg, new Date(2026, 4, 18, 8, 0, 0))!
    expect(next).not.toBeNull()
    expect(next.getDate()).toBe(18)
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
  })

  test("skips today when no remaining slots, jumps to next active day", () => {
    const cfg = cfgWith([{ start: "09:00", end: "17:00", days: ["mon"] }])
    // 2026-05-18 Mon 20:00 — past today's slot, next Monday 09:00.
    const next = nextWindowStart(cfg, new Date(2026, 4, 18, 20, 0, 0))!
    expect(next).not.toBeNull()
    expect(next.getDate()).toBe(25)
    expect(next.getHours()).toBe(9)
  })
})
