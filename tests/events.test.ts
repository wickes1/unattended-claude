import { describe, expect, it } from "bun:test"
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureDir } from "../src/fs-utils.ts"
import {
  appendEvent,
  eventsForTask,
  eventsSince,
  readEvents,
} from "../src/events.ts"
import { Layout } from "../src/layout.ts"
import type { Event } from "../src/types.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-events-"))
  return new Layout(dir)
}

describe("appendEvent / readEvents", () => {
  it("round-trips a single event", () => {
    const layout = freshLayout()
    const ev: Event = { ts: "2026-05-23T00:00:00Z", event: "run_start", until: null }
    appendEvent(layout, ev)
    expect(readEvents(layout)).toEqual([ev])
  })

  it("returns multiple events in insertion order", () => {
    const layout = freshLayout()
    const e1: Event = { ts: "2026-05-23T00:00:00Z", event: "run_start", until: null }
    const e2: Event = {
      ts: "2026-05-23T00:01:00Z",
      event: "task_started",
      task: "2026-05-23-01-foo",
      episode: 0,
      resumed: false,
    }
    const e3: Event = {
      ts: "2026-05-23T00:02:00Z",
      event: "task_done",
      task: "2026-05-23-01-foo",
      episode: 0,
    }
    appendEvent(layout, e1)
    appendEvent(layout, e2)
    appendEvent(layout, e3)
    expect(readEvents(layout)).toEqual([e1, e2, e3])
  })

  it("skips a corrupted trailing line", () => {
    const layout = freshLayout()
    const e1: Event = { ts: "2026-05-23T00:00:00Z", event: "run_start", until: null }
    const e2: Event = {
      ts: "2026-05-23T00:01:00Z",
      event: "run_end",
      reason: "ok",
    }
    appendEvent(layout, e1)
    appendEvent(layout, e2)
    // Simulate a crash mid-write: incomplete JSON appended without newline.
    appendFileSync(layout.eventsJsonl, `{"ts":"2026`)
    expect(readEvents(layout)).toEqual([e1, e2])
  })

  it("returns [] for non-existent file", () => {
    const layout = freshLayout()
    expect(readEvents(layout)).toEqual([])
  })

  it("returns [] for empty file", () => {
    const layout = freshLayout()
    ensureDir(layout.stateDir)
    writeFileSync(layout.eventsJsonl, "")
    expect(readEvents(layout)).toEqual([])
  })
})

describe("eventsSince", () => {
  it("filters events strictly before `since` out", () => {
    const layout = freshLayout()
    const early: Event = { ts: "2026-05-23T00:00:00Z", event: "run_start", until: null }
    const mid: Event = { ts: "2026-05-23T01:00:00Z", event: "run_end", reason: "ok" }
    const late: Event = { ts: "2026-05-23T02:00:00Z", event: "error", reason: "boom" }
    appendEvent(layout, early)
    appendEvent(layout, mid)
    appendEvent(layout, late)

    const since = new Date("2026-05-23T01:00:00Z")
    expect(eventsSince(layout, since)).toEqual([mid, late])
  })
})

describe("eventsForTask", () => {
  it("returns only events whose `task` matches the given id", () => {
    const layout = freshLayout()
    const noTask: Event = { ts: "2026-05-23T00:00:00Z", event: "run_start", until: null }
    const otherTask: Event = {
      ts: "2026-05-23T00:01:00Z",
      event: "task_started",
      task: "2026-05-23-02-other",
      episode: 0,
      resumed: false,
    }
    const matchA: Event = {
      ts: "2026-05-23T00:02:00Z",
      event: "task_started",
      task: "2026-05-23-01-foo",
      episode: 0,
      resumed: false,
    }
    const matchB: Event = {
      ts: "2026-05-23T00:03:00Z",
      event: "task_done",
      task: "2026-05-23-01-foo",
      episode: 0,
    }
    const weeklyNoTask: Event = {
      ts: "2026-05-23T00:04:00Z",
      event: "weekly_limit",
      resume_at: "2026-05-30T00:00:00Z",
    }
    appendEvent(layout, noTask)
    appendEvent(layout, otherTask)
    appendEvent(layout, matchA)
    appendEvent(layout, matchB)
    appendEvent(layout, weeklyNoTask)

    expect(eventsForTask(layout, "2026-05-23-01-foo")).toEqual([matchA, matchB])
  })
})
