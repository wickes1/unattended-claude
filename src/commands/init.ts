import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { atomicWrite, ensureDir } from "../fs-utils.ts"
import { Layout } from "../layout.ts"
import { resolvePath } from "../config.ts"

export const helpText = `Usage: ucl init

One-time setup. Creates the runtime dir tree and config file. Idempotent.

This command:
1. Creates ~/unattended/ with subdirs: tasks, workdirs, archive, state/{tasks,handoffs}, logs
2. Creates ~/.config/unattended-claude/cc.yaml from the bundled template
3. Preflight-checks for claude, happy, zellij CLIs (warn if missing)
4. Prints next-step hints

Existing data is never overwritten.
`

export interface InitResult {
  /** Absolute path to the config file (created or pre-existing). */
  configPath: string
  /** Absolute path to the runtime dir. */
  runtimeDir: string
  /** Notes the wizard surfaced (warnings, info). */
  notes: string[]
}

/**
 * Run the init wizard. Pure function over filesystem — accepts overrides
 * for testability.
 */
export async function cmdInit(opts: {
  templatePath?: string
  configPath?: string
  runtimeDir?: string
  toolCheck?: (cmd: string) => boolean
  log?: (s: string) => void
} = {}): Promise<InitResult> {
  const log = opts.log ?? console.log
  const templatePath = opts.templatePath
    ?? resolve(import.meta.dir, "..", "..", "config", "cc.yaml")
  const configPath = opts.configPath
    ?? join(homedir(), ".config", "unattended-claude", "cc.yaml")
  const runtimeDir = opts.runtimeDir
    ?? resolvePath("~/unattended", homedir())
  const layout = new Layout(runtimeDir)
  const notes: string[] = []

  // 1. Create runtime dir tree
  ensureDir(runtimeDir)
  ensureDir(layout.tasksDir)
  ensureDir(layout.workdirsDir)
  ensureDir(layout.archiveDir)
  ensureDir(layout.stateDir)
  ensureDir(layout.taskStatesDir)
  ensureDir(layout.handoffsDir)
  ensureDir(layout.logsDir)

  // Create empty todo.md if missing
  if (!existsSync(layout.todoFile)) {
    writeFileSync(
      layout.todoFile,
      "# unattended-claude — todo inbox\n\n" +
      "Add lines below. `[x]` means already planned (you don't have to add it manually — `ucl plan` does).\n\n",
    )
    notes.push(`Created empty todo.md at ${layout.todoFile}`)
  }

  // 2. Create config from template if missing
  if (!existsSync(configPath)) {
    if (!existsSync(templatePath)) {
      throw new Error(`init template not found: ${templatePath}`)
    }
    ensureDir(dirname(configPath))
    const tpl = readFileSync(templatePath, "utf8")
    atomicWrite(configPath, tpl)
    notes.push(`Created config at ${configPath}`)
  } else {
    notes.push(`Config exists at ${configPath} (kept; edit manually if needed)`)
  }

  // 3. Preflight tool checks (warn only)
  const toolCheck = opts.toolCheck ?? defaultToolCheck
  for (const t of ["claude", "happy", "zellij"]) {
    if (!toolCheck(t)) {
      notes.push(`WARN: ${t} CLI not found on PATH. Install it before \`ucl run\`.`)
    }
  }

  // 4. Print summary + next steps
  log("unattended-claude initialized.")
  for (const n of notes) log(`  - ${n}`)
  log("")
  log("Next steps:")
  log(`  1. Edit ${layout.todoFile} — add what you want done.`)
  log("  2. Run `ucl plan` to convert todos into task docs.")
  log("  3. Run `ucl run --until <HH:MM>` when you're leaving the keyboard.")

  return { configPath, runtimeDir, notes }
}

function defaultToolCheck(cmd: string): boolean {
  const r = Bun.spawnSync(["which", cmd], { stdout: "pipe", stderr: "pipe" })
  return r.exitCode === 0
}
