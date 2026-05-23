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
    ...over,
  }
}

// ── buildLaunchCommand ──────────────────────────────────────────────

describe("buildLaunchCommand", () => {
  test("new session: --session-id <uuid> + extra args", () => {
    const cfg = testConfig() // bin=happy, extraArgs=["--dangerously-skip-permissions"]
    const opts = makeOpts({ claudeSessionId: "abc-123", resume: false })
    expect(buildLaunchCommand(cfg, opts)).toBe(
      "happy --session-id abc-123 --dangerously-skip-permissions",
    )
  })

  test("resume: --resume <uuid> + extra args (no --session-id)", () => {
    const cfg = testConfig()
    const opts = makeOpts({ claudeSessionId: "abc-123", resume: true })
    expect(buildLaunchCommand(cfg, opts)).toBe(
      "happy --resume abc-123 --dangerously-skip-permissions",
    )
  })

  test("empty extraArgs: just bin + session flag", () => {
    const cfg = testConfig({
      runtime: { driver: "claude", bin: "claude", extraArgs: [] },
    })
    const opts = makeOpts({ claudeSessionId: "uuid-1", resume: false })
    expect(buildLaunchCommand(cfg, opts)).toBe("claude --session-id uuid-1")
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
    const result = await pollUntilDone(makeOpts(), cfg, log, clock, z)
    expect(result).toEqual({ status: "context_full" })
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
      const result = await runClaudeSession(
        makeOpts({
          sentinelFile: sentinel,
          promptFile,
          resume: false,
          wakeUpPrompt: "SHOULD NOT BE SENT",
        }),
        testConfig(),
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
