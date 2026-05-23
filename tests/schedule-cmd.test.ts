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

  it("helpText mentions add and remove subcommands", () => {
    // The helpText is the contract for `ucl schedule --help`; once add/remove
    // exist they MUST be documented here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { helpText } = require("../src/commands/schedule.ts")
    expect(helpText).toMatch(/\badd\b/)
    expect(helpText).toMatch(/\bremove\b/)
  })
})

// ─── F11: schedule add / remove ──────────────────────────────────────────────

/** Helper: write a minimal ucl.yaml with the given windows and return the path. */
function writeConfigYaml(dir: string, windows: ScheduleWindow[]): string {
  const path = join(dir, "ucl.yaml")
  const lines = [
    "# user comment we want to preserve",
    "paths:",
    "  runtime_dir: ~/unattended",
    "execution:",
    "  max_parallel_tabs: 3",
    "schedule:",
    "  windows:",
  ]
  if (windows.length === 0) {
    // Use flow-style `[]` to mirror the template's "no windows" shape.
    lines[lines.length - 1] = "  windows: []"
  } else {
    for (const w of windows) {
      lines.push(`    - { start: "${w.start}", end: "${w.end}", days: [${w.days.join(", ")}] }`)
    }
  }
  writeFileSync(path, lines.join("\n") + "\n")
  return path
}

describe("cmdSchedule add — F11", () => {
  it("appends a new window to schedule.windows in the YAML and reinstalls plists", async () => {
    const launchAgentsDir = freshDir()
    const ymlDir = freshDir()
    const { ops, loadCalls } = fakeOps(launchAgentsDir)
    const configPath = writeConfigYaml(ymlDir, [])
    const cfg = testConfig({
      configPath,
      schedule: { windows: [] },
    })

    const logs: string[] = []
    await cmdSchedule(
      cfg,
      ["add", "09:00", "12:00"],
      (s) => logs.push(s),
      ops,
      "/usr/local/bin/ucl",
    )

    // 1. YAML on disk now has exactly one window.
    const raw = readFileSync(configPath, "utf8")
    expect(raw).toMatch(/start:\s*"?09:00"?/)
    expect(raw).toMatch(/end:\s*"?12:00"?/)

    // 2. A plist file was written for the new window.
    const expectedPlist = join(launchAgentsDir, "dev.unattended-claude.0900-1200.plist")
    expect(existsSync(expectedPlist)).toBe(true)
    expect(loadCalls).toContain(expectedPlist)

    // 3. Comment from the original YAML survives the round-trip.
    expect(raw).toContain("# user comment we want to preserve")

    // 4. Friendly log.
    expect(logs.some((l) => l.includes("added"))).toBe(true)
  })

  it("supports --days override", async () => {
    const launchAgentsDir = freshDir()
    const ymlDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const configPath = writeConfigYaml(ymlDir, [])
    const cfg = testConfig({ configPath, schedule: { windows: [] } })

    const logs: string[] = []
    await cmdSchedule(
      cfg,
      ["add", "09:00", "12:00", "--days", "mon,wed,fri"],
      (s) => logs.push(s),
      ops,
      "/usr/local/bin/ucl",
    )

    const raw = readFileSync(configPath, "utf8")
    expect(raw).toMatch(/mon/)
    expect(raw).toMatch(/wed/)
    expect(raw).toMatch(/fri/)
    expect(raw).not.toMatch(/\btue\b/)
  })

  it("defaults to all 7 days when --days is omitted", async () => {
    const launchAgentsDir = freshDir()
    const ymlDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const configPath = writeConfigYaml(ymlDir, [])
    const cfg = testConfig({ configPath, schedule: { windows: [] } })

    await cmdSchedule(
      cfg,
      ["add", "09:00", "12:00"],
      () => {},
      ops,
      "/usr/local/bin/ucl",
    )
    const raw = readFileSync(configPath, "utf8")
    for (const d of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
      expect(raw).toMatch(new RegExp(`\\b${d}\\b`))
    }
  })

  it("logs usage and does NOT mutate the file when start/end missing", async () => {
    const launchAgentsDir = freshDir()
    const ymlDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const configPath = writeConfigYaml(ymlDir, [])
    const before = readFileSync(configPath, "utf8")
    const cfg = testConfig({ configPath, schedule: { windows: [] } })

    const logs: string[] = []
    await cmdSchedule(cfg, ["add", "09:00"], (s) => logs.push(s), ops, "/usr/local/bin/ucl")

    expect(readFileSync(configPath, "utf8")).toBe(before)
    expect(logs.some((l) => l.includes("Usage: ucl schedule add"))).toBe(true)
  })

  it("rejects malformed HH:MM and does NOT mutate the file", async () => {
    const launchAgentsDir = freshDir()
    const ymlDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const configPath = writeConfigYaml(ymlDir, [])
    const before = readFileSync(configPath, "utf8")
    const cfg = testConfig({ configPath, schedule: { windows: [] } })

    const logs: string[] = []
    await cmdSchedule(cfg, ["add", "9am", "noon"], (s) => logs.push(s), ops, "/usr/local/bin/ucl")
    expect(readFileSync(configPath, "utf8")).toBe(before)
    expect(logs.some((l) => l.includes("schedule add:"))).toBe(true)
  })
})

describe("cmdSchedule remove — F11", () => {
  it("removes the Nth window (1-indexed) and reinstalls plists", async () => {
    const launchAgentsDir = freshDir()
    const ymlDir = freshDir()
    const { ops, loadCalls, unloadCalls } = fakeOps(launchAgentsDir)
    const w1: ScheduleWindow = { start: "09:00", end: "12:00", days: ["mon"] }
    const w2: ScheduleWindow = { start: "13:00", end: "17:00", days: ["mon"] }
    const configPath = writeConfigYaml(ymlDir, [w1, w2])
    const cfg = testConfig({ configPath, schedule: { windows: [w1, w2] } })

    // Pre-plant both plists on disk so the uninstall step has something to remove.
    writeFileSync(join(launchAgentsDir, plistFilename(w1)), "<plist/>")
    writeFileSync(join(launchAgentsDir, plistFilename(w2)), "<plist/>")

    const logs: string[] = []
    await cmdSchedule(cfg, ["remove", "2"], (s) => logs.push(s), ops, "/usr/local/bin/ucl")

    const raw = readFileSync(configPath, "utf8")
    expect(raw).toMatch(/12:00/) // w1 still there
    expect(raw).not.toMatch(/13:00/) // w2 gone

    // Uninstall step removed BOTH plists, install step wrote w1 back.
    expect(unloadCalls.length).toBeGreaterThan(0)
    expect(existsSync(join(launchAgentsDir, plistFilename(w1)))).toBe(true)
    expect(existsSync(join(launchAgentsDir, plistFilename(w2)))).toBe(false)
    expect(loadCalls).toContain(join(launchAgentsDir, plistFilename(w1)))

    expect(logs.some((l) => l.includes("removed  #2"))).toBe(true)
  })

  it("errors when N is out of range (does NOT mutate the file)", async () => {
    const launchAgentsDir = freshDir()
    const ymlDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const w1: ScheduleWindow = { start: "09:00", end: "12:00", days: ["mon"] }
    const configPath = writeConfigYaml(ymlDir, [w1])
    const before = readFileSync(configPath, "utf8")
    const cfg = testConfig({ configPath, schedule: { windows: [w1] } })

    const logs: string[] = []
    await cmdSchedule(cfg, ["remove", "99"], (s) => logs.push(s), ops, "/usr/local/bin/ucl")
    expect(readFileSync(configPath, "utf8")).toBe(before)
    expect(logs.some((l) => l.includes("out of range"))).toBe(true)
  })

  it("errors when schedule is empty", async () => {
    const launchAgentsDir = freshDir()
    const ymlDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const configPath = writeConfigYaml(ymlDir, [])
    const cfg = testConfig({ configPath, schedule: { windows: [] } })

    const logs: string[] = []
    await cmdSchedule(cfg, ["remove", "1"], (s) => logs.push(s), ops, "/usr/local/bin/ucl")
    expect(logs.some((l) => l.includes("no windows configured"))).toBe(true)
  })

  it("errors when N is missing or not a positive integer", async () => {
    const launchAgentsDir = freshDir()
    const ymlDir = freshDir()
    const { ops } = fakeOps(launchAgentsDir)
    const w1: ScheduleWindow = { start: "09:00", end: "12:00", days: ["mon"] }
    const configPath = writeConfigYaml(ymlDir, [w1])
    const cfg = testConfig({ configPath, schedule: { windows: [w1] } })

    const usageLogs: string[] = []
    await cmdSchedule(cfg, ["remove"], (s) => usageLogs.push(s), ops, "/usr/local/bin/ucl")
    expect(usageLogs.some((l) => l.includes("Usage: ucl schedule remove"))).toBe(true)

    const negLogs: string[] = []
    await cmdSchedule(cfg, ["remove", "0"], (s) => negLogs.push(s), ops, "/usr/local/bin/ucl")
    expect(negLogs.some((l) => l.includes("positive integer"))).toBe(true)

    const nanLogs: string[] = []
    await cmdSchedule(cfg, ["remove", "abc"], (s) => nanLogs.push(s), ops, "/usr/local/bin/ucl")
    expect(nanLogs.some((l) => l.includes("positive integer"))).toBe(true)
  })
})

// ─── F06: ProgramArguments path resolution ────────────────────────────────────
// The plist's ProgramArguments must reflect HOW the CLI was invoked so launchd
// can re-launch it. Compiled binary → just the binary. Source mode → bun + script.

describe("resolveProgramPrefix — F06 + install metadata", () => {
  // All auto-detect tests pin metadataPath to a non-existent file so the
  // production install.json (which may exist on this machine) doesn't bleed in.
  const noMeta = (): string => join(mkdtempSync(join(tmpdir(), "ucl-sched-no-meta-")), "install.json")

  it("returns [execPath] when execPath basename is 'ucl' (compiled binary mode)", () => {
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/ucl", argv: ["/usr/local/bin/ucl"],
        metadataPath: noMeta(),
      }),
    ).toEqual(["/usr/local/bin/ucl"])
  })

  it("returns [execPath] when execPath basename is 'unattended-claude' (compiled binary mode)", () => {
    expect(
      resolveProgramPrefix({
        execPath: "/opt/local/bin/unattended-claude",
        argv: ["/opt/local/bin/unattended-claude"],
        metadataPath: noMeta(),
      }),
    ).toEqual(["/opt/local/bin/unattended-claude"])
  })

  it("is case-insensitive on the binary basename", () => {
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/UCL", argv: [],
        metadataPath: noMeta(),
      }),
    ).toEqual(["/usr/local/bin/UCL"])
  })

  it("returns [bun, scriptPath] in source mode (execPath is bun)", () => {
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/bun",
        argv: ["/usr/local/bin/bun", "/Users/me/proj/src/index.ts", "schedule", "install"],
        metadataPath: noMeta(),
      }),
    ).toEqual(["/usr/local/bin/bun", "/Users/me/proj/src/index.ts"])
  })

  it("binOverride always wins, regardless of execPath/argv/metadata", () => {
    // Even with install metadata present, --bin wins.
    const metaDir = mkdtempSync(join(tmpdir(), "ucl-sched-meta-"))
    const metaPath = join(metaDir, "install.json")
    writeFileSync(metaPath, JSON.stringify({ binary_path: "/from/metadata/ucl" }))
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/bun",
        argv: ["/usr/local/bin/bun", "/Users/me/proj/src/index.ts"],
        binOverride: "/opt/local/bin/ucl",
        metadataPath: metaPath,
      }),
    ).toEqual(["/opt/local/bin/ucl"])
    // Even in compiled mode, override wins.
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/ucl",
        argv: ["/usr/local/bin/ucl"],
        binOverride: "/elsewhere/ucl",
        metadataPath: noMeta(),
      }),
    ).toEqual(["/elsewhere/ucl"])
  })

  it("throws a clear error when in source mode but argv[1] is missing and no metadata", () => {
    expect(() =>
      resolveProgramPrefix({
        execPath: "/usr/local/bin/bun", argv: ["/usr/local/bin/bun"],
        metadataPath: noMeta(),
      }),
    ).toThrow(/cannot determine script path|argv\[1\] is missing/)
  })

  it("uses binary_path from install metadata when present (beats auto-detect)", () => {
    // Even when execPath is bun (which would normally take the source-mode path),
    // install metadata's binary_path is preferred — that's the whole point: the
    // plist should point at the stable installed binary, not the dev cwd.
    const metaDir = mkdtempSync(join(tmpdir(), "ucl-sched-meta-prio-"))
    const metaPath = join(metaDir, "install.json")
    writeFileSync(metaPath, JSON.stringify({
      binary_path: "/Users/test/.local/bin/ucl",
      skills_dir: "/Users/test/repo/.claude/skills",
    }))
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/bun",
        argv: ["/usr/local/bin/bun", "/Users/test/repo/src/index.ts"],
        metadataPath: metaPath,
      }),
    ).toEqual(["/Users/test/.local/bin/ucl"])
  })

  it("falls back to auto-detect when metadata file is missing binary_path", () => {
    const metaDir = mkdtempSync(join(tmpdir(), "ucl-sched-meta-partial-"))
    const metaPath = join(metaDir, "install.json")
    writeFileSync(metaPath, JSON.stringify({ skills_dir: "/x/.claude/skills" }))
    // No binary_path → auto-detect kicks in; compiled mode matches "ucl".
    expect(
      resolveProgramPrefix({
        execPath: "/usr/local/bin/ucl", argv: ["/usr/local/bin/ucl"],
        metadataPath: metaPath,
      }),
    ).toEqual(["/usr/local/bin/ucl"])
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
