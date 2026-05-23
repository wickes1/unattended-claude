import { RealClock } from "../clock.ts"
import { Layout } from "../layout.ts"
import { TaskStateStore } from "../orchestrator/state-store.ts"
import type { TaskRuntimeState } from "../types.ts"

export const helpText = `Usage: ucl status

Print a snapshot of the runtime: queue counts, in-flight tasks, recent activity.
No AI involvement, fast.
`

export interface StatusSnapshot {
  counts: { planned: number; running: number; paused: number; done: number; failed: number; archived: number }
  inFlight: TaskRuntimeState[]
  paused: TaskRuntimeState[]
  recentDone: TaskRuntimeState[]
  cap?: { active: number; max: number }
}

export function buildStatus(layout: Layout, maxParallelTabs: number): StatusSnapshot {
  const store = new TaskStateStore(layout, new RealClock())
  const all = store.listAll()
  const counts = {
    planned: 0, running: 0, paused: 0, done: 0, failed: 0, archived: 0,
  }
  for (const s of all) counts[s.state]++
  const inFlight = all.filter((s) => s.state === "running")
  const paused = all.filter((s) => s.state === "paused")
  const recentDone = all
    .filter((s) => s.state === "done" || s.state === "failed")
    .sort((a, b) => b.last_updated.localeCompare(a.last_updated))
    .slice(0, 5)
  return {
    counts,
    inFlight,
    paused,
    recentDone,
    cap: { active: inFlight.length, max: maxParallelTabs },
  }
}

export function renderStatus(snap: StatusSnapshot): string {
  const lines: string[] = []
  const c = snap.counts
  lines.push(`planned: ${c.planned}  running: ${c.running}  paused: ${c.paused}  done: ${c.done}  failed: ${c.failed}`)
  lines.push("")
  if (snap.inFlight.length > 0) {
    lines.push("In-flight:")
    for (const s of snap.inFlight) {
      lines.push(`  ${s.task_id}    episode ${s.current_episode}    last update ${s.last_updated}`)
    }
  } else {
    lines.push("In-flight: (none)")
  }
  if (snap.paused.length > 0) {
    lines.push("")
    lines.push("Paused:")
    for (const s of snap.paused) {
      const compaction = s.context_compactions > 0 ? `  (${s.context_compactions} compactions)` : ""
      lines.push(`  ${s.task_id}    ${s.paused_reason ?? "unknown"}${compaction}`)
    }
  }
  if (snap.cap) {
    lines.push("")
    lines.push(`Cap: ${snap.cap.active}/${snap.cap.max} used`)
  }
  return lines.join("\n")
}

export async function cmdStatus(layout: Layout, maxParallelTabs: number, log: (s: string) => void = console.log): Promise<void> {
  const snap = buildStatus(layout, maxParallelTabs)
  log(renderStatus(snap))
}
