import type { Config, ScheduleWindow } from "./config.ts"

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

export function parseHHMM(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) throw new Error(`invalid HH:MM: ${s}`)
  return { h: Number(m[1]), m: Number(m[2]) }
}

/**
 * The schedule window that is active at `now`, or null. Handles overnight
 * windows where end < start (e.g. 22:30 → 06:30 crosses midnight).
 */
export function activeWindow(cfg: Config, now: Date): ScheduleWindow | null {
  const day = DAYS[now.getDay()]!
  const yesterday = DAYS[(now.getDay() + 6) % 7]!
  const nowMin = now.getHours() * 60 + now.getMinutes()
  for (const w of cfg.schedule.windows) {
    const { h: sh, m: sm } = parseHHMM(w.start)
    const { h: eh, m: em } = parseHHMM(w.end)
    const startMin = sh * 60 + sm
    const endMin = eh * 60 + em
    if (startMin <= endMin) {
      // Same-day window
      if (w.days.includes(day) && nowMin >= startMin && nowMin < endMin) return w
    } else {
      // Overnight window — counts when:
      //   1) today after start (e.g. it's 23:00 on Mon, window mon 22:30-06:30)
      //   2) today before end and yesterday is one of the active days (the window started yesterday)
      if (w.days.includes(day) && nowMin >= startMin) return w
      if (w.days.includes(yesterday) && nowMin < endMin) return w
    }
  }
  return null
}

/** Compute the absolute end Date for `--until`, given the active window and now. */
export function windowEndsAt(window: ScheduleWindow, now: Date): Date {
  const { h, m } = parseHHMM(window.end)
  const end = new Date(now)
  end.setHours(h, m, 0, 0)
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1)
  return end
}

/** Next window start strictly after `now`, or null if schedule empty. */
export function nextWindowStart(cfg: Config, now: Date): Date | null {
  if (cfg.schedule.windows.length === 0) return null
  // Search ahead up to 8 days (covers weekly cycles + day-after edge cases).
  for (let i = 0; i < 8; i++) {
    const cand = new Date(now)
    cand.setDate(cand.getDate() + i)
    const day = DAYS[cand.getDay()]!
    for (const w of cfg.schedule.windows) {
      if (!w.days.includes(day)) continue
      const { h, m } = parseHHMM(w.start)
      cand.setHours(h, m, 0, 0)
      if (cand.getTime() > now.getTime()) return new Date(cand)
    }
  }
  return null
}
