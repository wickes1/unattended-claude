import { cpSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ensureDir } from "../fs-utils.ts"
import { appendEvent } from "../events.ts"
import { Layout } from "../layout.ts"
import { TaskStateStore } from "../orchestrator/state-store.ts"
import type { TaskRuntimeState } from "../types.ts"

export const helpText = `Usage:
  ucl archive <id>                          move one task's bundle into archive/<id>/
  ucl archive --done-before <Nd> [--dry-run]   batch archive done/failed tasks older than N days
  ucl unarchive <id>                        move a bundle back from archive/

Archive layout per task: archive/<id>/{task.md, state.json, handoff.md?, workdir/?}.
`

interface ArchiveArgs {
  id: string | null
  doneBeforeDays: number | null
  dryRun: boolean
  unarchive: boolean
}

export function parseArchiveArgs(argv: string[]): ArchiveArgs {
  let id: string | null = null
  let doneBeforeDays: number | null = null
  let dryRun = false
  let unarchive = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--done-before" && argv[i + 1]) {
      const m = /^(\d+)d?$/.exec(argv[i + 1]!)
      if (m) doneBeforeDays = Number(m[1])
      i++
    } else if (a === "--dry-run") dryRun = true
    else if (a === "--unarchive") unarchive = true
    else if (!a.startsWith("--")) id = a
  }
  return { id, doneBeforeDays, dryRun, unarchive }
}

/** Move one task bundle into archive/<id>/. Idempotent: returns false if already archived. */
export function archiveOne(layout: Layout, id: string, now: Date): boolean {
  const taskFile = layout.taskDocFile(id)
  const stateFile = layout.taskStateFile(id)
  const handoffFile = layout.handoffFile(id)
  const workdir = layout.taskWorkdir(id)
  const archiveBase = layout.taskArchiveDir(id)

  if (existsSync(archiveBase)) return false // already archived

  ensureDir(archiveBase)
  if (existsSync(taskFile)) {
    cpSync(taskFile, join(archiveBase, "task.md"))
    rmSync(taskFile)
  }
  if (existsSync(stateFile)) {
    cpSync(stateFile, join(archiveBase, "state.json"))
    rmSync(stateFile)
  }
  if (existsSync(handoffFile)) {
    cpSync(handoffFile, join(archiveBase, "handoff.md"))
    rmSync(handoffFile)
  }
  if (existsSync(workdir)) {
    cpSync(workdir, join(archiveBase, "workdir"), { recursive: true })
    rmSync(workdir, { recursive: true })
  }
  appendEvent(layout, {
    ts: now.toISOString(),
    event: "archive_moved",
    task: id,
  })
  return true
}

/** Reverse of archiveOne. Returns false if nothing in archive/<id>. */
export function unarchiveOne(layout: Layout, id: string): boolean {
  const archiveBase = layout.taskArchiveDir(id)
  if (!existsSync(archiveBase)) return false
  const task = join(archiveBase, "task.md")
  const state = join(archiveBase, "state.json")
  const handoff = join(archiveBase, "handoff.md")
  const workdir = join(archiveBase, "workdir")

  ensureDir(layout.tasksDir)
  ensureDir(layout.taskStatesDir)
  if (existsSync(task)) cpSync(task, layout.taskDocFile(id))
  if (existsSync(state)) cpSync(state, layout.taskStateFile(id))
  if (existsSync(handoff)) {
    ensureDir(layout.handoffsDir)
    cpSync(handoff, layout.handoffFile(id))
  }
  if (existsSync(workdir)) {
    cpSync(workdir, layout.taskWorkdir(id), { recursive: true })
  }
  rmSync(archiveBase, { recursive: true })
  return true
}

/** Find tasks eligible for batch archive (done or failed, last_updated older than cutoff). */
export function findArchiveCandidates(
  layout: Layout,
  doneBeforeDays: number,
  now: Date,
): TaskRuntimeState[] {
  const cutoff = now.getTime() - doneBeforeDays * 24 * 3600_000
  const store = new TaskStateStore(layout)
  return store.listAll().filter((s) => {
    if (s.state !== "done" && s.state !== "failed") return false
    return new Date(s.last_updated).getTime() < cutoff
  })
}

export async function cmdArchive(
  layout: Layout,
  argv: string[],
  log: (s: string) => void = console.log,
): Promise<void> {
  const args = parseArchiveArgs(argv)

  if (args.unarchive) {
    if (!args.id) {
      log("unarchive requires an id")
      return
    }
    const ok = unarchiveOne(layout, args.id)
    log(ok ? `unarchived ${args.id}` : `nothing to unarchive at ${layout.taskArchiveDir(args.id)}`)
    return
  }

  if (args.id) {
    const ok = archiveOne(layout, args.id, new Date())
    log(ok ? `archived ${args.id} → ${layout.taskArchiveDir(args.id)}` : `${args.id} already archived`)
    return
  }

  if (args.doneBeforeDays !== null) {
    const cands = findArchiveCandidates(layout, args.doneBeforeDays, new Date())
    if (cands.length === 0) {
      log(`no candidates older than ${args.doneBeforeDays}d`)
      return
    }
    if (args.dryRun) {
      log(`would archive ${cands.length} task(s):`)
      for (const s of cands) log(`  ${s.task_id}  (${s.state}, last_updated ${s.last_updated})`)
      return
    }
    for (const s of cands) {
      archiveOne(layout, s.task_id, new Date())
      log(`archived ${s.task_id}`)
    }
    return
  }

  log(helpText)
}
