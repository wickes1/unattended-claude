/**
 * Token-usage helpers shared by the orchestrator (emits usage_snapshot events
 * at episode end) and the stats command (back-fills from claude jsonl when
 * events.jsonl has no usage_snapshot entries yet). Pure file I/O — no clock,
 * no state mutation.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Find a claude session jsonl file by UUID across all encoded-cwd project
 * subdirs of `claudeProjectsDir`. Returns the absolute path or null.
 *
 * Claude Code stores each session as `<projects-dir>/<encoded-cwd>/<uuid>.jsonl`,
 * where <encoded-cwd> is the cwd path with slashes replaced by dashes. We don't
 * know which encoded-cwd subdir the session lives in (the orchestrator can
 * launch tasks under any workdir), so we scan all of them.
 */
export function findClaudeSessionFile(
  claudeProjectsDir: string,
  sessionId: string,
): string | null {
  if (!existsSync(claudeProjectsDir)) return null
  for (const sub of readdirSync(claudeProjectsDir)) {
    const candidate = join(claudeProjectsDir, sub, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Sum input + output tokens recorded across every line of a claude jsonl
 * transcript. Returns 0 on missing file. Corrupted lines and lines without
 * `message.usage` are silently skipped (matches the events.ts crash-recovery
 * pattern).
 */
export function sumTokensFromJsonl(path: string): number {
  if (!existsSync(path)) return 0
  let total = 0
  const raw = readFileSync(path, "utf8")
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line) as {
        message?: { usage?: { input_tokens?: number; output_tokens?: number } }
      }
      const usage = obj?.message?.usage
      if (usage) {
        total += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      }
    } catch {
      /* skip corrupted line */
    }
  }
  return total
}

/** Default claude-projects directory (~/.claude/projects). */
export function defaultClaudeProjectsDir(homeDir: string): string {
  return join(homeDir, ".claude", "projects")
}
