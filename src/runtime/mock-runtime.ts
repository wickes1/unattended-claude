/**
 * Mock Runtime — does not start zellij, does not call the real claude, does not
 * burn quota. Used for end-to-end simulation tests of the v2 §12 scenarios.
 *
 * simComplete reads the injected prompt file, automatically parses out the
 * deliverable paths the task declares, and produces the corresponding files —
 * so the episode order does not need to be hardcoded in the script.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { SimClock } from "../clock.ts"
import type { EpisodeResult, InvokeOpts, Runtime } from "../types.ts"

export interface MockCtx {
  episodeNum: number
}
export type MockBehavior = (
  opts: InvokeOpts,
  ctx: MockCtx,
) => EpisodeResult | Promise<EpisodeResult>

/**
 * Derive a task's related paths from opts. In v2, deliverables are written
 * relative to opts.workdir (the task workdir) — no per-night layout exists.
 */
function paths(opts: InvokeOpts) {
  return {
    stateDir: dirname(opts.sentinelFile),
    workdir: opts.workdir,
  }
}

function w(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** Parse the deliverable relative paths the task declares from the injected prompt file. */
function deliverablesFromPrompt(promptFile: string): string[] {
  try {
    const text = readFileSync(promptFile, "utf8")
    const set = new Set<string>()
    for (const m of text.matchAll(/(?:^|[\s'"(-])(deliverables\/[^\s'"]+?\.\w+)/g)) {
      set.add(m[1]!)
    }
    return [...set]
  } catch {
    return []
  }
}

// ── Behavior factories (all capture the sim clock and advance virtual time) ──

/** Normal completion: auto-produce deliverables (per the prompt's declarations) + sentinel. */
export function simComplete(
  clock: SimClock,
  o: { durationMin?: number } = {},
): MockBehavior {
  const durMs = (o.durationMin ?? 25) * 60_000
  return (opts, ctx) => {
    clock.advance(durMs)
    const p = paths(opts)
    for (const d of deliverablesFromPrompt(opts.promptFile)) {
      w(join(p.workdir, d), `# deliverable\nmock output (episode ${ctx.episodeNum})\n`)
    }
    w(opts.sentinelFile, "done\n")
    return { status: "completed", durationMs: durMs }
  }
}

/** Hit a rate limit: write no sentinel, return resumeAt. */
export function simRateLimited(clock: SimClock, resumeAfterMin: number): MockBehavior {
  return () => {
    clock.advance(2 * 60_000)
    return {
      status: "rate_limited",
      resumeAt: new Date(clock.now().getTime() + resumeAfterMin * 60_000),
    }
  }
}

export function simTimeout(clock: SimClock, durationMin = 60): MockBehavior {
  return () => {
    clock.advance(durationMin * 60_000)
    return { status: "timeout" }
  }
}

export function simError(clock: SimClock, reason: string, durationMin = 1): MockBehavior {
  return () => {
    clock.advance(durationMin * 60_000)
    return { status: "error", reason }
  }
}

export function simLost(clock: SimClock, reason: string, durationMin = 1): MockBehavior {
  return () => {
    clock.advance(durationMin * 60_000)
    return { status: "lost", reason }
  }
}

/** Context-full: claude TUI signaled context exhaustion. */
export function simContextFull(clock: SimClock, durationMin = 5): MockBehavior {
  return () => {
    clock.advance(durationMin * 60_000)
    return { status: "context_full" }
  }
}

/** Weekly-limit: subscription weekly cap hit. resetInHours is how far out the reset is. */
export function simWeeklyLimited(clock: SimClock, resetInHours: number): MockBehavior {
  return () => {
    clock.advance(2 * 60_000)
    return {
      status: "weekly_limited",
      resumeAt: new Date(clock.now().getTime() + resetInHours * 3600_000),
    }
  }
}

/**
 * Mock Runtime. episodeScript is consumed one at a time; once exhausted, the
 * last one repeats.
 */
export class MockRuntime implements Runtime {
  readonly invocations: InvokeOpts[] = []
  private idx = 0

  constructor(private readonly episodeScript: MockBehavior[]) {
    if (episodeScript.length === 0) throw new Error("MockRuntime: episodeScript must not be empty")
  }

  async invoke(opts: InvokeOpts): Promise<EpisodeResult> {
    this.invocations.push(opts)
    const b = this.episodeScript[Math.min(this.idx, this.episodeScript.length - 1)]!
    this.idx++
    return b(opts, { episodeNum: this.idx })
  }

  /** Number of episode invokes run so far. */
  get episodeCalls(): number {
    return this.idx
  }
}
