/** Episode-loop tests — one per EpisodeResult status, plus helpers. */
import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimClock } from "../src/clock.ts"
import { readEvents } from "../src/events.ts"
import { Layout } from "../src/layout.ts"
import { MemoryLogger } from "../src/logger.ts"
import {
  applyResult,
  buildInvokeOpts,
  type EpisodeCtx,
  runEpisode,
} from "../src/orchestrator/episode.ts"
import { RateLimitGate, WeeklyLimitGate } from "../src/orchestrator/rate-limit.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"
import {
  MockRuntime,
  simComplete,
  simContextFull,
  simError,
  simLost,
  simRateLimited,
  simTimeout,
  simWeeklyLimited,
} from "../src/runtime/mock-runtime.ts"
import type { TaskDoc } from "../src/types.ts"

const TASK_ID = "2026-05-23-01-foo"
const SESSION_ID = "00000000-0000-0000-0000-000000000001"

interface Setup {
  dir: string
  layout: Layout
  clock: SimClock
  log: MemoryLogger
  store: TaskStateStore
  rateLimitGate: RateLimitGate
  weeklyLimitGate: WeeklyLimitGate
  task: TaskDoc
  promptFile: string
}

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), "ucl-episode-"))
  const layout = new Layout(dir)
  const clock = new SimClock(new Date("2026-05-23T22:30:00.000Z"))
  const log = new MemoryLogger()
  const store = new TaskStateStore(layout)
  const rateLimitGate = new RateLimitGate()
  const weeklyLimitGate = new WeeklyLimitGate(layout)
  const workdir = layout.taskWorkdir(TASK_ID)
  store.init(TASK_ID, workdir, SESSION_ID)
  const task: TaskDoc = {
    id: TASK_ID,
    title: "Foo",
    workdir,
    serial: false,
    file: layout.taskDocFile(TASK_ID),
  }
  const promptFile = join(dir, "prompt.md")
  return { dir, layout, clock, log, store, rateLimitGate, weeklyLimitGate, task, promptFile }
}

function makeCtx(s: Setup, runtime: MockRuntime, over: Partial<EpisodeCtx> = {}): EpisodeCtx {
  return {
    runtime,
    layout: s.layout,
    log: s.log,
    clock: s.clock,
    store: s.store,
    rateLimitGate: s.rateLimitGate,
    weeklyLimitGate: s.weeklyLimitGate,
    windowEndsAt: null,
    windDownLeadMs: 5 * 60_000,
    parentSession: "ucl-test",
    contextCompactThreshold: 150_000,
    ...over,
  }
}

// ── Per-status result tests ──────────────────────────────────────────

describe("applyResult: completed", () => {
  it("transitions state to done, increments episode, writes task_done event", async () => {
    const s = setup()
    const runtime = new MockRuntime([simComplete(s.clock, { durationMin: 1 })])
    const ctx = makeCtx(s, runtime)
    const result = await runEpisode(s.task, s.store.load(TASK_ID)!, ctx, s.promptFile, null)
    expect(result.status).toBe("completed")

    await applyResult(s.task, result, ctx)

    const after = s.store.load(TASK_ID)!
    expect(after.state).toBe("done")
    expect(after.paused_reason).toBeNull()
    expect(after.current_episode).toBe(1)

    const events = readEvents(s.layout)
    const done = events.find((e) => e.event === "task_done")
    expect(done).toBeDefined()
    expect((done as { task: string }).task).toBe(TASK_ID)
    expect((done as { episode: number }).episode).toBe(1)
  })
})

describe("applyResult: rate_limited", () => {
  it("pauses with rate-limit-5h, trips RateLimitGate, writes rate_limit + task_paused events", async () => {
    const s = setup()
    const runtime = new MockRuntime([simRateLimited(s.clock, 300)]) // 300 min
    const ctx = makeCtx(s, runtime)
    const result = await runEpisode(s.task, s.store.load(TASK_ID)!, ctx, s.promptFile, null)
    expect(result.status).toBe("rate_limited")

    await applyResult(s.task, result, ctx)

    const after = s.store.load(TASK_ID)!
    expect(after.state).toBe("paused")
    expect(after.paused_reason).toBe("rate-limit-5h")
    expect(after.current_episode).toBe(1)

    // Gate tripped to the same time the result carried.
    expect(s.rateLimitGate.resumeAt).not.toBeNull()
    if (result.status === "rate_limited") {
      expect(s.rateLimitGate.resumeAt!.getTime()).toBe(result.resumeAt.getTime())
    }

    const events = readEvents(s.layout)
    const rl = events.find((e) => e.event === "rate_limit")
    const paused = events.find((e) => e.event === "task_paused")
    expect(rl).toBeDefined()
    expect(paused).toBeDefined()
    expect((paused as { reason: string }).reason).toBe("rate-limit-5h")
  })
})

describe("applyResult: weekly_limited", () => {
  it("pauses with weekly-limit, trips WeeklyLimitGate (file persists), writes weekly_limit + task_paused events", async () => {
    const s = setup()
    const runtime = new MockRuntime([simWeeklyLimited(s.clock, 24)]) // 24h
    const ctx = makeCtx(s, runtime)
    const result = await runEpisode(s.task, s.store.load(TASK_ID)!, ctx, s.promptFile, null)
    expect(result.status).toBe("weekly_limited")

    await applyResult(s.task, result, ctx)

    const after = s.store.load(TASK_ID)!
    expect(after.state).toBe("paused")
    expect(after.paused_reason).toBe("weekly-limit")
    expect(after.current_episode).toBe(1)

    // Weekly-limit gate persists via file.
    expect(existsSync(s.layout.weeklyPausedFile)).toBe(true)
    if (result.status === "weekly_limited") {
      expect(s.weeklyLimitGate.pausedUntil()!.getTime()).toBe(result.resumeAt.getTime())
    }

    const events = readEvents(s.layout)
    const wl = events.find((e) => e.event === "weekly_limit")
    const paused = events.find((e) => e.event === "task_paused")
    expect(wl).toBeDefined()
    expect(paused).toBeDefined()
    expect((paused as { reason: string }).reason).toBe("weekly-limit")
  })
})

describe("applyResult: context_full", () => {
  it("regenerates claude_session_id, increments context_compactions, pauses with context-full", async () => {
    const s = setup()
    const runtime = new MockRuntime([simContextFull(s.clock)])
    const ctx = makeCtx(s, runtime)
    const before = s.store.load(TASK_ID)!
    expect(before.claude_session_id).toBe(SESSION_ID)
    expect(before.context_compactions).toBe(0)

    const result = await runEpisode(s.task, before, ctx, s.promptFile, null)
    expect(result.status).toBe("context_full")

    await applyResult(s.task, result, ctx)

    const after = s.store.load(TASK_ID)!
    expect(after.state).toBe("paused")
    expect(after.paused_reason).toBe("context-full")
    expect(after.current_episode).toBe(1)
    expect(after.context_compactions).toBe(1)
    // Session id was regenerated.
    expect(after.claude_session_id).not.toBe(SESSION_ID)
    // Looks like a UUID.
    expect(after.claude_session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    const events = readEvents(s.layout)
    const cc = events.find((e) => e.event === "context_compaction")
    const paused = events.find((e) => e.event === "task_paused")
    expect(cc).toBeDefined()
    expect(paused).toBeDefined()
    expect((paused as { reason: string }).reason).toBe("context-full")
  })
})

describe("applyResult: timeout", () => {
  it("fails the task and writes task_failed with reason 'timeout'", async () => {
    const s = setup()
    const runtime = new MockRuntime([simTimeout(s.clock, 1)])
    const ctx = makeCtx(s, runtime)
    const result = await runEpisode(s.task, s.store.load(TASK_ID)!, ctx, s.promptFile, null)
    expect(result.status).toBe("timeout")

    await applyResult(s.task, result, ctx)

    const after = s.store.load(TASK_ID)!
    expect(after.state).toBe("failed")
    expect(after.paused_reason).toBeNull()
    expect(after.current_episode).toBe(1)

    const events = readEvents(s.layout)
    const failed = events.find((e) => e.event === "task_failed")
    expect(failed).toBeDefined()
    expect((failed as { reason: string }).reason).toBe("timeout")
  })
})

describe("applyResult: error", () => {
  it("fails the task and writes task_failed with the error reason", async () => {
    const s = setup()
    const runtime = new MockRuntime([simError(s.clock, "boom", 1)])
    const ctx = makeCtx(s, runtime)
    const result = await runEpisode(s.task, s.store.load(TASK_ID)!, ctx, s.promptFile, null)
    expect(result.status).toBe("error")

    await applyResult(s.task, result, ctx)

    const after = s.store.load(TASK_ID)!
    expect(after.state).toBe("failed")
    expect(after.current_episode).toBe(1)

    const events = readEvents(s.layout)
    const failed = events.find((e) => e.event === "task_failed")
    expect(failed).toBeDefined()
    expect((failed as { reason: string }).reason).toBe("boom")
  })
})

describe("applyResult: lost", () => {
  it("fails the task and writes task_failed with the lost reason", async () => {
    const s = setup()
    const runtime = new MockRuntime([simLost(s.clock, "vanished", 1)])
    const ctx = makeCtx(s, runtime)
    const result = await runEpisode(s.task, s.store.load(TASK_ID)!, ctx, s.promptFile, null)
    expect(result.status).toBe("lost")

    await applyResult(s.task, result, ctx)

    const after = s.store.load(TASK_ID)!
    expect(after.state).toBe("failed")
    expect(after.current_episode).toBe(1)

    const events = readEvents(s.layout)
    const failed = events.find((e) => e.event === "task_failed")
    expect(failed).toBeDefined()
    expect((failed as { reason: string }).reason).toBe("vanished")
  })
})

// ── F01: discoveredSessionId persistence ─────────────────────────────

describe("applyResult: discoveredSessionId (F01 Happy mode)", () => {
  it("persists discoveredSessionId onto TaskRuntimeState.claude_session_id", async () => {
    const s = setup()
    const DISCOVERED = "4765a36e-0e9f-4b09-9779-8f185d20ac6b"
    const runtime = new MockRuntime([
      (opts) => {
        // Mimic happy first-launch result.
        const sentinelPath = opts.sentinelFile
        // No file write needed for applyResult test; we hand-craft the result.
        void sentinelPath
        s.clock.advance(60_000)
        return {
          status: "completed",
          durationMs: 60_000,
          discoveredSessionId: DISCOVERED,
        }
      },
    ])
    const ctx = makeCtx(s, runtime)

    const before = s.store.load(TASK_ID)!
    expect(before.claude_session_id).toBe(SESSION_ID)

    const result = await runEpisode(s.task, before, ctx, s.promptFile, null)
    expect(result.status).toBe("completed")
    expect(result.discoveredSessionId).toBe(DISCOVERED)

    await applyResult(s.task, result, ctx)

    const after = s.store.load(TASK_ID)!
    expect(after.claude_session_id).toBe(DISCOVERED)
    expect(after.state).toBe("done")
  })

  it("leaves claude_session_id unchanged when discoveredSessionId is absent", async () => {
    const s = setup()
    const runtime = new MockRuntime([simComplete(s.clock, { durationMin: 1 })])
    const ctx = makeCtx(s, runtime)

    const result = await runEpisode(s.task, s.store.load(TASK_ID)!, ctx, s.promptFile, null)
    await applyResult(s.task, result, ctx)

    const after = s.store.load(TASK_ID)!
    expect(after.claude_session_id).toBe(SESSION_ID)
  })
})

// ── Helper tests ─────────────────────────────────────────────────────

describe("buildInvokeOpts: resume flag", () => {
  it("resume=false for first episode (current_episode=0); resume=true for later episodes", () => {
    const s = setup()
    const runtime = new MockRuntime([simComplete(s.clock)])
    const ctx = makeCtx(s, runtime)

    const state0 = s.store.load(TASK_ID)!
    const opts0 = buildInvokeOpts(
      s.task,
      state0,
      ctx,
      s.promptFile,
      "/tmp/sentinel-1",
      "/tmp/log-1",
      null,
    )
    expect(opts0.resume).toBe(false)

    // Pretend the task has run once.
    const state1 = { ...state0, current_episode: 1 }
    const opts1 = buildInvokeOpts(
      s.task,
      state1,
      ctx,
      s.promptFile,
      "/tmp/sentinel-2",
      "/tmp/log-2",
      null,
    )
    expect(opts1.resume).toBe(true)
  })
})

describe("buildInvokeOpts: windDownAt", () => {
  it("windDownAt = windowEndsAt - windDownLeadMs when window set; null when window null", () => {
    const s = setup()
    const runtime = new MockRuntime([simComplete(s.clock)])
    const windowEndsAt = new Date("2026-05-24T07:00:00.000Z")
    const ctx = makeCtx(s, runtime, { windowEndsAt, windDownLeadMs: 5 * 60_000 })

    const state = s.store.load(TASK_ID)!
    const opts = buildInvokeOpts(
      s.task,
      state,
      ctx,
      s.promptFile,
      "/tmp/sentinel-1",
      "/tmp/log-1",
      null,
    )
    expect(opts.windDownAt).not.toBeNull()
    expect(opts.windDownAt!.getTime()).toBe(windowEndsAt.getTime() - 5 * 60_000)

    // With no window: null.
    const ctx2 = makeCtx(s, runtime, { windowEndsAt: null })
    const opts2 = buildInvokeOpts(
      s.task,
      state,
      ctx2,
      s.promptFile,
      "/tmp/sentinel-1",
      "/tmp/log-1",
      null,
    )
    expect(opts2.windDownAt).toBeNull()
  })
})

describe("runEpisode: task_started event", () => {
  it("writes task_started event with resumed=false on first episode", async () => {
    const s = setup()
    const runtime = new MockRuntime([simComplete(s.clock)])
    const ctx = makeCtx(s, runtime)

    await runEpisode(s.task, s.store.load(TASK_ID)!, ctx, s.promptFile, null)

    const events = readEvents(s.layout)
    const started = events.find((e) => e.event === "task_started")
    expect(started).toBeDefined()
    expect((started as { task: string }).task).toBe(TASK_ID)
    expect((started as { episode: number }).episode).toBe(1)
    expect((started as { resumed: boolean }).resumed).toBe(false)
  })

  it("writes task_started event with resumed=true when current_episode > 0", async () => {
    const s = setup()
    const runtime = new MockRuntime([simComplete(s.clock)])
    const ctx = makeCtx(s, runtime)

    // Simulate an already-resumed state.
    await s.store.update(TASK_ID, (st) => {
      st.current_episode = 2
    })

    await runEpisode(s.task, s.store.load(TASK_ID)!, ctx, s.promptFile, null)

    const events = readEvents(s.layout)
    const started = events.find((e) => e.event === "task_started")
    expect(started).toBeDefined()
    expect((started as { episode: number }).episode).toBe(3)
    expect((started as { resumed: boolean }).resumed).toBe(true)
  })
})
