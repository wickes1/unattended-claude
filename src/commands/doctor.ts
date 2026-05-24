/** `ucl doctor` — preflight / health checks (no side effects beyond stdout). */
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Config } from "../config.ts"
import { Layout } from "../layout.ts"

export const helpText = `Usage: ucl doctor [--json]

Preflight checks: bun, zellij, claude, happy (if runtime.bin=happy), zellij
socket, skill folder reachable, config file, runtime dir, billing env vars,
extra-usage opt-in reminder, ~/.bun/bin on PATH.

Options:
  --json    Emit results as a JSON array instead of colored rows.

Exit code 0 if no errors, 1 if any error. Warnings and info rows don't fail.
`

// ── Result types ───────────────────────────────────────────────────

export type Severity = "pass" | "warn" | "info" | "error"

export interface CheckResult {
  severity: Severity
  name: string
  detail: string
  /** Remediation hint — shown for warn/error; ignored for pass; printed for info. */
  remediation?: string
}

// ── Formatting helpers (file-local; do NOT extract) ───────────────

const COLOR = process.stdout.isTTY === true
const green = (s: string): string => (COLOR ? `\x1b[32m${s}\x1b[0m` : s)
const yellow = (s: string): string => (COLOR ? `\x1b[33m${s}\x1b[0m` : s)
const red = (s: string): string => (COLOR ? `\x1b[31m${s}\x1b[0m` : s)
const blue = (s: string): string => (COLOR ? `\x1b[34m${s}\x1b[0m` : s)

export function formatResult(r: CheckResult): string {
  if (r.severity === "pass") return `${green("✓")} ${r.name}: ${r.detail}`
  if (r.severity === "info") {
    return `${blue("ℹ")} ${r.name}: ${r.detail}${r.remediation ? ` — ${r.remediation}` : ""}`
  }
  if (r.severity === "warn") {
    return `${yellow("⚠")} ${r.name}: ${r.detail}${r.remediation ? ` — ${r.remediation}` : ""}`
  }
  return `${red("✗")} ${r.name}: ${r.detail}${r.remediation ? ` — ${r.remediation}` : ""}`
}

// ── Subprocess version probe ──────────────────────────────────────

interface VersionProbe {
  ok: boolean
  /** First line of stdout, trimmed. Empty string if the binary failed. */
  version: string
}

function probeVersion(cmd: string, args: string[] = ["--version"]): VersionProbe {
  let proc: ReturnType<typeof Bun.spawnSync>
  try {
    proc = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" })
  } catch {
    return { ok: false, version: "" }
  }
  if (proc.exitCode !== 0) return { ok: false, version: "" }
  const out = new TextDecoder().decode(proc.stdout).trim()
  const firstLine = out.split("\n")[0]?.trim() ?? ""
  return { ok: true, version: firstLine }
}

// ── Individual checks ─────────────────────────────────────────────

export function checkBun(): CheckResult {
  const p = probeVersion("bun")
  if (p.ok) return { severity: "pass", name: "bun", detail: p.version }
  // bun must be present — we're literally running under it — but report cleanly anyway.
  return {
    severity: "error",
    name: "bun",
    detail: "bun --version failed",
    remediation: "install bun from https://bun.com",
  }
}

export function checkZellij(): CheckResult {
  const p = probeVersion("zellij")
  if (p.ok) return { severity: "pass", name: "zellij", detail: p.version }
  const hint =
    process.platform === "linux"
      ? "cargo install --locked zellij"
      : "brew install zellij"
  return {
    severity: "error",
    name: "zellij",
    detail: "not found",
    remediation: hint,
  }
}

export function checkClaude(): CheckResult {
  const p = probeVersion("claude")
  if (p.ok) return { severity: "pass", name: "claude", detail: p.version }
  return {
    severity: "error",
    name: "claude",
    detail: "not found",
    remediation: "install Claude Code: https://docs.claude.com/claude-code",
  }
}

export function checkHappy(): CheckResult {
  const p = probeVersion("happy")
  if (p.ok) return { severity: "pass", name: "happy", detail: p.version }
  return {
    severity: "error",
    name: "happy",
    detail: "not found",
    remediation: "npm install -g happy-coder (see https://happy.engineering)",
  }
}

/**
 * Zellij keeps its IPC socket dir at /tmp/zellij. If it doesn't exist yet,
 * that's fine — zellij auto-creates it on first run. If it exists but isn't
 * a directory or isn't writable by the current user, sessions will fail to
 * start with a confusing error, so surface it here.
 */
export function checkZellijSocket(): CheckResult {
  const path = "/tmp/zellij"
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch {
    return {
      severity: "pass",
      name: "zellij socket",
      detail: "dir auto-created on first run",
    }
  }
  if (!st.isDirectory()) {
    return {
      severity: "error",
      name: "zellij socket",
      detail: `not a directory: ${path}`,
      remediation: `rm ${path} and let zellij re-create it`,
    }
  }
  try {
    accessSync(path, fsConstants.W_OK)
  } catch {
    return {
      severity: "error",
      name: "zellij socket",
      detail: `not writable: ${path}`,
      remediation: `chmod u+w ${path}`,
    }
  }
  return { severity: "pass", name: "zellij socket", detail: path }
}

/**
 * Skills are user-installed into `<runtime_dir>/.claude/skills/` by `ucl init`
 * (parallel to ucl.yaml — user data, not repo-bundled assets). `ucl plan` and
 * `ucl review` spawn claude with `cwd = runtime_dir` so SKILL.md files there
 * auto-load. If either is missing, the interactive session will run without
 * the skill — point the user at `ucl init` to reinstall.
 */
export function checkSkillFolder(cfg: Config): CheckResult {
  const layout = new Layout(cfg.runtimeDir)
  const briefFile = layout.skillFile("task-brief")
  const reviewFile = layout.skillFile("task-review")
  const missing: string[] = []
  if (!existsSync(briefFile)) missing.push("task-brief")
  if (!existsSync(reviewFile)) missing.push("task-review")
  if (missing.length === 0) {
    return {
      severity: "pass",
      name: "skill folder",
      detail: layout.runtimeSkillsDir,
    }
  }
  return {
    severity: "error",
    name: "skill folder",
    detail: `missing skill(s): ${missing.join(", ")} at ${layout.runtimeSkillsDir}`,
    remediation: "run `ucl init` to install skill templates",
  }
}

export function checkConfigFile(cfg: Config): CheckResult {
  if (existsSync(cfg.configPath)) {
    return { severity: "pass", name: "config file", detail: cfg.configPath }
  }
  return {
    severity: "error",
    name: "config file",
    detail: `missing: ${cfg.configPath}`,
    remediation: "run `ucl init`",
  }
}

export function checkRuntimeDir(cfg: Config): CheckResult {
  const path = cfg.runtimeDir
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch {
    return {
      severity: "error",
      name: "runtime dir",
      detail: `missing: ${path}`,
      remediation: `mkdir -p ${path}`,
    }
  }
  if (!st.isDirectory()) {
    return {
      severity: "error",
      name: "runtime dir",
      detail: `not a directory: ${path}`,
      remediation: `remove ${path} and \`mkdir -p ${path}\``,
    }
  }
  try {
    accessSync(path, fsConstants.W_OK)
  } catch {
    return {
      severity: "error",
      name: "runtime dir",
      detail: `not writable: ${path}`,
      remediation: `chmod u+w ${path}`,
    }
  }
  return { severity: "pass", name: "runtime dir", detail: path }
}

const BILLING_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const

/**
 * Single check covering all billing-related env vars. If any is set, claude
 * will bypass subscription auth and bill against API credits / cloud quotas
 * — usually not what an unattended runner wants. Warn rather than error so
 * users who intentionally use API billing aren't blocked.
 */
export function checkBillingEnv(): CheckResult {
  const set = BILLING_ENV_VARS.filter((k) => process.env[k] !== undefined && process.env[k] !== "")
  if (set.length === 0) {
    return {
      severity: "pass",
      name: "billing env",
      detail: "subscription billing path (no billing env vars set)",
    }
  }
  return {
    severity: "warn",
    name: "billing env",
    detail: `${set.join(", ")} is set`,
    remediation:
      "this forces non-subscription billing; unset before `ucl run` if you want subscription quota to apply",
  }
}

/**
 * Doctor can't probe Anthropic's web-side extra-usage opt-in — it's a server
 * setting with no public API. Always surface it as an info row so users know
 * to verify it manually before unattended runs.
 */
export function checkBillingServerSide(): CheckResult {
  return {
    severity: "info",
    name: "extra-usage opt-in",
    detail: "server-side setting, doctor cannot detect",
    remediation:
      "verify https://claude.com/settings/usage shows extra usage = OFF before unattended runs if you want a hard ceiling",
  }
}

/**
 * launchd-scheduled runs spawn from a stripped environment that doesn't
 * source the user's shell rc. Without `~/.bun/bin` on PATH, the `ucl` binary
 * (installed via `bun link`) won't resolve. Warn-only because users may have
 * installed `ucl` somewhere else entirely.
 */
export function checkBunPath(): CheckResult {
  const bunBin = join(homedir(), ".bun", "bin")
  const path = process.env.PATH ?? ""
  const parts = path.split(":").filter((p) => p.length > 0)
  if (parts.includes(bunBin)) {
    return { severity: "pass", name: "bun PATH", detail: `includes ${bunBin}` }
  }
  return {
    severity: "warn",
    name: "bun PATH",
    detail: `does not include ${bunBin}`,
    remediation:
      `export PATH="$HOME/.bun/bin:$PATH" in your shell rc (needed for launchd scheduled runs to find \`ucl\`)`,
  }
}

// ── Main ──────────────────────────────────────────────────────────

/** Pure: run all checks, return ordered results. No stdout, no exit. */
export function runChecks(cfg: Config): CheckResult[] {
  const results: CheckResult[] = []
  results.push(checkBun())
  results.push(checkZellij())
  results.push(checkClaude())
  if (cfg.runtime.bin === "happy") results.push(checkHappy())
  results.push(checkZellijSocket())
  results.push(checkSkillFolder(cfg))
  results.push(checkConfigFile(cfg))
  results.push(checkRuntimeDir(cfg))
  results.push(checkBillingEnv())
  results.push(checkBillingServerSide())
  results.push(checkBunPath())
  return results
}

/** CLI entry. Parses `--json` flag from argv. Prints results + summary. Returns exit code (0/1). */
export async function cmdDoctor(cfg: Config, argv: string[]): Promise<number> {
  const json = argv.includes("--json")
  const results = runChecks(cfg)
  if (json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    for (const r of results) console.log(formatResult(r))
    const summary = { pass: 0, warn: 0, info: 0, error: 0 }
    for (const r of results) summary[r.severity]++
    console.log(
      `Doctor: ${results.length} checks · ${summary.pass} pass · ${summary.warn} warn · ${summary.info} info · ${summary.error} error`,
    )
  }
  return results.some((r) => r.severity === "error") ? 1 : 0
}
