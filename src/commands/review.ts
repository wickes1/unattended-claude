import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../config.ts"
import { Layout } from "../layout.ts"
import { ConsoleLogger } from "../logger.ts"
import { ensureDir } from "../fs-utils.ts"
import { launchInteractiveSession } from "../runtime/claude-session.ts"
import { readEvents } from "../events.ts"
import { killSession } from "../runtime/zellij.ts"
import type { Event } from "../types.ts"

export const helpText = `Usage: ucl review [<id>] [--synthesize] [--since <duration>]

Without args   open interactive AI session reviewing the most recent run window
<id>           print SUMMARY section of tasks/<id>.md (non-interactive)
--synthesize   force generation of a markdown synthesis report at
               <runtime>/reviews/<timestamp>.md
--since 24h    when interactive/synthesize, scope context to events since now-24h
`

export interface ReviewArgs {
  id: string | null
  synthesize: boolean
  sinceHours: number | null
}

export function parseReviewArgs(argv: string[]): ReviewArgs {
  let id: string | null = null
  let synthesize = false
  let sinceHours: number | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--synthesize") synthesize = true
    else if (a === "--since" && argv[i + 1]) {
      const m = /^(\d+)\s*([hmd])$/.exec(argv[i + 1]!)
      if (m) {
        const n = Number(m[1])
        sinceHours = m[2] === "h" ? n : m[2] === "m" ? n / 60 : n * 24
      }
      i++
    } else if (!a.startsWith("--")) {
      id = a
    }
  }
  return { id, synthesize, sinceHours }
}

/** Extract the "## Summary" / "## SUMMARY" section from a task doc, or null. */
export function extractSummary(taskDoc: string): string | null {
  // Anchor on start-of-line via (?:^|\n); end at the next `## ` heading or
  // end-of-string. Using `m` would make `$` match every line-end (lazy
  // capture would yield ""), so we avoid it.
  const m = /(?:^|\n)##+\s+Summary\b([\s\S]*?)(?=\n##+\s+\S|$)/i.exec(taskDoc)
  if (!m) return null
  return m[1]!.trim()
}

/** Compute the events to consider for the interactive review window. */
export function eventsForReview(layout: Layout, args: ReviewArgs, now: Date): Event[] {
  const all = readEvents(layout)
  if (args.sinceHours !== null) {
    const cutoff = now.getTime() - args.sinceHours * 3600_000
    return all.filter((e) => new Date(e.ts).getTime() >= cutoff)
  }
  // Default: events since the most recent run_start
  let cutoffIdx = -1
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.event === "run_start") { cutoffIdx = i; break }
  }
  return cutoffIdx >= 0 ? all.slice(cutoffIdx) : all
}

export async function cmdReview(cfg: Config, argv: string[]): Promise<void> {
  const args = parseReviewArgs(argv)
  const layout = new Layout(cfg.runtimeDir)
  const log = new ConsoleLogger()

  // Mode 1: non-interactive single-task summary
  if (args.id) {
    const taskFile = layout.taskDocFile(args.id)
    if (!existsSync(taskFile)) {
      log.log("warn", `Task doc not found: ${taskFile}`)
      return
    }
    const content = readFileSync(taskFile, "utf8")
    const summary = extractSummary(content)
    if (summary) console.log(summary)
    else console.log(`(no SUMMARY section yet for ${args.id})`)
    return
  }

  // Mode 2 + 3: interactive AI review (synthesize is a flag inside)
  const events = eventsForReview(layout, args, new Date())
  const reviewsDir = join(cfg.runtimeDir, "reviews")
  if (args.synthesize) ensureDir(reviewsDir)
  const synthesisFile = args.synthesize ? join(reviewsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`) : null

  const sessionName = `unattended-claude-review-${Date.now()}`
  const cwd = cfg.runtimeDir
  const initialMessage = buildReviewInitialPrompt(layout, events, synthesisFile)
  try {
    await launchInteractiveSession(sessionName, cwd, initialMessage, cfg, log)
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

export function buildReviewInitialPrompt(layout: Layout, events: Event[], synthesisFile: string | null): string {
  const eventLog = events.length > 0
    ? events.map((e) => `  ${JSON.stringify(e)}`).join("\n")
    : "  (no events in range)"
  const synthesisInstruction = synthesisFile
    ? `\n\nSynthesis mode: write a final markdown report to ${synthesisFile}. Cover what got done, what failed, key decisions, follow-ups.`
    : ""
  return `Run the task-review skill. Review the events below and discuss with me.${synthesisInstruction}

events.jsonl (filtered):
\`\`\`
${eventLog}
\`\`\`

Task docs are in ${layout.tasksDir}. Per-task state is in ${layout.taskStatesDir}. SUMMARY sections live in each task doc.`
}
