/**
 * Layer B integration tests for src/runtime/zellij.ts — spawn a real zellij
 * binary and exercise newSession / newTab / sendText / capture / closeTab /
 * killSession end-to-end.
 *
 * Deferred from T06 (zellij Layer A unit tests covered pure parsers only).
 * Re-introduced as part of F11.
 *
 * The whole suite skips when `zellij` is not on PATH so CI runners without
 * the binary remain green. To force-skip even when zellij is installed
 * (e.g. macOS where socket-dir setup conflicts with a personal zellij
 * session), set `UCL_SKIP_ZELLIJ_INTEGRATION=1`.
 *
 * Each test uses a unique session name (random suffix) so the suite is safe
 * to run in parallel with a developer's own zellij sessions.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testConfig } from "./helpers.ts"
import {
  capture,
  closeTab,
  killSession,
  listSessions,
  newSession,
  newTab,
  parseSessionList,
  pipePane,
  sendText,
  sessionAlive,
  zellijCmd,
} from "../src/runtime/zellij.ts"

const zellijAvailable = Bun.which("zellij") !== null
  && process.env.UCL_SKIP_ZELLIJ_INTEGRATION !== "1"

/** Unique per-suite session prefix; each test appends its own name. */
const SESSION_PREFIX = `ucl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** Track sessions created during the suite so afterAll can sweep them. */
const created: string[] = []

function uniqueSession(label: string): string {
  const name = `${SESSION_PREFIX}-${label}`
  created.push(name)
  return name
}

const cfg = testConfig()

describe.skipIf(!zellijAvailable)("zellij Layer B (integration)", () => {
  beforeAll(() => {
    // Nothing to do — tests own their own sessions.
  })

  afterAll(async () => {
    // Best-effort cleanup so a failing test doesn't leave dangling zellij
    // sessions on a developer's machine.
    for (const name of created) {
      try { await killSession(name) } catch { /* ignore */ }
    }
  })

  test("newSession creates a session listable via list-sessions", async () => {
    const name = uniqueSession("new-session")
    await newSession(name, cfg)
    try {
      expect(await sessionAlive(name)).toBe(true)
      const sessions = await listSessions()
      expect(sessions).toContain(name)
    } finally {
      await killSession(name)
    }
  })

  test("newTab + sendText + capture round-trips the text", async () => {
    const name = uniqueSession("send-capture")
    await newSession(name, cfg)
    try {
      await newTab(name, "t1")
      // Quiesce the shell prompt before sending so the captured buffer is
      // dominated by the echo of our payload rather than terminal noise.
      await new Promise((r) => setTimeout(r, 500))
      const payload = "HELLO-UCL-F11-ECHO-MARKER"
      // Use `echo` so we get a deterministic line we can look for. sendText
      // pastes + Enter; the running shell will echo + print.
      await sendText(name, "t1", `echo ${payload}`)
      // Allow the shell to process and print the output.
      await new Promise((r) => setTimeout(r, 1000))
      const buf = await capture(name, "t1", 200)
      expect(buf).toContain(payload)
    } finally {
      await killSession(name)
    }
  })

  test("closeTab completes without error and leaves the session alive", async () => {
    // NOTE on zellij behavior: `zellij action close-tab` against a headless
    // (background-attached) session does not actually delete the tab from the
    // server's view in zellij 0.44.x — running close-tab in attached interactive
    // mode is required for that side-effect. The Layer B contract this suite
    // actually verifies is that `closeTab()` returns without throwing, drops
    // its in-memory tracking, and leaves the parent session alive (so the next
    // task can still open a tab and the run can continue).
    const name = uniqueSession("close-tab")
    await newSession(name, cfg)
    try {
      await newTab(name, "doomed")
      await new Promise((r) => setTimeout(r, 300))

      const beforeRes = await zellijCmd(["--session", name, "action", "query-tab-names"])
      expect(beforeRes.code).toBe(0)
      expect(beforeRes.stdout).toContain("doomed")

      await closeTab(name, "doomed")
      expect(await sessionAlive(name)).toBe(true)

      // After closeTab the runtime is allowed to forget the tab; re-using the
      // same tab id MUST work (e.g. when the next task happens to have the
      // same id). If closeTab leaked tracking, `newTab` would crash with
      // "unknown tab" on the next capture call.
      await newTab(name, "doomed")
      await new Promise((r) => setTimeout(r, 300))
      // capture proves the new tab is freshly tracked + reachable.
      const buf = await capture(name, "doomed", 50)
      expect(typeof buf).toBe("string")
    } finally {
      await killSession(name)
    }
  })

  test("killSession removes the session from list-sessions", async () => {
    const name = uniqueSession("kill-session")
    await newSession(name, cfg)
    expect(await sessionAlive(name)).toBe(true)

    await killSession(name)
    // After delete-session the name may briefly remain in list-sessions but
    // marked EXITED; sessionAlive returns false in both the "gone" and
    // "EXITED" cases.
    expect(await sessionAlive(name)).toBe(false)
    const r = await zellijCmd(["list-sessions", "--no-formatting"])
    const entry = parseSessionList(r.stdout).find((s) => s.name === name)
    if (entry !== undefined) expect(entry.exited).toBe(true)
  })

  test("pipePane registers a raw-log file that closeTab flushes to disk", async () => {
    const name = uniqueSession("pipe-pane")
    await newSession(name, cfg)
    try {
      await newTab(name, "log")
      const tmpDir = mkdtempSync(join(tmpdir(), "ucl-zellij-pipe-"))
      const logFile = join(tmpDir, "raw.log")
      await pipePane(name, "log", logFile)
      await new Promise((r) => setTimeout(r, 300))
      await sendText(name, "log", "echo PIPED-MARKER-F11")
      await new Promise((r) => setTimeout(r, 800))
      // closeTab takes a final dump-screen snapshot into the registered file.
      await closeTab(name, "log")
      const contents = readFileSync(logFile, "utf8")
      expect(contents).toContain("PIPED-MARKER-F11")
    } finally {
      await killSession(name)
    }
  })
})

// When zellij is not available the suite is skipped wholesale — but emit a
// single visible breadcrumb test that records *why* so a developer running
// `bun test` doesn't have to wonder.
describe.skipIf(zellijAvailable)("zellij Layer B (integration) — skipped", () => {
  test("skipped because zellij is not on PATH (or UCL_SKIP_ZELLIJ_INTEGRATION=1)", () => {
    // No-op — the skipIf above means this body never runs.
    expect(true).toBe(true)
  })
})
