import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { cmdStop, parseStopArgs } from "../src/commands/stop.ts"
import { Layout } from "../src/layout.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-stop-"))
  return new Layout(dir)
}

describe("parseStopArgs", () => {
  it("parses --now flag", () => {
    expect(parseStopArgs(["--now"])).toEqual({ now: true })
  })

  it("returns now:false for empty argv", () => {
    expect(parseStopArgs([])).toEqual({ now: false })
  })

  it("ignores unknown flags", () => {
    expect(parseStopArgs(["--unknown"])).toEqual({ now: false })
  })
})

describe("cmdStop", () => {
  it("returns {killed:false, pid:null} and logs friendly message when no lockfile", async () => {
    const layout = freshLayout()
    const logs: string[] = []
    const result = await cmdStop(layout, [], (s) => logs.push(s))
    expect(result).toEqual({ killed: false, pid: null })
    expect(logs.some((l) => l.includes("No worker running"))).toBe(true)
  })

  it("returns {killed:false, pid:<dead>} when lockfile holds dead PID", async () => {
    const layout = freshLayout()
    mkdirSync(dirname(layout.lockFile), { recursive: true })
    const deadPid = 99_999_999
    writeFileSync(layout.lockFile, String(deadPid))
    const logs: string[] = []
    const result = await cmdStop(layout, [], (s) => logs.push(s))
    expect(result.killed).toBe(false)
    expect(result.pid).toBe(deadPid)
    expect(logs.some((l) => l.includes("Stale lockfile"))).toBe(true)
  })

  it("returns {killed:false, pid:<dead>} also when --now is passed for a stale lockfile", async () => {
    const layout = freshLayout()
    mkdirSync(dirname(layout.lockFile), { recursive: true })
    const deadPid = 99_999_999
    writeFileSync(layout.lockFile, String(deadPid))
    const logs: string[] = []
    const result = await cmdStop(layout, ["--now"], (s) => logs.push(s))
    expect(result.killed).toBe(false)
    expect(result.pid).toBe(deadPid)
    expect(logs.some((l) => l.includes("Stale"))).toBe(true)
  })

  // NOTE: Testing the SIGTERM/SIGKILL paths against a live process would
  // require spawning a child and is covered by T23 e2e tests. Unit-level
  // coverage is the args parsing + no-lockfile + stale-lockfile paths.

  it("--now writes the stop-now flag before SIGKILL so orphan recovery can attribute it", async () => {
    // The flag is only meaningful on the SIGKILL escalation path. Spawn a
    // child that ignores SIGTERM so cmdStop is forced into the SIGKILL branch.
    const layout = freshLayout()
    mkdirSync(dirname(layout.lockFile), { recursive: true })
    const child = Bun.spawn(
      [
        "node",
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    writeFileSync(layout.lockFile, String(child.pid))
    try {
      // Give node a moment to register its SIGTERM handler before cmdStop
      // sends the signal — otherwise the default behavior (exit) wins and
      // we never hit the SIGKILL branch this test exercises.
      await new Promise((r) => setTimeout(r, 300))
      const logs: string[] = []
      const result = await cmdStop(layout, ["--now"], (s) => logs.push(s))
      expect(result.killed).toBe(true)
      expect(result.pid).toBe(child.pid)
      // We must have hit the SIGKILL branch (otherwise the flag would not be
      // written, which is the design — SIGTERM-only flow goes through the
      // orchestrator's signal handler instead).
      expect(logs.some((l) => l.includes("Escalated to SIGKILL"))).toBe(true)
      expect(existsSync(layout.stopNowFlagFile)).toBe(true)
    } finally {
      try { child.kill("SIGKILL") } catch { /* already dead */ }
    }
  })
})
