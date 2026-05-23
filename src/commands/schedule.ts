import { readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import { ensureDir } from "../fs-utils.ts"
import type { Config, ScheduleWindow } from "../config.ts"
import { parseHHMM } from "../schedule.ts"

export const helpText = `Usage: ucl schedule <list|install|uninstall> [--bin <path>]

Manage macOS launchd entries for scheduled \`ucl run\` invocations.

  list        Print configured windows and currently-installed plist labels
  install     Write a plist for each window in config.schedule.windows
              and launchctl-load them
  uninstall   launchctl-unload and remove all unattended-claude plists

Options for install:
  --bin <path>  Override the binary path written into ProgramArguments.
                Useful when installing from a build dir but the binary will
                live elsewhere (e.g. /opt/local/bin/ucl).

Plists go in ~/Library/LaunchAgents/ with labels dev.unattended-claude.<start>-<end>.plist
`

/** Names we recognize as our compiled-binary artifact (case-insensitive). */
const COMPILED_BIN_NAMES = new Set(["ucl", "unattended-claude"])

/**
 * Resolve the ProgramArguments *prefix* (everything before `run --until <end>`)
 * for the launchd plist, by inspecting how the current process was invoked.
 *
 * - `binOverride` (e.g. from `--bin /opt/local/bin/ucl`) always wins: emits `[binOverride]`.
 * - Compiled binary mode (`execPath` basename matches "ucl" or "unattended-claude"):
 *   emits `[execPath]`.
 * - Source mode (Bun interpreter + script path in argv[1]):
 *   emits `[execPath, scriptPath]`.
 *
 * If we can't detect compiled mode and `argv[1]` is missing, throw — silently
 * writing a plist that launchd will fail to execute is worse than a clear error.
 */
export function resolveProgramPrefix(opts: {
  execPath?: string
  argv?: string[]
  binOverride?: string
} = {}): string[] {
  if (opts.binOverride) return [opts.binOverride]
  const execPath = opts.execPath ?? process.execPath
  const argv = opts.argv ?? process.argv
  const exeBase = basename(execPath).toLowerCase()
  if (COMPILED_BIN_NAMES.has(exeBase)) return [execPath]
  // Source mode (bun + script) — need argv[1] as the script path.
  const script = argv[1]
  if (!script) {
    throw new Error(
      `schedule install: cannot determine script path. ` +
      `execPath=${execPath} is not a recognized compiled binary (expected one of: ` +
      `${[...COMPILED_BIN_NAMES].join(", ")}) and argv[1] is missing. ` +
      `Pass --bin <path> to override.`,
    )
  }
  return [execPath, script]
}

const DAY_TO_LAUNCHD_WEEKDAY: Record<string, number> = {
  // launchd Weekday: 0=Sunday … 6=Saturday (per Apple docs; some sources say 1-7, but 0=Sun works)
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

export function plistLabel(window: ScheduleWindow): string {
  return `dev.unattended-claude.${window.start.replace(":", "")}-${window.end.replace(":", "")}`
}

export function plistFilename(window: ScheduleWindow): string {
  return `${plistLabel(window)}.plist`
}

/**
 * Generate a launchd plist XML for one schedule window.
 *
 * `programPrefix` is the list of arg-strings that come BEFORE `run --until <end>`
 * in the plist's ProgramArguments. For a compiled binary that's `[ucl]`; for
 * source mode that's `[bun, /path/to/src/index.ts]`. A bare string is accepted
 * for back-compat (treated as a single-element prefix).
 */
export function generatePlist(
  window: ScheduleWindow,
  programPrefix: string | string[],
  runtimeDir: string,
): string {
  const { h, m } = parseHHMM(window.start)
  const intervals = window.days
    .map((d) => DAY_TO_LAUNCHD_WEEKDAY[d.toLowerCase()])
    .filter((n): n is number => n !== undefined)
    .map((wd) => `    <dict>
      <key>Weekday</key><integer>${wd}</integer>
      <key>Hour</key><integer>${h}</integer>
      <key>Minute</key><integer>${m}</integer>
    </dict>`)
    .join("\n")

  const prefix = Array.isArray(programPrefix) ? programPrefix : [programPrefix]
  const programArgs = [...prefix, "run", "--until", window.end]
    .map((s) => `    <string>${s}</string>`)
    .join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistLabel(window)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>StandardOutPath</key>
  <string>${runtimeDir}/logs/schedule.out.log</string>
  <key>StandardErrorPath</key>
  <string>${runtimeDir}/logs/schedule.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`
}

export interface ScheduleOps {
  /** Path to ~/Library/LaunchAgents (test override). */
  launchAgentsDir: string
  /** Run `launchctl load -w <plist>`; returns true on success. Test override may no-op. */
  launchctlLoad: (plistPath: string) => boolean
  /** Run `launchctl unload -w <plist>`; returns true on success. Test override may no-op. */
  launchctlUnload: (plistPath: string) => boolean
}

export const defaultOps: ScheduleOps = {
  launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
  launchctlLoad: (p) => {
    const r = Bun.spawnSync(["launchctl", "load", "-w", p], { stdout: "pipe", stderr: "pipe" })
    return r.exitCode === 0
  },
  launchctlUnload: (p) => {
    const r = Bun.spawnSync(["launchctl", "unload", "-w", p], { stdout: "pipe", stderr: "pipe" })
    return r.exitCode === 0
  },
}

/** Extract `--bin <path>` from argv, returning the value (or undefined) plus argv with the flag removed. */
function takeBinFlag(argv: string[]): { binOverride: string | undefined; rest: string[] } {
  const out: string[] = []
  let binOverride: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bin" && argv[i + 1]) {
      binOverride = argv[i + 1]
      i++
      continue
    }
    out.push(argv[i]!)
  }
  return { binOverride, rest: out }
}

/** Sub-command dispatch. */
export async function cmdSchedule(
  cfg: Config,
  argv: string[],
  log: (s: string) => void = console.log,
  ops: ScheduleOps = defaultOps,
  /**
   * ProgramArguments prefix to write into the plist. Accepts:
   *   - a `string[]` (preferred): the full prefix, e.g. `["/usr/local/bin/ucl"]` or `["/usr/local/bin/bun", "/Users/.../src/index.ts"]`
   *   - a `string` (back-compat with older callers/tests): treated as a single-element prefix
   *   - omitted: auto-detected via `resolveProgramPrefix()` from process state
   * A `--bin <path>` flag in `argv` overrides this.
   */
  programPrefix?: string | string[],
): Promise<void> {
  const { binOverride, rest } = takeBinFlag(argv)
  const sub = rest[0]
  if (sub === "list") return cmdScheduleList(cfg, log, ops)
  if (sub === "install") {
    const prefix = binOverride
      ? [binOverride]
      : programPrefix !== undefined
        ? (Array.isArray(programPrefix) ? programPrefix : [programPrefix])
        : resolveProgramPrefix()
    return cmdScheduleInstall(cfg, log, ops, prefix)
  }
  if (sub === "uninstall") return cmdScheduleUninstall(log, ops)
  log(helpText)
}

function cmdScheduleList(cfg: Config, log: (s: string) => void, ops: ScheduleOps): void {
  if (cfg.schedule.windows.length === 0) {
    log("No schedule windows configured. Add to cc.yaml then `ucl schedule install`.")
  } else {
    log("Configured windows:")
    for (const w of cfg.schedule.windows) {
      log(`  ${w.start} → ${w.end}  days=[${w.days.join(",")}]  label=${plistLabel(w)}`)
    }
  }
  ensureDir(ops.launchAgentsDir)
  const installed = readdirSync(ops.launchAgentsDir).filter((f) => f.startsWith("dev.unattended-claude."))
  log("")
  log(`Installed plists in ${ops.launchAgentsDir}:`)
  if (installed.length === 0) log("  (none)")
  else for (const f of installed) log(`  ${f}`)
}

function cmdScheduleInstall(cfg: Config, log: (s: string) => void, ops: ScheduleOps, programPrefix: string[]): void {
  ensureDir(ops.launchAgentsDir)
  for (const w of cfg.schedule.windows) {
    const path = join(ops.launchAgentsDir, plistFilename(w))
    writeFileSync(path, generatePlist(w, programPrefix, cfg.runtimeDir))
    const ok = ops.launchctlLoad(path)
    log(`${ok ? "loaded" : "wrote (load failed)"}  ${path}`)
  }
  if (cfg.schedule.windows.length === 0) log("No schedule windows configured. Nothing installed.")
}

function cmdScheduleUninstall(log: (s: string) => void, ops: ScheduleOps): void {
  ensureDir(ops.launchAgentsDir)
  const plists = readdirSync(ops.launchAgentsDir).filter((f) => f.startsWith("dev.unattended-claude."))
  if (plists.length === 0) {
    log("No unattended-claude plists installed.")
    return
  }
  for (const f of plists) {
    const path = join(ops.launchAgentsDir, f)
    ops.launchctlUnload(path)
    try { unlinkSync(path) } catch { /* ignore */ }
    log(`removed  ${path}`)
  }
}
