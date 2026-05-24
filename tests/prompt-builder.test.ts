/**
 * PromptBuilder — unit tests (F09).
 *
 * Consolidates the four prompt-construction call sites (initial task prompt,
 * wake-up prompt, wind-down prompt, resume-with-handoff prompt) behind a
 * single class. F02 will plug HANDOFF.md resume into resumeWithHandoff()
 * without touching call sites again.
 */
import { describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PromptBuilder } from "../src/orchestrator/prompt-builder.ts"
import { WIND_DOWN_PROMPT } from "../src/runtime/claude-session.ts"
import type { PausedReason, TaskDoc } from "../src/types.ts"

function freshPromptsDir(): string {
  return mkdtempSync(join(tmpdir(), "ucl-pb-"))
}

function fakeTaskDoc(body: string): TaskDoc {
  const dir = mkdtempSync(join(tmpdir(), "ucl-pb-task-"))
  const id = "2026-05-23-01-x"
  const file = join(dir, `${id}.md`)
  writeFileSync(file, body)
  return { id, title: "T", workdir: dir, serial: false, file }
}

describe("PromptBuilder.initial", () => {
  it("returns text matching the task doc body and writes a file to promptsDir", () => {
    const promptsDir = freshPromptsDir()
    const body = "# Task body content here\n\nDo the thing.\n"
    const task = fakeTaskDoc(body)
    const pb = new PromptBuilder({ promptsDir })

    const result = pb.initial(task, 1)

    expect(result.text).toBe(body)
    expect(result.path).toBeDefined()
    expect(existsSync(result.path!)).toBe(true)
    expect(readFileSync(result.path!, "utf8")).toBe(body)
  })

  it("writes file inside promptsDir (not OS tmpdir)", () => {
    const promptsDir = freshPromptsDir()
    const task = fakeTaskDoc("body\n")
    const pb = new PromptBuilder({ promptsDir })

    const result = pb.initial(task, 1)

    expect(dirname(result.path!)).toBe(promptsDir)
  })

  it("filename includes task id and episode number", () => {
    const promptsDir = freshPromptsDir()
    const task = fakeTaskDoc("body\n")
    const pb = new PromptBuilder({ promptsDir })

    const result = pb.initial(task, 3)

    expect(result.path).toContain(task.id)
    expect(result.path).toContain("ep3")
  })
})

describe("PromptBuilder.wakeUp", () => {
  const task: TaskDoc = {
    id: "x",
    title: "x",
    workdir: "/tmp/x",
    serial: false,
    file: "/tmp/x.md",
  }

  function pb(): PromptBuilder {
    return new PromptBuilder({ promptsDir: freshPromptsDir() })
  }

  it("schedule-boundary returns continuation cue", () => {
    const r = pb().wakeUp(task, "schedule-boundary")
    expect(r?.text).toContain("Schedule window ended")
  })

  it("rate-limit-5h mentions 5-hour reset", () => {
    const r = pb().wakeUp(task, "rate-limit-5h")
    expect(r?.text).toContain("5-hour")
  })

  it("weekly-limit mentions weekly limit cleared", () => {
    const r = pb().wakeUp(task, "weekly-limit")
    expect(r?.text).toContain("weekly limit")
  })

  it("context-full returns null", () => {
    const r = pb().wakeUp(task, "context-full")
    expect(r).toBeNull()
  })

  it("user-stop returns continuation cue", () => {
    const r = pb().wakeUp(task, "user-stop")
    expect(r?.text).toContain("Manual stop")
  })

  it("user-stop-now warns about verifying state", () => {
    const r = pb().wakeUp(task, "user-stop-now")
    expect(r?.text).toContain("interrupted forcibly")
    expect(r?.text).toContain("verify")
  })

  it("orphan asks to verify file/test state", () => {
    const r = pb().wakeUp(task, "orphan")
    expect(r?.text).toContain("interrupted unexpectedly")
    expect(r?.text).toContain("verify")
  })

  it("wakeUp result does not include a path (no file written)", () => {
    const reasons: PausedReason[] = [
      "schedule-boundary",
      "rate-limit-5h",
      "weekly-limit",
      "user-stop",
      "user-stop-now",
      "orphan",
    ]
    for (const r of reasons) {
      const out = pb().wakeUp(task, r)
      expect(out?.path).toBeUndefined()
    }
  })
})

describe("PromptBuilder.windDown", () => {
  it("returns the same text as the exported WIND_DOWN_PROMPT constant", () => {
    const pb = new PromptBuilder({ promptsDir: freshPromptsDir() })
    const r = pb.windDown()
    expect(r.text).toBe(WIND_DOWN_PROMPT)
  })

  it("returns deterministic wind-down text (snapshot)", () => {
    const pb = new PromptBuilder({ promptsDir: freshPromptsDir() })
    const r = pb.windDown()
    expect(r.text).toContain("Schedule window is ending soon")
    expect(r.text).toContain("preserved and resumed")
  })

  it("does not write a file", () => {
    const pb = new PromptBuilder({ promptsDir: freshPromptsDir() })
    const r = pb.windDown()
    expect(r.path).toBeUndefined()
  })
})

describe("PromptBuilder completion postamble (sentinel + summary)", () => {
  it("initial appends sentinel-write + summary-append instructions when sentinelFile provided", () => {
    const promptsDir = freshPromptsDir()
    const task = fakeTaskDoc("# do the thing\n\nbody\n")
    const pb = new PromptBuilder({ promptsDir })
    const sentinel = "/tmp/ucl/state/x-ep1.done"
    const r = pb.initial(task, 1, sentinel)
    expect(r.text).toContain("## Summary")
    expect(r.text).toContain(task.file)
    expect(r.text).toContain(sentinel)
    expect(r.text).toContain('"done"')
    expect(r.text).toContain("Stop only after both files exist")
  })

  it("initial omits postamble when sentinelFile not provided (test mode)", () => {
    const promptsDir = freshPromptsDir()
    const task = fakeTaskDoc("body\n")
    const pb = new PromptBuilder({ promptsDir })
    const r = pb.initial(task, 1)
    expect(r.text).not.toContain("Stop only after both files exist")
  })

  it("resumeWithHandoff appends postamble when sentinelFile provided", () => {
    const promptsDir = freshPromptsDir()
    const dir = mkdtempSync(join(tmpdir(), "ucl-pb-pa-"))
    const handoffPath = join(dir, "h.md")
    writeFileSync(handoffPath, "handoff body\n")
    const task: TaskDoc = {
      id: "y",
      title: "T",
      workdir: dir,
      serial: false,
      file: join(dir, "y.md"),
    }
    writeFileSync(task.file, "task body\n")
    const pb = new PromptBuilder({ promptsDir })
    const sentinel = "/tmp/ucl/state/y-ep2.done"
    const r = pb.resumeWithHandoff(task, handoffPath, 2, sentinel)
    expect(r.text).toContain("handoff body")
    expect(r.text).toContain(sentinel)
    expect(r.text).toContain("Stop only after both files exist")
  })

  it("wakeUp is unchanged — no postamble (wake-up cue precedes a follow-up paste)", () => {
    const promptsDir = freshPromptsDir()
    const task: TaskDoc = {
      id: "z",
      title: "T",
      workdir: "/tmp/z",
      serial: false,
      file: "/tmp/z.md",
    }
    const pb = new PromptBuilder({ promptsDir })
    const r = pb.wakeUp(task, "schedule-boundary")
    expect(r?.text).not.toContain("Stop only after both files exist")
  })
})

describe("PromptBuilder happy-title preamble (bin=happy)", () => {
  it("initial prepends mcp__happy__change_title call with [ucl] prefix", () => {
    const promptsDir = freshPromptsDir()
    const task: TaskDoc = {
      id: "2026-05-23-01-x",
      title: "build the auth flow",
      workdir: "/tmp/x",
      serial: false,
      file: (() => {
        const f = join(mkdtempSync(join(tmpdir(), "ucl-pb-task-")), "x.md")
        writeFileSync(f, "task body\n")
        return f
      })(),
    }
    const pb = new PromptBuilder({ promptsDir, bin: "happy" })
    const r = pb.initial(task, 1)
    expect(r.text).toContain("mcp__happy__change_title")
    expect(r.text).toContain("[ucl] build the auth flow")
    expect(r.text).toContain("task body")
  })

  it("initial does NOT prepend when bin=claude (default)", () => {
    const promptsDir = freshPromptsDir()
    const task = fakeTaskDoc("task body\n")
    const pb = new PromptBuilder({ promptsDir })
    const r = pb.initial(task, 1)
    expect(r.text).not.toContain("mcp__happy__change_title")
  })

  it("wakeUp prepends preamble when bin=happy", () => {
    const promptsDir = freshPromptsDir()
    const task: TaskDoc = {
      id: "x",
      title: "T",
      workdir: "/tmp/x",
      serial: false,
      file: "/tmp/x.md",
    }
    const pb = new PromptBuilder({ promptsDir, bin: "happy" })
    const r = pb.wakeUp(task, "schedule-boundary")
    expect(r?.text).toContain("mcp__happy__change_title")
    expect(r?.text).toContain("Schedule window ended")
  })

  it("resumeWithHandoff prepends preamble when bin=happy", () => {
    const promptsDir = freshPromptsDir()
    const dir = mkdtempSync(join(tmpdir(), "ucl-pb-h2-"))
    const handoffPath = join(dir, "h.md")
    writeFileSync(handoffPath, "handoff body\n")
    const task: TaskDoc = {
      id: "y",
      title: "T",
      workdir: dir,
      serial: false,
      file: "/tmp/y.md",
    }
    const pb = new PromptBuilder({ promptsDir, bin: "happy" })
    const r = pb.resumeWithHandoff(task, handoffPath, 2)
    expect(r.text).toContain("mcp__happy__change_title")
    expect(r.text).toContain("handoff body")
  })

  it("title truncates to 40 chars when task title is long", () => {
    const promptsDir = freshPromptsDir()
    const longTitle = "this is a very long task title that exceeds forty characters easily"
    const task: TaskDoc = {
      id: "z",
      title: longTitle,
      workdir: "/tmp/z",
      serial: false,
      file: (() => {
        const f = join(mkdtempSync(join(tmpdir(), "ucl-pb-task-z-")), "z.md")
        writeFileSync(f, "body\n")
        return f
      })(),
    }
    const pb = new PromptBuilder({ promptsDir, bin: "happy" })
    const r = pb.initial(task, 1)
    // Extract the title="..." part and assert it's <= 40 chars
    const m = /title="([^"]+)"/.exec(r.text)
    expect(m).not.toBeNull()
    expect(m![1]!.length).toBeLessThanOrEqual(40)
    expect(m![1]).toContain("[ucl]")
  })

  it("windDown does NOT prepend (session is ending, no need to retitle)", () => {
    const pb = new PromptBuilder({ promptsDir: freshPromptsDir(), bin: "happy" })
    const r = pb.windDown()
    expect(r.text).not.toContain("mcp__happy__change_title")
  })
})

describe("PromptBuilder.resumeWithHandoff", () => {
  function withHandoff(body: string): { task: TaskDoc; handoffPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "ucl-pb-handoff-"))
    const id = "2026-05-23-02-handoff"
    const file = join(dir, `${id}.md`)
    writeFileSync(file, "task body\n")
    const handoffDir = join(dir, "handoffs")
    mkdirSync(handoffDir, { recursive: true })
    const handoffPath = join(handoffDir, `${id}.md`)
    writeFileSync(handoffPath, body)
    return {
      task: { id, title: "T", workdir: dir, serial: false, file },
      handoffPath,
    }
  }

  it("embeds the handoff body in the returned text", () => {
    const promptsDir = freshPromptsDir()
    const { task, handoffPath } = withHandoff(
      "# Where we left off\n\nFinished step 1, about to do step 2.\n",
    )
    const pb = new PromptBuilder({ promptsDir })

    const r = pb.resumeWithHandoff(task, handoffPath, 2)

    expect(r.text).toContain("Finished step 1, about to do step 2.")
  })

  it("writes the prompt to promptsDir with episode + task id in filename", () => {
    const promptsDir = freshPromptsDir()
    const { task, handoffPath } = withHandoff("handoff body\n")
    const pb = new PromptBuilder({ promptsDir })

    const r = pb.resumeWithHandoff(task, handoffPath, 4)

    expect(r.path).toBeDefined()
    expect(existsSync(r.path!)).toBe(true)
    expect(dirname(r.path!)).toBe(promptsDir)
    expect(r.path).toContain(task.id)
    expect(r.path).toContain("ep4")
    expect(readFileSync(r.path!, "utf8")).toBe(r.text)
  })

  it("returned text mentions that previous session ran out of context", () => {
    const promptsDir = freshPromptsDir()
    const { task, handoffPath } = withHandoff("h\n")
    const pb = new PromptBuilder({ promptsDir })

    const r = pb.resumeWithHandoff(task, handoffPath, 2)

    expect(r.text.toLowerCase()).toContain("context")
  })
})
