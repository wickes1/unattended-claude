import { existsSync, readFileSync, readdirSync } from "node:fs"
import { atomicWrite, ensureDir } from "../fs-utils.ts"
import type { Layout } from "../layout.ts"
import type { TaskRuntimeState } from "../types.ts"

/**
 * Per-task state store with per-id async mutex chain.
 *
 * Concurrent updates to the same task ID are serialized; updates to
 * different IDs run in parallel. Writes are atomic (.tmp + rename).
 */
export class TaskStateStore {
  /** Per-id promise chain. Each id has its own serialization. */
  private chains = new Map<string, Promise<unknown>>()

  constructor(private layout: Layout) {}

  /** Read the current state from disk (no mutex; callers must coordinate). */
  load(id: string): TaskRuntimeState | null {
    const f = this.layout.taskStateFile(id)
    if (!existsSync(f)) return null
    try {
      const raw = JSON.parse(readFileSync(f, "utf8")) as TaskRuntimeState
      // Backward compat: state files written before F02 lack handoff_pending.
      if (typeof raw.handoff_pending !== "boolean") raw.handoff_pending = false
      return raw
    } catch {
      return null
    }
  }

  /**
   * Atomic, serialized per-id update. Callbacks see the latest on-disk state.
   * The chain swallows rejections so a single failed update doesn't block later ones.
   */
  update<T>(id: string, fn: (s: TaskRuntimeState) => T): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve()
    const run = prev.then(() => {
      const cur = this.load(id)
      if (!cur) throw new Error(`task state not initialized: ${id}`)
      const r = fn(cur)
      cur.last_updated = new Date().toISOString()
      ensureDir(this.layout.taskStatesDir)
      atomicWrite(this.layout.taskStateFile(id), JSON.stringify(cur, null, 2))
      return r
    })
    this.chains.set(id, run.then(() => {}, () => {}))
    return run
  }

  /** Initialize a fresh task state file. Overwrites if exists. */
  init(id: string, workdir: string, claudeSessionId: string): void {
    const now = new Date().toISOString()
    const state: TaskRuntimeState = {
      schema_version: 1,
      task_id: id,
      state: "planned",
      paused_reason: null,
      claude_session_id: claudeSessionId,
      current_episode: 0,
      context_compactions: 0,
      created_at: now,
      last_updated: now,
      workdir,
      handoff_pending: false,
    }
    ensureDir(this.layout.taskStatesDir)
    atomicWrite(this.layout.taskStateFile(id), JSON.stringify(state, null, 2))
  }

  /** All task states currently on disk. */
  listAll(): TaskRuntimeState[] {
    if (!existsSync(this.layout.taskStatesDir)) return []
    return readdirSync(this.layout.taskStatesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.load(f.replace(/\.json$/, "")))
      .filter((s): s is TaskRuntimeState => s !== null)
  }
}
