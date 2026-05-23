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
