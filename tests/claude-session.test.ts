/**
 * claude-session.ts — unit tests.
 *
 * Real zellij is replaced by a FakeZellij so polling logic, wind-down
 * injection, and resume-flag ordering can be verified end-to-end without
 * spawning anything.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimClock } from "../src/clock.ts"
import { MemoryLogger } from "../src/logger.ts"
import {
  buildLaunchCommand,
  pollUntilDone,
  runClaudeSession,
  WIND_DOWN_PROMPT,
  type ZellijOps,
} from "../src/runtime/claude-session.ts"
import type { InvokeOpts } from "../src/types.ts"
import { testConfig } from "./helpers.ts"

/** Recorded zellij call — name + args. */
interface Call {
  fn: string
  args: unknown[]
}

/**
 * Fake ZellijOps for testing. `captureScript` is a function that returns the
 * pane text per call — usually scripted by index. sessionAlive returns true
 * unless overridden.
 */
function fakeZellij(opts: {
  captureScript?: (callIdx: number) => string
  sessionAlive?: () => boolean
} = {}): { z: ZellijOps; calls: Call[] } {
  const calls: Call[] = []
  let captureIdx = 0
  const z: ZellijOps = {
    async newTab(s, t) {
      calls.push({ fn: "newTab", args: [s, t] })
    },
    async closeTab(s, t) {
      calls.push({ fn: "closeTab", args: [s, t] })
    },
    async sendKeys(s, t, ...keys) {
      calls.push({ fn: "sendKeys", args: [s, t, ...keys] })
    },
    async sendText(s, t, text) {
      calls.push({ fn: "sendText", args: [s, t, text] })
    },
    async pasteFile(s, t, file) {
      calls.push({ fn: "pasteFile", args: [s, t, file] })
    },
    async pipePane(s, t, file) {
      calls.push({ fn: "pipePane", args: [s, t, file] })
    },
    async capture(s, t, lines) {
      const idx = captureIdx++
      const text = opts.captureScript ? opts.captureScript(idx) : "❯ "
      calls.push({ fn: "capture", args: [s, t, lines, text] })
      return text
    },
    async sessionAlive() {
      return opts.sessionAlive ? opts.sessionAlive() : true
    },
  }
  return { z, calls }
}

function makeOpts(over: Partial<InvokeOpts> = {}): InvokeOpts {
  return {
    workdir: "/tmp/wd",
    promptFile: "/tmp/prompt.md",
    sentinelFile: "/tmp/state/episode.done",
    timeoutMs: 60_000,
    parentSession: "ucl",
    tabName: "task-1",
    rawLogFile: "/tmp/raw.log",
    claudeSessionId: "abc-123",
    resume: false,
    windDownAt: null,
    wakeUpPrompt: null,
    handoffPath: "/tmp/handoff.md",
    handoffTimeoutMs: 120_000,
    ...over,
  }
}

// ── buildLaunchCommand ──────────────────────────────────────────────

describe("buildLaunchCommand", () => {
  // F01 truth table — bin × mode (4 cases).
  test("bin=happy first launch: NO --session-id (Happy 1.1.8 swallows it)", () => {
    const cfg = testConfig() // bin=happy, extraArgs=["--dangerously-skip-permissions"]
    const opts = makeOpts({ claudeSessionId: "abc-123", resume: false })
    expect(buildLaunchCommand(cfg, opts)).toBe(
      "happy --dangerously-skip-permissions",
    )
  })

  test("bin=happy resume: --resume <uuid> (Happy forwards --resume)", () => {
    const cfg = testConfig()
    const opts = makeOpts({ claudeSessionId: "abc-123", resume: true })
    expect(buildLaunchCommand(cfg, opts)).toBe(
      "happy --resume abc-123 --dangerously-skip-permissions",
    )
  })

  test("bin=claude first launch: --session-id <uuid> + extra args", () => {
    const cfg = testConfig({
      runtime: { bin: "claude", extraArgs: ["--dangerously-skip-permissions"] },
    })
    const opts = makeOpts({ claudeSessionId: "uuid-1", resume: false })
    expect(buildLaunchCommand(cfg, opts)).toBe(
      "claude --session-id uuid-1 --dangerously-skip-permissions",
    )
  })

  test("bin=claude resume: --resume <uuid> + extra args", () => {
    const cfg = testConfig({
      runtime: { bin: "claude", extraArgs: ["--dangerously-skip-permissions"] },
    })
    const opts = makeOpts({ claudeSessionId: "uuid-1", resume: true })
    expect(buildLaunchCommand(cfg, opts)).toBe(
      "claude --resume uuid-1 --dangerously-skip-permissions",
    )
  })

  test("empty extraArgs (bin=claude): just bin + session flag", () => {
    const cfg = testConfig({
      runtime: { bin: "claude", extraArgs: [] },
    })
    const opts = makeOpts({ claudeSessionId: "uuid-1", resume: false })
    expect(buildLaunchCommand(cfg, opts)).toBe("claude --session-id uuid-1")
  })

  test("empty extraArgs (bin=happy first launch): just bin", () => {
    const cfg = testConfig({
      runtime: { bin: "happy", extraArgs: [] },
    })
    const opts = makeOpts({ claudeSessionId: "abc-123", resume: false })
    expect(buildLaunchCommand(cfg, opts)).toBe("happy")
  })
})

// ── pollUntilDone ───────────────────────────────────────────────────

describe("pollUntilDone — detection priorities", () => {
  test("detects context-full and returns {status: 'context_full'}", async () => {
    const { z } = fakeZellij({
      captureScript: () => "Conversation too long. /compact to continue.\n❯ ",
    })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    const cfg = testConfig()
    // Tiny handoffTimeoutMs so the context-full write path falls through
    // quickly without producing the file or READY. Status flag is the
    // contract here; handoff details are exercised in tests/handoff.test.ts.
    const result = await pollUntilDone(
      makeOpts({ handoffTimeoutMs: 50 }),
      cfg,
      log,
      clock,
      z,
    )
    expect(result.status).toBe("context_full")
  })

  test("weekly limit beats rate limit when both phrases present", async () => {
    // Weekly limit must take priority because the wait is much longer.
    const { z } = fakeZellij({
      captureScript: () =>
        "Weekly limit reached · resets Oct 9 at 10:30am\nYou've reached your usage limit. Try again at 3:00 PM",
    })
    const clock = new SimClock(new Date(2026, 9, 5, 0, 0, 0)) // Oct 5 2026
    const log = new MemoryLogger()
    const cfg = testConfig()
    const result = await pollUntilDone(makeOpts(), cfg, log, clock, z)
    expect(result.status).toBe("weekly_limited")
    if (result.status === "weekly_limited") {
      expect(result.resumeAt).toEqual(new Date(2026, 9, 9, 10, 30, 0))
    }
  })

  test("session-death returns {status: 'lost'}", async () => {
    const { z } = fakeZellij({ sessionAlive: () => false })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    const result = await pollUntilDone(makeOpts(), testConfig(), log, clock, z)
    expect(result.status).toBe("lost")
    if (result.status === "lost") {
      expect(result.reason).toMatch(/zellij session died/)
    }
  })

  test("sentinel file present → completed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-poll-"))
    try {
      const sentinel = join(dir, "done")
      writeFileSync(sentinel, "done\n")
      const { z } = fakeZellij({ captureScript: () => "some normal output\n❯ " })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      const result = await pollUntilDone(
        makeOpts({ sentinelFile: sentinel }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("pollUntilDone — wind-down injection", () => {
  test("injects WIND_DOWN_PROMPT exactly once at windDownAt", async () => {
    const start = new Date("2026-05-23T00:00:00Z")
    // Wind-down kicks in 1.5s into the polling loop.
    const windDownAt = new Date(start.getTime() + 1500)
    // sentinel appears after 5 capture polls so we keep iterating past wind-down.
    const dir = mkdtempSync(join(tmpdir(), "ucl-winddown-"))
    try {
      const sentinel = join(dir, "done")
      const { z, calls } = fakeZellij({
        captureScript: (i) => {
          // Write sentinel on the 5th capture so the loop exits after wind-down + more ticks.
          if (i === 5) writeFileSync(sentinel, "done\n")
          return "normal output\n❯ "
        },
      })
      const clock = new SimClock(start)
      const log = new MemoryLogger()
      const result = await pollUntilDone(
        makeOpts({ sentinelFile: sentinel, windDownAt, timeoutMs: 60_000 }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      const windDownCalls = calls.filter(
        (c) => c.fn === "sendText" && c.args[2] === WIND_DOWN_PROMPT,
      )
      expect(windDownCalls.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("never injects WIND_DOWN_PROMPT when windDownAt is null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-winddown-null-"))
    try {
      const sentinel = join(dir, "done")
      const { z, calls } = fakeZellij({
        captureScript: (i) => {
          if (i === 3) writeFileSync(sentinel, "done\n")
          return "normal output\n❯ "
        },
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      const result = await pollUntilDone(
        makeOpts({ sentinelFile: sentinel, windDownAt: null }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      const windDownCalls = calls.filter(
        (c) => c.fn === "sendText" && c.args[2] === WIND_DOWN_PROMPT,
      )
      expect(windDownCalls.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // F05: pollUntilDone must report wind-down injection back to applyResult so
  // a wind_down_injected event can be appended to events.jsonl. The injection
  // itself was already covered above; here we pin the result-side contract.
  test("result.windDownInjected is populated when wind-down fires", async () => {
    const start = new Date("2026-05-23T00:00:00Z")
    const windDownAt = new Date(start.getTime() + 1500)
    const dir = mkdtempSync(join(tmpdir(), "ucl-winddown-result-"))
    try {
      const sentinel = join(dir, "done")
      const { z } = fakeZellij({
        captureScript: (i) => {
          if (i === 5) writeFileSync(sentinel, "done\n")
          return "normal output\n❯ "
        },
      })
      const clock = new SimClock(start)
      const log = new MemoryLogger()
      const result = await pollUntilDone(
        makeOpts({ sentinelFile: sentinel, windDownAt, timeoutMs: 60_000 }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      expect(result.windDownInjected).not.toBeNull()
      expect(result.windDownInjected).toBeDefined()
      // Boundary was 1500ms after start; injection lands on a tick that has
      // SimClock at >= boundary. The lag in minutes is round((-elapsed)/60_000)
      // — for this short test that's effectively 0.
      expect(
        typeof result.windDownInjected?.atMinutesBeforeBoundary,
      ).toBe("number")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("result.windDownInjected is null when wind-down never fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-winddown-null-result-"))
    try {
      const sentinel = join(dir, "done")
      const { z } = fakeZellij({
        captureScript: (i) => {
          if (i === 3) writeFileSync(sentinel, "done\n")
          return "normal output\n❯ "
        },
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      const result = await pollUntilDone(
        makeOpts({ sentinelFile: sentinel, windDownAt: null }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      expect(result.windDownInjected).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── pollUntilDone — SimClock-driven timing (F03) ────────────────────
//
// These tests prove that every flow-control time reference in
// pollUntilDone routes through the injected Clock — so SimClock can
// fast-forward virtual time deterministically and we never have to wait
// real wall-clock seconds in CI. Each test would have hung or returned
// the wrong status before F03 (when Date.now() was used directly).

describe("pollUntilDone — clock-driven timing (F03)", () => {
  test("inactivity at input prompt: SimClock fast-forward → completed", async () => {
    // Stable input-prompt pane, no recent question → after inactivityTimeoutMs
    // of sim-time elapses (clock advanced by clock.sleep ticks), returns
    // completed via the secondary signal. Before F03 this never fired
    // because the threshold compared real wall-clock to stableSince.
    const { z } = fakeZellij({ captureScript: () => "normal output\n❯ " })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    const cfg = testConfig({
      execution: {
        ...testConfig().execution,
        inactivityTimeoutMs: 5_000, // 5 ticks of clock.sleep(1000)
      },
    })
    const result = await pollUntilDone(
      // Use a sentinel path that never exists so only the inactivity branch
      // can complete. Large timeoutMs so hard-timeout cannot win.
      makeOpts({ sentinelFile: "/tmp/__ucl_test_no_sentinel__", timeoutMs: 60 * 60_000 }),
      cfg,
      log,
      clock,
      z,
    )
    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      // Duration must reflect sim-time elapsed, not real wall time.
      // Minimum: inactivityTimeoutMs (5_000) since stableSince was set on
      // the first tick and we needed >= threshold elapsed since then.
      expect(result.durationMs).toBeGreaterThanOrEqual(5_000)
      // Sanity ceiling: a handful of ticks beyond the threshold.
      expect(result.durationMs).toBeLessThan(20_000)
    }
  })

  test("hard timeout: SimClock advances past timeoutMs while pane keeps changing → timeout", async () => {
    // Pane text changes on every capture so stableSince resets every tick and
    // the inactivity branch can never fire. Only the hard-timeout branch
    // (clock.now() - start >= opts.timeoutMs) can exit the loop. With
    // timeoutMs = 3_000 and clock.sleep(1000) per tick, we expect timeout
    // after ~3 ticks of sim-time. Before F03 this would have waited 3
    // real seconds; now it returns instantly under SimClock.
    const { z } = fakeZellij({ captureScript: (i) => `tick ${i}\n❯ ` })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    const result = await pollUntilDone(
      makeOpts({ sentinelFile: "/tmp/__ucl_test_no_sentinel__", timeoutMs: 3_000 }),
      testConfig(),
      log,
      clock,
      z,
    )
    expect(result.status).toBe("timeout")
    // Sim-time must have advanced by at least the timeoutMs.
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(
      new Date("2026-05-23T00:00:00Z").getTime() + 3_000,
    )
  })

  test("completed durationMs reflects sim-time, not wall-time", async () => {
    // Sentinel-driven completion after exactly N sim-time ticks. Asserts the
    // returned durationMs equals the SimClock-elapsed time (was ~0 before F03
    // because Date.now() barely moved while SimClock ticked).
    const dir = mkdtempSync(join(tmpdir(), "ucl-duration-"))
    try {
      const sentinel = join(dir, "done")
      const { z } = fakeZellij({
        captureScript: (i) => {
          // Write sentinel on the 4th capture (i=3). The loop layout is:
          //   tick 0: capture (i=0) → no sentinel → sleep 1000
          //   tick 1: capture (i=1) → no sentinel → sleep 1000
          //   tick 2: capture (i=2) → no sentinel → sleep 1000
          //   tick 3: capture (i=3) writes sentinel → sentinel check
          //           runs next iteration after sleep 1000 (tick 4 capture).
          // So expected sim-time elapsed when sentinel is observed = 4_000ms.
          if (i === 3) writeFileSync(sentinel, "done\n")
          return "❯ "
        },
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      const result = await pollUntilDone(
        makeOpts({ sentinelFile: sentinel, timeoutMs: 60 * 60_000 }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      if (result.status === "completed") {
        // Duration must equal sim-time, which only advances via clock.sleep.
        // The sentinel is checked on the iteration following its write, so
        // durationMs is a multiple of the 1000ms tick. Loose bounds because
        // the exact tick count depends on capture/sentinel interleaving,
        // but it MUST be far above wall-time (which is <100ms here).
        expect(result.durationMs).toBeGreaterThanOrEqual(3_000)
        expect(result.durationMs).toBeLessThan(20_000)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("wind-down fires exactly at SimClock-driven windDownAt boundary", async () => {
    // Wind-down boundary is 2500ms after start in sim-time. Before that
    // boundary, no WIND_DOWN_PROMPT must be sent. After it, exactly one.
    // Sentinel completes the loop several ticks later.
    const dir = mkdtempSync(join(tmpdir(), "ucl-winddown-sim-"))
    try {
      const sentinel = join(dir, "done")
      const start = new Date("2026-05-23T00:00:00Z")
      const windDownAt = new Date(start.getTime() + 2_500)
      // Track wind-down send order vs capture indices.
      const { z, calls } = fakeZellij({
        captureScript: (i) => {
          // Complete after wind-down has had time to fire.
          if (i >= 6) writeFileSync(sentinel, "done\n")
          return "running...\n❯ "
        },
      })
      const clock = new SimClock(start)
      const log = new MemoryLogger()
      const result = await pollUntilDone(
        makeOpts({ sentinelFile: sentinel, windDownAt, timeoutMs: 60 * 60_000 }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      const windDownCalls = calls.filter(
        (c) => c.fn === "sendText" && c.args[2] === WIND_DOWN_PROMPT,
      )
      expect(windDownCalls.length).toBe(1)
      // The wind-down sendText must be preceded by at least 2 captures
      // (each tick is one capture + one sleep(1000)), proving it didn't
      // fire before the SimClock crossed the 2500ms boundary.
      const windDownIdx = calls.findIndex(
        (c) => c.fn === "sendText" && c.args[2] === WIND_DOWN_PROMPT,
      )
      const capturesBeforeWindDown = calls
        .slice(0, windDownIdx)
        .filter((c) => c.fn === "capture").length
      expect(capturesBeforeWindDown).toBeGreaterThanOrEqual(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── runClaudeSession — ordering of wakeUpPrompt vs promptFile ──────

describe("runClaudeSession — resume ordering", () => {
  test("on resume with wakeUpPrompt: sendText(wakeUp) BEFORE pasteFile(prompt)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-resume-"))
    try {
      const sentinel = join(dir, "done")
      const promptFile = join(dir, "prompt.md")
      writeFileSync(promptFile, "do the thing")
      // Dialog ready immediately; sentinel on 2nd poll-capture.
      const { z, calls } = fakeZellij({
        captureScript: (i) => {
          // capture is called by handleDialogs first, then pollUntilDone.
          // After 2 captures inside polling, write sentinel.
          if (i >= 3) writeFileSync(sentinel, "done\n")
          return "❯ "
        },
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      const result = await runClaudeSession(
        makeOpts({
          sentinelFile: sentinel,
          promptFile,
          resume: true,
          wakeUpPrompt: "RESUMING NOW",
        }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      const wakeIdx = calls.findIndex(
        (c) => c.fn === "sendText" && c.args[2] === "RESUMING NOW",
      )
      const pasteIdx = calls.findIndex((c) => c.fn === "pasteFile")
      expect(wakeIdx).toBeGreaterThan(-1)
      expect(pasteIdx).toBeGreaterThan(-1)
      expect(wakeIdx).toBeLessThan(pasteIdx)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("first launch (resume=false) ignores wakeUpPrompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-firstlaunch-"))
    try {
      const sentinel = join(dir, "done")
      const promptFile = join(dir, "prompt.md")
      writeFileSync(promptFile, "do the thing")
      const { z, calls } = fakeZellij({
        captureScript: (i) => {
          if (i >= 3) writeFileSync(sentinel, "done\n")
          return "❯ "
        },
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      // Use bin=claude so this test stays focused on wakeUpPrompt ordering;
      // happy first launch triggers /status discovery which is covered in
      // tests/claude-session-happy-mode.test.ts.
      const cfg = testConfig({
        runtime: { bin: "claude", extraArgs: ["--dangerously-skip-permissions"] },
      })
      const result = await runClaudeSession(
        makeOpts({
          sentinelFile: sentinel,
          promptFile,
          resume: false,
          wakeUpPrompt: "SHOULD NOT BE SENT",
        }),
        cfg,
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      const wakeCalls = calls.filter(
        (c) => c.fn === "sendText" && c.args[2] === "SHOULD NOT BE SENT",
      )
      expect(wakeCalls.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
