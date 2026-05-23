import { homedir } from "node:os"
import { join } from "node:path"
import { RealClock } from "../clock.ts"
import type { Config } from "../config.ts"
import { Layout, fmtDate } from "../layout.ts"
import { TaskStateStore } from "../orchestrator/state-store.ts"
import { readEvents } from "../events.ts"
import { findClaudeSessionFile, sumTokensFromJsonl } from "../usage.ts"

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
  /**
   * True when events.jsonl had zero `usage_snapshot` entries and tokens were
   * back-filled from raw claude jsonl (the pre-F05 path). Surfaced so the CLI
   * can print a one-line notice — events.jsonl is supposed to be the source
   * of truth, so a fallback usually means very old runs or a brand-new install.
   */
  fellBackToJsonlScan: boolean
}

// findClaudeSessionFile + sumTokensFromJsonl moved to src/usage.ts so the
// orchestrator can reuse them when emitting usage_snapshot events at episode
// end. Re-exported here for backward compatibility with existing call sites.
export { findClaudeSessionFile, sumTokensFromJsonl } from "../usage.ts"

/**
 * Build the StatsSummary from layout + claude jsonl source.
 *
 * F05: token rollup prefers `usage_snapshot` events in events.jsonl. Events
 * are bucketed by their own `ts` (the moment the episode ended), which is
 * more accurate than the per-task last_updated heuristic and lets a single
 * task contribute to multiple days when it spans episodes. The legacy
 * jsonl-scan path is kept as a backfill for runs that predate F05 and
 * triggered via `fellBackToJsonlScan` so the CLI can print a notice.
 */
export function buildStats(
  layout: Layout,
  claudeProjectsDir: string,
  days: number,
  now: Date,
): StatsSummary {
  const events = readEvents(layout)
  const store = new TaskStateStore(layout, new RealClock())
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

  // Bucket task_done / task_failed / rate_limit events
  for (const e of eventsInWindow) {
    const key = fmtDate(new Date(e.ts))
    const bucket = dayByDate.get(key)
    if (!bucket) continue
    if (e.event === "task_done") bucket.tasksDone++
    else if (e.event === "task_failed") bucket.tasksFailed++
    else if (e.event === "rate_limit") bucket.rateLimitHits++
  }

  // Token rollup. Prefer usage_snapshot events when present — that's the
  // authoritative per-episode record. Fall back to scanning claude jsonl files
  // only when no snapshots exist in the window (older runs or fresh installs).
  const usageSnapshots = eventsInWindow.filter((e) => e.event === "usage_snapshot")
  let fellBackToJsonlScan = false
  if (usageSnapshots.length > 0) {
    for (const e of usageSnapshots) {
      // Type narrowed: usage_snapshot has tokens_used.
      const ev = e as Extract<typeof e, { event: "usage_snapshot" }>
      const key = fmtDate(new Date(ev.ts))
      const bucket = dayByDate.get(key)
      if (!bucket) continue
      bucket.tokens += ev.tokens_used
    }
  } else {
    // Legacy fallback: per-task jsonl scan keyed by last_updated.
    fellBackToJsonlScan = true
    for (const t of tasks) {
      const key = fmtDate(new Date(t.last_updated))
      const bucket = dayByDate.get(key)
      if (!bucket) continue
      const f = findClaudeSessionFile(claudeProjectsDir, t.claude_session_id)
      if (f) bucket.tokens += sumTokensFromJsonl(f)
    }
  }

  let totalTokens = 0, totalTasksDone = 0, totalTasksFailed = 0
  for (const d of perDay) {
    totalTokens += d.tokens
    totalTasksDone += d.tasksDone
    totalTasksFailed += d.tasksFailed
  }
  return { perDay, totalTokens, totalTasksDone, totalTasksFailed, fellBackToJsonlScan }
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
  if (summary.fellBackToJsonlScan) {
    log("(no usage_snapshot events found, falling back to jsonl scan)")
  }
  log(renderStats(summary))
}
