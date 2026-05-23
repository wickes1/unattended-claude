/**
 * rate-limit.ts — global rate-limit gate
 *
 * The parallel orchestrator uses RateLimitGate to decide "can we run now?" and
 * "when is the limit lifted?". When any episode hits a rate-limit it calls
 * trip(); all lanes pause via waitIfNeeded() until resumeAt.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { atomicWrite } from "../fs-utils.ts"
import type { Layout } from "../layout.ts"
import type { Clock } from "../types.ts"

/**
 * Global rate-limit gate. When any episode hits the limit it calls trip();
 * all lanes pause via waitIfNeeded() until resumeAt.
 *
 * `safetyMarginMs` (cfg.rateLimit.safetyMarginMs) is added to every parsed
 * resume time so lanes wake slightly AFTER the limit actually lifts — this
 * absorbs clock skew between the local machine and Anthropic's reset clock.
 */
export class RateLimitGate {
  /** Current resume time (already padded with safetyMarginMs); null = not limited. */
  resumeAt: Date | null = null

  constructor(private readonly safetyMarginMs: number = 0) {}

  /**
   * Hit the limit — record the resume time padded with safetyMarginMs.
   * Keep the later one to avoid moving backwards; if the new (padded)
   * resumeAt is earlier than the current value, the current value is kept.
   */
  trip(resumeAt: Date): void {
    const padded = new Date(resumeAt.getTime() + this.safetyMarginMs)
    if (this.resumeAt === null || padded.getTime() > this.resumeAt.getTime()) {
      this.resumeAt = padded
    }
  }

  /**
   * Whether currently rate-limited (judged against the given time).
   * Limited when: resumeAt is not null and now < resumeAt.
   */
  blockedAt(now: Date): boolean {
    return this.resumeAt !== null && now.getTime() < this.resumeAt.getTime()
  }

  /**
   * If limited, sleep until resumeAt. Returns immediately if not limited.
   * Re-checks after sleeping (guarding against clock jumps or repeated trips)
   * until the limit is cleared.
   */
  async waitIfNeeded(clock: Clock): Promise<void> {
    while (this.resumeAt !== null) {
      const now = clock.now()
      if (now.getTime() >= this.resumeAt.getTime()) {
        // Past resumeAt — clear the limit.
        this.resumeAt = null
        break
      }
      const waitMs = this.resumeAt.getTime() - now.getTime()
      await clock.sleep(waitMs)
    }
  }
}

/**
 * Weekly-limit gate. Persists across processes via a small file (so scheduled
 * `ucl run` invocations can check it without re-tripping).
 */
export class WeeklyLimitGate {
  constructor(private layout: Layout) {}

  /** Read the persisted pause-until time, or null if not paused. */
  pausedUntil(): Date | null {
    if (!existsSync(this.layout.weeklyPausedFile)) return null
    const t = Date.parse(readFileSync(this.layout.weeklyPausedFile, "utf8").trim())
    return Number.isNaN(t) ? null : new Date(t)
  }

  /** Trip the gate; persists so future processes (scheduled runs) see it. */
  trip(resumeAt: Date): void {
    atomicWrite(this.layout.weeklyPausedFile, resumeAt.toISOString())
  }

  /** True if `now` is before the pause-until time. */
  blocked(now: Date): boolean {
    const u = this.pausedUntil()
    return u !== null && now.getTime() < u.getTime()
  }

  /** If the pause-until time has passed, remove the file. Returns true if cleared. */
  clearIfExpired(now: Date): boolean {
    const u = this.pausedUntil()
    if (u && now.getTime() >= u.getTime()) {
      try { unlinkSync(this.layout.weeklyPausedFile) } catch { /* race-safe */ }
      return true
    }
    return false
  }
}
