import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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
})
