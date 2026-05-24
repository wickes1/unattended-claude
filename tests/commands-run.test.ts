import { describe, expect, it, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimClock } from "../src/clock.ts"
import {
  parseRunArgs,
  parseUntil,
  deriveWindowEnd,
  loadTaskDocs,
  makeBuildPromptFile,
  makeBuildWakeUpPrompt,
} from "../src/commands/run.ts"
import { Layout } from "../src/layout.ts"
import { PromptBuilder } from "../src/orchestrator/prompt-builder.ts"
import type { TaskDoc, TaskRuntimeState } from "../src/types.ts"
import { testConfig } from "./helpers.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-run-"))
  return new Layout(dir)
}

describe("parseRunArgs", () => {
  it("parses --until with value", () => {
    expect(parseRunArgs(["--until", "06:30"])).toEqual({
      until: "06:30",
      force: false,
      foreground: false,
    })
  })

  it("parses --force flag", () => {
    expect(parseRunArgs(["--force"])).toEqual({
      until: null,
      force: true,
      foreground: false,
    })
  })

  it("parses both --until and --force together", () => {
    expect(parseRunArgs(["--until", "23:00", "--force"])).toEqual({
      until: "23:00",
      force: true,
      foreground: false,
    })
  })

  it("returns defaults for empty argv", () => {
    expect(parseRunArgs([])).toEqual({
      until: null,
      force: false,
      foreground: false,
    })
  })

  it("ignores --until without a following value", () => {
    expect(parseRunArgs(["--until"])).toEqual({
      until: null,
      force: false,
      foreground: false,
    })
  })
})

describe("parseRunArgs --foreground", () => {
  it("default foreground is false (daemonize)", () => {
    expect(parseRunArgs([]).foreground).toBe(false)
  })

  it("--foreground sets flag true", () => {
    expect(parseRunArgs(["--foreground"]).foreground).toBe(true)
  })

  it("--foreground composes with --until and --force", () => {
    const a = parseRunArgs(["--until", "+5m", "--foreground", "--force"])
    expect(a.foreground).toBe(true)
    expect(a.until).toBe("+5m")
    expect(a.force).toBe(true)
  })
})

// cmdRun daemon-dispatch (fork via Bun.spawn) is OS-coupled and brittle in
// unit-test environments. Verify manually post-merge by running
// `ucl run --until +5m` and confirming the shell prompt returns immediately +
// a fresh ~/unattended/logs/orchestrator-<ts>.log appears.
test.skip("cmdRun daemon dispatch (integration, manual verify)", () => {})

describe("parseUntil", () => {
  it("HH:MM resolves to today at that wall-clock when later than now", () => {
    const now = new Date()
    now.setHours(10, 0, 0, 0)
    const end = parseUntil("23:00", now)
    expect(end.getHours()).toBe(23)
    expect(end.getMinutes()).toBe(0)
    expect(end.getDate()).toBe(now.getDate())
    expect(end.getTime()).toBeGreaterThan(now.getTime())
  })

  it("HH:MM rolls to tomorrow when earlier than now", () => {
    const now = new Date()
    now.setHours(23, 0, 0, 0)
    const end = parseUntil("06:30", now)
    expect(end.getHours()).toBe(6)
    expect(end.getMinutes()).toBe(30)
    expect(end.getTime()).toBeGreaterThan(now.getTime())
  })

  it("+5m returns now + 5 minutes", () => {
    const now = new Date("2026-05-23T10:00:00.000Z")
    const end = parseUntil("+5m", now)
    expect(end.toISOString()).toBe("2026-05-23T10:05:00.000Z")
  })

  it("+2h returns now + 2 hours", () => {
    const now = new Date("2026-05-23T10:00:00.000Z")
    const end = parseUntil("+2h", now)
    expect(end.toISOString()).toBe("2026-05-23T12:00:00.000Z")
  })

  it("+1m (minimum) is accepted", () => {
    const now = new Date("2026-05-23T10:00:00.000Z")
    const end = parseUntil("+1m", now)
    expect(end.toISOString()).toBe("2026-05-23T10:01:00.000Z")
  })

  it("+0m is rejected (N must be >= 1)", () => {
    const now = new Date("2026-05-23T10:00:00.000Z")
    expect(() => parseUntil("+0m", now)).toThrow(
      "Invalid --until value: '+0m'. Use HH:MM, +Nm, or +Nh.",
    )
  })

  it("+0h is rejected (N must be >= 1)", () => {
    const now = new Date("2026-05-23T10:00:00.000Z")
    expect(() => parseUntil("+0h", now)).toThrow(
      "Invalid --until value: '+0h'. Use HH:MM, +Nm, or +Nh.",
    )
  })

  it("+abc is rejected with clear error", () => {
    const now = new Date("2026-05-23T10:00:00.000Z")
    expect(() => parseUntil("+abc", now)).toThrow(
      "Invalid --until value: '+abc'. Use HH:MM, +Nm, or +Nh.",
    )
  })

  it("+5s (unsupported unit) is rejected", () => {
    const now = new Date("2026-05-23T10:00:00.000Z")
    expect(() => parseUntil("+5s", now)).toThrow(
      "Invalid --until value: '+5s'. Use HH:MM, +Nm, or +Nh.",
    )
  })

  it("garbage string is rejected", () => {
    const now = new Date("2026-05-23T10:00:00.000Z")
    expect(() => parseUntil("not-a-time", now)).toThrow(
      "Invalid --until value: 'not-a-time'. Use HH:MM, +Nm, or +Nh.",
    )
  })

  it("empty string is rejected", () => {
    const now = new Date("2026-05-23T10:00:00.000Z")
    expect(() => parseUntil("", now)).toThrow(
      "Invalid --until value: ''. Use HH:MM, +Nm, or +Nh.",
    )
  })
})

describe("deriveWindowEnd", () => {
  it("returns null when no active schedule window and no --until", () => {
    const cfg = testConfig({ schedule: { windows: [] } })
    const now = new Date("2026-05-23T10:00:00.000Z")
    expect(deriveWindowEnd(cfg, null, now)).toBeNull()
  })

  it("returns Date matching argUntil HH:MM (same day if later than now)", () => {
    const cfg = testConfig()
    // Use local-time-aware now: 10:00 local
    const now = new Date()
    now.setHours(10, 0, 0, 0)
    const end = deriveWindowEnd(cfg, "23:00", now)
    expect(end).not.toBeNull()
    expect(end!.getHours()).toBe(23)
    expect(end!.getMinutes()).toBe(0)
    // Same calendar date
    expect(end!.getDate()).toBe(now.getDate())
  })

  it("rolls argUntil to next day if HH:MM is earlier than now", () => {
    const cfg = testConfig()
    const now = new Date()
    now.setHours(23, 0, 0, 0)
    const end = deriveWindowEnd(cfg, "06:30", now)
    expect(end).not.toBeNull()
    expect(end!.getHours()).toBe(6)
    expect(end!.getMinutes()).toBe(30)
    expect(end!.getTime()).toBeGreaterThan(now.getTime())
  })

  it("accepts +Nm shorthand and returns now + N minutes", () => {
    const cfg = testConfig()
    const now = new Date("2026-05-23T10:00:00.000Z")
    const end = deriveWindowEnd(cfg, "+15m", now)
    expect(end).not.toBeNull()
    expect(end!.toISOString()).toBe("2026-05-23T10:15:00.000Z")
  })

  it("accepts +Nh shorthand and returns now + N hours", () => {
    const cfg = testConfig()
    const now = new Date("2026-05-23T10:00:00.000Z")
    const end = deriveWindowEnd(cfg, "+3h", now)
    expect(end).not.toBeNull()
    expect(end!.toISOString()).toBe("2026-05-23T13:00:00.000Z")
  })

  it("returns windowEnd when an active schedule window covers now", () => {
    // Active window: every day 09:00 → 18:00
    const cfg = testConfig({
      schedule: {
        windows: [{ start: "09:00", end: "18:00", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] }],
      },
    })
    const now = new Date()
    now.setHours(10, 30, 0, 0)
    const end = deriveWindowEnd(cfg, null, now)
    expect(end).not.toBeNull()
    expect(end!.getHours()).toBe(18)
    expect(end!.getMinutes()).toBe(0)
  })
})

describe("loadTaskDocs", () => {
  it("returns [] when tasks dir doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-run-notasks-"))
    // Do NOT create tasksDir
    const layout = new Layout(dir)
    expect(loadTaskDocs(layout)).toEqual([])
  })

  it("parses frontmatter (title, workdir, serial) from tasks/<id>.md", () => {
    const layout = freshLayout()
    mkdirSync(layout.tasksDir, { recursive: true })
    const id = "2026-05-23-01-feature-x"
    const file = join(layout.tasksDir, `${id}.md`)
    writeFileSync(
      file,
      `---
title: Build feature X
workdir: /tmp/my-workdir
serial: true
---

# Feature X

Body text here.
`,
    )
    const docs = loadTaskDocs(layout)
    expect(docs.length).toBe(1)
    const d = docs[0]!
    expect(d.id).toBe(id)
    expect(d.title).toBe("Build feature X")
    expect(d.workdir).toBe("/tmp/my-workdir")
    expect(d.serial).toBe(true)
    expect(d.file).toBe(file)
  })

  it("defaults serial:false and workdir=workdirs/<id> when missing", () => {
    const layout = freshLayout()
    mkdirSync(layout.tasksDir, { recursive: true })
    const id = "2026-05-23-02-no-fm"
    const file = join(layout.tasksDir, `${id}.md`)
    // No frontmatter at all
    writeFileSync(file, `# Just a body\n\nNo frontmatter here.\n`)
    const docs = loadTaskDocs(layout)
    expect(docs.length).toBe(1)
    const d = docs[0]!
    expect(d.id).toBe(id)
    expect(d.title).toBe(id)
    expect(d.workdir).toBe(layout.taskWorkdir(id))
    expect(d.serial).toBe(false)
  })

  it("ignores non-.md files", () => {
    const layout = freshLayout()
    mkdirSync(layout.tasksDir, { recursive: true })
    writeFileSync(join(layout.tasksDir, "README.txt"), "ignore me")
    writeFileSync(join(layout.tasksDir, "2026-05-23-01-x.md"), "")
    const docs = loadTaskDocs(layout)
    expect(docs.length).toBe(1)
    expect(docs[0]!.id).toBe("2026-05-23-01-x")
  })
})

describe("makeBuildPromptFile (PromptBuilder binding)", () => {
  function fakeDoc(layout: Layout): TaskDoc {
    const id = "2026-05-23-01-x"
    mkdirSync(layout.tasksDir, { recursive: true })
    const file = join(layout.tasksDir, `${id}.md`)
    writeFileSync(file, "# Task body content here\n")
    return {
      id,
      title: "T",
      workdir: layout.taskWorkdir(id),
      serial: false,
      file,
    }
  }

  function build(layout: Layout): {
    fn: (t: TaskDoc, e: number, r: boolean, s: TaskRuntimeState) => string
    promptsDir: string
  } {
    const promptsDir = mkdtempSync(join(tmpdir(), "ucl-prompt-"))
    const pb = new PromptBuilder({ promptsDir })
    const clock = new SimClock(new Date("2026-05-23T22:30:00.000Z"))
    return {
      fn: makeBuildPromptFile(pb, promptsDir, layout, clock),
      promptsDir,
    }
  }

  function blankState(taskId: string, workdir: string): TaskRuntimeState {
    return {
      schema_version: 1,
      task_id: taskId,
      state: "running",
      paused_reason: null,
      claude_session_id: "00000000-0000-0000-0000-000000000001",
      current_episode: 0,
      context_compactions: 0,
      created_at: "2026-05-23T22:30:00.000Z",
      last_updated: "2026-05-23T22:30:00.000Z",
      workdir,
      handoff_pending: false,
    }
  }

  it("writes task content + completion postamble for fresh episode (resume=false)", () => {
    const layout = freshLayout()
    const task = fakeDoc(layout)
    const { fn } = build(layout)
    const path = fn(task, 1, false, blankState(task.id, task.workdir))
    const content = readFileSync(path, "utf8")
    expect(content).toContain("# Task body content here")
    // Postamble: sentinel + summary instructions
    expect(content).toContain(layout.sentinelFile(task.id, 1))
    expect(content).toContain("## Summary")
    expect(content).toContain("Stop only after both files exist")
  })

  it("writes wake-up continuation cue + completion postamble for resume=true", () => {
    const layout = freshLayout()
    const task = fakeDoc(layout)
    const { fn } = build(layout)
    const path = fn(task, 2, true, blankState(task.id, task.workdir))
    const content = readFileSync(path, "utf8")
    expect(content).toContain("Continue from where you left off")
    // Resume episodes also write the sentinel postamble
    expect(content).toContain(layout.sentinelFile(task.id, 2))
    expect(content).toContain("Stop only after both files exist")
  })

  it("path filename includes task id + episode", () => {
    const layout = freshLayout()
    const task = fakeDoc(layout)
    const { fn } = build(layout)
    const path = fn(task, 3, false, blankState(task.id, task.workdir))
    expect(path).toContain(task.id)
    expect(path).toContain("ep3")
  })
})

describe("makeBuildWakeUpPrompt (PromptBuilder binding)", () => {
  const task: TaskDoc = {
    id: "x",
    title: "x",
    workdir: "/tmp/x",
    serial: false,
    file: "/tmp/x.md",
  }

  function build(): (t: TaskDoc, r: import("../src/types.ts").PausedReason | null) => string | null {
    const promptsDir = mkdtempSync(join(tmpdir(), "ucl-prompt-"))
    return makeBuildWakeUpPrompt(new PromptBuilder({ promptsDir }))
  }

  it("returns null when pausedReason is null", () => {
    expect(build()(task, null)).toBeNull()
  })

  it("context-full returns null (handled separately by orchestrator)", () => {
    expect(build()(task, "context-full")).toBeNull()
  })

  it("schedule-boundary returns continuation cue", () => {
    expect(build()(task, "schedule-boundary")).toContain("Schedule window ended")
  })
})
