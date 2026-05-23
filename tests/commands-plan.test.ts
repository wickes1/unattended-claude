import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildPlanInitialPrompt,
  parsePlanArgs,
  planPreflight,
} from "../src/commands/plan.ts"
import { Layout } from "../src/layout.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-plan-"))
  return new Layout(dir)
}

describe("parsePlanArgs", () => {
  it("returns force:false for empty argv", () => {
    expect(parsePlanArgs([])).toEqual({ force: false })
  })

  it("returns force:true when --force present", () => {
    expect(parsePlanArgs(["--force"])).toEqual({ force: true })
  })

  it("ignores unrelated flags", () => {
    expect(parsePlanArgs(["--bogus"])).toEqual({ force: false })
  })
})

describe("planPreflight", () => {
  it("returns null when no tasks exist", () => {
    const layout = freshLayout()
    expect(planPreflight(layout)).toBeNull()
  })

  it("returns null when only non-running tasks exist", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    store.init("2026-05-23-01-a", "/tmp/w/a", "uuid-a")
    await store.update("2026-05-23-01-a", (s) => { s.state = "paused" })
    store.init("2026-05-23-02-b", "/tmp/w/b", "uuid-b")
    await store.update("2026-05-23-02-b", (s) => { s.state = "done" })
    expect(planPreflight(layout)).toBeNull()
  })

  it("returns refusal string containing task id when one is running", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    store.init("2026-05-23-01-running-task", "/tmp/w/r", "uuid-r")
    await store.update("2026-05-23-01-running-task", (s) => { s.state = "running" })
    const r = planPreflight(layout)
    expect(r).not.toBeNull()
    expect(r!).toContain("2026-05-23-01-running-task")
    expect(r!).toContain("Worker is running")
    expect(r!).toContain("--force")
  })

  it("lists multiple running task ids in the refusal string", async () => {
    const layout = freshLayout()
    const store = new TaskStateStore(layout)
    store.init("2026-05-23-01-a", "/tmp/w/a", "uuid-a")
    await store.update("2026-05-23-01-a", (s) => { s.state = "running" })
    store.init("2026-05-23-02-b", "/tmp/w/b", "uuid-b")
    await store.update("2026-05-23-02-b", (s) => { s.state = "running" })
    const r = planPreflight(layout)
    expect(r).not.toBeNull()
    expect(r!).toContain("2026-05-23-01-a")
    expect(r!).toContain("2026-05-23-02-b")
    expect(r!).toContain("2 task(s)")
  })
})

describe("buildPlanInitialPrompt", () => {
  it("includes (empty) when todo.md is missing", () => {
    const layout = freshLayout()
    const out = buildPlanInitialPrompt(layout)
    expect(out).toContain("(empty)")
    expect(out).toContain(layout.todoFile)
    expect(out).toContain(layout.tasksDir)
    expect(out).toContain(layout.workdirsDir)
  })

  it("includes todo.md content when present", () => {
    const layout = freshLayout()
    // Ensure parent dir exists, then write a todo
    writeFileSync(layout.todoFile, "- [ ] fix the bug\n- [ ] write docs\n")
    const out = buildPlanInitialPrompt(layout)
    expect(out).toContain("fix the bug")
    expect(out).toContain("write docs")
    expect(out).toContain(layout.todoFile)
    expect(out).toContain(layout.tasksDir)
    expect(out).toContain(layout.workdirsDir)
  })

  it("instructs the AI to invoke the task-brief skill", () => {
    const layout = freshLayout()
    const out = buildPlanInitialPrompt(layout)
    expect(out).toContain("task-brief")
  })
})
