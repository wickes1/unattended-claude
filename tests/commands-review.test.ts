import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildReviewInitialPrompt,
  eventsForReview,
  extractSummary,
  parseReviewArgs,
} from "../src/commands/review.ts"
import { Layout } from "../src/layout.ts"
import { appendEvent } from "../src/events.ts"
import type { Event } from "../src/types.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-review-"))
  return new Layout(dir)
}

describe("parseReviewArgs", () => {
  it("returns all defaults for empty argv", () => {
    expect(parseReviewArgs([])).toEqual({ id: null, synthesize: false, sinceHours: null })
  })

  it("parses a bare positional as id", () => {
    expect(parseReviewArgs(["2026-05-23-01-x"])).toEqual({
      id: "2026-05-23-01-x",
      synthesize: false,
      sinceHours: null,
    })
  })

  it("parses --synthesize and --since 24h together", () => {
    expect(parseReviewArgs(["--synthesize", "--since", "24h"])).toEqual({
      id: null,
      synthesize: true,
      sinceHours: 24,
    })
  })

  it("parses --since 30m as 0.5 hours", () => {
    expect(parseReviewArgs(["--since", "30m"]).sinceHours).toBe(0.5)
  })

  it("parses --since 2d as 48 hours", () => {
    expect(parseReviewArgs(["--since", "2d"]).sinceHours).toBe(48)
  })

  it("leaves sinceHours null when --since value is malformed", () => {
    expect(parseReviewArgs(["--since", "junk"]).sinceHours).toBeNull()
  })

  it("leaves sinceHours null when --since has no value", () => {
    expect(parseReviewArgs(["--since"]).sinceHours).toBeNull()
  })
})

describe("extractSummary", () => {
  it("extracts the Summary section between two headings", () => {
    const doc = "# Task\n\n## Summary\nDid X.\n\n## Notes\n..."
    expect(extractSummary(doc)).toBe("Did X.")
  })

  it("returns null when there is no Summary heading", () => {
    expect(extractSummary("no summary here")).toBeNull()
  })

  it("is case-insensitive on the heading", () => {
    expect(extractSummary("## SUMMARY\nuppercase")).toBe("uppercase")
  })

  it("captures multi-line summary content", () => {
    const doc = "## Summary\nLine 1\nLine 2\n\n## Other\nignored"
    expect(extractSummary(doc)).toBe("Line 1\nLine 2")
  })

  it("captures Summary at end of file (no trailing heading)", () => {
    const doc = "intro\n\n## Summary\nfinal body text"
    expect(extractSummary(doc)).toBe("final body text")
  })
})

describe("eventsForReview", () => {
  it("returns events newer than now-1h when sinceHours=1", () => {
    const layout = freshLayout()
    const now = new Date("2026-05-23T12:00:00.000Z")
    const old: Event = { ts: "2026-05-23T10:00:00.000Z", event: "run_start", until: null }
    const recent: Event = { ts: "2026-05-23T11:30:00.000Z", event: "run_end", reason: "ok" }
    appendEvent(layout, old)
    appendEvent(layout, recent)
    const out = eventsForReview(layout, { id: null, synthesize: false, sinceHours: 1 }, now)
    expect(out.length).toBe(1)
    expect(out[0]).toEqual(recent)
  })

  it("returns events since the most recent run_start when sinceHours is null", () => {
    const layout = freshLayout()
    const e1: Event = { ts: "2026-05-23T09:00:00.000Z", event: "run_start", until: null }
    const e2: Event = { ts: "2026-05-23T09:30:00.000Z", event: "run_end", reason: "ok" }
    const e3: Event = { ts: "2026-05-23T10:00:00.000Z", event: "run_start", until: null }
    const e4: Event = { ts: "2026-05-23T10:30:00.000Z", event: "task_done", task: "t", episode: 0 }
    appendEvent(layout, e1)
    appendEvent(layout, e2)
    appendEvent(layout, e3)
    appendEvent(layout, e4)
    const out = eventsForReview(
      layout,
      { id: null, synthesize: false, sinceHours: null },
      new Date("2026-05-23T11:00:00.000Z"),
    )
    expect(out).toEqual([e3, e4])
  })

  it("returns all events when there is no run_start in history", () => {
    const layout = freshLayout()
    const e1: Event = { ts: "2026-05-23T09:00:00.000Z", event: "task_done", task: "t", episode: 0 }
    const e2: Event = { ts: "2026-05-23T10:00:00.000Z", event: "error", reason: "boom" }
    appendEvent(layout, e1)
    appendEvent(layout, e2)
    const out = eventsForReview(
      layout,
      { id: null, synthesize: false, sinceHours: null },
      new Date("2026-05-23T11:00:00.000Z"),
    )
    expect(out).toEqual([e1, e2])
  })

  it("returns empty array when no events at all", () => {
    const layout = freshLayout()
    const out = eventsForReview(
      layout,
      { id: null, synthesize: false, sinceHours: null },
      new Date(),
    )
    expect(out).toEqual([])
  })
})

describe("buildReviewInitialPrompt", () => {
  it("includes (no events in range) when events list is empty", () => {
    const layout = freshLayout()
    const out = buildReviewInitialPrompt(layout, [], null)
    expect(out).toContain("(no events in range)")
    expect(out).toContain("task-review")
  })

  it("includes each event as a JSON line", () => {
    const layout = freshLayout()
    const ev: Event = { ts: "2026-05-23T10:00:00.000Z", event: "run_end", reason: "ok" }
    const out = buildReviewInitialPrompt(layout, [ev], null)
    expect(out).toContain('"event":"run_end"')
    expect(out).toContain('"reason":"ok"')
  })

  it("adds synthesis instructions when a synthesisFile is provided", () => {
    const layout = freshLayout()
    const out = buildReviewInitialPrompt(layout, [], "/tmp/review-2026.md")
    expect(out).toContain("Synthesis mode")
    expect(out).toContain("/tmp/review-2026.md")
  })

  it("omits synthesis instructions when synthesisFile is null", () => {
    const layout = freshLayout()
    const out = buildReviewInitialPrompt(layout, [], null)
    expect(out).not.toContain("Synthesis mode")
  })
})
