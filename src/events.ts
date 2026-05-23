import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { ensureDir } from "./fs-utils.ts"
import type { Layout } from "./layout.ts"
import type { Event } from "./types.ts"

/** Append a single event to events.jsonl. Creates the dir if needed. */
export function appendEvent(layout: Layout, ev: Event): void {
  ensureDir(layout.stateDir)
  appendFileSync(layout.eventsJsonl, JSON.stringify(ev) + "\n")
}

/** Read all events. A corrupted trailing line (e.g. crash mid-write) is silently skipped. */
export function readEvents(layout: Layout): Event[] {
  if (!existsSync(layout.eventsJsonl)) return []
  const raw = readFileSync(layout.eventsJsonl, "utf8")
  const out: Event[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Event)
    } catch {
      // Skip incomplete trailing line (crash recovery; rare).
    }
  }
  return out
}

/** All events at or after `since`. */
export function eventsSince(layout: Layout, since: Date): Event[] {
  return readEvents(layout).filter((e) => new Date(e.ts).getTime() >= since.getTime())
}

/** All events referencing a particular task id (filters by `task` field where present). */
export function eventsForTask(layout: Layout, taskId: string): Event[] {
  return readEvents(layout).filter(
    (e) => "task" in e && (e as { task: string }).task === taskId,
  )
}
