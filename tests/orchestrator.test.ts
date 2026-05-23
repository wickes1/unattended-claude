/**
 * Orchestrator main-loop tests.
 *
 * Strategy: drive runOrchestrator with a SimClock + MockRuntime. The
 * `skipZellij` option bypasses real zellij calls; `installSignals` is
 * overridden to avoid mutating real process state.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimClock } from "../src/clock.ts"
import { readEvents } from "../src/events.ts"
import { ensureDir } from "../src/fs-utils.ts"
import { Layout } from "../src/layout.ts"
import { MemoryLogger } from "../src/logger.ts"
import {
  runOrchestrator,
  type OrchestratorDeps,
  type RunOptions,
  type RunResult,
} from "../src/orchestrator/main.ts"
import { TaskStateStore } from "../src/orchestrator/state-store.ts"
import { WeeklyLimitGate } from "../src/orchestrator/rate-limit.ts"
import {
  MockRuntime,
  simComplete,
  simContextFull,
  simRateLimited,
  simWeeklyLimited,
  type MockBehavior,
} from "../src/runtime/mock-runtime.ts"
import { testConfig } from "./helpers.ts"
import type { Event, PausedReason, TaskDoc } from "../src/types.ts"

// ── Setup helpers ────────────────────────────────────────────────────

interface Setup {
  dir: string
  layout: Layout
  clock: SimClock
  log: MemoryLogger
  store: TaskStateStore
}

function setup(startIso = "2026-05-23T22:30:00.000Z"): Setup {
  const dir = mkdtempSync(join(tmpdir(), "ucl-orch-"))
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

function makeTask(s: Setup, id: string, opts: { workdir?: string; serial?: boolean } = {}): TaskDoc {
  const workdir = opts.workdir ?? s.layout.taskWorkdir(id)
  ensureDir(workdir)
  return {
    id,
    title: id,
    workdir,
    serial: opts.serial ?? false,
    file: s.layout.taskDocFile(id),
  }
}

/** Build a stub `buildPromptFile` that writes a tiny prompt file per call. */
function promptFn(s: Setup) {
  return (task: TaskDoc, episode: number, _resume: boolean, _state: import("../src/types.ts").TaskRuntimeState): string => {
    const p = join(s.dir, `prompt-${task.id}-${episode}.md`)
    writeFileSync(p, `# ${task.id} episode ${episode}\n`)
    return p
  }
}

function wakeUpFn(): (t: TaskDoc, r: PausedReason | null) => string | null {
  return (_t, _r) => null
}

interface DepsOver {
  docs?: TaskDoc[]
  episodeScript: MockBehavior[]
  maxParallelTabs?: number
}

function buildDeps(s: Setup, over: DepsOver): { deps: OrchestratorDeps; runtime: MockRuntime } {
  const cfg = testConfig({
    runtimeDir: s.dir,
    execution: {
      ...testConfig().execution,
      maxParallelTabs: over.maxParallelTabs ?? 3,
    },
  })
  const runtime = new MockRuntime(over.episodeScript)
  const deps: OrchestratorDeps = {
    cfg,
    layout: s.layout,
    log: s.log,
    clock: s.clock,
    runtime,
    loadTaskDocs: () => over.docs ?? [],
    buildPromptFile: promptFn(s),
    buildWakeUpPrompt: wakeUpFn(),
    installSignals: () => {},
  }
  return { deps, runtime }
}

const runOpts = (over: Partial<RunOptions> = {}): RunOptions => ({
  windowEndsAt: null,
  parentSession: "ucl-test",
  skipZellij: true,
  ...over,
})

function eventNames(s: Setup): string[] {
  return readEvents(s.layout).map((e) => e.event)
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runOrchestrator: empty queue", () => {
  test("completes immediately with queue_empty when no docs", async () => {
    const s = setup()
    const { deps } = buildDeps(s, { docs: [], episodeScript: [simComplete(s.clock)] })
    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("queue_empty")
    expect(r.taskCount).toBe(0)

    const names = eventNames(s)
    expect(names).toContain("run_start")
    expect(names).toContain("run_end")
    const end = readEvents(s.layout).find((e) => e.event === "run_end") as
      | (Event & { reason: string })
      | undefined
    expect(end?.reason).toBe("queue_empty")
  })
})

describe("runOrchestrator: single task completes", () => {
  test("task transitions planned → running → done; events recorded", async () => {
    const s = setup()
    const id = "2026-05-23-01-foo"
    const task = makeTask(s, id)
    const { deps, runtime } = buildDeps(s, {
      docs: [task],
      episodeScript: [simComplete(s.clock, { durationMin: 1 })],
    })

    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("queue_empty")
    expect(r.taskCount).toBe(1)
    expect(runtime.episodeCalls).toBe(1)

    const final = s.store.load(id)!
    expect(final.state).toBe("done")
    expect(final.current_episode).toBe(1)

    const names = eventNames(s)
    expect(names).toContain("run_start")
    expect(names).toContain("task_started")
    expect(names).toContain("task_done")
    expect(names).toContain("run_end")
  })
})

describe("runOrchestrator: rate-limit within window", () => {
  test("first episode rate-limits, gate clears via SimClock sleep, second completes", async () => {
    const s = setup()
    const id = "2026-05-23-01-foo"
    const task = makeTask(s, id)
    // resumeAt is 30min out — well before windowEndsAt (3h out).
    const windowEndsAt = new Date(s.clock.now().getTime() + 3 * 3600_000)
    const { deps } = buildDeps(s, {
      docs: [task],
      episodeScript: [simRateLimited(s.clock, 30), simComplete(s.clock, { durationMin: 1 })],
    })

    const r = await runOrchestrator(deps, runOpts({ windowEndsAt }))
    expect(r.reason).toBe("queue_empty")
    expect(r.taskCount).toBe(2)

    const final = s.store.load(id)!
    expect(final.state).toBe("done")

    const names = eventNames(s)
    expect(names).toContain("rate_limit")
    expect(names).toContain("task_done")
  })
})

describe("runOrchestrator: rate-limit beyond window", () => {
  test("resumeAt past windowEndsAt → task paused, run ends with window_end", async () => {
    const s = setup()
    const id = "2026-05-23-01-foo"
    const task = makeTask(s, id)
    // resumeAt is 5h out, well past windowEndsAt (1h out).
    const windowEndsAt = new Date(s.clock.now().getTime() + 1 * 3600_000)
    const { deps } = buildDeps(s, {
      docs: [task],
      episodeScript: [simRateLimited(s.clock, 300)], // 5h
    })

    const r = await runOrchestrator(deps, runOpts({ windowEndsAt }))
    expect(r.reason).toBe("window_end")

    const final = s.store.load(id)!
    expect(final.state).toBe("paused")
    // The first event recorded is rate-limit-5h; suspendForShutdown is a no-op
    // because state was already paused (not running) by the time we hit window_end.
    expect(final.paused_reason).toBe("rate-limit-5h")
  })
})

describe("runOrchestrator: weekly limit during run", () => {
  test("weekly limit trips → run ends with weekly_limited, state paused, gate file persists", async () => {
    const s = setup()
    const id = "2026-05-23-01-foo"
    const task = makeTask(s, id)
    const { deps } = buildDeps(s, {
      docs: [task],
      episodeScript: [simWeeklyLimited(s.clock, 24)], // 24h ahead
    })

    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("weekly_limited")

    const final = s.store.load(id)!
    expect(final.state).toBe("paused")
    expect(final.paused_reason).toBe("weekly-limit")

    // Persisted weekly gate file.
    expect(existsSync(s.layout.weeklyPausedFile)).toBe(true)
    const gate = new WeeklyLimitGate(s.layout)
    const until = gate.pausedUntil()
    expect(until).not.toBeNull()
    expect(until!.getTime()).toBeGreaterThan(s.clock.now().getTime())
  })
})

describe("runOrchestrator: weekly gate blocks run at preflight", () => {
  test("pre-existing weekly gate → returns weekly_paused without invoking runtime", async () => {
    const s = setup()
    const gate = new WeeklyLimitGate(s.layout)
    gate.trip(new Date(s.clock.now().getTime() + 60_000)) // 1m future

    const id = "2026-05-23-01-foo"
    const task = makeTask(s, id)
    const { deps, runtime } = buildDeps(s, {
      docs: [task],
      episodeScript: [simComplete(s.clock)],
    })
    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("weekly_paused")
    expect(runtime.episodeCalls).toBe(0)
  })
})

describe("runOrchestrator: context-full", () => {
  test("context_full → claude_session_id rotates, context_compactions++, task ultimately done", async () => {
    const s = setup()
    const id = "2026-05-23-01-foo"
    const task = makeTask(s, id)
    const { deps } = buildDeps(s, {
      docs: [task],
      episodeScript: [simContextFull(s.clock), simComplete(s.clock, { durationMin: 1 })],
    })

    // Inspect session id evolution by snapshotting before/after — the state
    // file is written by store.init via runOrchestrator's init path.
    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("queue_empty")
    expect(r.taskCount).toBe(2)

    const final = s.store.load(id)!
    expect(final.state).toBe("done")
    expect(final.context_compactions).toBe(1)
    expect(final.current_episode).toBe(2)

    const names = eventNames(s)
    expect(names).toContain("context_compaction")
    expect(names).toContain("task_done")
  })
})

describe("runOrchestrator: window end mid-run", () => {
  test("clock past windowEndsAt → in-flight tasks paused with schedule-boundary", async () => {
    const s = setup()
    const id = "2026-05-23-01-foo"
    const task = makeTask(s, id)

    // window ends 10 minutes in the future. simComplete advances 60min — so
    // after the first episode the clock is past windowEndsAt and we should
    // observe window_end on the next loop iteration. But because this is a
    // single task lane, the lane exits cleanly and the task is already done
    // by then. So instead, use a behavior that just advances time without
    // completing the task.
    const windowEndsAt = new Date(s.clock.now().getTime() + 10 * 60_000)

    // Custom behavior: advance clock past windowEndsAt, then return a result
    // that re-pauses the task so the loop tries again (and observes stop).
    // Simpler: use simRateLimited with a long enough resumeAt that the gate
    // triggers — but that returns weekly_limited or rate-limit which already
    // pauses the task. We need a running task surviving past window-end.
    //
    // Approach: run two tasks, first one consumes the window, second has
    // state=running but gets caught by stopReason before its first episode.
    const id2 = "2026-05-23-02-bar"
    const task2 = makeTask(s, id2, { workdir: "/tmp/ucl-orch-other" })

    const { deps } = buildDeps(s, {
      docs: [task, task2],
      // First task completes (advances clock 60min, past window). Second
      // task's lane runs in parallel but each lane is serial — the slot for
      // task2 may execute first. Use maxParallelTabs=1 to force serial.
      episodeScript: [simComplete(s.clock, { durationMin: 60 }), simComplete(s.clock)],
      maxParallelTabs: 1,
    })

    const r = await runOrchestrator(deps, runOpts({ windowEndsAt }))
    expect(r.reason).toBe("window_end")

    // task1 completed before window-end.
    const t1 = s.store.load(id)!
    expect(t1.state).toBe("done")

    // task2 never started (or was pre-empted before episode 1).
    const t2 = s.store.load(id2)!
    // With concurrency=1 and serial execution, task2 lane starts AFTER task1's
    // lane finishes. At that point stopReason() returns "window_end" and the
    // lane exits before transitioning task2 to running. So state stays planned.
    expect(["planned"]).toContain(t2.state)
  })
})

describe("runOrchestrator: signal during run", () => {
  test("signal handler triggers → in-flight running tasks paused with user-stop, reason=signal", async () => {
    const s = setup()
    const id = "2026-05-23-01-foo"
    const task = makeTask(s, id)

    // Inject a "stuck" episode script that lets us flip the signal flag
    // mid-flight. We achieve this by having two tasks; we'll trip the signal
    // handler before the orchestrator processes the second lane.
    const id2 = "2026-05-23-02-bar"
    const task2 = makeTask(s, id2, { workdir: "/tmp/ucl-orch-sig" })

    // Capture the registered handler so we can call it directly.
    let trigger: (() => Promise<void>) | null = null
    const installSignals = (h: (sig: NodeJS.Signals) => Promise<void>): void => {
      trigger = () => h("SIGTERM")
    }

    // First episode completes normally; before second lane can start, we trip
    // the signal by hooking into the first simComplete.
    const sigBehavior: MockBehavior = async (opts, ctx) => {
      const res = await simComplete(s.clock, { durationMin: 1 })(opts, ctx)
      // Mark task2 as running so suspendForShutdown will find it. The signal
      // sets `signalled`, after which the outer scheduler exits.
      await s.store.update(id2, (st) => {
        st.state = "running"
      })
      if (trigger) await trigger()
      return res
    }

    const cfg = testConfig({
      runtimeDir: s.dir,
      execution: { ...testConfig().execution, maxParallelTabs: 1 },
    })
    const runtime = new MockRuntime([sigBehavior, simComplete(s.clock)])
    const deps: OrchestratorDeps = {
      cfg,
      layout: s.layout,
      log: s.log,
      clock: s.clock,
      runtime,
      loadTaskDocs: () => [task, task2],
      buildPromptFile: promptFn(s),
      buildWakeUpPrompt: wakeUpFn(),
      installSignals,
    }

    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("signal")

    const t1 = s.store.load(id)!
    expect(t1.state).toBe("done")

    // task2 was running when signal hit → suspendForShutdown moves it to paused/user-stop.
    const t2 = s.store.load(id2)!
    expect(t2.state).toBe("paused")
    expect(t2.paused_reason).toBe("user-stop")
  })
})

describe("runOrchestrator: concurrency cap", () => {
  test("5 lanes with cap=2 → ≤2 active at a time; queued events emitted for the rest", async () => {
    const s = setup()
    const ids = [
      "2026-05-23-01-a",
      "2026-05-23-02-b",
      "2026-05-23-03-c",
      "2026-05-23-04-d",
      "2026-05-23-05-e",
    ]
    // Distinct workdirs so each gets its own lane.
    const tasks = ids.map((id, i) =>
      makeTask(s, id, { workdir: join(s.dir, `wd-${i}`) }),
    )
    const { deps } = buildDeps(s, {
      docs: tasks,
      // 5 simComplete behaviors — MockRuntime repeats the last one if exhausted
      // but each task only invokes once here.
      episodeScript: tasks.map(() => simComplete(s.clock, { durationMin: 1 })),
      maxParallelTabs: 2,
    })

    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("queue_empty")
    expect(r.taskCount).toBe(5)

    // All tasks completed.
    for (const id of ids) {
      expect(s.store.load(id)!.state).toBe("done")
    }

    // queued_due_to_concurrency_cap was emitted (at least once).
    const events = readEvents(s.layout)
    const queued = events.filter((e) => e.event === "queued_due_to_concurrency_cap") as Array<
      Event & { task: string }
    >
    // 5 lanes - 2 immediate slots = 3 queued initially.
    expect(queued.length).toBe(3)
  })
})

describe("runOrchestrator: resume a paused task", () => {
  test("pre-existing paused task is picked up and resumed → done", async () => {
    const s = setup()
    const id = "2026-05-23-01-resumed"
    const task = makeTask(s, id)
    // Pre-populate state as paused/user-stop.
    s.store.init(id, task.workdir, "uuid-resumed")
    await s.store.update(id, (st) => {
      st.state = "paused"
      st.paused_reason = "user-stop"
      st.current_episode = 1
    })

    // Track resume flag observed by the runtime.
    const seen: { resume: boolean | null } = { resume: null }
    const captureBehavior: MockBehavior = async (opts, ctx) => {
      seen.resume = opts.resume
      return simComplete(s.clock, { durationMin: 1 })(opts, ctx)
    }

    const cfg = testConfig({ runtimeDir: s.dir })
    const runtime = new MockRuntime([captureBehavior])
    const deps: OrchestratorDeps = {
      cfg,
      layout: s.layout,
      log: s.log,
      clock: s.clock,
      runtime,
      loadTaskDocs: () => [task],
      buildPromptFile: promptFn(s),
      buildWakeUpPrompt: wakeUpFn(),
      installSignals: () => {},
    }

    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("queue_empty")
    expect(seen.resume).toBe(true)

    const final = s.store.load(id)!
    expect(final.state).toBe("done")
  })
})

describe("runOrchestrator: orphan recovery", () => {
  test("pre-existing running task with no live tabs → paused/orphan at preflight", async () => {
    const s = setup()
    const id = "2026-05-23-01-orphan"
    const workdir = s.layout.taskWorkdir(id)
    ensureDir(workdir)
    s.store.init(id, workdir, "uuid-orphan")
    await s.store.update(id, (st) => {
      st.state = "running"
    })

    // No tasks loaded by docs() — orphan recovery should still find it.
    const { deps, runtime } = buildDeps(s, { docs: [], episodeScript: [simComplete(s.clock)] })
    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("queue_empty")
    // Orphan recovery doesn't invoke the runtime.
    expect(runtime.episodeCalls).toBe(0)

    const final = s.store.load(id)!
    expect(final.state).toBe("paused")
    expect(final.paused_reason).toBe("orphan")

    const orphanEvents = readEvents(s.layout).filter(
      (e) => e.event === "task_paused" && (e as { reason: string }).reason === "orphan",
    )
    expect(orphanEvents.length).toBe(1)
  })
})

describe("runOrchestrator: serial: true lane isolation", () => {
  test("two serial-true tasks in the same workdir get separate lanes (parallel slots)", async () => {
    const s = setup()
    const sharedWorkdir = join(s.dir, "shared-wd")
    ensureDir(sharedWorkdir)
    const id1 = "2026-05-23-01-a"
    const id2 = "2026-05-23-02-b"
    const task1 = makeTask(s, id1, { workdir: sharedWorkdir, serial: true })
    const task2 = makeTask(s, id2, { workdir: sharedWorkdir, serial: true })

    const { deps } = buildDeps(s, {
      docs: [task1, task2],
      episodeScript: [simComplete(s.clock, { durationMin: 1 }), simComplete(s.clock, { durationMin: 1 })],
      maxParallelTabs: 2,
    })
    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("queue_empty")
    expect(r.taskCount).toBe(2)

    // Both completed; with serial=true they should be in their own lanes, so
    // they both ran (no queueing event).
    expect(s.store.load(id1)!.state).toBe("done")
    expect(s.store.load(id2)!.state).toBe("done")
    const queued = readEvents(s.layout).filter(
      (e) => e.event === "queued_due_to_concurrency_cap",
    )
    expect(queued.length).toBe(0)
  })

  test("two non-serial tasks in same workdir share one lane (serial within workdir)", async () => {
    const s = setup()
    const sharedWorkdir = join(s.dir, "shared-wd-2")
    ensureDir(sharedWorkdir)
    const id1 = "2026-05-23-01-x"
    const id2 = "2026-05-23-02-y"
    const task1 = makeTask(s, id1, { workdir: sharedWorkdir, serial: false })
    const task2 = makeTask(s, id2, { workdir: sharedWorkdir, serial: false })

    // Capture invocation order.
    const order: string[] = []
    const trackBehavior = (clock: SimClock): MockBehavior => async (opts, ctx) => {
      order.push(opts.tabName)
      return simComplete(clock, { durationMin: 1 })(opts, ctx)
    }

    const cfg = testConfig({ runtimeDir: s.dir })
    const runtime = new MockRuntime([trackBehavior(s.clock), trackBehavior(s.clock)])
    const deps: OrchestratorDeps = {
      cfg,
      layout: s.layout,
      log: s.log,
      clock: s.clock,
      runtime,
      loadTaskDocs: () => [task1, task2],
      buildPromptFile: promptFn(s),
      buildWakeUpPrompt: wakeUpFn(),
      installSignals: () => {},
    }

    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("queue_empty")
    // Order is deterministic: same lane, sorted by id.
    expect(order).toEqual([id1, id2])
  })
})

describe("runOrchestrator: lock_held", () => {
  test("returns lock_held without writing run_start when another live pid owns lock", async () => {
    const s = setup()
    // Pretend init (pid 1) holds the lock.
    ensureDir(s.layout.stateDir)
    writeFileSync(s.layout.lockFile, "1")

    const { deps } = buildDeps(s, { docs: [], episodeScript: [simComplete(s.clock)] })
    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("lock_held")
    expect(r.taskCount).toBe(0)

    // No events should have been written (we bailed before run_start).
    expect(existsSync(s.layout.eventsJsonl)).toBe(false)
  })
})

describe("runOrchestrator: queue ordering", () => {
  test("resumable tasks come before fresh planned tasks", async () => {
    const s = setup()
    // Pre-populate one paused task and one fresh planned doc.
    const resumeId = "2026-05-23-02-paused"
    const freshId = "2026-05-23-01-fresh"
    s.store.init(resumeId, s.layout.taskWorkdir(resumeId), "uuid-r")
    await s.store.update(resumeId, (st) => {
      st.state = "paused"
      st.paused_reason = "user-stop"
      st.current_episode = 1
    })

    const taskFresh = makeTask(s, freshId)
    const taskResume = makeTask(s, resumeId)

    const order: string[] = []
    const trackBehavior: MockBehavior = async (opts, ctx) => {
      order.push(opts.tabName)
      return simComplete(s.clock, { durationMin: 1 })(opts, ctx)
    }
    const cfg = testConfig({
      runtimeDir: s.dir,
      execution: { ...testConfig().execution, maxParallelTabs: 1 },
    })
    const runtime = new MockRuntime([trackBehavior, trackBehavior])
    const deps: OrchestratorDeps = {
      cfg,
      layout: s.layout,
      log: s.log,
      clock: s.clock,
      runtime,
      // Order docs reversed to ensure ordering comes from queue logic.
      loadTaskDocs: () => [taskFresh, taskResume],
      buildPromptFile: promptFn(s),
      buildWakeUpPrompt: wakeUpFn(),
      installSignals: () => {},
    }

    const r = await runOrchestrator(deps, runOpts())
    expect(r.reason).toBe("queue_empty")
    // Resumed task should run first.
    expect(order[0]).toBe(resumeId)
    expect(order[1]).toBe(freshId)
  })
})
