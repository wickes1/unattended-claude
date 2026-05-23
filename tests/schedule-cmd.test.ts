/** Unit tests — schedule install/uninstall command. */
import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cmdSchedule,
  generatePlist,
  plistFilename,
  plistLabel,
  type ScheduleOps,
} from "../src/commands/schedule.ts"
import type { ScheduleWindow } from "../src/config.ts"
import { testConfig } from "./helpers.ts"

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ucl-schedule-"))
}

function fakeOps(launchAgentsDir: string): {
  ops: ScheduleOps
  loadCalls: string[]
  unloadCalls: string[]
} {
  const loadCalls: string[] = []
  const unloadCalls: string[] = []
  const ops: ScheduleOps = {
    launchAgentsDir,
    launchctlLoad: (p) => {
      loadCalls.push(p)
      return true
    },
    launchctlUnload: (p) => {
      unloadCalls.push(p)
      return true
    },
  }
  return { ops, loadCalls, unloadCalls }
}

const overnight: ScheduleWindow = { start: "22:30", end: "06:30", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }
const workday: ScheduleWindow = { start: "09:00", end: "17:00", days: ["mon", "tue", "wed", "thu", "fri"] }

describe("plistLabel", () => {
  it("formats as dev.unattended-claude.<start>-<end> with colons stripped", () => {
    expect(plistLabel(overnight)).toBe("dev.unattended-claude.2230-0630")
    expect(plistLabel(workday)).toBe("dev.unattended-claude.0900-1700")
  })
})

describe("plistFilename", () => {
  it("returns label + .plist", () => {
    expect(plistFilename(overnight)).toBe("dev.unattended-claude.2230-0630.plist")
  })
})

describe("generatePlist", () => {
  const xml = generatePlist(overnight, "/usr/local/bin/ucl", "/Users/me/unattended")

  it("contains the correct Label", () => {
    expect(xml).toContain("<key>Label</key>")
    expect(xml).toContain("<string>dev.unattended-claude.2230-0630</string>")
  })

  it("has one StartCalendarInterval <dict> entry per active day", () => {
    // 7 days configured → 7 inner <dict> entries inside StartCalendarInterval.
    const matches = xml.match(/<key>Weekday<\/key>/g)
    expect(matches?.length).toBe(7)
  })

  it("emits the correct launchd Weekday integer for each day", () => {
    // mon=1, tue=2, wed=3, thu=4, fri=5, sat=6, sun=0
    for (const wd of [1, 2, 3, 4, 5, 6, 0]) {
      expect(xml).toContain(`<key>Weekday</key><integer>${wd}</integer>`)
    }
  })

  it("emits Hour=22 and Minute=30 inside each StartCalendarInterval entry", () => {
    const hourMatches = xml.match(/<key>Hour<\/key><integer>22<\/integer>/g)
    const minMatches = xml.match(/<key>Minute<\/key><integer>30<\/integer>/g)
    expect(hourMatches?.length).toBe(7)
    expect(minMatches?.length).toBe(7)
  })

  it("emits ProgramArguments with exePath, run, --until, end-time", () => {
    expect(xml).toContain("<string>/usr/local/bin/ucl</string>")
    expect(xml).toContain("<string>run</string>")
    expect(xml).toContain("<string>--until</string>")
    expect(xml).toContain("<string>06:30</string>")
  })

  it("emits StandardOutPath/StandardErrorPath under runtimeDir/logs", () => {
    expect(xml).toContain("<string>/Users/me/unattended/logs/schedule.out.log</string>")
    expect(xml).toContain("<string>/Users/me/unattended/logs/schedule.err.log</string>")
  })

  it("emits RunAtLoad=false so loading does not immediately fire the task", () => {
    expect(xml).toContain("<key>RunAtLoad</key>")
    expect(xml).toContain("<false/>")
  })
})

describe("cmdSchedule list", () => {
  it("logs friendly message when no windows configured", async () => {
    const launchAgentsDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const cfg = testConfig({ schedule: { windows: [] } })
    const logs: string[] = []
    await cmdSchedule(cfg, ["list"], (s) => logs.push(s), ops)
    expect(logs.some((l) => l.includes("No schedule windows configured."))).toBe(true)
  })

  it("logs each configured window's label", async () => {
    const launchAgentsDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const cfg = testConfig({ schedule: { windows: [overnight, workday] } })
    const logs: string[] = []
    await cmdSchedule(cfg, ["list"], (s) => logs.push(s), ops)
    expect(logs.some((l) => l.includes("dev.unattended-claude.2230-0630"))).toBe(true)
    expect(logs.some((l) => l.includes("dev.unattended-claude.0900-1700"))).toBe(true)
  })

  it("lists installed plists from the launchAgentsDir", async () => {
    const launchAgentsDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    // Pre-populate the dir with a stale plist + an unrelated file (must be ignored).
    writeFileSync(join(launchAgentsDir, "dev.unattended-claude.2230-0630.plist"), "<plist/>")
    writeFileSync(join(launchAgentsDir, "com.other.app.plist"), "<plist/>")
    const cfg = testConfig({ schedule: { windows: [] } })
    const logs: string[] = []
    await cmdSchedule(cfg, ["list"], (s) => logs.push(s), ops)
    expect(logs.some((l) => l.includes("dev.unattended-claude.2230-0630.plist"))).toBe(true)
    expect(logs.some((l) => l.includes("com.other.app.plist"))).toBe(false)
  })

  it("prints '(none)' when no unattended-claude plists are installed", async () => {
    const launchAgentsDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const cfg = testConfig({ schedule: { windows: [workday] } })
    const logs: string[] = []
    await cmdSchedule(cfg, ["list"], (s) => logs.push(s), ops)
    expect(logs.some((l) => l.includes("(none)"))).toBe(true)
  })
})

describe("cmdSchedule install", () => {
  it("writes a plist file for each window and calls launchctlLoad", async () => {
    const launchAgentsDir = freshDir()
    const { ops, loadCalls } = fakeOps(launchAgentsDir)
    const cfg = testConfig({
      runtimeDir: "/tmp/ucl-test",
      schedule: { windows: [overnight, workday] },
    })
    const logs: string[] = []
    await cmdSchedule(cfg, ["install"], (s) => logs.push(s), ops, "/usr/local/bin/ucl")

    const p1 = join(launchAgentsDir, plistFilename(overnight))
    const p2 = join(launchAgentsDir, plistFilename(workday))
    expect(existsSync(p1)).toBe(true)
    expect(existsSync(p2)).toBe(true)

    // Both plists were load-ed.
    expect(loadCalls).toEqual([p1, p2])

    // Sanity-check one plist's content.
    const xml = readFileSync(p1, "utf8")
    expect(xml).toContain("<string>dev.unattended-claude.2230-0630</string>")
    expect(xml).toContain("<string>/usr/local/bin/ucl</string>")
    expect(xml).toContain("<string>06:30</string>")

    expect(logs.some((l) => l.startsWith("loaded"))).toBe(true)
  })

  it("logs '(load failed)' when launchctlLoad returns false but still writes the plist", async () => {
    const launchAgentsDir = freshDir()
    const ops: ScheduleOps = {
      launchAgentsDir,
      launchctlLoad: () => false,
      launchctlUnload: () => true,
    }
    const cfg = testConfig({ schedule: { windows: [workday] } })
    const logs: string[] = []
    await cmdSchedule(cfg, ["install"], (s) => logs.push(s), ops, "/usr/local/bin/ucl")

    const p = join(launchAgentsDir, plistFilename(workday))
    expect(existsSync(p)).toBe(true)
    expect(logs.some((l) => l.includes("load failed"))).toBe(true)
  })

  it("logs 'Nothing installed' when schedule is empty", async () => {
    const launchAgentsDir = freshDir()
    const { ops, loadCalls } = fakeOps(launchAgentsDir)
    const cfg = testConfig({ schedule: { windows: [] } })
    const logs: string[] = []
    await cmdSchedule(cfg, ["install"], (s) => logs.push(s), ops)
    expect(logs.some((l) => l.includes("Nothing installed"))).toBe(true)
    expect(loadCalls).toEqual([])
  })
})

describe("cmdSchedule uninstall", () => {
  it("removes all dev.unattended-claude.*.plist files and calls launchctlUnload for each", async () => {
    const launchAgentsDir = freshDir()
    const { ops, unloadCalls } = fakeOps(launchAgentsDir)
    // Plant two of ours + one foreign plist that must be left alone.
    const f1 = join(launchAgentsDir, "dev.unattended-claude.2230-0630.plist")
    const f2 = join(launchAgentsDir, "dev.unattended-claude.0900-1700.plist")
    const foreign = join(launchAgentsDir, "com.other.app.plist")
    writeFileSync(f1, "<plist/>")
    writeFileSync(f2, "<plist/>")
    writeFileSync(foreign, "<plist/>")

    const cfg = testConfig({ schedule: { windows: [] } })
    const logs: string[] = []
    await cmdSchedule(cfg, ["uninstall"], (s) => logs.push(s), ops)

    expect(existsSync(f1)).toBe(false)
    expect(existsSync(f2)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
    // Unload was called for both — order isn't load-bearing.
    expect(unloadCalls.sort()).toEqual([f1, f2].sort())
    // Should log a 'removed' line for each.
    expect(logs.filter((l) => l.startsWith("removed")).length).toBe(2)
    // And the foreign plist should not appear in any log.
    expect(logs.some((l) => l.includes("com.other.app"))).toBe(false)
    // Sanity-check the dir state from outside.
    expect(readdirSync(launchAgentsDir).sort()).toEqual(["com.other.app.plist"])
  })

  it("logs friendly message when no plists are installed", async () => {
    const launchAgentsDir = freshDir()
    const { ops, unloadCalls } = fakeOps(launchAgentsDir)
    const cfg = testConfig({ schedule: { windows: [] } })
    const logs: string[] = []
    await cmdSchedule(cfg, ["uninstall"], (s) => logs.push(s), ops)
    expect(logs.some((l) => l.includes("No unattended-claude plists installed."))).toBe(true)
    expect(unloadCalls).toEqual([])
  })
})

describe("cmdSchedule help", () => {
  it("prints helpText when sub-command is missing or unknown", async () => {
    const launchAgentsDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const cfg = testConfig({ schedule: { windows: [] } })

    const logsEmpty: string[] = []
    await cmdSchedule(cfg, [], (s) => logsEmpty.push(s), ops)
    expect(logsEmpty.some((l) => l.includes("Usage: ucl schedule"))).toBe(true)

    const logsUnknown: string[] = []
    await cmdSchedule(cfg, ["bogus"], (s) => logsUnknown.push(s), ops)
    expect(logsUnknown.some((l) => l.includes("Usage: ucl schedule"))).toBe(true)
  })
})
