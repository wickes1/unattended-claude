import type { Clock } from "./types.ts"

/** For production runs: real time. */
export class RealClock implements Clock {
  now(): Date {
    return new Date()
  }
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(0, ms)))
  }
}

/**
 * For simulation: virtual time. sleep() does not actually wait; it just
 * advances the virtual clock.
 * Lets a full "9-hour night" be simulated end-to-end in a few milliseconds
 * (needed for the scenario verification in spec-usage-flow).
 */
export class SimClock implements Clock {
  private virtual: number
  constructor(start: Date) {
    this.virtual = start.getTime()
  }
  now(): Date {
    return new Date(this.virtual)
  }
  sleep(ms: number): Promise<void> {
    this.virtual += Math.max(0, ms)
    return Promise.resolve()
  }
  /** Simulate episode execution time etc.: advance the virtual clock directly. */
  advance(ms: number): void {
    this.virtual += Math.max(0, ms)
  }
}
