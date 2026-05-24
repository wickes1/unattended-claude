import { join } from "node:path"

/** Date format YYYY-MM-DD (local TZ). */
export function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Task ID format check: YYYY-MM-DD-NN-slug. */
export function isValidTaskId(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-\d{2}-[a-z0-9-]+$/.test(s)
}

/**
 * Generate next task ID for today. Examines `existing` (any task IDs), picks
 * the next NN for `today` date, formats as YYYY-MM-DD-NN-slug.
 */
export function nextTaskId(today: string, existing: string[], slug: string): string {
  const sameDate = existing
    .map((id) => /^(\d{4}-\d{2}-\d{2})-(\d{2})-/.exec(id))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === today)
    .map((m) => Number(m[2]))
  const next = (sameDate.length === 0 ? 0 : Math.max(...sameDate)) + 1
  return `${today}-${String(next).padStart(2, "0")}-${slug}`
}

/** All runtime paths centralized. */
export class Layout {
  constructor(readonly runtimeDir: string) {}

  get todoFile(): string { return join(this.runtimeDir, "todo.md") }
  get tasksDir(): string { return join(this.runtimeDir, "tasks") }
  get workdirsDir(): string { return join(this.runtimeDir, "workdirs") }
  get archiveDir(): string { return join(this.runtimeDir, "archive") }
  get stateDir(): string { return join(this.runtimeDir, "state") }
  get eventsJsonl(): string { return join(this.stateDir, "events.jsonl") }
  get taskStatesDir(): string { return join(this.stateDir, "tasks") }
  get handoffsDir(): string { return join(this.stateDir, "handoffs") }
  get weeklyPausedFile(): string { return join(this.stateDir, "weekly-paused-until.txt") }
  get lockFile(): string { return join(this.stateDir, ".lock") }
  /** Sentinel written by `ucl stop --now` before SIGKILL; consumed by the next
   *  run's orphan recovery to surface `paused_reason="user-stop-now"`. */
  get stopNowFlagFile(): string { return join(this.stateDir, "stop-now.flag") }
  get logsDir(): string { return join(this.runtimeDir, "logs") }
  /** User-installed skill templates dir. `ucl plan`/`ucl review` spawn claude
   *  with `cwd = runtimeDir` so SKILL.md files here auto-load. */
  get runtimeSkillsDir(): string { return join(this.runtimeDir, ".claude", "skills") }

  skillDir(name: string): string { return join(this.runtimeSkillsDir, name) }
  skillFile(name: string): string { return join(this.skillDir(name), "SKILL.md") }

  taskDocFile(id: string): string { return join(this.tasksDir, `${id}.md`) }
  taskStateFile(id: string): string { return join(this.taskStatesDir, `${id}.json`) }
  handoffFile(id: string): string { return join(this.handoffsDir, `${id}.md`) }
  taskWorkdir(id: string): string { return join(this.workdirsDir, id) }
  taskArchiveDir(id: string): string { return join(this.archiveDir, id) }
  episodeLogFile(id: string, n: number): string {
    return join(this.logsDir, `${id}-${n}.log`)
  }
  sentinelFile(id: string, n: number): string {
    return join(this.stateDir, `episode-${id}-${n}.done`)
  }
  /** Path for one daemonized orchestrator run's log file. ISO timestamp avoids collisions across runs. */
  daemonLogFile(ts: Date): string {
    const iso = ts.toISOString().replace(/[:.]/g, "-")
    return join(this.logsDir, `orchestrator-${iso}.log`)
  }
}
