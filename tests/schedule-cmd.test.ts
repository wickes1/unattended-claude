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
  resolveProgramPrefix,
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

// ─── F06: ProgramArguments path resolution ────────────────────────────────────
// The plist's ProgramArguments must reflect HOW the CLI was invoked so launchd
// can re-launch it. Compiled binary → just the binary. Source mode → bun + script.

describe("resolveProgramPrefix — F06", () => {
  it("returns [execPath] when execPath basename is 'ucl' (compiled binary mode)", () => {
    expect(
      resolveProgramPrefix({ execPath: "/usr/local/bin/ucl", argv: ["/usr/local/bin/ucl"] }),
    ).toEqual(["/usr/local/bin/ucl"])
  })

  it("returns [execPath] when execPath basename is 'unattended-claude' (compiled binary mode)", () => {
    expect(
      resolveProgramPrefix({ execPath: "/opt/local/bin/unattended-claude", argv: ["/opt/local/bin/unattended-claude"] }),
    ).toEqual(["/opt/local/bin/unattended-claude"])
  })

  it("is case-insensitive on the binary basename", () => {
    expect(
      resolveProgramPrefix({ execPath: "/usr/local/bin/UCL", argv: [] }),
    ).toEqual(["/usr/local/bin/UCL"])
  })

  it("returns [bun, scriptPath] in source mode (execPath is bun)", () => {
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/bun",
        argv: ["/usr/local/bin/bun", "/Users/me/proj/src/index.ts", "schedule", "install"],
      }),
    ).toEqual(["/usr/local/bin/bun", "/Users/me/proj/src/index.ts"])
  })

  it("binOverride always wins, regardless of execPath/argv", () => {
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/bun",
        argv: ["/usr/local/bin/bun", "/Users/me/proj/src/index.ts"],
        binOverride: "/opt/local/bin/ucl",
      }),
    ).toEqual(["/opt/local/bin/ucl"])
    // Even in compiled mode, override wins.
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/ucl",
        argv: ["/usr/local/bin/ucl"],
        binOverride: "/elsewhere/ucl",
      }),
    ).toEqual(["/elsewhere/ucl"])
  })

  it("throws a clear error when in source mode but argv[1] is missing", () => {
    expect(() =>
      resolveProgramPrefix({ execPath: "/usr/local/bin/bun", argv: ["/usr/local/bin/bun"] }),
    ).toThrow(/cannot determine script path|argv\[1\] is missing/)
  })
})

describe("generatePlist — F06 ProgramArguments array", () => {
  const window: ScheduleWindow = { start: "22:30", end: "06:30", days: ["mon"] }

  it("emits a single <string> for the binary in compiled mode", () => {
    const xml = generatePlist(window, ["/usr/local/bin/ucl"], "/tmp/rt")
    // ProgramArguments should contain: ucl, run, --until, 06:30 — in that order.
    const args = [...xml.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])
    // First few <string>s after Label= are the ProgramArguments. Filter to the relevant prefix.
    const programIdx = args.indexOf("/usr/local/bin/ucl")
    expect(programIdx).toBeGreaterThanOrEqual(0)
    expect(args.slice(programIdx, programIdx + 4)).toEqual([
      "/usr/local/bin/ucl",
      "run",
      "--until",
      "06:30",
    ])
  })

  it("emits TWO <string>s (bun + script) for the prefix in source mode", () => {
    const xml = generatePlist(
      window,
      ["/usr/local/bin/bun", "/Users/me/proj/src/index.ts"],
      "/tmp/rt",
    )
    const args = [...xml.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])
    const bunIdx = args.indexOf("/usr/local/bin/bun")
    expect(bunIdx).toBeGreaterThanOrEqual(0)
    expect(args.slice(bunIdx, bunIdx + 5)).toEqual([
      "/usr/local/bin/bun",
      "/Users/me/proj/src/index.ts",
      "run",
      "--until",
      "06:30",
    ])
  })

  it("accepts a bare string prefix for back-compat", () => {
    const xml = generatePlist(window, "/usr/local/bin/ucl", "/tmp/rt")
    expect(xml).toContain("<string>/usr/local/bin/ucl</string>")
    expect(xml).toContain("<string>run</string>")
    expect(xml).toContain("<string>--until</string>")
    expect(xml).toContain("<string>06:30</string>")
  })

  it("produces well-formed XML (single <plist> root, balanced <dict>/<array>)", () => {
    const xml = generatePlist(
      window,
      ["/usr/local/bin/bun", "/Users/me/proj/src/index.ts"],
      "/tmp/rt",
    )
    expect(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")).toBe(true)
    expect((xml.match(/<plist /g) ?? []).length).toBe(1)
    expect((xml.match(/<\/plist>/g) ?? []).length).toBe(1)
    // Balanced dict + array tags (open count === close count).
    expect((xml.match(/<dict>/g) ?? []).length).toBe((xml.match(/<\/dict>/g) ?? []).length)
    expect((xml.match(/<array>/g) ?? []).length).toBe((xml.match(/<\/array>/g) ?? []).length)
  })

  it("does not change StartCalendarInterval generation (regression)", () => {
    // The plist for a 7-day overnight window must still emit 7 <dict> entries
    // with the correct Weekday/Hour/Minute values — independent of prefix shape.
    const allDays: ScheduleWindow = {
      start: "22:30",
      end: "06:30",
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    }
    const xml = generatePlist(allDays, ["/usr/local/bin/bun", "/p/src/index.ts"], "/tmp/rt")
    expect((xml.match(/<key>Weekday<\/key>/g) ?? []).length).toBe(7)
    expect((xml.match(/<key>Hour<\/key><integer>22<\/integer>/g) ?? []).length).toBe(7)
    expect((xml.match(/<key>Minute<\/key><integer>30<\/integer>/g) ?? []).length).toBe(7)
    for (const wd of [0, 1, 2, 3, 4, 5, 6]) {
      expect(xml).toContain(`<key>Weekday</key><integer>${wd}</integer>`)
    }
  })
})

describe("cmdSchedule install — F06 --bin override", () => {
  const workday: ScheduleWindow = { start: "09:00", end: "17:00", days: ["mon", "tue", "wed", "thu", "fri"] }

  it("writes the verbatim --bin path into ProgramArguments", async () => {
    const launchAgentsDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const cfg = testConfig({ schedule: { windows: [workday] } })
    const logs: string[] = []
    // Pass an array prefix that should be IGNORED in favor of --bin.
    await cmdSchedule(
      cfg,
      ["install", "--bin", "/opt/local/bin/ucl"],
      (s) => logs.push(s),
      ops,
      ["/should/be/ignored/bun", "/should/be/ignored/script.ts"],
    )
    const p = join(launchAgentsDir, plistFilename(workday))
    const xml = readFileSync(p, "utf8")
    expect(xml).toContain("<string>/opt/local/bin/ucl</string>")
    // The ignored prefix must NOT appear.
    expect(xml).not.toContain("/should/be/ignored")
    // And there should be exactly ONE pre-`run` string (the --bin path) — not two.
    const args = [...xml.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])
    const runIdx = args.indexOf("run")
    expect(runIdx).toBeGreaterThan(0)
    // The element immediately before "run" should be the override binary.
    expect(args[runIdx - 1]).toBe("/opt/local/bin/ucl")
  })

  it("accepts --bin in any position within argv", async () => {
    const launchAgentsDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const cfg = testConfig({ schedule: { windows: [workday] } })
    const logs: string[] = []
    // --bin BEFORE the sub-command should also work.
    await cmdSchedule(
      cfg,
      ["--bin", "/opt/ucl-trailing", "install"],
      (s) => logs.push(s),
      ops,
    )
    const p = join(launchAgentsDir, plistFilename(workday))
    const xml = readFileSync(p, "utf8")
    expect(xml).toContain("<string>/opt/ucl-trailing</string>")
  })

  it("passing a string[] prefix from caller writes the full prefix into ProgramArguments", async () => {
    const launchAgentsDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const cfg = testConfig({ schedule: { windows: [workday] } })
    const logs: string[] = []
    await cmdSchedule(
      cfg,
      ["install"],
      (s) => logs.push(s),
      ops,
      ["/usr/local/bin/bun", "/Users/me/proj/src/index.ts"],
    )
    const p = join(launchAgentsDir, plistFilename(workday))
    const xml = readFileSync(p, "utf8")
    expect(xml).toContain("<string>/usr/local/bin/bun</string>")
    expect(xml).toContain("<string>/Users/me/proj/src/index.ts</string>")
    const args = [...xml.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])
    const runIdx = args.indexOf("run")
    expect(args[runIdx - 1]).toBe("/Users/me/proj/src/index.ts")
    expect(args[runIdx - 2]).toBe("/usr/local/bin/bun")
  })
})
