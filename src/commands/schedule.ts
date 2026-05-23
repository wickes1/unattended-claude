import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import { parseDocument, type Document } from "yaml"
import { ensureDir } from "../fs-utils.ts"
import type { Config, ScheduleWindow } from "../config.ts"
import { readInstallMetadata, INSTALL_METADATA_PATH } from "../git-utils.ts"
import { parseHHMM } from "../schedule.ts"

export const helpText = `Usage: ucl schedule <list|add|remove|install|uninstall> [--bin <path>]

Manage macOS launchd entries for scheduled \`ucl run\` invocations.

  list                  Print configured windows and currently-installed plist labels
  add HH:MM HH:MM       Append a window to config.schedule.windows and reinstall plists.
                        Days default to mon..sun; override with --days mon,tue,wed
  remove N              Remove the Nth window (1-indexed) and reinstall plists
  install               Write a plist for each window in config.schedule.windows
                        and launchctl-load them
  uninstall             launchctl-unload and remove all unattended-claude plists

Options for install (also accepted by add/remove since they re-install):
  --bin <path>          Override the binary path written into ProgramArguments.
                        Useful when installing from a build dir but the binary
                        will live elsewhere (e.g. /opt/local/bin/ucl).

Plists go in ~/Library/LaunchAgents/ with labels dev.unattended-claude.<start>-<end>.plist
`

/** Names we recognize as our compiled-binary artifact (case-insensitive). */
const COMPILED_BIN_NAMES = new Set(["ucl", "unattended-claude"])

/**
 * Resolve the ProgramArguments *prefix* (everything before `run --until <end>`)
 * for the launchd plist.
 *
 * Resolution priority:
 *   1. `binOverride` (e.g. from `--bin /opt/local/bin/ucl`) — always wins.
 *   2. Install metadata at ~/.local/share/unattended-claude/install.json —
 *      `binary_path` is the symlink that scripts/install.ts placed on $PATH.
 *      This is the production path: stable across cwd changes / homebrew
 *      cellar moves / bunx invocations.
 *   3. Auto-detect from `execPath` basename matching "ucl"/"unattended-claude"
 *      (compiled binary) → emits `[execPath]`.
 *   4. Source mode (Bun interpreter + script path in argv[1]) →
 *      emits `[execPath, scriptPath]`. Dev fallback.
 *
 * Throws if all four fail (e.g. source mode but argv[1] missing) — silently
 * writing a plist launchd can't execute is worse than a clear error.
 */
export function resolveProgramPrefix(opts: {
  execPath?: string
  argv?: string[]
  binOverride?: string
  /**
   * Path to install metadata. Tests override this; production defaults to
   * INSTALL_METADATA_PATH. Pass an explicit non-existent path to force the
   * auto-detect fallback.
   */
  metadataPath?: string
} = {}): string[] {
  if (opts.binOverride) return [opts.binOverride]

  // Strategy 2: install metadata.
  const meta = readInstallMetadata(opts.metadataPath ?? INSTALL_METADATA_PATH)
  if (meta?.binary_path) return [meta.binary_path]

  // Strategy 3 + 4: detect from process state.
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
      `Pass --bin <path> to override, or run \`bun scripts/install.ts\`.`,
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

/** Resolve the final ProgramArguments prefix: --bin > caller > auto-detect. */
function resolvePrefixFor(
  binOverride: string | undefined,
  programPrefix: string | string[] | undefined,
): string[] {
  if (binOverride) return [binOverride]
  if (programPrefix !== undefined) {
    return Array.isArray(programPrefix) ? programPrefix : [programPrefix]
  }
  return resolveProgramPrefix()
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
    return cmdScheduleInstall(cfg, log, ops, resolvePrefixFor(binOverride, programPrefix))
  }
  if (sub === "uninstall") return cmdScheduleUninstall(log, ops)
  if (sub === "add") {
    return cmdScheduleAdd(
      cfg,
      rest.slice(1),
      log,
      ops,
      resolvePrefixFor(binOverride, programPrefix),
    )
  }
  if (sub === "remove") {
    return cmdScheduleRemove(
      cfg,
      rest.slice(1),
      log,
      ops,
      resolvePrefixFor(binOverride, programPrefix),
    )
  }
  log(helpText)
}

function cmdScheduleList(cfg: Config, log: (s: string) => void, ops: ScheduleOps): void {
  if (cfg.schedule.windows.length === 0) {
    log("No schedule windows configured. Add to ucl.yaml then `ucl schedule install`.")
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

// ─── add / remove ────────────────────────────────────────────────────────────
// Both subcommands edit the on-disk YAML (cfg.configPath) and reinstall plists
// so the change is immediately effective.

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
const ALL_DAYS = [...VALID_DAYS]

function parseDaysArg(s: string): string[] {
  const out = s.split(",").map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0)
  for (const d of out) {
    if (!(VALID_DAYS as readonly string[]).includes(d)) {
      throw new Error(
        `unknown day "${d}" — expected one of: ${VALID_DAYS.join(", ")}`,
      )
    }
  }
  return out
}

/** Take `--days mon,tue,...` out of argv. Throws on unknown day names. */
function takeDaysFlag(argv: string[]): { days: string[] | undefined; rest: string[] } {
  const out: string[] = []
  let days: string[] | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) {
      days = parseDaysArg(argv[i + 1]!)
      i++
      continue
    }
    out.push(argv[i]!)
  }
  return { days, rest: out }
}

/**
 * Validate HH:MM. We only assert format here — overnight windows where
 * start > end are legal (see src/schedule.ts:activeWindow), so the relative
 * ordering is intentionally NOT checked.
 */
function assertHHMM(s: string): void {
  parseHHMM(s) // throws on bad format
}

/**
 * Read-modify-write the user's ucl.yaml at cfg.configPath, mutating
 * `schedule.windows` via the supplied callback. Uses yaml.parseDocument so
 * comments and unrelated keys survive the round-trip. Returns the new windows
 * array (so the caller can immediately re-install plists without reloading).
 */
function updateScheduleYaml(
  configPath: string,
  mutate: (windows: ScheduleWindow[]) => ScheduleWindow[],
): ScheduleWindow[] {
  const src = readFileSync(configPath, "utf8")
  const doc: Document = parseDocument(src)
  // Materialize the full document as plain JS, then pluck schedule.windows.
  // This sidesteps the awkward Node.toJS(doc, ...) signature for the AST node
  // returned by doc.getIn.
  const asJs = (doc.toJS() ?? {}) as { schedule?: { windows?: ScheduleWindow[] } }
  const curJs: ScheduleWindow[] = asJs.schedule?.windows ?? []
  const next = mutate([...curJs])

  if (!doc.hasIn(["schedule"])) {
    doc.setIn(["schedule"], { windows: next })
  } else {
    doc.setIn(["schedule", "windows"], next)
  }

  writeFileSync(configPath, doc.toString())
  return next
}

function cmdScheduleAdd(
  cfg: Config,
  argv: string[],
  log: (s: string) => void,
  ops: ScheduleOps,
  programPrefix: string[],
): void {
  const { days: daysOverride, rest } = takeDaysFlag(argv)
  const [start, end] = rest
  if (!start || !end) {
    log("Usage: ucl schedule add HH:MM HH:MM [--days mon,tue,...]")
    return
  }
  try {
    assertHHMM(start)
    assertHHMM(end)
  } catch (e) {
    log(`schedule add: ${String(e)}`)
    return
  }
  const days = daysOverride ?? ALL_DAYS
  const window: ScheduleWindow = { start, end, days }

  const next = updateScheduleYaml(cfg.configPath, (windows) => [...windows, window])
  log(`added  ${start} → ${end}  days=[${days.join(",")}]`)

  // Re-install plists from the new in-memory cfg view.
  cfg.schedule.windows = next
  cmdScheduleInstall(cfg, log, ops, programPrefix)
}

function cmdScheduleRemove(
  cfg: Config,
  argv: string[],
  log: (s: string) => void,
  ops: ScheduleOps,
  programPrefix: string[],
): void {
  const [nStr] = argv
  if (!nStr) {
    log("Usage: ucl schedule remove N  (1-indexed; see `ucl schedule list`)")
    return
  }
  const n = Number(nStr)
  if (!Number.isInteger(n) || n <= 0) {
    log(`schedule remove: N must be a positive integer (got "${nStr}")`)
    return
  }
  const windows = cfg.schedule.windows
  if (windows.length === 0) {
    log("schedule remove: no windows configured.")
    return
  }
  if (n > windows.length) {
    log(`schedule remove: N=${n} is out of range (only ${windows.length} window(s) configured).`)
    return
  }

  const removed = windows[n - 1]!
  const next = updateScheduleYaml(cfg.configPath, (ws) => {
    ws.splice(n - 1, 1)
    return ws
  })
  log(`removed  #${n}  ${removed.start} → ${removed.end}  days=[${removed.days.join(",")}]`)

  // Re-install (which is really "rewrite all plists"). Uninstall first so that
  // a removed window's plist actually gets cleared from disk.
  cfg.schedule.windows = next
  cmdScheduleUninstall(log, ops)
  cmdScheduleInstall(cfg, log, ops, programPrefix)
}
