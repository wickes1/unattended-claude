import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimClock } from "../src/clock.ts"
import {
  MockRuntime,
  simComplete,
  simContextFull,
  simError,
  simLost,
  simRateLimited,
  simTimeout,
  simWeeklyLimited,
} from "../src/runtime/mock-runtime.ts"
import type { InvokeOpts } from "../src/types.ts"

function makeOpts(over: Partial<InvokeOpts> = {}): InvokeOpts {
  return {
    workdir: "/tmp/wd",
    promptFile: "/tmp/prompt.md",
    sentinelFile: "/tmp/state/episode-x-1.done",
    timeoutMs: 60_000,
    parentSession: "ucl",
    tabName: "task-x-1",
    rawLogFile: "/tmp/x-1.log",
    claudeSessionId: "00000000-0000-0000-0000-000000000001",
    resume: false,
    windDownAt: null,
    wakeUpPrompt: null,
    ...over,
  }
}

describe("simComplete", () => {
  it("writes deliverables based on prompt file, writes sentinel, returns completed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-mock-complete-"))
    try {
      const workdir = join(dir, "wd")
      const stateDir = join(dir, "state")
      const promptFile = join(dir, "prompt.md")
      const sentinelFile = join(stateDir, "episode-x-1.done")
      writeFileSync(
        promptFile,
        "Write deliverables/report.md and deliverables/data.json please.\n",
        "utf8",
      )

      const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
      const before = clock.now().getTime()
      const behavior = simComplete(clock, { durationMin: 10 })
      const result = behavior(
        makeOpts({ workdir, promptFile, sentinelFile }),
        { episodeNum: 1 },
      )

      expect(result).toEqual({ status: "completed", durationMs: 10 * 60_000 })
      expect(clock.now().getTime() - before).toBe(10 * 60_000)
      expect(existsSync(sentinelFile)).toBe(true)
      expect(readFileSync(sentinelFile, "utf8")).toBe("done\n")
      expect(existsSync(join(workdir, "deliverables/report.md"))).toBe(true)
      expect(existsSync(join(workdir, "deliverables/data.json"))).toBe(true)
      const reportText = readFileSync(join(workdir, "deliverables/report.md"), "utf8")
      expect(reportText).toContain("episode 1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("simRateLimited", () => {
  it("returns rate_limited with resumeAt = now + resumeAfterMin", async () => {
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const behavior = simRateLimited(clock, 90)
    const result = await behavior(makeOpts(), { episodeNum: 1 })
    expect(result.status).toBe("rate_limited")
    if (result.status === "rate_limited") {
      // 2 min advance (during invoke) + 90 min offset
      const expected = new Date("2026-05-23T00:00:00Z").getTime() + (2 + 90) * 60_000
      expect(result.resumeAt.getTime()).toBe(expected)
    }
  })
})

describe("simTimeout", () => {
  it("returns timeout", async () => {
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const result = await simTimeout(clock, 30)(makeOpts(), { episodeNum: 1 })
    expect(result).toEqual({ status: "timeout" })
    expect(clock.now().getTime()).toBe(
      new Date("2026-05-23T00:00:00Z").getTime() + 30 * 60_000,
    )
  })
})

describe("simError", () => {
  it("returns error with reason", async () => {
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const result = await simError(clock, "boom")(makeOpts(), { episodeNum: 1 })
    expect(result).toEqual({ status: "error", reason: "boom" })
  })
})

describe("simLost", () => {
  it("returns lost with reason", async () => {
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const result = await simLost(clock, "vanished")(makeOpts(), { episodeNum: 1 })
    expect(result).toEqual({ status: "lost", reason: "vanished" })
  })
})

describe("simContextFull", () => {
  it("returns context_full with no payload", async () => {
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const result = await simContextFull(clock)(makeOpts(), { episodeNum: 1 })
    expect(result).toEqual({ status: "context_full" })
    // default 5min advance
    expect(clock.now().getTime()).toBe(
      new Date("2026-05-23T00:00:00Z").getTime() + 5 * 60_000,
    )
  })
})

describe("simWeeklyLimited", () => {
  it("returns weekly_limited with resumeAt ~ now + 2h", async () => {
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const result = await simWeeklyLimited(clock, 2)(makeOpts(), { episodeNum: 1 })
    expect(result.status).toBe("weekly_limited")
    if (result.status === "weekly_limited") {
      // 2 min advance + 2 hours
      const expected = new Date("2026-05-23T00:00:00Z").getTime() + 2 * 60_000 + 2 * 3600_000
      expect(result.resumeAt.getTime()).toBe(expected)
    }
  })
})

describe("MockRuntime", () => {
  it("throws when episodeScript is empty", () => {
    expect(() => new MockRuntime([])).toThrow(/must not be empty/)
  })

  it("invokes script in order; last behavior repeats when exhausted", async () => {
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const rt = new MockRuntime([
      simRateLimited(clock, 10),
      simTimeout(clock, 1),
      simError(clock, "final"),
    ])
    const r1 = await rt.invoke(makeOpts({ sentinelFile: "/tmp/s/e-1.done" }))
    const r2 = await rt.invoke(makeOpts({ sentinelFile: "/tmp/s/e-2.done" }))
    const r3 = await rt.invoke(makeOpts({ sentinelFile: "/tmp/s/e-3.done" }))
    // exhausted — last (simError) repeats
    const r4 = await rt.invoke(makeOpts({ sentinelFile: "/tmp/s/e-4.done" }))
    const r5 = await rt.invoke(makeOpts({ sentinelFile: "/tmp/s/e-5.done" }))

    expect(r1.status).toBe("rate_limited")
    expect(r2.status).toBe("timeout")
    expect(r3).toEqual({ status: "error", reason: "final" })
    expect(r4).toEqual({ status: "error", reason: "final" })
    expect(r5).toEqual({ status: "error", reason: "final" })
  })

  it("records each invoke in invocations array", async () => {
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const rt = new MockRuntime([simTimeout(clock, 1)])
    await rt.invoke(makeOpts({ tabName: "tab-A" }))
    await rt.invoke(makeOpts({ tabName: "tab-B" }))
    expect(rt.invocations.length).toBe(2)
    expect(rt.invocations[0]!.tabName).toBe("tab-A")
    expect(rt.invocations[1]!.tabName).toBe("tab-B")
  })

  it("episodeCalls getter returns correct count", async () => {
    const clock = new SimClock(new Date("2026-05-23T00:00:00Z"))
    const rt = new MockRuntime([simTimeout(clock, 1)])
    expect(rt.episodeCalls).toBe(0)
    await rt.invoke(makeOpts())
    expect(rt.episodeCalls).toBe(1)
    await rt.invoke(makeOpts())
    await rt.invoke(makeOpts())
    expect(rt.episodeCalls).toBe(3)
  })
})
