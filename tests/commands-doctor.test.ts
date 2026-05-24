import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkBillingEnv,
  checkBillingServerSide,
  checkBunPath,
  checkSkillFolder,
  cmdDoctor,
  runChecks,
} from "../src/commands/doctor.ts"
import type { Config } from "../src/config.ts"

/** Minimal Config shape sufficient for doctor checks. */
function mkCfg(overrides: { bin?: "claude" | "happy"; runtimeDir?: string; configPath?: string } = {}): Config {
  const runtimeDir = overrides.runtimeDir ?? mkdtempSync(join(tmpdir(), "ucl-doctor-rt-"))
  const configDir = mkdtempSync(join(tmpdir(), "ucl-doctor-cfg-"))
  const configPath = overrides.configPath ?? join(configDir, "ucl.yaml")
  writeFileSync(configPath, "paths:\n  runtime_dir: ~/x\n")
  return {
    configPath,
    runtimeDir,
    runtime: {
      bin: overrides.bin ?? "claude",
      extraArgs: [],
    },
    execution: {
      maxParallelTabs: 3,
      windDownLeadMinutes: 5,
      episodeHardTimeoutMs: 3_600_000,
      inactivityTimeoutMs: 30_000,
      captureLines: 3000,
    },
    detection: { dialogPollIntervalMs: 500, dialogTimeoutMs: 30_000 },
    rateLimit: { safetyMarginMs: 30_000, parseFailFallbackMs: 3_600_000 },
    archive: { autoAfterDays: 7 },
    subscription: { weeklyTokenCap: 0 },
    schedule: { windows: [] },
    terminal: { term: "xterm-256color", envScrub: [], envSet: {} },
    logging: { level: "info", dir: join(runtimeDir, "logs") },
  }
}

/** Snapshot+restore env vars that affect doctor checks. */
const BILLING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const

let envSnapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  envSnapshot = {}
  for (const k of BILLING_VARS) envSnapshot[k] = process.env[k]
  envSnapshot["PATH"] = process.env.PATH
  for (const k of BILLING_VARS) delete process.env[k]
})

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("runChecks ordering", () => {
  test("runChecks returns array with all expected check names in order (bin=claude → 10 results, no checkHappy)", () => {
    const cfg = mkCfg({ bin: "claude" })
    const results = runChecks(cfg)
    expect(results.length).toBe(10)
    const names = results.map((r) => r.name)
    expect(names).not.toContain("happy")
    // Verify the expected ordering of check identifiers.
    expect(names[0]).toBe("bun")
    expect(names[1]).toBe("zellij")
    expect(names[2]).toBe("claude")
    // bin=claude → next is zellij socket
    expect(names[3]).toBe("zellij socket")
    expect(names[4]).toBe("skill folder")
    expect(names[5]).toBe("config file")
    expect(names[6]).toBe("runtime dir")
    expect(names[7]).toBe("billing env")
    expect(names[8]).toBe("extra-usage opt-in")
    expect(names[9]).toBe("bun PATH")
  })

  test("runChecks includes checkHappy when bin=happy (11 results)", () => {
    const cfg = mkCfg({ bin: "happy" })
    const results = runChecks(cfg)
    expect(results.length).toBe(11)
    const names = results.map((r) => r.name)
    expect(names).toContain("happy")
    // happy slot is right after claude
    expect(names[3]).toBe("happy")
  })
})

describe("checkBillingEnv", () => {
  test("pass when no env vars set", () => {
    const r = checkBillingEnv()
    expect(r.severity).toBe("pass")
    expect(r.detail).toContain("subscription billing")
  })

  test("warn when ANTHROPIC_API_KEY set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-fake"
    const r = checkBillingEnv()
    expect(r.severity).toBe("warn")
    expect(r.detail).toContain("ANTHROPIC_API_KEY")
    expect(r.remediation).toBeDefined()
  })

  test("warn lists all set vars", () => {
    process.env.ANTHROPIC_API_KEY = "sk-fake"
    process.env.CLAUDE_CODE_USE_BEDROCK = "1"
    const r = checkBillingEnv()
    expect(r.severity).toBe("warn")
    expect(r.detail).toContain("ANTHROPIC_API_KEY")
    expect(r.detail).toContain("CLAUDE_CODE_USE_BEDROCK")
  })
})

describe("checkBillingServerSide", () => {
  test("always returns info severity", () => {
    const r = checkBillingServerSide()
    expect(r.severity).toBe("info")
    expect(r.remediation).toContain("https://claude.com/settings/usage")
  })
})

describe("checkBunPath", () => {
  test("pass when ~/.bun/bin in PATH", () => {
    const bunBin = join(homedir(), ".bun", "bin")
    process.env.PATH = `${bunBin}:/usr/bin`
    const r = checkBunPath()
    expect(r.severity).toBe("pass")
  })

  test("warn when not in PATH", () => {
    process.env.PATH = "/usr/bin:/bin"
    const r = checkBunPath()
    expect(r.severity).toBe("warn")
    expect(r.remediation).toContain("$HOME/.bun/bin")
  })
})

describe("checkSkillFolder", () => {
  /** Pre-populate `<runtimeDir>/.claude/skills/<name>/SKILL.md` with dummy content. */
  function seedSkill(runtimeDir: string, name: string): void {
    const dir = join(runtimeDir, ".claude", "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`)
  }

  test("pass when both task-brief and task-review SKILL.md exist under runtime dir", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ucl-doctor-skills-"))
    seedSkill(runtimeDir, "task-brief")
    seedSkill(runtimeDir, "task-review")
    const cfg = mkCfg({ runtimeDir })
    const r = checkSkillFolder(cfg)
    expect(r.severity).toBe("pass")
    expect(r.detail).toContain(join(runtimeDir, ".claude", "skills"))
  })

  test("error when one skill is missing — detail names the missing one", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ucl-doctor-skills-"))
    // Only install task-brief.
    seedSkill(runtimeDir, "task-brief")
    const cfg = mkCfg({ runtimeDir })
    const r = checkSkillFolder(cfg)
    expect(r.severity).toBe("error")
    expect(r.detail).toContain("task-review")
    expect(r.detail).not.toContain("task-brief,") // task-brief should NOT be listed as missing
    expect(r.remediation).toBe("run `ucl init` to install skill templates")
  })
})

describe("cmdDoctor", () => {
  test("--json emits valid JSON array, no color codes", async () => {
    const cfg = mkCfg({ bin: "claude" })
    // Capture stdout via console.log monkey-patch.
    const captured: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")) }
    try {
      await cmdDoctor(cfg, ["--json"])
    } finally {
      console.log = origLog
    }
    expect(captured.length).toBe(1)
    const joined = captured[0]!
    expect(joined).not.toContain("\x1b[")
    const parsed = JSON.parse(joined)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed[0]).toHaveProperty("severity")
    expect(parsed[0]).toHaveProperty("name")
    expect(parsed[0]).toHaveProperty("detail")
  })

  test("exit code 0 when no errors (or matches presence of errors)", async () => {
    const cfg = mkCfg({ bin: "claude" })
    const captured: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")) }
    let code: number
    try {
      code = await cmdDoctor(cfg, ["--json"])
    } finally {
      console.log = origLog
    }
    const parsed = JSON.parse(captured[0]!) as Array<{ severity: string }>
    const hasError = parsed.some((r) => r.severity === "error")
    expect(code).toBe(hasError ? 1 : 0)
  })
})
