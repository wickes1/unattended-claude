/**
 * session-discovery.ts — unit tests.
 *
 * Verifies the /status-based session UUID discovery path used for Happy mode
 * (Happy 1.1.8 swallows --session-id; we must read claude's UUID back from
 * the TUI's /status panel instead).
 */
import { describe, expect, test } from "bun:test"
import { SimClock } from "../src/clock.ts"
import { MemoryLogger } from "../src/logger.ts"
import { discoverViaStatus } from "../src/runtime/session-discovery.ts"
import type { ZellijOps } from "../src/runtime/claude-session.ts"

/** Recorded zellij call — name + args (mirrors claude-session.test.ts). */
interface Call {
  fn: string
  args: unknown[]
}

function fakeZellij(opts: {
  captureScript?: (callIdx: number) => string
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
    async pasteFileNoSubmit(s, t, file) {
      calls.push({ fn: "pasteFileNoSubmit", args: [s, t, file] })
    },
    async submitInput(s, t) {
      calls.push({ fn: "submitInput", args: [s, t] })
    },
    async pipePane(s, t, file) {
      calls.push({ fn: "pipePane", args: [s, t, file] })
    },
    async capture(s, t, lines) {
      const idx = captureIdx++
      const text = opts.captureScript ? opts.captureScript(idx) : ""
      calls.push({ fn: "capture", args: [s, t, lines, text] })
      return text
    },
    async sessionAlive() {
      return true
    },
  }
  return { z, calls }
}

const STATUS_PANEL_TEXT = `
  Version:          2.1.150
  Session ID:       4765a36e-0e9f-4b09-9779-8f185d20ac6b
  cwd:              /tmp/test-workdir
  Login method:     Claude Max account
`.trim()

describe("discoverViaStatus — happy path", () => {
  test("parses Session ID from canonical /status panel text", async () => {
    const { z, calls } = fakeZellij({ captureScript: () => STATUS_PANEL_TEXT })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    const uuid = await discoverViaStatus(z, "ucl", "task-1", clock, log)
    expect(uuid).toBe("4765a36e-0e9f-4b09-9779-8f185d20ac6b")
    // /status was injected
    const slashStatus = calls.find(
      (c) => c.fn === "sendText" && /^\/status/.test(String(c.args[2])),
    )
    expect(slashStatus).toBeDefined()
    // capture was called (at least once)
    expect(calls.some((c) => c.fn === "capture")).toBe(true)
  })

  test("dismisses the panel with Esc after parse success", async () => {
    const { z, calls } = fakeZellij({ captureScript: () => STATUS_PANEL_TEXT })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    await discoverViaStatus(z, "ucl", "task-1", clock, log)
    const escCall = calls.find((c) => c.fn === "sendKeys" && c.args[2] === "Esc")
    expect(escCall).toBeDefined()
  })
})

describe("discoverViaStatus — ANSI handling", () => {
  test("strips ANSI escape codes before parsing", async () => {
    const ansiText = `
  \x1b[1mVersion:\x1b[0m          2.1.150
  \x1b[33mSession ID:\x1b[0m       4765a36e-0e9f-4b09-9779-8f185d20ac6b
  cwd:              /tmp/test-workdir
`.trim()
    const { z } = fakeZellij({ captureScript: () => ansiText })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    const uuid = await discoverViaStatus(z, "ucl", "task-1", clock, log)
    expect(uuid).toBe("4765a36e-0e9f-4b09-9779-8f185d20ac6b")
  })
})

describe("discoverViaStatus — defensive parsing", () => {
  test("returns the first UUID when multiple Session ID lines appear", async () => {
    const text = `
  Session ID:       11111111-2222-3333-4444-555555555555
  Some unrelated text
  Session ID:       aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
`.trim()
    const { z } = fakeZellij({ captureScript: () => text })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    const uuid = await discoverViaStatus(z, "ucl", "task-1", clock, log)
    expect(uuid).toBe("11111111-2222-3333-4444-555555555555")
  })

  test("rejects a truncated UUID and keeps polling until timeout", async () => {
    // Each capture returns the same malformed text; we must time out.
    const text = "Session ID:       4765a36e-0e9f-4b09-XXXX"
    const { z } = fakeZellij({ captureScript: () => text })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    await expect(
      discoverViaStatus(z, "ucl", "task-1", clock, log, 2000),
    ).rejects.toThrow(/session.?id/i)
  })

  test("does not parse a UUID on a different line from the Session ID label", async () => {
    // UUID is two lines below the label — must NOT be accepted.
    const text = `
  Session ID:
  some intervening text
  4765a36e-0e9f-4b09-9779-8f185d20ac6b
`.trim()
    const { z } = fakeZellij({ captureScript: () => text })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    await expect(
      discoverViaStatus(z, "ucl", "task-1", clock, log, 2000),
    ).rejects.toThrow(/session.?id/i)
  })
})

describe("discoverViaStatus — timeout", () => {
  test("throws when /status output never contains a UUID", async () => {
    const { z } = fakeZellij({ captureScript: () => "no UUID here\n❯ " })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    await expect(
      discoverViaStatus(z, "ucl", "task-1", clock, log, 1500),
    ).rejects.toThrow()
  })

  test("throws when capturePane always returns empty", async () => {
    const { z } = fakeZellij({ captureScript: () => "" })
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const log = new MemoryLogger()
    await expect(
      discoverViaStatus(z, "ucl", "task-1", clock, log, 1500),
    ).rejects.toThrow()
  })
})
