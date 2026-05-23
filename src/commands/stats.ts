import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Config } from "../config.ts"
import { Layout, fmtDate } from "../layout.ts"
import { TaskStateStore } from "../orchestrator/state-store.ts"
import { readEvents } from "../events.ts"

export const helpText = `Usage: ucl stats [--days N] [--claude-projects-dir <path>]

Print historical utilization: per-day task counts, token usage, rate-limit hits.
Pure read of state and ~/.claude/projects/*.jsonl. No AI.

  --days N                       Window size in days (default 7)
  --claude-projects-dir <path>   Override for token-source dir (default ~/.claude/projects/)
`

export interface StatsArgs {
  days: number
  claudeProjectsDir: string
}

export function parseStatsArgs(argv: string[]): StatsArgs {
  let days = 7
  let claudeProjectsDir = join(homedir(), ".claude", "projects")
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) {
      const n = Number(argv[i + 1])
      if (Number.isFinite(n) && n > 0) days = Math.floor(n)
      i++
    } else if (argv[i] === "--claude-projects-dir" && argv[i + 1]) {
      claudeProjectsDir = argv[i + 1]!
      i++
    }
  }
  return { days, claudeProjectsDir }
}

/** Per-day rollup. */
export interface DayStats {
  day: string                    // YYYY-MM-DD
  tasksDone: number
  tasksFailed: number
  tokens: number
  rateLimitHits: number
}

export interface StatsSummary {
  perDay: DayStats[]
  totalTokens: number
  totalTasksDone: number
  totalTasksFailed: number
}

/**
 * Find a claude session jsonl file by UUID across all encoded-cwd project subdirs.
 * Returns the absolute path or null.
 */
export function findClaudeSessionFile(claudeProjectsDir: string, sessionId: string): string | null {
  if (!existsSync(claudeProjectsDir)) return null
  for (const sub of readdirSync(claudeProjectsDir)) {
    const candidate = join(claudeProjectsDir, sub, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Sum input+output tokens from a claude jsonl. Returns 0 on missing file. */
export function sumTokensFromJsonl(path: string): number {
  if (!existsSync(path)) return 0
  let total = 0
  const raw = readFileSync(path, "utf8")
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line) as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } }
      const usage = obj?.message?.usage
      if (usage) {
        total += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      }
    } catch { /* skip corrupted line */ }
  }
  return total
}

/** Build the StatsSummary from layout + claude jsonl source. */
export function buildStats(
  layout: Layout,
  claudeProjectsDir: string,
  days: number,
  now: Date,
): StatsSummary {
  const events = readEvents(layout)
  const store = new TaskStateStore(layout)
  const tasks = store.listAll()

  // Group events by day
  const cutoff = now.getTime() - days * 24 * 3600_000
  const eventsInWindow = events.filter((e) => new Date(e.ts).getTime() >= cutoff)

  // Initialize per-day bucket for `days` days ending at now
  const perDay: DayStats[] = []
  const dayByDate = new Map<string, DayStats>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = fmtDate(d)
    const stats: DayStats = { day: key, tasksDone: 0, tasksFailed: 0, tokens: 0, rateLimitHits: 0 }
    perDay.push(stats)
    dayByDate.set(key, stats)
  }

  // Bucket events
  for (const e of eventsInWindow) {
    const key = fmtDate(new Date(e.ts))
    const bucket = dayByDate.get(key)
    if (!bucket) continue
    if (e.event === "task_done") bucket.tasksDone++
    else if (e.event === "task_failed") bucket.tasksFailed++
    else if (e.event === "rate_limit") bucket.rateLimitHits++
  }

  // Sum tokens per task → assign to day of last_updated
  for (const t of tasks) {
    const key = fmtDate(new Date(t.last_updated))
    const bucket = dayByDate.get(key)
    if (!bucket) continue
    const f = findClaudeSessionFile(claudeProjectsDir, t.claude_session_id)
    if (f) bucket.tokens += sumTokensFromJsonl(f)
  }

  let totalTokens = 0, totalTasksDone = 0, totalTasksFailed = 0
  for (const d of perDay) {
    totalTokens += d.tokens
    totalTasksDone += d.tasksDone
    totalTasksFailed += d.tasksFailed
  }
  return { perDay, totalTokens, totalTasksDone, totalTasksFailed }
}

/** Render as a text table per DESIGN §十二 example. */
export function renderStats(summary: StatsSummary): string {
  const lines: string[] = []
  lines.push(`Last ${summary.perDay.length} days:`)
  lines.push("  Day          Tasks(✓/✗)    Token usage    5h-windows hit limit")
  for (const d of summary.perDay) {
    const tasks = `${d.tasksDone}/${d.tasksFailed}`.padEnd(13)
    const tokens = d.tokens.toLocaleString().padStart(11)
    const hits = String(d.rateLimitHits).padStart(2)
    lines.push(`  ${d.day}   ${tasks} ${tokens}    ${hits}`)
  }
  lines.push("")
  lines.push(`Totals: done=${summary.totalTasksDone}  failed=${summary.totalTasksFailed}  tokens=${summary.totalTokens.toLocaleString()}`)
  return lines.join("\n")
}

export async function cmdStats(cfg: Config, argv: string[], log: (s: string) => void = console.log): Promise<void> {
  const args = parseStatsArgs(argv)
  const layout = new Layout(cfg.runtimeDir)
  const summary = buildStats(layout, args.claudeProjectsDir, args.days, new Date())
  log(renderStats(summary))
}
