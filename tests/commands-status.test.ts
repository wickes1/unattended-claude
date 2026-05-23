import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildStatus, renderStatus } from "../src/commands/status.ts"
import { Layout } from "../src/layout.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"
import type { PausedReason, TaskState } from "../src/types.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-status-"))
  return new Layout(dir)
}

async function seed(
  store: TaskStateStore,
  id: string,
  state: TaskState,
  opts: { paused_reason?: PausedReason; compactions?: number; episode?: number } = {},
): Promise<void> {
  store.init(id, `/tmp/w/${id}`, `uuid-${id}`)
  await store.update(id, (s) => {
    s.state = state
    if (opts.paused_reason !== undefined) s.paused_reason = opts.paused_reason
    if (opts.compactions !== undefined) s.context_compactions = opts.compactions
    if (opts.episode !== undefined) s.current_episode = opts.episode
  })
}

describe("buildStatus", () => {
  it("returns all zero counts when no tasks", () => {
    const layout = freshLayout()
    const snap = buildStatus(layout, 3)
    expect(snap.counts).toEqual({ planned: 0, running: 0, paused: 0, done: 0, failed: 0, archived: 0 })
    expect(snap.inFlight).toEqual([])
    expect(snap.paused).toEqual([])
    expect(snap.recentDone).toEqual([])
    expect(snap.cap).toEqual({ active: 0, max: 3 })
  })

  it("counts mixed states correctly", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    await seed(store, "2026-05-23-01-a", "planned")
    await seed(store, "2026-05-23-02-b", "running")
    await seed(store, "2026-05-23-03-c", "running")
    await seed(store, "2026-05-23-04-d", "paused", { paused_reason: "rate-limit-5h" })
    await seed(store, "2026-05-23-05-e", "done")
    await seed(store, "2026-05-23-06-f", "failed")
    await seed(store, "2026-05-23-07-g", "archived")

    const snap = buildStatus(layout, 3)
    expect(snap.counts).toEqual({ planned: 1, running: 2, paused: 1, done: 1, failed: 1, archived: 1 })
    expect(snap.cap).toEqual({ active: 2, max: 3 })
  })

  it("returns paused tasks separately", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    await seed(store, "2026-05-23-01-a", "paused", { paused_reason: "weekly-limit" })
    await seed(store, "2026-05-23-02-b", "running")
    const snap = buildStatus(layout, 3)
    expect(snap.paused.length).toBe(1)
    expect(snap.paused[0]!.task_id).toBe("2026-05-23-01-a")
    expect(snap.paused[0]!.paused_reason).toBe("weekly-limit")
  })

  it("recentDone returns at most 5, sorted by last_updated desc", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    // Seed 7 done tasks with strictly increasing last_updated by waiting between updates.
    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      const id = `2026-05-23-${String(i + 1).padStart(2, "0")}-x`
      ids.push(id)
      await seed(store, id, "done")
      // Tiny sleep so last_updated ordering is well-defined.
      await new Promise((r) => setTimeout(r, 2))
    }
    const snap = buildStatus(layout, 3)
    expect(snap.recentDone.length).toBe(5)
    // Most recent first: last seeded = ids[6]
    expect(snap.recentDone[0]!.task_id).toBe(ids[6]!)
    // Sorted desc
    for (let i = 0; i < snap.recentDone.length - 1; i++) {
      expect(
        snap.recentDone[i]!.last_updated.localeCompare(snap.recentDone[i + 1]!.last_updated),
      ).toBeGreaterThanOrEqual(0)
    }
  })

  it("recentDone includes both done and failed", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    await seed(store, "2026-05-23-01-a", "done")
    await new Promise((r) => setTimeout(r, 2))
    await seed(store, "2026-05-23-02-b", "failed")
    const snap = buildStatus(layout, 3)
    expect(snap.recentDone.length).toBe(2)
    const states = snap.recentDone.map((s) => s.state).sort()
    expect(states).toEqual(["done", "failed"])
  })
})

describe("renderStatus", () => {
  it("includes 'In-flight: (none)' when no running tasks", () => {
    const layout = freshLayout()
    const snap = buildStatus(layout, 3)
    const out = renderStatus(snap)
    expect(out).toContain("In-flight: (none)")
  })

  it("shows paused_reason and (N compactions) when N > 0", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    await seed(store, "2026-05-23-01-a", "paused", {
      paused_reason: "context-full",
      compactions: 3,
    })
    const snap = buildStatus(layout, 3)
    const out = renderStatus(snap)
    expect(out).toContain("context-full")
    expect(out).toContain("(3 compactions)")
  })

  it("does not show compactions clause when context_compactions is 0", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    await seed(store, "2026-05-23-01-a", "paused", {
      paused_reason: "rate-limit-5h",
      compactions: 0,
    })
    const snap = buildStatus(layout, 3)
    const out = renderStatus(snap)
    expect(out).toContain("rate-limit-5h")
    expect(out).not.toContain("compactions")
  })

  it("shows Cap: M/N line", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    await seed(store, "2026-05-23-01-a", "running")
    await seed(store, "2026-05-23-02-b", "running")
    const snap = buildStatus(layout, 3)
    const out = renderStatus(snap)
    expect(out).toContain("Cap: 2/3 used")
  })

  it("includes in-flight rows with episode + last_updated", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    await seed(store, "2026-05-23-01-a", "running", { episode: 2 })
    const snap = buildStatus(layout, 3)
    const out = renderStatus(snap)
    expect(out).toContain("In-flight:")
    expect(out).toContain("2026-05-23-01-a")
    expect(out).toContain("episode 2")
  })
})
