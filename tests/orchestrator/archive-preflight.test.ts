/**
 * F10: archive.auto_after_days preflight wiring.
 *
 * At orchestrator run start, if `cfg.archive.autoAfterDays > 0`, find tasks
 * whose `last_updated` is older than that threshold AND in a terminal state
 * (done/failed) and archive them. Emit `archive_auto` event per archived task.
 *
 * Invariants:
 *   - Auto-archive runs BEFORE the queue is built (no terminal tasks should
 *     reach the queue logic anyway, but ordering matters for log output).
 *   - autoAfterDays=0 disables auto-archive (no candidate scan, no events).
 *   - Non-terminal tasks (running/paused/planned) are never auto-archived,
 *     even if last_updated is old (orphan recovery handles those).
 *   - A failure archiving one task does NOT abort the run.
 *   - When no candidates match, no spurious events are emitted (Rule 12).
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimClock } from "../../src/clock.ts"
import { readEvents } from "../../src/events.ts"
import { ensureDir } from "../../src/fs-utils.ts"
import { Layout } from "../../src/layout.ts"
import { MemoryLogger } from "../../src/logger.ts"
import {
  runOrchestrator,
  type OrchestratorDeps,
  type RunOptions,
} from "../../src/orchestrator/main.ts"
import { TaskStateStore } from "../../src/orchestrator/state-store.ts"
import { MockRuntime, simComplete } from "../../src/runtime/mock-runtime.ts"
import { testConfig } from "../helpers.ts"
import type { Event, TaskRuntimeState } from "../../src/types.ts"

// ── Setup ──────────────────────────────────────────────────────────────

interface Setup {
  dir: string
  layout: Layout
  clock: SimClock
  log: MemoryLogger
  store: TaskStateStore
}

function setup(startIso = "2026-05-23T22:30:00.000Z"): Setup {
  const dir = mkdtempSync(join(tmpdir(), "ucl-arch-preflight-"))
  const layout = new Layout(dir)
  ensureDir(layout.stateDir)
  const clock = new SimClock(new Date(startIso))
  return {
    dir,
    layout,
    clock,
    log: new MemoryLogger(),
    store: new TaskStateStore(layout, clock),
  }
}

/** Seed a task state file with given state + last_updated offset (negative = past). */
function seedTaskState(
  layout: Layout,
  id: string,
  state: TaskRuntimeState["state"],
  lastUpdated: Date,
): void {
  ensureDir(layout.taskStatesDir)
  ensureDir(layout.tasksDir)
  ensureDir(layout.workdirsDir)
  writeFileSync(layout.taskDocFile(id), `# ${id}\n`)
  ensureDir(layout.taskWorkdir(id))
  writeFileSync(join(layout.taskWorkdir(id), "scratch.txt"), `scratch ${id}\n`)
  const s: TaskRuntimeState = {
    schema_version: 1,
    task_id: id,
    state,
    paused_reason: null,
    claude_session_id: `uuid-${id}`,
    current_episode: 1,
    context_compactions: 0,
    created_at: lastUpdated.toISOString(),
    last_updated: lastUpdated.toISOString(),
    workdir: layout.taskWorkdir(id),
    handoff_pending: false,
  }
  writeFileSync(layout.taskStateFile(id), JSON.stringify(s, null, 2))
}

function buildDeps(
  s: Setup,
  over: { autoAfterDays?: number } = {},
): OrchestratorDeps {
  const baseCfg = testConfig({ runtimeDir: s.dir })
  const cfg =
    over.autoAfterDays !== undefined
      ? { ...baseCfg, archive: { autoAfterDays: over.autoAfterDays } }
      : baseCfg
  return {
    cfg,
    layout: s.layout,
    log: s.log,
    clock: s.clock,
    runtime: new MockRuntime([simComplete(s.clock)]),
    loadTaskDocs: () => [],
    buildPromptFile: (_t, _e, _r, _st) => "/dev/null",
    buildWakeUpPrompt: () => null,
    installSignals: () => {},
  }
}

const runOpts: RunOptions = {
  windowEndsAt: null,
  parentSession: "ucl-test",
  skipZellij: true,
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("runOrchestrator: auto-archive preflight (F10)", () => {
  test("archives only done/failed tasks older than threshold, emits archive_auto per task", async () => {
    const s = setup()
    const now = s.clock.now()
    const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000)
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)

    // Done, 3 days old → NOT archived (within 7d window).
    seedTaskState(s.layout, "2026-05-20-01-recent", "done", threeDaysAgo)
    // Done, 10 days old → archived.
    seedTaskState(s.layout, "2026-05-13-01-stale", "done", tenDaysAgo)

    const deps = buildDeps(s, { autoAfterDays: 7 })
    await runOrchestrator(deps, runOpts)

    // Recent task untouched.
    expect(existsSync(s.layout.taskDocFile("2026-05-20-01-recent"))).toBe(true)
    expect(existsSync(s.layout.taskArchiveDir("2026-05-20-01-recent"))).toBe(false)

    // Stale task moved to archive.
    expect(existsSync(s.layout.taskDocFile("2026-05-13-01-stale"))).toBe(false)
    expect(existsSync(s.layout.taskArchiveDir("2026-05-13-01-stale"))).toBe(true)

    // Exactly one archive_auto event, for the stale id.
    const autoEvents = readEvents(s.layout).filter(
      (e) => e.event === "archive_auto",
    ) as Array<Event & { task: string }>
    expect(autoEvents.length).toBe(1)
    expect(autoEvents[0]!.task).toBe("2026-05-13-01-stale")
  })

  test("autoAfterDays=0 disables auto-archive (no scan, no events)", async () => {
    const s = setup()
    const tenDaysAgo = new Date(s.clock.now().getTime() - 10 * 86_400_000)
    seedTaskState(s.layout, "2026-05-13-01-stale", "done", tenDaysAgo)

    const deps = buildDeps(s, { autoAfterDays: 0 })
    await runOrchestrator(deps, runOpts)

    // Stale task NOT archived because feature disabled.
    expect(existsSync(s.layout.taskDocFile("2026-05-13-01-stale"))).toBe(true)
    expect(existsSync(s.layout.taskArchiveDir("2026-05-13-01-stale"))).toBe(false)

    const autoEvents = readEvents(s.layout).filter(
      (e) => e.event === "archive_auto",
    )
    expect(autoEvents.length).toBe(0)
  })

  test("non-terminal tasks are never auto-archived even if last_updated is old", async () => {
    const s = setup()
    const tenDaysAgo = new Date(s.clock.now().getTime() - 10 * 86_400_000)
    // in_progress proxy: "paused" (long-stale paused tasks must stay live).
    // Also a planned and a running, all 10 days stale.
    seedTaskState(s.layout, "2026-05-13-01-paused", "paused", tenDaysAgo)
    seedTaskState(s.layout, "2026-05-13-02-planned", "planned", tenDaysAgo)
    // "running" would be picked up by orphan recovery and flipped to paused;
    // it is still not a terminal state so must not be auto-archived.
    seedTaskState(s.layout, "2026-05-13-03-running", "running", tenDaysAgo)

    const deps = buildDeps(s, { autoAfterDays: 7 })
    await runOrchestrator(deps, runOpts)

    // None archived.
    for (const id of [
      "2026-05-13-01-paused",
      "2026-05-13-02-planned",
      "2026-05-13-03-running",
    ]) {
      expect(existsSync(s.layout.taskArchiveDir(id))).toBe(false)
    }
    const autoEvents = readEvents(s.layout).filter(
      (e) => e.event === "archive_auto",
    )
    expect(autoEvents.length).toBe(0)
  })

  test("no candidates → no spurious events (Rule 12)", async () => {
    const s = setup()
    // Empty state dir, autoAfterDays=7.
    const deps = buildDeps(s, { autoAfterDays: 7 })
    await runOrchestrator(deps, runOpts)
    const autoEvents = readEvents(s.layout).filter(
      (e) => e.event === "archive_auto",
    )
    expect(autoEvents.length).toBe(0)
  })

  test("failed tasks beyond threshold are also auto-archived", async () => {
    const s = setup()
    const tenDaysAgo = new Date(s.clock.now().getTime() - 10 * 86_400_000)
    seedTaskState(s.layout, "2026-05-13-01-failed", "failed", tenDaysAgo)

    const deps = buildDeps(s, { autoAfterDays: 7 })
    await runOrchestrator(deps, runOpts)

    expect(existsSync(s.layout.taskArchiveDir("2026-05-13-01-failed"))).toBe(true)
    const autoEvents = readEvents(s.layout).filter(
      (e) => e.event === "archive_auto",
    ) as Array<Event & { task: string }>
    expect(autoEvents.length).toBe(1)
    expect(autoEvents[0]!.task).toBe("2026-05-13-01-failed")
  })
})
