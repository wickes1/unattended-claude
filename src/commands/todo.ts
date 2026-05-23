import { existsSync, readFileSync } from "node:fs"
import { atomicWrite } from "../fs-utils.ts"
import { Layout } from "../layout.ts"

export const helpText = `Usage: ucl todo --consolidate

Group all [x]-checked lines in todo.md under a journal section at the bottom, grouped by date.
The unchecked lines stay where they are.
`

const JOURNAL_HEADER = "## ── Planned (archive line) ──"

/** Pure: take todo.md content, return consolidated content. */
export function consolidateTodo(content: string): string {
  const lines = content.split("\n")
  const journalIdx = lines.findIndex((l) => l.trim() === JOURNAL_HEADER)
  const upper = journalIdx >= 0 ? lines.slice(0, journalIdx) : lines
  const existingJournal = journalIdx >= 0 ? lines.slice(journalIdx + 1) : []

  const checked: { line: string; date: string | null }[] = []
  const others: string[] = []
  for (const ln of upper) {
    const m = /^\s*-\s*\[x\]\s*(.*)$/i.exec(ln)
    if (m) {
      const dm = /\b(\d{4}-\d{2}-\d{2})\b/.exec(ln)
      checked.push({ line: ln, date: dm ? dm[1]! : null })
    } else {
      others.push(ln)
    }
  }

  // If nothing checked and no pre-existing journal, leave content untouched.
  if (checked.length === 0 && existingJournal.length === 0) return content

  // Group checked by date (nulls grouped under "(undated)").
  const byDate = new Map<string, string[]>()
  for (const c of checked) {
    const key = c.date ?? "(undated)"
    const arr = byDate.get(key) ?? []
    arr.push(c.line)
    byDate.set(key, arr)
  }
  const grouped: string[] = []
  const dates = [...byDate.keys()].filter((k) => k !== "(undated)").sort()
  for (const d of dates) {
    grouped.push("")
    grouped.push(`### ${d}`)
    for (const ln of byDate.get(d)!) grouped.push(ln)
  }
  if (byDate.has("(undated)")) {
    grouped.push("")
    grouped.push("### (undated)")
    for (const ln of byDate.get("(undated)")!) grouped.push(ln)
  }

  const trimmedOthers = others.join("\n").replace(/\n+$/, "")
  const journalBody = [JOURNAL_HEADER, ...grouped, ...existingJournal]
    .join("\n")
    .replace(/\n+$/, "")
  return trimmedOthers + "\n\n" + journalBody + "\n"
}

export async function cmdTodo(
  layout: Layout,
  argv: string[],
  log: (s: string) => void = console.log,
): Promise<void> {
  if (!argv.includes("--consolidate")) {
    log(helpText)
    return
  }
  if (!existsSync(layout.todoFile)) {
    log(`No todo.md at ${layout.todoFile}`)
    return
  }
  const content = readFileSync(layout.todoFile, "utf8")
  const next = consolidateTodo(content)
  if (next === content) {
    log("todo.md already consolidated")
    return
  }
  atomicWrite(layout.todoFile, next)
  log(`consolidated ${layout.todoFile}`)
}
