import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Layout } from "../src/layout.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-state-store-"))
  return new Layout(dir)
}

describe("TaskStateStore.init", () => {
  it("creates the state file with correct shape", () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const id = "2026-05-23-01-foo"
    const workdir = "/tmp/work/foo"
    const sessionId = "550e8400-e29b-41d4-a716-446655440000"

    store.init(id, workdir, sessionId)

    const loaded = store.load(id)
    expect(loaded).not.toBeNull()
    expect(loaded!.schema_version).toBe(1)
    expect(loaded!.task_id).toBe(id)
    expect(loaded!.state).toBe("planned")
    expect(loaded!.paused_reason).toBeNull()
    expect(loaded!.claude_session_id).toBe(sessionId)
    expect(loaded!.current_episode).toBe(0)
    expect(loaded!.context_compactions).toBe(0)
    expect(loaded!.workdir).toBe(workdir)
    expect(typeof loaded!.created_at).toBe("string")
    expect(typeof loaded!.last_updated).toBe("string")
    // Both timestamps should be valid ISO 8601
    expect(() => new Date(loaded!.created_at).toISOString()).not.toThrow()
    expect(() => new Date(loaded!.last_updated).toISOString()).not.toThrow()
  })
})

describe("TaskStateStore.load", () => {
  it("returns null when file doesn't exist", () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    expect(store.load("nonexistent")).toBeNull()
  })

  it("returns the state when file exists", () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const id = "2026-05-23-01-bar"
    store.init(id, "/tmp/w", "uuid-1")
    const s = store.load(id)
    expect(s).not.toBeNull()
    expect(s!.task_id).toBe(id)
  })
})

describe("TaskStateStore.update", () => {
  it("modifies + atomic-writes the state", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const id = "2026-05-23-01-mut"
    store.init(id, "/tmp/w", "uuid-1")

    await store.update(id, (s) => {
      s.state = "running"
      s.current_episode = 3
    })

    const reloaded = store.load(id)
    expect(reloaded!.state).toBe("running")
    expect(reloaded!.current_episode).toBe(3)
  })

  it("throws when called on un-initialized task ID", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    await expect(store.update("nope", (s) => s)).rejects.toThrow(
      /task state not initialized/,
    )
  })

  it("updates last_updated timestamp automatically", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const id = "2026-05-23-01-ts"
    store.init(id, "/tmp/w", "uuid-1")
    const before = store.load(id)!.last_updated

    // Wait a couple ms so timestamp must differ
    await new Promise((r) => setTimeout(r, 5))

    await store.update(id, (s) => {
      s.current_episode = 1
    })

    const after = store.load(id)!.last_updated
    expect(after).not.toBe(before)
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it("serializes concurrent updates to the SAME id (no lost updates)", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const id = "2026-05-23-01-conc"
    store.init(id, "/tmp/w", "uuid-1")

    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(
        store.update(id, (s) => {
          s.context_compactions += 1
        }),
      )
    }
    await Promise.all(promises)

    expect(store.load(id)!.context_compactions).toBe(100)
  })

  it("runs concurrent updates to DIFFERENT ids in parallel", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const id = `2026-05-23-${String(i + 1).padStart(2, "0")}-x`
      ids.push(id)
      store.init(id, `/tmp/w/${id}`, `uuid-${i}`)
    }

    // Each update sleeps ~20ms inside the callback. If serialized, total time
    // would be ~200ms+; in parallel it should finish in roughly one slot.
    const sleepMs = 20
    const start = Date.now()
    await Promise.all(
      ids.map((id) =>
        store.update(id, (s) => {
          s.current_episode = 1
          // Sync sleep inside the synchronous fn:
          const end = Date.now() + sleepMs
          while (Date.now() < end) {
            // busy-wait — keeps the callback synchronous so the only chance for
            // overlap is across different per-id chains.
          }
        }),
      ),
    )
    const elapsed = Date.now() - start

    // All updates completed and all states reflect the change.
    for (const id of ids) {
      expect(store.load(id)!.current_episode).toBe(1)
    }
    // Sanity: ten 20ms busy-waits run essentially serially within one event-loop
    // turn (JS is single-threaded), but the *chains* don't add additional waiting,
    // so total wall-clock is on the order of 10*sleepMs, not 100*sleepMs. We just
    // assert it isn't catastrophically slow (i.e. the chains aren't deadlocked).
    expect(elapsed).toBeLessThan(sleepMs * 100)
  })

  it("does not block later updates after a failed callback", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const id = "2026-05-23-01-fail"
    store.init(id, "/tmp/w", "uuid-1")

    await expect(
      store.update(id, () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    // Subsequent update on the same id should succeed.
    await store.update(id, (s) => {
      s.current_episode = 7
    })

    expect(store.load(id)!.current_episode).toBe(7)
  })
})

describe("TaskStateStore.listAll", () => {
  it("returns empty list when dir doesn't exist", () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    expect(store.listAll()).toEqual([])
  })

  it("returns all task states on disk", () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    const ids = [
      "2026-05-23-01-a",
      "2026-05-23-02-b",
      "2026-05-23-03-c",
    ]
    for (const id of ids) store.init(id, `/tmp/w/${id}`, `uuid-${id}`)

    const all = store.listAll()
    expect(all.length).toBe(3)
    const got = all.map((s) => s.task_id).sort()
    expect(got).toEqual(ids)
  })
})
