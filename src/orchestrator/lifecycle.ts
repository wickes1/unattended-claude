import { existsSync, readFileSync, rmSync } from "node:fs"
import { atomicWrite, ensureDir } from "../fs-utils.ts"
import type { Layout } from "../layout.ts"
import type { Logger, PausedReason, TaskRuntimeState } from "../types.ts"
import { appendEvent } from "../events.ts"
import { TaskStateStore } from "./state-store.ts"
import { WeeklyLimitGate } from "./rate-limit.ts"
import { dirname } from "node:path"

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    return (e as { code?: string }).code === "EPERM"
  }
}

/** Acquire the orchestrator lockfile. Returns true if acquired, false if another live orchestrator owns it. */
export function acquireLock(layout: Layout): boolean {
  ensureDir(dirname(layout.lockFile))
  if (existsSync(layout.lockFile)) {
    const old = Number(readFileSync(layout.lockFile, "utf8").trim())
    if (isProcessAlive(old) && old !== process.pid) return false
  }
  atomicWrite(layout.lockFile, String(process.pid))
  return true
}

export function releaseLock(layout: Layout): void {
  try {
    if (existsSync(layout.lockFile)) {
      const owner = Number(readFileSync(layout.lockFile, "utf8").trim())
      if (owner === process.pid) rmSync(layout.lockFile)
    }
  } catch {
    /* not fatal */
  }
}

/** Register SIGTERM/SIGINT handlers; only fires once. */
export function installSignalHandlers(handler: (sig: string) => Promise<void>): void {
  let firing = false
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (firing) return
      firing = true
      handler(sig).then(() => process.exit(0), () => process.exit(1))
    })
  }
}

/**
 * Mark running tasks as paused with the given reason. Used by SIGTERM handlers
 * and graceful window-end. Returns the ids touched.
 */
export async function suspendForShutdown(
  store: TaskStateStore,
  layout: Layout,
  reason: PausedReason,
  log: Logger,
): Promise<string[]> {
  const touched: string[] = []
  for (const s of store.listAll()) {
    if (s.state === "running") {
      await store.update(s.task_id, (cur) => {
        cur.state = "paused"
        cur.paused_reason = reason
      })
      appendEvent(layout, {
        ts: new Date().toISOString(),
        event: "task_paused",
        task: s.task_id,
        episode: s.current_episode,
        reason,
      })
      touched.push(s.task_id)
    }
  }
  if (touched.length > 0) log.log("warn", `suspended ${touched.length} running task(s) → paused/${reason}`)
  return touched
}

/**
 * Find tasks that should resume in this run, in FIFO order by last_updated.
 * Excludes tasks paused for weekly-limit if the weekly gate is still blocked.
 */
export function findResumableTasks(
  store: TaskStateStore,
  weeklyGate: WeeklyLimitGate,
  now: Date,
): TaskRuntimeState[] {
  const weeklyBlocked = weeklyGate.blocked(now)
  return store.listAll()
    .filter((s) => s.state === "paused")
    .filter((s) => !(weeklyBlocked && s.paused_reason === "weekly-limit"))
    .sort((a, b) => a.last_updated.localeCompare(b.last_updated))
}

/**
 * Detect orphaned tasks: state=running on disk but no corresponding zellij tab.
 * Caller passes `liveTabs` derived from `zellij action list-panes` for the parent session.
 * Returns the orphan task IDs (caller is expected to suspend them with reason "orphan").
 */
export function findOrphans(
  store: TaskStateStore,
  liveTabNames: Set<string>,
): string[] {
  return store.listAll()
    .filter((s) => s.state === "running" && !liveTabNames.has(s.task_id))
    .map((s) => s.task_id)
}
