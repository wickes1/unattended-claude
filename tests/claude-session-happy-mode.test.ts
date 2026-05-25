/**
 * F01 — Happy-mode session-id discovery integration tests.
 *
 * Verifies runClaudeSession's dual-mode behavior:
 *   - bin=happy, first launch → calls discoverViaStatus, EpisodeResult carries
 *     the discovered UUID
 *   - bin=happy, resume       → does NOT call discoverViaStatus (UUID already on state)
 *   - bin=claude, first launch → does NOT call discoverViaStatus (--session-id works)
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimClock } from "../src/clock.ts"
import { MemoryLogger } from "../src/logger.ts"
import { runClaudeSession, type ZellijOps } from "../src/runtime/claude-session.ts"
import type { InvokeOpts } from "../src/types.ts"
import { testConfig } from "./helpers.ts"

interface Call {
  fn: string
  args: unknown[]
}

const STATUS_PANEL_TEXT = `
  Version:          2.1.150
  Session ID:       4765a36e-0e9f-4b09-9779-8f185d20ac6b
  cwd:              /tmp/wd
  Login method:     Claude Max account
`.trim()

const DISCOVERED_UUID = "4765a36e-0e9f-4b09-9779-8f185d20ac6b"

function fakeZellij(opts: {
  captureScript?: (callIdx: number) => string
} = {}): { z: ZellijOps; calls: Call[] } {
  const calls: Call[] = []
  let captureIdx = 0
  let pendingPasteContent = ""
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
    async pasteFileNoSubmit(s, t, file) {
      calls.push({ fn: "pasteFileNoSubmit", args: [s, t, file] })
      try { pendingPasteContent = readFileSync(file, "utf8") } catch { /* fine */ }
    },
    async submitInput(s, t) {
      calls.push({ fn: "submitInput", args: [s, t] })
      pendingPasteContent = ""
    },
    async pipePane(s, t, file) {
      calls.push({ fn: "pipePane", args: [s, t, file] })
    },
    async capture(s, t, lines) {
      const idx = captureIdx++
      const scripted = opts.captureScript ? opts.captureScript(idx) : "❯ "
      const text = pendingPasteContent ? `${scripted}\n${pendingPasteContent}` : scripted
      calls.push({ fn: "capture", args: [s, t, lines, text] })
      return text
    },
    async sessionAlive() {
      return true
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

describe("runClaudeSession: bin=happy first launch", () => {
  test("calls discoverViaStatus and attaches discoveredSessionId to result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-happy-discover-"))
    try {
      const sentinel = join(dir, "done")
      const promptFile = join(dir, "prompt.md")
      writeFileSync(promptFile, "do the thing")
      // Scripted captures:
      //   0   : handleDialogs → "❯ " (input prompt detected; followed by a
      //         5s settle sleep inside handleDialogs before returning, which
      //         under SimClock does NOT block test wall-clock time).
      //   1+  : discoverViaStatus → STATUS_PANEL_TEXT (parses UUID immediately)
      //   later: pollUntilDone → "❯ " until sentinel appears
      const { z, calls } = fakeZellij({
        captureScript: (i) => {
          if (i === 0) return "❯ " // dialog check (settle sleep runs after)
          if (i === 1) return STATUS_PANEL_TEXT // first capture inside discoverViaStatus
          if (i >= 4) writeFileSync(sentinel, "done\n")
          return "❯ "
        },
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      const cfg = testConfig() // bin=happy
      const result = await runClaudeSession(
        makeOpts({ sentinelFile: sentinel, promptFile, resume: false }),
        cfg,
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      expect(result.discoveredSessionId).toBe(DISCOVERED_UUID)
      // /status was injected
      const slashStatus = calls.find(
        (c) => c.fn === "sendText" && /^\/status/.test(String(c.args[2])),
      )
      expect(slashStatus).toBeDefined()
      // Esc was sent to dismiss the panel
      const esc = calls.find((c) => c.fn === "sendKeys" && c.args[2] === "Esc")
      expect(esc).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("discovery failure → warn logged, task continues without UUID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-happy-fail-"))
    try {
      const sentinel = join(dir, "done")
      const promptFile = join(dir, "prompt.md")
      writeFileSync(promptFile, "do the thing")
      // Touch the sentinel right away so pollUntilDone exits "completed" on
      // first poll — we want the test to exercise the discovery branch, not
      // the detection loop.
      writeFileSync(sentinel, "")
      const { z } = fakeZellij({
        // captureScript always returns input prompt, no Session ID present →
        // discoverViaStatus will time out.
        captureScript: () => "❯ ",
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      const cfg = testConfig()
      const result = await runClaudeSession(
        makeOpts({ sentinelFile: sentinel, promptFile, resume: false, timeoutMs: 5000 }),
        cfg,
        log,
        clock,
        z,
      )
      // Task should NOT fail on discovery timeout — it should proceed and
      // complete, with the failure surfaced via a warn log entry.
      expect(result.status).not.toBe("error")
      expect(log.has("warn", "session-id discovery failed")).toBe(true)
      // No UUID was discovered → result carries null/undefined discoveredSessionId.
      if (result.status === "completed") {
        expect(result.discoveredSessionId ?? null).toBeNull()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("runClaudeSession: bin=happy resume", () => {
  test("does NOT call discoverViaStatus (no /status injection)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-happy-resume-"))
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
      const cfg = testConfig()
      const result = await runClaudeSession(
        makeOpts({
          sentinelFile: sentinel,
          promptFile,
          resume: true,
          claudeSessionId: DISCOVERED_UUID,
          wakeUpPrompt: "continuing",
        }),
        cfg,
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      // No /status was sent — bin=happy resume skips discovery.
      const slashStatus = calls.find(
        (c) => c.fn === "sendText" && /^\/status/.test(String(c.args[2])),
      )
      expect(slashStatus).toBeUndefined()
      // No discoveredSessionId field on result.
      expect(result.discoveredSessionId).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("runClaudeSession: bin=claude first launch", () => {
  test("does NOT call discoverViaStatus (--session-id flows through)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-claude-first-"))
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
      const cfg = testConfig({
        runtime: { bin: "claude", extraArgs: [] },
      })
      const result = await runClaudeSession(
        makeOpts({ sentinelFile: sentinel, promptFile, resume: false }),
        cfg,
        log,
        clock,
        z,
      )
      expect(result.status).toBe("completed")
      const slashStatus = calls.find(
        (c) => c.fn === "sendText" && /^\/status/.test(String(c.args[2])),
      )
      expect(slashStatus).toBeUndefined()
      expect(result.discoveredSessionId).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
