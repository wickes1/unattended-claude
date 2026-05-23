import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../config.ts"
import { Layout } from "../layout.ts"
import { ConsoleLogger } from "../logger.ts"
import { launchInteractiveSession } from "../runtime/claude-session.ts"
import { TaskStateStore } from "../orchestrator/state-store.ts"
import { killSession } from "../runtime/zellij.ts"

export const helpText = `Usage: ucl plan [--force]

Open an interactive claude session to convert new todo.md entries into task docs.
Walks the task-brief skill: clarify scope, freeze each item into tasks/<YYYY-MM-DD-NN-slug>.md,
mark planned entries as [x] in todo.md.

  --force   Skip preflight check (which refuses if a worker is currently running).

Plan runs in the foreground; exit claude (/exit) when finished.
`

export interface PlanArgs { force: boolean }

export function parsePlanArgs(argv: string[]): PlanArgs {
  return { force: argv.includes("--force") }
}

/** Returns null if OK to proceed; a refusal reason string otherwise. */
export function planPreflight(layout: Layout): string | null {
  const store = new TaskStateStore(layout)
  const running = store.listAll().filter((s) => s.state === "running")
  if (running.length > 0) {
    return `Worker is running (${running.length} task(s) in flight: ${running.map((s) => s.task_id).join(", ")}). Run \`ucl stop\` first, or use \`ucl plan --force\` to override.`
  }
  return null
}

/** v2 repo dir — claude must be launched from here so .claude/skills/task-brief loads. */
function findRepoDir(): string {
  // walk up from import.meta.dir looking for .claude/skills directory
  let dir = import.meta.dir
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, ".claude", "skills"))) return dir
    dir = join(dir, "..")
  }
  // fallback: parent of src/commands
  return join(import.meta.dir, "..", "..")
}

/** Build the initial prompt that triggers task-brief skill. */
export function buildPlanInitialPrompt(layout: Layout): string {
  const todo = existsSync(layout.todoFile) ? readFileSync(layout.todoFile, "utf8") : "(empty)"
  return `Run the task-brief skill. Process the unattended-claude todo.md.

todo.md (at ${layout.todoFile}):
\`\`\`
${todo}
\`\`\`

Existing task docs live in ${layout.tasksDir}. Mark planned entries as [x] in todo.md with a task-link suffix; write each new task doc as tasks/<YYYY-MM-DD-NN-slug>.md with frontmatter (title, workdir, serial). Auto-assigned workdirs go under ${layout.workdirsDir}/<id>/.`
}

export async function cmdPlan(cfg: Config, argv: string[]): Promise<void> {
  const args = parsePlanArgs(argv)
  const layout = new Layout(cfg.runtimeDir)
  const log = new ConsoleLogger()

  if (!args.force) {
    const refusal = planPreflight(layout)
    if (refusal) {
      log.log("warn", refusal)
      return
    }
  }

  const sessionName = `unattended-claude-plan-${Date.now()}`
  const cwd = findRepoDir()
  const initialMessage = buildPlanInitialPrompt(layout)
  try {
    await launchInteractiveSession(sessionName, cwd, initialMessage, cfg, log)
    // Attach the user's terminal so they can drive the session.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ZELLIJ_SOCKET_DIR: process.env.ZELLIJ_SOCKET_DIR ?? "/tmp/zellij",
    }
    Bun.spawnSync(["zellij", "attach", sessionName], {
      env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    })
  } finally {
    try { await killSession(sessionName) } catch { /* ignore */ }
  }
}
