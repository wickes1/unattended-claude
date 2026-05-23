/**
 * End-to-end milestone test (DESIGN §十五).
 *
 * Walks the full v2 lifecycle in a single integration test using SimClock +
 * MockRuntime — no real claude / zellij / launchd. Demonstrates:
 *
 *   1. Init dirs + task doc placed → loadTaskDocs parses it
 *   2. Window 1: rate-limit beyond window → task paused/rate-limit-5h
 *   3. Window 2 (fresh orchestrator call, clock past reset): task resumes → done
 *   4. events.jsonl contains the expected sequence (start/paused/resume/done/end)
 *   5. ucl stats sees 1 done task
 *   6. ucl archive moves the bundle into archive/<id>/ after 7 days
 *
 * This test is load-bearing: if it fails, something is wrong upstream.
 */
import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimClock } from "../src/clock.ts"
import { readEvents } from "../src/events.ts"
import { Layout } from "../src/layout.ts"
import { MemoryLogger } from "../src/logger.ts"
import { archiveOne, findArchiveCandidates } from "../src/commands/archive.ts"
import { buildStats } from "../src/commands/stats.ts"
import { extractSummary } from "../src/commands/review.ts"
import {
  loadTaskDocs,
  makeBuildPromptFile,
  makeBuildWakeUpPrompt,
} from "../src/commands/run.ts"
import { runOrchestrator, type OrchestratorDeps } from "../src/orchestrator/main.ts"
import { PromptBuilder } from "../src/orchestrator/prompt-builder.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"
import { MockRuntime, simComplete, simRateLimited } from "../src/runtime/mock-runtime.ts"
import { testConfig } from "./helpers.ts"
import type { Event } from "../src/types.ts"

describe("e2e milestone — paused (rate-limit) → resumed → done → archive", () => {
  it("walks the full lifecycle end-to-end with MockRuntime", async () => {
    // ── 1. Init runtime dir tree (equivalent of `ucl init`) ─────────────
    const runtimeDir = mkdtempSync(join(tmpdir(), "ucl-e2e-"))
    const layout = new Layout(runtimeDir)
    const log = new MemoryLogger()
    const clock = new SimClock(new Date("2026-05-23T22:30:00.000Z"))

    for (const d of [
      layout.tasksDir,
      layout.workdirsDir,
      layout.archiveDir,
      layout.stateDir,
      layout.taskStatesDir,
      layout.handoffsDir,
      layout.logsDir,
    ]) {
      mkdirSync(d, { recursive: true })
    }
    writeFileSync(layout.todoFile, "- hello from window N\n")

    // ── 2. Place fixture task doc (equivalent of `ucl plan`) ────────────
    const taskId = "2026-05-23-01-hello"
    const fixturePath = join(import.meta.dir, "fixtures", "milestone-task.md")
    writeFileSync(layout.taskDocFile(taskId), readFileSync(fixturePath, "utf8"))

    // Sanity: loadTaskDocs parses our fixture correctly.
    const docs0 = loadTaskDocs(layout)
    expect(docs0.length).toBe(1)
    expect(docs0[0]!.id).toBe(taskId)
    expect(docs0[0]!.title).toBe("hello-from-window-N")
    expect(docs0[0]!.serial).toBe(false)
    expect(docs0[0]!.workdir).toBe(layout.taskWorkdir(taskId))

    const cfg = testConfig({ runtimeDir })
    const store = new TaskStateStore(layout)

    // ── 3. WINDOW 1: rate-limit beyond window → task pauses ─────────────
    // Window is 5 minutes wide; the rate-limit fires with resumeAt 60min out,
    // so the orchestrator's pre-window short-circuit exits with window_end
    // after applyResult marked the task paused/rate-limit-5h.
    const runtime1 = new MockRuntime([simRateLimited(clock, 60)])
    const win1End = new Date(clock.now().getTime() + 5 * 60_000)
    const promptsDir = mkdtempSync(join(tmpdir(), "ucl-e2e-prompts-"))
    const pb = new PromptBuilder({ promptsDir })
    const deps1: OrchestratorDeps = {
      cfg,
      layout,
      log,
      clock,
      runtime: runtime1,
      loadTaskDocs: () => loadTaskDocs(layout),
      buildPromptFile: makeBuildPromptFile(pb, promptsDir),
      buildWakeUpPrompt: makeBuildWakeUpPrompt(pb),
      installSignals: () => {}, // bypass real signal handlers
    }
    const result1 = await runOrchestrator(deps1, {
      windowEndsAt: win1End,
      parentSession: "unattended-claude",
      skipZellij: true,
    })
    expect(result1.reason).toBe("window_end")
    expect(result1.taskCount).toBe(1) // one episode invoked

    const after1 = store.load(taskId)
    expect(after1).not.toBeNull()
    expect(after1!.state).toBe("paused")
    expect(after1!.paused_reason).toBe("rate-limit-5h")
    expect(after1!.current_episode).toBe(1)

    // ── 4. WINDOW 2: rate-limit cleared, task resumes → done ────────────
    clock.advance(70 * 60_000) // 70 minutes later — past the 60min reset
    const runtime2 = new MockRuntime([simComplete(clock, { durationMin: 5 })])
    const win2End = new Date(clock.now().getTime() + 10 * 60_000)
    const deps2: OrchestratorDeps = {
      ...deps1,
      runtime: runtime2,
    }
    const result2 = await runOrchestrator(deps2, {
      windowEndsAt: win2End,
      parentSession: "unattended-claude",
      skipZellij: true,
    })
    expect(result2.reason).toBe("queue_empty")
    expect(result2.taskCount).toBe(1) // one more episode invoked

    const after2 = store.load(taskId)
    expect(after2).not.toBeNull()
    expect(after2!.state).toBe("done")
    expect(after2!.paused_reason).toBeNull()
    expect(after2!.current_episode).toBe(2)

    // ── 5. events.jsonl contains the expected sequence ──────────────────
    const events = readEvents(layout)
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes).toContain("run_start")
    expect(eventTypes).toContain("task_started")
    expect(eventTypes).toContain("rate_limit")
    expect(eventTypes).toContain("task_paused")
    expect(eventTypes).toContain("task_done")
    expect(eventTypes).toContain("run_end")

    // Two run_start / run_end pairs (one per window invocation).
    expect(eventTypes.filter((t) => t === "run_start").length).toBe(2)
    expect(eventTypes.filter((t) => t === "run_end").length).toBe(2)

    // Two task_started events: first not-resumed, second resumed.
    const taskStarted = events.filter(
      (e): e is Event & { event: "task_started"; episode: number; resumed: boolean } =>
        e.event === "task_started",
    )
    expect(taskStarted.length).toBe(2)
    expect(taskStarted[0]!.resumed).toBe(false)
    expect(taskStarted[0]!.episode).toBe(1)
    expect(taskStarted[1]!.resumed).toBe(true)
    expect(taskStarted[1]!.episode).toBe(2)

    // The paused event is rate-limit-5h (not schedule-boundary — applyResult
    // ran before suspendForShutdown could observe a running task).
    const taskPaused = events.filter(
      (e): e is Event & { event: "task_paused"; reason: string } =>
        e.event === "task_paused",
    )
    expect(taskPaused.length).toBe(1)
    expect(taskPaused[0]!.reason).toBe("rate-limit-5h")

    // ── 6. extractSummary on the task doc returns the placeholder text ──
    const docContent = readFileSync(layout.taskDocFile(taskId), "utf8")
    const summary = extractSummary(docContent)
    expect(summary).toBe("(filled at done)")

    // ── 7. ucl stats: 1 done task, 0 failed ─────────────────────────────
    const stats = buildStats(layout, "/nonexistent-claude-projects-dir", 7, clock.now())
    expect(stats.totalTasksDone).toBe(1)
    expect(stats.totalTasksFailed).toBe(0)

    // ── 8. Archive after 7 days ─────────────────────────────────────────
    clock.advance(8 * 24 * 3600_000) // 8 days later
    const cands = findArchiveCandidates(layout, 7, clock.now())
    expect(cands.map((c) => c.task_id)).toContain(taskId)

    const archived = archiveOne(layout, taskId, clock.now())
    expect(archived).toBe(true)

    // Bundle structure on disk.
    const archDir = layout.taskArchiveDir(taskId)
    expect(existsSync(archDir)).toBe(true)
    expect(existsSync(join(archDir, "task.md"))).toBe(true)
    expect(existsSync(join(archDir, "state.json"))).toBe(true)

    // Active state and task doc are gone.
    expect(existsSync(layout.taskStateFile(taskId))).toBe(false)
    expect(existsSync(layout.taskDocFile(taskId))).toBe(false)

    // archive_moved event appended.
    const finalEvents = readEvents(layout)
    expect(finalEvents.some((e) => e.event === "archive_moved")).toBe(true)
  })
})
