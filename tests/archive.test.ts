import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  archiveOne,
  cmdArchive,
  findArchiveCandidates,
  parseArchiveArgs,
  unarchiveOne,
} from "../src/commands/archive.ts"
import { readEvents } from "../src/events.ts"
import { ensureDir } from "../src/fs-utils.ts"
import { Layout } from "../src/layout.ts"
import { RealClock } from "../src/clock.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"
import type { TaskRuntimeState } from "../src/types.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-archive-"))
  return new Layout(dir)
}

/** Seed task doc, state, handoff, workdir for a given id. */
function seedFullTask(layout: Layout, id: string): void {
  ensureDir(layout.tasksDir)
  ensureDir(layout.taskStatesDir)
  ensureDir(layout.handoffsDir)
  ensureDir(layout.workdirsDir)
  writeFileSync(layout.taskDocFile(id), `# task ${id}\n`)
  const store = new TaskStateStore(layout, new RealClock())
  store.init(id, layout.taskWorkdir(id), "uuid-" + id)
  writeFileSync(layout.handoffFile(id), `handoff ${id}\n`)
  ensureDir(layout.taskWorkdir(id))
  writeFileSync(join(layout.taskWorkdir(id), "scratch.txt"), `scratch ${id}\n`)
}

describe("parseArchiveArgs", () => {
  it("parses a bare id", () => {
    expect(parseArchiveArgs(["2026-05-23-01-x"])).toEqual({
      id: "2026-05-23-01-x",
      doneBeforeDays: null,
      dryRun: false,
      unarchive: false,
    })
  })

  it("parses --done-before Nd and --dry-run", () => {
    expect(parseArchiveArgs(["--done-before", "7d", "--dry-run"])).toEqual({
      id: null,
      doneBeforeDays: 7,
      dryRun: true,
      unarchive: false,
    })
  })

  it("parses --done-before with bare integer (no 'd' suffix)", () => {
    expect(parseArchiveArgs(["--done-before", "14"])).toEqual({
      id: null,
      doneBeforeDays: 14,
      dryRun: false,
      unarchive: false,
    })
  })

  it("parses --unarchive with id", () => {
    expect(parseArchiveArgs(["--unarchive", "x-id"])).toEqual({
      id: "x-id",
      doneBeforeDays: null,
      dryRun: false,
      unarchive: true,
    })
  })
})

describe("archiveOne", () => {
  it("moves task doc + state + handoff + workdir into archive/<id>/", () => {
    const layout = freshLayout()
    const id = "2026-05-23-01-foo"
    seedFullTask(layout, id)

    const ok = archiveOne(layout, id, new Date("2026-05-23T12:00:00Z"))
    expect(ok).toBe(true)

    // Originals removed
    expect(existsSync(layout.taskDocFile(id))).toBe(false)
    expect(existsSync(layout.taskStateFile(id))).toBe(false)
    expect(existsSync(layout.handoffFile(id))).toBe(false)
    expect(existsSync(layout.taskWorkdir(id))).toBe(false)

    // Archive bundle populated
    const base = layout.taskArchiveDir(id)
    expect(existsSync(join(base, "task.md"))).toBe(true)
    expect(existsSync(join(base, "state.json"))).toBe(true)
    expect(existsSync(join(base, "handoff.md"))).toBe(true)
    expect(existsSync(join(base, "workdir", "scratch.txt"))).toBe(true)
  })

  it("returns false when archive/<id>/ already exists", () => {
    const layout = freshLayout()
    const id = "2026-05-23-02-bar"
    seedFullTask(layout, id)
    expect(archiveOne(layout, id, new Date())).toBe(true)
    // Re-seeding originals shouldn't matter; archive dir already there.
    seedFullTask(layout, id)
    expect(archiveOne(layout, id, new Date())).toBe(false)
  })

  it("writes archive_moved event", () => {
    const layout = freshLayout()
    const id = "2026-05-23-03-evt"
    seedFullTask(layout, id)
    archiveOne(layout, id, new Date("2026-05-23T12:00:00Z"))
    const evs = readEvents(layout)
    const moved = evs.filter((e) => e.event === "archive_moved")
    expect(moved.length).toBe(1)
    expect((moved[0] as { task: string }).task).toBe(id)
  })

  it("works when only task.md exists (no state/handoff/workdir)", () => {
    const layout = freshLayout()
    const id = "2026-05-23-04-tiny"
    ensureDir(layout.tasksDir)
    writeFileSync(layout.taskDocFile(id), "# tiny\n")
    const ok = archiveOne(layout, id, new Date())
    expect(ok).toBe(true)
    const base = layout.taskArchiveDir(id)
    expect(existsSync(join(base, "task.md"))).toBe(true)
    expect(existsSync(join(base, "state.json"))).toBe(false)
    expect(existsSync(join(base, "handoff.md"))).toBe(false)
    expect(existsSync(join(base, "workdir"))).toBe(false)
  })
})

describe("unarchiveOne", () => {
  it("reverses archiveOne (recovers all components)", () => {
    const layout = freshLayout()
    const id = "2026-05-23-05-rev"
    seedFullTask(layout, id)
    const originalTask = readFileSync(layout.taskDocFile(id), "utf8")
    const originalScratch = readFileSync(
      join(layout.taskWorkdir(id), "scratch.txt"),
      "utf8",
    )
    archiveOne(layout, id, new Date())

    const ok = unarchiveOne(layout, id)
    expect(ok).toBe(true)
    expect(existsSync(layout.taskArchiveDir(id))).toBe(false)
    expect(readFileSync(layout.taskDocFile(id), "utf8")).toBe(originalTask)
    expect(existsSync(layout.taskStateFile(id))).toBe(true)
    expect(existsSync(layout.handoffFile(id))).toBe(true)
    expect(
      readFileSync(join(layout.taskWorkdir(id), "scratch.txt"), "utf8"),
    ).toBe(originalScratch)
  })

  it("returns false when archive/<id>/ doesn't exist", () => {
    const layout = freshLayout()
    expect(unarchiveOne(layout, "ghost")).toBe(false)
  })
})

describe("findArchiveCandidates", () => {
  function seedState(layout: Layout, s: TaskRuntimeState): void {
    ensureDir(layout.taskStatesDir)
    writeFileSync(layout.taskStateFile(s.task_id), JSON.stringify(s, null, 2))
  }

  it("returns done/failed tasks older than N days", () => {
    const layout = freshLayout()
    const now = new Date("2026-05-23T12:00:00Z")
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 3600_000).toISOString()
    seedState(layout, {
      schema_version: 1,
      task_id: "2026-05-13-01-done-old",
      state: "done",
      paused_reason: null,
      claude_session_id: "u1",
      current_episode: 1,
      context_compactions: 0,
      created_at: tenDaysAgo,
      last_updated: tenDaysAgo,
      workdir: "/tmp/w1",
      handoff_pending: false,
    })
    seedState(layout, {
      schema_version: 1,
      task_id: "2026-05-13-02-failed-old",
      state: "failed",
      paused_reason: null,
      claude_session_id: "u2",
      current_episode: 1,
      context_compactions: 0,
      created_at: tenDaysAgo,
      last_updated: tenDaysAgo,
      workdir: "/tmp/w2",
      handoff_pending: false,
    })
    const cands = findArchiveCandidates(layout, 7, now)
    const ids = cands.map((c) => c.task_id).sort()
    expect(ids).toEqual([
      "2026-05-13-01-done-old",
      "2026-05-13-02-failed-old",
    ])
  })

  it("excludes running/paused/planned tasks", () => {
    const layout = freshLayout()
    const now = new Date("2026-05-23T12:00:00Z")
    const old = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString()
    for (const st of ["running", "paused", "planned"] as const) {
      seedState(layout, {
        schema_version: 1,
        task_id: `2026-04-23-01-${st}`,
        state: st,
        paused_reason: null,
        claude_session_id: `u-${st}`,
        current_episode: 1,
        context_compactions: 0,
        created_at: old,
        last_updated: old,
        workdir: `/tmp/${st}`,
        handoff_pending: false,
      })
    }
    expect(findArchiveCandidates(layout, 7, now)).toEqual([])
  })

  it("excludes recent done tasks (within cutoff)", () => {
    const layout = freshLayout()
    const now = new Date("2026-05-23T12:00:00Z")
    const recent = new Date(now.getTime() - 2 * 24 * 3600_000).toISOString()
    seedState(layout, {
      schema_version: 1,
      task_id: "2026-05-21-01-fresh",
      state: "done",
      paused_reason: null,
      claude_session_id: "u-f",
      current_episode: 1,
      context_compactions: 0,
      created_at: recent,
      last_updated: recent,
      workdir: "/tmp/fresh",
      handoff_pending: false,
    })
    expect(findArchiveCandidates(layout, 7, now)).toEqual([])
  })
})

describe("cmdArchive", () => {
  it("--dry-run doesn't move files but logs candidates", async () => {
    const layout = freshLayout()
    const now = new Date()
    const old = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString()
    const id = "2026-04-23-01-dry"
    // Seed state + a task doc so we'd notice if archive moved anything.
    ensureDir(layout.taskStatesDir)
    ensureDir(layout.tasksDir)
    writeFileSync(layout.taskStateFile(id), JSON.stringify({
      schema_version: 1,
      task_id: id,
      state: "done",
      paused_reason: null,
      claude_session_id: "u",
      current_episode: 1,
      context_compactions: 0,
      created_at: old,
      last_updated: old,
      workdir: "/tmp/dry",
      handoff_pending: false,
    } satisfies TaskRuntimeState, null, 2))
    writeFileSync(layout.taskDocFile(id), "# dry\n")

    const logs: string[] = []
    await cmdArchive(layout, ["--done-before", "7d", "--dry-run"], (s) => logs.push(s))

    expect(existsSync(layout.taskDocFile(id))).toBe(true)
    expect(existsSync(layout.taskStateFile(id))).toBe(true)
    expect(existsSync(layout.taskArchiveDir(id))).toBe(false)
    expect(logs.some((l) => l.includes("would archive"))).toBe(true)
    expect(logs.some((l) => l.includes(id))).toBe(true)
  })

  it("archives a single id when given", async () => {
    const layout = freshLayout()
    const id = "2026-05-23-10-one"
    seedFullTask(layout, id)
    const logs: string[] = []
    await cmdArchive(layout, [id], (s) => logs.push(s))
    expect(existsSync(layout.taskDocFile(id))).toBe(false)
    expect(existsSync(layout.taskArchiveDir(id))).toBe(true)
    expect(logs.some((l) => l.includes("archived"))).toBe(true)
  })

  it("unarchive returns id back to live dirs", async () => {
    const layout = freshLayout()
    const id = "2026-05-23-11-back"
    seedFullTask(layout, id)
    archiveOne(layout, id, new Date())
    const logs: string[] = []
    await cmdArchive(layout, ["--unarchive", id], (s) => logs.push(s))
    expect(existsSync(layout.taskDocFile(id))).toBe(true)
    expect(existsSync(layout.taskArchiveDir(id))).toBe(false)
    expect(logs.some((l) => l.includes("unarchived"))).toBe(true)
  })

  it("logs help text when no args provided", async () => {
    const layout = freshLayout()
    const logs: string[] = []
    await cmdArchive(layout, [], (s) => logs.push(s))
    expect(logs.join("\n")).toContain("Usage:")
  })
})
