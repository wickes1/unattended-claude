/**
 * HANDOFF.md write/read for context-full recovery (F02).
 *
 * Two flows:
 *   - write: pollUntilDone detects context-full, injects a HANDOFF-writing
 *     prompt, waits for the file + READY line, returns handoffWritten flag.
 *   - read:  makeBuildPromptFile sees handoff_pending=true, builds the next
 *     episode's prompt from HANDOFF.md via PromptBuilder.resumeWithHandoff,
 *     and clears the flag once the new episode commits.
 */
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimClock } from "../src/clock.ts"
import { readEvents } from "../src/events.ts"
import { Layout } from "../src/layout.ts"
import { MemoryLogger } from "../src/logger.ts"
import { makeBuildPromptFile } from "../src/commands/run.ts"
import { applyResult, runEpisode, type EpisodeCtx } from "../src/orchestrator/episode.ts"
import { PromptBuilder } from "../src/orchestrator/prompt-builder.ts"
import { RateLimitGate, WeeklyLimitGate } from "../src/orchestrator/rate-limit.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"
import { pollUntilDone, type ZellijOps } from "../src/runtime/claude-session.ts"
import { MockRuntime, simComplete } from "../src/runtime/mock-runtime.ts"
import type { InvokeOpts, TaskDoc } from "../src/types.ts"
import { testConfig } from "./helpers.ts"

interface Call {
  fn: string
  args: unknown[]
}

/**
 * Fake ZellijOps where capture text is scripted by call index. Optional
 * onSend lets tests react to the injected HANDOFF-writing prompt (e.g.
 * write the handoff file from inside the fake).
 */
function fakeZellij(opts: {
  captureScript?: (callIdx: number) => string
  onSend?: (text: string) => void
  sessionAlive?: () => boolean
} = {}): { z: ZellijOps; calls: Call[] } {
  const calls: Call[] = []
  let captureIdx = 0
  const z: ZellijOps = {
    async newTab(s, t) {
      calls.push({ fn: "newTab", args: [s, t] })
    },
    async closeTab(s, t) {
      calls.push({ fn: "closeTab", args: [s, t] })
    },
    async sendKeys(s, t, ...keys) {
      calls.push({ fn: "sendKeys", args: [s, t, ...keys] })
    },
    async sendText(s, t, text) {
      calls.push({ fn: "sendText", args: [s, t, text] })
      opts.onSend?.(text)
    },
    async pasteFile(s, t, file) {
      calls.push({ fn: "pasteFile", args: [s, t, file] })
    },
    async pipePane(s, t, file) {
      calls.push({ fn: "pipePane", args: [s, t, file] })
    },
    async capture(s, t, lines) {
      const idx = captureIdx++
      const text = opts.captureScript ? opts.captureScript(idx) : "❯ "
      calls.push({ fn: "capture", args: [s, t, lines, text] })
      return text
    },
    async sessionAlive() {
      return opts.sessionAlive ? opts.sessionAlive() : true
    },
  }
  return { z, calls }
}

function makeOpts(over: Partial<InvokeOpts> = {}): InvokeOpts {
  return {
    workdir: "/tmp/wd",
    promptFile: "/tmp/prompt.md",
    sentinelFile: "/tmp/state/episode.done",
    timeoutMs: 60_000,
    parentSession: "ucl",
    tabName: "task-1",
    rawLogFile: "/tmp/raw.log",
    claudeSessionId: "abc-123",
    resume: false,
    windDownAt: null,
    wakeUpPrompt: null,
    handoffPath: "/tmp/handoff.md",
    handoffTimeoutMs: 120_000,
    ...over,
  }
}

// ── Write path — pollUntilDone ───────────────────────────────────────

describe("pollUntilDone context-full write", () => {
  test("happy path: file exists + READY → handoffWritten=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-handoff-write-"))
    try {
      const handoffPath = join(dir, "handoff.md")
      let injected = false
      // Capture flow: first capture surfaces context-full; after the prompt
      // is sent, subsequent captures include READY and the file appears.
      const { z, calls } = fakeZellij({
        captureScript: (i) => {
          if (i === 0) return "Conversation too long.\n❯ "
          // After injection, fake claude writes the file and prints READY.
          if (injected) return "wrote handoff\nREADY\n❯ "
          return "❯ "
        },
        onSend: () => {
          injected = true
          writeFileSync(handoffPath, "# handoff body\nstep 1 done.\n")
        },
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      const result = await pollUntilDone(
        makeOpts({ handoffPath, handoffTimeoutMs: 30_000 }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("context_full")
      if (result.status === "context_full") {
        expect(result.handoffWritten).toBe(true)
      }
      // Verify the HANDOFF-writing prompt was injected via sendText.
      const sent = calls.filter((c) => c.fn === "sendText")
      expect(sent.length).toBe(1)
      expect(String(sent[0]!.args[2])).toContain("HANDOFF.md")
      expect(String(sent[0]!.args[2])).toContain(handoffPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("timeout: no file, no READY → handoffWritten=false + warn log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-handoff-timeout-"))
    try {
      const handoffPath = join(dir, "handoff.md")
      const { z } = fakeZellij({
        captureScript: (i) => {
          // Always surface context-full; never produce READY, never write file.
          if (i === 0) return "Conversation too long.\n❯ "
          return "still working\n❯ "
        },
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      // Tiny timeout so the test finishes quickly. SimClock.sleep advances
      // virtual time so this exits on the first deadline check.
      const result = await pollUntilDone(
        makeOpts({ handoffPath, handoffTimeoutMs: 100 }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("context_full")
      if (result.status === "context_full") {
        expect(result.handoffWritten).toBe(false)
      }
      expect(log.has("warn", "handoff")).toBe(true)
      expect(existsSync(handoffPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("file only (no READY) → handoffWritten=true (file is authoritative)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-handoff-fileonly-"))
    try {
      const handoffPath = join(dir, "handoff.md")
      let injected = false
      const { z } = fakeZellij({
        captureScript: (i) => {
          if (i === 0) return "Conversation too long.\n❯ "
          // After injection: file written but TUI never prints READY.
          if (injected) return "still typing...\n❯ "
          return "❯ "
        },
        onSend: () => {
          injected = true
          writeFileSync(handoffPath, "# handoff (file but no READY)\n")
        },
      })
      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const log = new MemoryLogger()
      const result = await pollUntilDone(
        makeOpts({ handoffPath, handoffTimeoutMs: 30_000 }),
        testConfig(),
        log,
        clock,
        z,
      )
      expect(result.status).toBe("context_full")
      if (result.status === "context_full") {
        expect(result.handoffWritten).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── applyResult — handoff_pending flag wiring ────────────────────────

describe("applyResult: context_full sets handoff_pending from handoffWritten", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "ucl-handoff-apply-"))
    const layout = new Layout(dir)
    const clock = new SimClock(new Date("2026-05-23T22:30:00.000Z"))
    const log = new MemoryLogger()
    const store = new TaskStateStore(layout)
    const taskId = "2026-05-23-01-foo"
    const workdir = layout.taskWorkdir(taskId)
    store.init(taskId, workdir, "00000000-0000-0000-0000-000000000001")
    const task: TaskDoc = {
      id: taskId,
      title: "Foo",
      workdir,
      serial: false,
      file: layout.taskDocFile(taskId),
    }
    return { dir, layout, clock, log, store, task, taskId }
  }

  test("handoffWritten=true → handoff_pending=true", async () => {
    const s = setup()
    const ctx: EpisodeCtx = {
      runtime: new MockRuntime([simComplete(s.clock)]),
      layout: s.layout,
      log: s.log,
      clock: s.clock,
      store: s.store,
      rateLimitGate: new RateLimitGate(),
      weeklyLimitGate: new WeeklyLimitGate(s.layout),
      windowEndsAt: null,
      windDownLeadMs: 0,
      parentSession: "ucl-test",
      contextCompactThreshold: 150_000,
    }
    await applyResult(
      s.task,
      { status: "context_full", handoffWritten: true },
      ctx,
    )
    const after = s.store.load(s.taskId)!
    expect(after.handoff_pending).toBe(true)
    expect(after.paused_reason).toBe("context-full")
  })

  test("handoffWritten=false → handoff_pending=false (degraded recovery)", async () => {
    const s = setup()
    const ctx: EpisodeCtx = {
      runtime: new MockRuntime([simComplete(s.clock)]),
      layout: s.layout,
      log: s.log,
      clock: s.clock,
      store: s.store,
      rateLimitGate: new RateLimitGate(),
      weeklyLimitGate: new WeeklyLimitGate(s.layout),
      windowEndsAt: null,
      windDownLeadMs: 0,
      parentSession: "ucl-test",
      contextCompactThreshold: 150_000,
    }
    await applyResult(
      s.task,
      { status: "context_full", handoffWritten: false },
      ctx,
    )
    const after = s.store.load(s.taskId)!
    expect(after.handoff_pending).toBe(false)
    expect(after.paused_reason).toBe("context-full")
  })
})

// ── Read path — makeBuildPromptFile uses handoff when pending ────────

describe("makeBuildPromptFile: handoff read path", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "ucl-handoff-read-"))
    const layout = new Layout(dir)
    mkdirSync(layout.handoffsDir, { recursive: true })
    const clock = new SimClock(new Date("2026-05-23T22:30:00.000Z"))
    const log = new MemoryLogger()
    const store = new TaskStateStore(layout)
    const taskId = "2026-05-23-01-foo"
    const workdir = layout.taskWorkdir(taskId)
    store.init(taskId, workdir, "00000000-0000-0000-0000-000000000001")
    const task: TaskDoc = {
      id: taskId,
      title: "Foo",
      workdir,
      serial: false,
      file: layout.taskDocFile(taskId),
    }
    const promptsDir = mkdtempSync(join(tmpdir(), "ucl-handoff-prompts-"))
    const pb = new PromptBuilder({ promptsDir })
    return { dir, layout, clock, log, store, task, taskId, promptsDir, pb }
  }

  test("happy: handoff_pending=true + file exists → prompt embeds handoff body + handoff_resumed event", async () => {
    const s = setup()
    const handoffBody = "# Prior session\n\nFinished step 1.\nNext: do step 2.\n"
    writeFileSync(s.layout.handoffFile(s.taskId), handoffBody)
    await s.store.update(s.taskId, (st) => {
      st.handoff_pending = true
      st.paused_reason = "context-full"
      st.current_episode = 1
    })
    const fn = makeBuildPromptFile(s.pb, s.promptsDir, s.layout, s.clock, s.log)
    const state = s.store.load(s.taskId)!
    const promptPath = fn(s.task, 2, true, state)
    const promptText = readFileSync(promptPath, "utf8")
    expect(promptText).toContain("Finished step 1.")
    expect(promptText).toContain("Next: do step 2.")
    // handoff_resumed event was emitted.
    const events = readEvents(s.layout)
    const ev = events.find((e) => e.event === "handoff_resumed")
    expect(ev).toBeDefined()
    expect((ev as { task: string }).task).toBe(s.taskId)
    expect((ev as { path: string }).path).toBe(s.layout.handoffFile(s.taskId))
  })

  test("applyResult clears handoff_pending after the next episode commits", async () => {
    const s = setup()
    writeFileSync(s.layout.handoffFile(s.taskId), "body\n")
    await s.store.update(s.taskId, (st) => {
      st.handoff_pending = true
      st.paused_reason = "context-full"
      st.current_episode = 1
    })
    // Build the prompt (simulates the orchestrator's prompt-build step).
    const fn = makeBuildPromptFile(s.pb, s.promptsDir, s.layout, s.clock, s.log)
    fn(s.task, 2, true, s.store.load(s.taskId)!)
    expect(s.store.load(s.taskId)!.handoff_pending).toBe(true)
    // Now simulate the episode completing — applyResult clears the flag.
    const ctx: EpisodeCtx = {
      runtime: new MockRuntime([simComplete(s.clock)]),
      layout: s.layout,
      log: s.log,
      clock: s.clock,
      store: s.store,
      rateLimitGate: new RateLimitGate(),
      weeklyLimitGate: new WeeklyLimitGate(s.layout),
      windowEndsAt: null,
      windDownLeadMs: 0,
      parentSession: "ucl-test",
      contextCompactThreshold: 150_000,
    }
    await applyResult(s.task, { status: "completed", durationMs: 1000 }, ctx)
    expect(s.store.load(s.taskId)!.handoff_pending).toBe(false)
  })

  test("missing file: handoff_pending=true but file deleted → fallback to plain cue + warn log", async () => {
    const s = setup()
    // Note: do NOT write the handoff file.
    await s.store.update(s.taskId, (st) => {
      st.handoff_pending = true
      st.paused_reason = "context-full"
      st.current_episode = 1
    })
    const fn = makeBuildPromptFile(s.pb, s.promptsDir, s.layout, s.clock, s.log)
    const promptPath = fn(s.task, 2, true, s.store.load(s.taskId)!)
    const promptText = readFileSync(promptPath, "utf8")
    expect(promptText).toContain("Continue from where you left off")
    expect(s.log.has("warn", "handoff")).toBe(true)
    // No handoff_resumed event emitted.
    const ev = readEvents(s.layout).find((e) => e.event === "handoff_resumed")
    expect(ev).toBeUndefined()
  })

  test("resume=false (first episode) ignores handoff_pending entirely", async () => {
    const s = setup()
    writeFileSync(s.layout.handoffFile(s.taskId), "body\n")
    // Even with handoff_pending set (which shouldn't happen on first episode),
    // a fresh episode pastes the task doc, not the handoff.
    mkdirSync(s.layout.tasksDir, { recursive: true })
    writeFileSync(s.task.file, "# Task doc body\nDo X.\n")
    await s.store.update(s.taskId, (st) => {
      st.handoff_pending = true
    })
    const fn = makeBuildPromptFile(s.pb, s.promptsDir, s.layout, s.clock, s.log)
    const promptPath = fn(s.task, 1, false, s.store.load(s.taskId)!)
    const promptText = readFileSync(promptPath, "utf8")
    expect(promptText).toContain("# Task doc body")
    expect(promptText).not.toContain("HANDOFF.md")
  })
})

// ── runEpisode integration: handoffPath threaded into InvokeOpts ─────

describe("runEpisode threads handoffPath into InvokeOpts", () => {
  test("buildInvokeOpts sets handoffPath = layout.handoffFile(task.id)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-handoff-invoke-"))
    const layout = new Layout(dir)
    const clock = new SimClock(new Date("2026-05-23T22:30:00.000Z"))
    const log = new MemoryLogger()
    const store = new TaskStateStore(layout)
    const taskId = "2026-05-23-01-foo"
    const workdir = layout.taskWorkdir(taskId)
    store.init(taskId, workdir, "00000000-0000-0000-0000-000000000001")
    const task: TaskDoc = {
      id: taskId,
      title: "Foo",
      workdir,
      serial: false,
      file: layout.taskDocFile(taskId),
    }
    const runtime = new MockRuntime([simComplete(clock)])
    const ctx: EpisodeCtx = {
      runtime,
      layout,
      log,
      clock,
      store,
      rateLimitGate: new RateLimitGate(),
      weeklyLimitGate: new WeeklyLimitGate(layout),
      windowEndsAt: null,
      windDownLeadMs: 0,
      parentSession: "ucl-test",
      contextCompactThreshold: 150_000,
    }
    await runEpisode(task, store.load(taskId)!, ctx, join(dir, "prompt.md"), null)
    expect(runtime.invocations[0]!.handoffPath).toBe(layout.handoffFile(taskId))
    expect(runtime.invocations[0]!.handoffTimeoutMs).toBeGreaterThan(0)
  })
})
