import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { fmtDate, isValidTaskId, nextTaskId, Layout } from "../src/layout.ts"

describe("fmtDate", () => {
  it("formats local-time date as YYYY-MM-DD", () => {
    // month is 0-indexed: 4 => May
    expect(fmtDate(new Date(2026, 4, 23))).toBe("2026-05-23")
  })
})

describe("isValidTaskId", () => {
  it("accepts well-formed id", () => {
    expect(isValidTaskId("2026-05-23-01-grep-bench")).toBe(true)
  })
  it("rejects garbage", () => {
    expect(isValidTaskId("invalid")).toBe(false)
  })
  it("rejects NN that is not 2 digits", () => {
    expect(isValidTaskId("2026-05-23-1-x")).toBe(false)
  })
})

describe("nextTaskId", () => {
  it("returns NN=01 when no existing for today", () => {
    expect(nextTaskId("2026-05-23", [], "slug")).toBe("2026-05-23-01-slug")
  })
  it("picks max+1 across existing same-date IDs", () => {
    expect(
      nextTaskId("2026-05-23", ["2026-05-23-01-foo", "2026-05-23-02-bar"], "baz"),
    ).toBe("2026-05-23-03-baz")
  })
  it("restarts at 01 on a different date", () => {
    expect(nextTaskId("2026-05-24", ["2026-05-23-99-foo"], "x")).toBe("2026-05-24-01-x")
  })
})

describe("Layout", () => {
  const L = new Layout("/tmp/x")
  it("computes getter paths", () => {
    expect(L.todoFile).toBe("/tmp/x/todo.md")
    expect(L.tasksDir).toBe("/tmp/x/tasks")
    expect(L.workdirsDir).toBe("/tmp/x/workdirs")
    expect(L.archiveDir).toBe("/tmp/x/archive")
    expect(L.stateDir).toBe("/tmp/x/state")
    expect(L.eventsJsonl).toBe("/tmp/x/state/events.jsonl")
    expect(L.taskStatesDir).toBe("/tmp/x/state/tasks")
    expect(L.handoffsDir).toBe("/tmp/x/state/handoffs")
    expect(L.weeklyPausedFile).toBe("/tmp/x/state/weekly-paused-until.txt")
    expect(L.lockFile).toBe("/tmp/x/state/.lock")
    expect(L.logsDir).toBe("/tmp/x/logs")
  })
  it("computes per-task method paths", () => {
    const id = "2026-05-23-01-slug"
    expect(L.taskDocFile(id)).toBe(join("/tmp/x/tasks", `${id}.md`))
    expect(L.taskStateFile(id)).toBe(join("/tmp/x/state/tasks", `${id}.json`))
    expect(L.handoffFile(id)).toBe(join("/tmp/x/state/handoffs", `${id}.md`))
    expect(L.taskWorkdir(id)).toBe(join("/tmp/x/workdirs", id))
    expect(L.taskArchiveDir(id)).toBe(join("/tmp/x/archive", id))
    expect(L.episodeLogFile(id, 2)).toBe(join("/tmp/x/logs", `${id}-2.log`))
    expect(L.sentinelFile(id, 2)).toBe(join("/tmp/x/state", `episode-${id}-2.done`))
  })
})
