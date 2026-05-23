import { readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ensureDir } from "../fs-utils.ts"
import type { Config, ScheduleWindow } from "../config.ts"
import { parseHHMM } from "../schedule.ts"

export const helpText = `Usage: ucl schedule <list|install|uninstall>

Manage macOS launchd entries for scheduled \`ucl run\` invocations.

  list        Print configured windows and currently-installed plist labels
  install     Write a plist for each window in config.schedule.windows
              and launchctl-load them
  uninstall   launchctl-unload and remove all unattended-claude plists

Plists go in ~/Library/LaunchAgents/ with labels dev.unattended-claude.<start>-<end>.plist
`

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
 * The plist runs `<exePath> run --until <window.end>` at the window's start time
 * on each active day.
 */
export function generatePlist(window: ScheduleWindow, exePath: string, runtimeDir: string): string {
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistLabel(window)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exePath}</string>
    <string>run</string>
    <string>--until</string>
    <string>${window.end}</string>
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

/** Sub-command dispatch. */
export async function cmdSchedule(
  cfg: Config,
  argv: string[],
  log: (s: string) => void = console.log,
  ops: ScheduleOps = defaultOps,
  exePath: string = process.argv[1] ?? "ucl",
): Promise<void> {
  const sub = argv[0]
  if (sub === "list") return cmdScheduleList(cfg, log, ops)
  if (sub === "install") return cmdScheduleInstall(cfg, log, ops, exePath)
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

function cmdScheduleInstall(cfg: Config, log: (s: string) => void, ops: ScheduleOps, exePath: string): void {
  ensureDir(ops.launchAgentsDir)
  for (const w of cfg.schedule.windows) {
    const path = join(ops.launchAgentsDir, plistFilename(w))
    writeFileSync(path, generatePlist(w, exePath, cfg.runtimeDir))
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
