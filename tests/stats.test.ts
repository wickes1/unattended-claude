import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildStats,
  findClaudeSessionFile,
  parseStatsArgs,
  renderStats,
  sumTokensFromJsonl,
} from "../src/commands/stats.ts"
import { appendEvent } from "../src/events.ts"
import { Layout, fmtDate } from "../src/layout.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"
import type { Event } from "../src/types.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-stats-"))
  return new Layout(dir)
}

function freshProjectsDir(): string {
  return mkdtempSync(join(tmpdir(), "ucl-stats-projects-"))
}

describe("parseStatsArgs", () => {
  it("defaults to 7 days and ~/.claude/projects", () => {
    const args = parseStatsArgs([])
    expect(args.days).toBe(7)
    expect(args.claudeProjectsDir).toContain(".claude")
    expect(args.claudeProjectsDir).toContain("projects")
  })

  it("parses --days N", () => {
    const args = parseStatsArgs(["--days", "30"])
    expect(args.days).toBe(30)
  })

  it("parses --claude-projects-dir <path>", () => {
    const args = parseStatsArgs(["--claude-projects-dir", "/x"])
    expect(args.claudeProjectsDir).toBe("/x")
  })

  it("parses both flags together", () => {
    const args = parseStatsArgs(["--days", "14", "--claude-projects-dir", "/y"])
    expect(args.days).toBe(14)
    expect(args.claudeProjectsDir).toBe("/y")
  })

  it("ignores --days with non-numeric or non-positive value", () => {
    expect(parseStatsArgs(["--days", "abc"]).days).toBe(7)
    expect(parseStatsArgs(["--days", "-3"]).days).toBe(7)
    expect(parseStatsArgs(["--days", "0"]).days).toBe(7)
  })

  it("floors fractional --days", () => {
    expect(parseStatsArgs(["--days", "3.7"]).days).toBe(3)
  })
})

describe("findClaudeSessionFile", () => {
  it("returns path when uuid exists under any project subdir", () => {
    const dir = freshProjectsDir()
    const sub = join(dir, "-Users-foo-proj")
    mkdirSync(sub, { recursive: true })
    const target = join(sub, "abc-123.jsonl")
    writeFileSync(target, "")
    expect(findClaudeSessionFile(dir, "abc-123")).toBe(target)
  })

  it("returns null when uuid not found anywhere", () => {
    const dir = freshProjectsDir()
    const sub = join(dir, "-Users-foo-proj")
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, "other.jsonl"), "")
    expect(findClaudeSessionFile(dir, "abc-123")).toBeNull()
  })

  it("returns null when the projects dir itself does not exist", () => {
    expect(findClaudeSessionFile("/no/such/path/here", "abc-123")).toBeNull()
  })

  it("searches across multiple subdirs", () => {
    const dir = freshProjectsDir()
    const a = join(dir, "-a")
    const b = join(dir, "-b")
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const target = join(b, "uuid-2.jsonl")
    writeFileSync(join(a, "uuid-1.jsonl"), "")
    writeFileSync(target, "")
    expect(findClaudeSessionFile(dir, "uuid-2")).toBe(target)
  })
})

describe("sumTokensFromJsonl", () => {
  it("returns 0 for missing file", () => {
    expect(sumTokensFromJsonl("/no/such/file.jsonl")).toBe(0)
  })

  it("returns 0 for empty file", () => {
    const dir = freshProjectsDir()
    const f = join(dir, "empty.jsonl")
    writeFileSync(f, "")
    expect(sumTokensFromJsonl(f)).toBe(0)
  })

  it("sums input + output tokens from message.usage per line", () => {
    const dir = freshProjectsDir()
    const f = join(dir, "good.jsonl")
    const lines = [
      JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
      JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
    ]
    writeFileSync(f, lines.join("\n") + "\n")
    expect(sumTokensFromJsonl(f)).toBe(10 + 5 + 100 + 20)
  })

  it("skips corrupted lines", () => {
    const dir = freshProjectsDir()
    const f = join(dir, "mixed.jsonl")
    const good1 = JSON.stringify({ message: { usage: { input_tokens: 7, output_tokens: 3 } } })
    const bad = "{not json"
    const good2 = JSON.stringify({ message: { usage: { input_tokens: 1, output_tokens: 1 } } })
    writeFileSync(f, [good1, bad, good2].join("\n") + "\n")
    expect(sumTokensFromJsonl(f)).toBe(7 + 3 + 1 + 1)
  })

  it("skips lines without message.usage", () => {
    const dir = freshProjectsDir()
    const f = join(dir, "noUsage.jsonl")
    const lines = [
      JSON.stringify({ message: { content: "hi" } }),
      JSON.stringify({ event: "other" }),
      JSON.stringify({ message: { usage: { input_tokens: 2, output_tokens: 3 } } }),
    ]
    writeFileSync(f, lines.join("\n") + "\n")
    expect(sumTokensFromJsonl(f)).toBe(5)
  })

  it("treats missing input_tokens or output_tokens as 0", () => {
    const dir = freshProjectsDir()
    const f = join(dir, "partial.jsonl")
    const lines = [
      JSON.stringify({ message: { usage: { input_tokens: 4 } } }),
      JSON.stringify({ message: { usage: { output_tokens: 6 } } }),
    ]
    writeFileSync(f, lines.join("\n") + "\n")
    expect(sumTokensFromJsonl(f)).toBe(10)
  })
})

describe("buildStats", () => {
  it("returns all-zero days for an empty layout", () => {
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")
    const s = buildStats(layout, projects, 7, now)
    expect(s.perDay.length).toBe(7)
    for (const d of s.perDay) {
      expect(d.tasksDone).toBe(0)
      expect(d.tasksFailed).toBe(0)
      expect(d.tokens).toBe(0)
      expect(d.rateLimitHits).toBe(0)
    }
    expect(s.totalTokens).toBe(0)
    expect(s.totalTasksDone).toBe(0)
    expect(s.totalTasksFailed).toBe(0)
    // Last day in window is the day of `now`.
    expect(s.perDay[s.perDay.length - 1]!.day).toBe(fmtDate(now))
  })

  it("aggregates task_done / task_failed / rate_limit into the correct day bucket", () => {
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")
    const today = fmtDate(now)
    const yesterday = fmtDate(new Date(now.getTime() - 86_400_000))

    const evs: Event[] = [
      { ts: new Date(now.getTime() - 86_400_000).toISOString(), event: "task_done", task: "t1", episode: 0 },
      { ts: now.toISOString(), event: "task_done", task: "t2", episode: 0 },
      { ts: now.toISOString(), event: "task_failed", task: "t3", reason: "boom" },
      { ts: now.toISOString(), event: "rate_limit", task: "t4", episode: 0, resume_at: "2026-05-23T18:00:00Z" },
      { ts: now.toISOString(), event: "rate_limit", task: "t5", episode: 0, resume_at: "2026-05-23T18:00:00Z" },
    ]
    for (const e of evs) appendEvent(layout, e)

    const s = buildStats(layout, projects, 7, now)
    const todayBucket = s.perDay.find((d) => d.day === today)!
    const yesterdayBucket = s.perDay.find((d) => d.day === yesterday)!
    expect(todayBucket.tasksDone).toBe(1)
    expect(todayBucket.tasksFailed).toBe(1)
    expect(todayBucket.rateLimitHits).toBe(2)
    expect(yesterdayBucket.tasksDone).toBe(1)
    expect(s.totalTasksDone).toBe(2)
    expect(s.totalTasksFailed).toBe(1)
  })

  it("assigns tokens to the day of the task's last_updated", async () => {
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date()

    // Set up a fake project subdir with a jsonl for the task's session uuid.
    const sub = join(projects, "-Users-foo")
    mkdirSync(sub, { recursive: true })
    const sessionUuid = "session-xyz"
    writeFileSync(
      join(sub, `${sessionUuid}.jsonl`),
      JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 50 } } }) + "\n",
    )

    const store = new TaskStateStore(layout)
    store.init("2026-05-23-01-a", "/tmp/wd", sessionUuid)
    // last_updated is set to "now" inside init via constructor; trigger an update so it refreshes.
    await store.update("2026-05-23-01-a", (st) => {
      st.state = "done"
    })

    const s = buildStats(layout, projects, 7, now)
    const todayBucket = s.perDay.find((d) => d.day === fmtDate(now))!
    expect(todayBucket.tokens).toBe(150)
    expect(s.totalTokens).toBe(150)
  })

  it("does not add tokens for tasks whose last_updated is outside the window", async () => {
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")

    const sub = join(projects, "-old")
    mkdirSync(sub, { recursive: true })
    const sessionUuid = "old-session"
    writeFileSync(
      join(sub, `${sessionUuid}.jsonl`),
      JSON.stringify({ message: { usage: { input_tokens: 999, output_tokens: 1 } } }) + "\n",
    )

    const store = new TaskStateStore(layout)
    store.init("2026-01-01-01-old", "/tmp/wd", sessionUuid)
    // last_updated is from init (now-ish on this machine), but we use a `now` far in the future
    // so 7-day window won't include it. To force this deterministically, hand-write the state file.
    const state = store.load("2026-01-01-01-old")!
    state.last_updated = "2025-01-01T00:00:00Z"
    writeFileSync(layout.taskStateFile("2026-01-01-01-old"), JSON.stringify(state))

    const s = buildStats(layout, projects, 7, now)
    expect(s.totalTokens).toBe(0)
  })

  it("excludes events older than the `days` window", () => {
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")
    const longAgo = new Date(now.getTime() - 30 * 86_400_000)

    appendEvent(layout, {
      ts: longAgo.toISOString(),
      event: "task_done",
      task: "t1",
      episode: 0,
    })
    appendEvent(layout, {
      ts: now.toISOString(),
      event: "task_done",
      task: "t2",
      episode: 0,
    })

    const s = buildStats(layout, projects, 7, now)
    expect(s.totalTasksDone).toBe(1)
  })

  it("window length matches `days` parameter", () => {
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")
    expect(buildStats(layout, projects, 1, now).perDay.length).toBe(1)
    expect(buildStats(layout, projects, 14, now).perDay.length).toBe(14)
  })
})

describe("renderStats", () => {
  it("includes header line, per-day rows, and totals line", () => {
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")
    const s = buildStats(layout, projects, 3, now)
    const out = renderStats(s)
    expect(out).toContain("Last 3 days:")
    expect(out).toContain("Day")
    expect(out).toContain("Token usage")
    // One line per day in window
    for (const d of s.perDay) {
      expect(out).toContain(d.day)
    }
    expect(out).toContain("Totals: done=0  failed=0  tokens=0")
  })

  it("formats tokens with thousands separators", () => {
    const summary = {
      perDay: [
        { day: "2026-05-23", tasksDone: 1, tasksFailed: 0, tokens: 1234567, rateLimitHits: 0 },
      ],
      totalTokens: 1234567,
      totalTasksDone: 1,
      totalTasksFailed: 0,
      fellBackToJsonlScan: false,
    }
    const out = renderStats(summary)
    expect(out).toContain("1,234,567")
  })
})

// ── F05: events.jsonl is now the source of truth for tokens ──────────
//
// buildStats used to scan ~/.claude/projects/*.jsonl unconditionally. F05
// rebases it on usage_snapshot events so the count reflects what the
// orchestrator actually observed at episode-end (and so future deletions
// of the claude jsonl files don't erase history). These tests pin:
//   1. usage_snapshot events drive per-day token sums when present.
//   2. multiple snapshots for the same task across days bucket correctly
//      (the old per-task last_updated heuristic could only hit one day).
//   3. when no usage_snapshot events exist, fall back to the jsonl scan
//      AND signal fellBackToJsonlScan=true so the CLI prints a notice.
//   4. usage_snapshot OUTSIDE the days window is excluded.
describe("buildStats: usage_snapshot events (F05)", () => {
  it("sums tokens_used from usage_snapshot events bucketed by event ts", () => {
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")
    const today = fmtDate(now)
    const yesterday = fmtDate(new Date(now.getTime() - 86_400_000))

    const evs: Event[] = [
      {
        ts: new Date(now.getTime() - 86_400_000).toISOString(),
        event: "usage_snapshot",
        task: "t1",
        episode: 1,
        tokens_used: 500,
        source_path: "/x/t1.jsonl",
      },
      {
        ts: now.toISOString(),
        event: "usage_snapshot",
        task: "t1",
        episode: 2,
        tokens_used: 800,
        source_path: "/x/t1.jsonl",
      },
      {
        ts: now.toISOString(),
        event: "usage_snapshot",
        task: "t2",
        episode: 1,
        tokens_used: 200,
        source_path: "/x/t2.jsonl",
      },
    ]
    for (const e of evs) appendEvent(layout, e)

    const s = buildStats(layout, projects, 7, now)
    const todayBucket = s.perDay.find((d) => d.day === today)!
    const yesterdayBucket = s.perDay.find((d) => d.day === yesterday)!
    expect(yesterdayBucket.tokens).toBe(500)
    expect(todayBucket.tokens).toBe(1000)
    expect(s.totalTokens).toBe(1500)
    expect(s.fellBackToJsonlScan).toBe(false)
  })

  it("a single task's snapshots split across days populate both day buckets", () => {
    // The pre-F05 fallback assigned ALL of a task's tokens to last_updated's
    // single day. usage_snapshot events let one task span multiple days when
    // it spans multiple episodes — this test would fail under the old behavior.
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")
    const today = fmtDate(now)
    const yesterday = fmtDate(new Date(now.getTime() - 86_400_000))

    appendEvent(layout, {
      ts: new Date(now.getTime() - 86_400_000).toISOString(),
      event: "usage_snapshot",
      task: "long-task",
      episode: 1,
      tokens_used: 700,
      source_path: "/x.jsonl",
    })
    appendEvent(layout, {
      ts: now.toISOString(),
      event: "usage_snapshot",
      task: "long-task",
      episode: 2,
      tokens_used: 300,
      source_path: "/x.jsonl",
    })

    const s = buildStats(layout, projects, 7, now)
    const todayBucket = s.perDay.find((d) => d.day === today)!
    const yesterdayBucket = s.perDay.find((d) => d.day === yesterday)!
    expect(yesterdayBucket.tokens).toBe(700)
    expect(todayBucket.tokens).toBe(300)
  })

  it("usage_snapshot outside the days window is excluded", () => {
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")
    const longAgo = new Date(now.getTime() - 30 * 86_400_000)

    appendEvent(layout, {
      ts: longAgo.toISOString(),
      event: "usage_snapshot",
      task: "old",
      episode: 1,
      tokens_used: 9_999,
      source_path: "/old.jsonl",
    })
    appendEvent(layout, {
      ts: now.toISOString(),
      event: "usage_snapshot",
      task: "new",
      episode: 1,
      tokens_used: 100,
      source_path: "/new.jsonl",
    })

    const s = buildStats(layout, projects, 7, now)
    expect(s.totalTokens).toBe(100)
  })

  it("falls back to jsonl scan + flags fellBackToJsonlScan when no usage_snapshot events exist", async () => {
    // No usage_snapshot events at all → must use the legacy claude-projects-dir
    // scan AND set fellBackToJsonlScan so the CLI can print a notice. Without
    // that flag, operators staring at an empty token column wouldn't know
    // their events.jsonl is missing the new event type.
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date()

    const sub = join(projects, "-Users-foo")
    mkdirSync(sub, { recursive: true })
    const sessionUuid = "session-legacy"
    writeFileSync(
      join(sub, `${sessionUuid}.jsonl`),
      JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 50 } } }) + "\n",
    )

    const store = new TaskStateStore(layout)
    store.init("2026-05-23-01-legacy", "/tmp/wd", sessionUuid)
    await store.update("2026-05-23-01-legacy", (st) => {
      st.state = "done"
    })

    const s = buildStats(layout, projects, 7, now)
    expect(s.fellBackToJsonlScan).toBe(true)
    expect(s.totalTokens).toBe(150)
  })

  it("does NOT fall back when at least one usage_snapshot event exists", async () => {
    // Mixed-mode safety: even if a stale claude jsonl is sitting on disk,
    // once we have ANY usage_snapshot we must not double-count via the
    // fallback. The legacy scan path would otherwise add 9999 silently.
    const layout = freshLayout()
    const projects = freshProjectsDir()
    const now = new Date("2026-05-23T12:00:00Z")

    const sub = join(projects, "-Users-stale")
    mkdirSync(sub, { recursive: true })
    const staleUuid = "stale-session"
    writeFileSync(
      join(sub, `${staleUuid}.jsonl`),
      JSON.stringify({ message: { usage: { input_tokens: 9_999, output_tokens: 0 } } }) + "\n",
    )
    const store = new TaskStateStore(layout)
    store.init("2026-05-23-01-stale", "/tmp/wd", staleUuid)
    await store.update("2026-05-23-01-stale", (st) => {
      st.state = "done"
    })

    appendEvent(layout, {
      ts: now.toISOString(),
      event: "usage_snapshot",
      task: "2026-05-23-01-stale",
      episode: 1,
      tokens_used: 42,
      source_path: "/x.jsonl",
    })

    const s = buildStats(layout, projects, 7, now)
    expect(s.fellBackToJsonlScan).toBe(false)
    expect(s.totalTokens).toBe(42)
  })
})
