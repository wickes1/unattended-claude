/** Unit tests — lifecycle (lockfile, signal helpers, suspend, resume queue, orphans). */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Layout } from "../src/layout.ts"
import { ensureDir } from "../src/fs-utils.ts"
import { MemoryLogger } from "../src/logger.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"
import { WeeklyLimitGate } from "../src/orchestrator/rate-limit.ts"
import {
  acquireLock,
  findOrphans,
  findResumableTasks,
  installSignalHandlers,
  isProcessAlive,
  releaseLock,
  suspendForShutdown,
} from "../src/orchestrator/lifecycle.ts"
import { readEvents } from "../src/events.ts"

// Definitely-not-a-real PID. Real PIDs are bounded by the kernel; 99_999_999 is
// well above macOS/Linux defaults and reliably "dead".
const DEAD_PID = 99_999_999

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-lifecycle-"))
  return new Layout(dir)
}

// ── isProcessAlive ───────────────────────────────────────────────

describe("isProcessAlive", () => {
  test("returns true for current process pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  test("returns false for clearly-dead pid", () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false)
  })

  test("returns false for negative/zero/NaN pids", () => {
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(NaN)).toBe(false)
  })
})

// ── acquireLock / releaseLock ────────────────────────────────────

describe("acquireLock", () => {
  test("succeeds on empty (no existing lock)", () => {
    const layout = freshLayout()
    expect(acquireLock(layout)).toBe(true)
    expect(existsSync(layout.lockFile)).toBe(true)
    expect(readFileSync(layout.lockFile, "utf8").trim()).toBe(String(process.pid))
  })

  test("overwrites a stale (dead-pid) lock and succeeds", () => {
    const layout = freshLayout()
    ensureDir(layout.stateDir)
    writeFileSync(layout.lockFile, String(DEAD_PID))
    expect(acquireLock(layout)).toBe(true)
    // Lock is now owned by current process.
    expect(readFileSync(layout.lockFile, "utf8").trim()).toBe(String(process.pid))
  })

  test("fails when a live, different pid owns the lock", () => {
    const layout = freshLayout()
    ensureDir(layout.stateDir)
    // Write a PID that is alive but not us. We pretend the current process PID
    // is "another orchestrator". We need a different PID for the test, so
    // temporarily monkey-patch process.pid via a stub: simplest is to write
    // process.pid + 0 (us) — but then the code's `old !== process.pid` branch
    // treats it as our own stale lock and allows overwrite. To simulate "another
    // live PID owns it" we'd need a real other-process PID. On POSIX the init
    // pid 1 is always alive and not us, so use it.
    writeFileSync(layout.lockFile, "1")
    expect(acquireLock(layout)).toBe(false)
    // File unchanged.
    expect(readFileSync(layout.lockFile, "utf8").trim()).toBe("1")
  })
})

describe("releaseLock", () => {
  test("removes the file when current process owns it", () => {
    const layout = freshLayout()
    acquireLock(layout)
    expect(existsSync(layout.lockFile)).toBe(true)
    releaseLock(layout)
    expect(existsSync(layout.lockFile)).toBe(false)
  })

  test("does NOT remove file owned by another pid", () => {
    const layout = freshLayout()
    ensureDir(layout.stateDir)
    writeFileSync(layout.lockFile, "1") // pretend init owns it
    releaseLock(layout)
    expect(existsSync(layout.lockFile)).toBe(true)
    expect(readFileSync(layout.lockFile, "utf8").trim()).toBe("1")
  })

  test("no-op when lock file does not exist", () => {
    const layout = freshLayout()
    expect(() => releaseLock(layout)).not.toThrow()
  })
})

// ── installSignalHandlers ─────────────────────────────────────────
// We can't actually deliver SIGTERM/SIGINT (it would kill the test runner),
// but we can verify the function returns without throwing and registers
// listeners. Smoke test only.

describe("installSignalHandlers", () => {
  test("registers listeners without throwing", () => {
    const beforeTerm = process.listenerCount("SIGTERM")
    const beforeInt = process.listenerCount("SIGINT")
    installSignalHandlers(async () => {})
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(beforeTerm)
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(beforeInt)
    // Clean up: remove only the listeners we just added (keep test isolation).
    const termListeners = process.listeners("SIGTERM")
    const intListeners = process.listeners("SIGINT")
    if (termListeners.length > 0) process.off("SIGTERM", termListeners[termListeners.length - 1]!)
    if (intListeners.length > 0) process.off("SIGINT", intListeners[intListeners.length - 1]!)
  })
})

// ── suspendForShutdown ────────────────────────────────────────────

describe("suspendForShutdown", () => {
  test("marks running tasks as paused and writes task_paused events", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)

    store.init("2026-05-23-01-a", "/tmp/w/a", "uuid-a")
    store.init("2026-05-23-02-b", "/tmp/w/b", "uuid-b")
    await store.update("2026-05-23-01-a", (s) => { s.state = "running" })
    await store.update("2026-05-23-02-b", (s) => { s.state = "running" })

    const touched = await suspendForShutdown(store, layout, "user-stop", new MemoryLogger())
    expect(touched.sort()).toEqual(["2026-05-23-01-a", "2026-05-23-02-b"])

    expect(store.load("2026-05-23-01-a")!.state).toBe("paused")
    expect(store.load("2026-05-23-01-a")!.paused_reason).toBe("user-stop")
    expect(store.load("2026-05-23-02-b")!.state).toBe("paused")

    const events = readEvents(layout).filter((e) => e.event === "task_paused")
    expect(events.length).toBe(2)
  })

  test("ignores non-running tasks (planned/done/failed unchanged)", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)

    store.init("2026-05-23-01-planned", "/tmp/w", "uuid-1")
    store.init("2026-05-23-02-done", "/tmp/w", "uuid-2")
    store.init("2026-05-23-03-failed", "/tmp/w", "uuid-3")
    await store.update("2026-05-23-02-done", (s) => { s.state = "done" })
    await store.update("2026-05-23-03-failed", (s) => { s.state = "failed" })

    const touched = await suspendForShutdown(store, layout, "user-stop", new MemoryLogger())
    expect(touched).toEqual([])

    expect(store.load("2026-05-23-01-planned")!.state).toBe("planned")
    expect(store.load("2026-05-23-02-done")!.state).toBe("done")
    expect(store.load("2026-05-23-03-failed")!.state).toBe("failed")
  })
})

// ── findResumableTasks ────────────────────────────────────────────

describe("findResumableTasks", () => {
  test("returns paused tasks in FIFO by last_updated", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const gate = new WeeklyLimitGate(layout)

    store.init("2026-05-23-01-a", "/tmp/w", "uuid-a")
    await new Promise((r) => setTimeout(r, 5))
    store.init("2026-05-23-02-b", "/tmp/w", "uuid-b")
    await new Promise((r) => setTimeout(r, 5))
    store.init("2026-05-23-03-c", "/tmp/w", "uuid-c")

    // Pause in reverse order, so last_updated order is c, b, a.
    await store.update("2026-05-23-03-c", (s) => { s.state = "paused"; s.paused_reason = "user-stop" })
    await new Promise((r) => setTimeout(r, 5))
    await store.update("2026-05-23-02-b", (s) => { s.state = "paused"; s.paused_reason = "user-stop" })
    await new Promise((r) => setTimeout(r, 5))
    await store.update("2026-05-23-01-a", (s) => { s.state = "paused"; s.paused_reason = "user-stop" })

    const out = findResumableTasks(store, gate, new Date())
    expect(out.map((s) => s.task_id)).toEqual([
      "2026-05-23-03-c",
      "2026-05-23-02-b",
      "2026-05-23-01-a",
    ])
  })

  test("excludes weekly-limit paused tasks when weekly gate is blocked", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const gate = new WeeklyLimitGate(layout)

    // Trip the weekly gate for an hour in the future.
    const future = new Date(Date.now() + 60 * 60_000)
    gate.trip(future)

    store.init("2026-05-23-01-a", "/tmp/w", "uuid-a")
    store.init("2026-05-23-02-b", "/tmp/w", "uuid-b")
    await store.update("2026-05-23-01-a", (s) => { s.state = "paused"; s.paused_reason = "weekly-limit" })
    await store.update("2026-05-23-02-b", (s) => { s.state = "paused"; s.paused_reason = "user-stop" })

    const out = findResumableTasks(store, gate, new Date())
    expect(out.map((s) => s.task_id)).toEqual(["2026-05-23-02-b"])
  })

  test("includes weekly-limit paused tasks when weekly gate is clear", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const gate = new WeeklyLimitGate(layout)

    store.init("2026-05-23-01-a", "/tmp/w", "uuid-a")
    store.init("2026-05-23-02-b", "/tmp/w", "uuid-b")
    await store.update("2026-05-23-01-a", (s) => { s.state = "paused"; s.paused_reason = "weekly-limit" })
    await store.update("2026-05-23-02-b", (s) => { s.state = "paused"; s.paused_reason = "user-stop" })

    const out = findResumableTasks(store, gate, new Date())
    expect(out.map((s) => s.task_id).sort()).toEqual(["2026-05-23-01-a", "2026-05-23-02-b"])
  })
})

// ── findOrphans ────────────────────────────────────────────────────

describe("findOrphans", () => {
  test("returns task IDs whose state=running but tab name not in liveTabs", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)

    store.init("2026-05-23-01-alive", "/tmp/w", "u1")
    store.init("2026-05-23-02-orphan", "/tmp/w", "u2")
    store.init("2026-05-23-03-planned", "/tmp/w", "u3")
    await store.update("2026-05-23-01-alive", (s) => { s.state = "running" })
    await store.update("2026-05-23-02-orphan", (s) => { s.state = "running" })
    // Leave 03-planned in state=planned.

    const live = new Set(["2026-05-23-01-alive"])
    const orphans = findOrphans(store, live)
    expect(orphans).toEqual(["2026-05-23-02-orphan"])
  })

  test("returns empty when all running tasks are live", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)

    store.init("2026-05-23-01-a", "/tmp/w", "u1")
    await store.update("2026-05-23-01-a", (s) => { s.state = "running" })

    expect(findOrphans(store, new Set(["2026-05-23-01-a"]))).toEqual([])
  })

  test("returns empty when no tasks are running", () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    expect(findOrphans(store, new Set())).toEqual([])
  })
})
