import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdTodo, consolidateTodo } from "../src/commands/todo.ts"
import { Layout } from "../src/layout.ts"

function freshLayout(): Layout {
  const dir = mkdtempSync(join(tmpdir(), "ucl-todo-"))
  return new Layout(dir)
}

describe("consolidateTodo", () => {
  it("returns empty input unchanged", () => {
    expect(consolidateTodo("")).toBe("")
  })

  it("returns unchanged content when no [x] lines and no journal exist", () => {
    const content = "# inbox\n\n- [ ] buy milk\n- [ ] write doc\n"
    expect(consolidateTodo(content)).toBe(content)
  })

  it("moves all [x] lines to journal grouped by extracted date", () => {
    const content = [
      "# inbox",
      "",
      "- [ ] not done",
      "- [x] finished thing 2026-05-20",
      "- [x] another 2026-05-21",
      "- [x] yet more 2026-05-20",
    ].join("\n")
    const out = consolidateTodo(content)
    expect(out).toContain("## ── Planned (archive line) ──")
    expect(out).toContain("### 2026-05-20")
    expect(out).toContain("### 2026-05-21")
    // Unchecked stays
    expect(out).toContain("- [ ] not done")
    // Checked items are no longer in the upper section
    const upper = out.split("## ── Planned (archive line) ──")[0]!
    expect(upper).not.toContain("[x]")
    // Dates ascending: 05-20 appears before 05-21 in the journal
    const lower = out.split("## ── Planned (archive line) ──")[1]!
    expect(lower.indexOf("### 2026-05-20")).toBeLessThan(
      lower.indexOf("### 2026-05-21"),
    )
  })

  it("places undated [x] lines under ### (undated)", () => {
    const content = [
      "- [x] no date here",
      "- [x] dated one 2026-05-22",
    ].join("\n")
    const out = consolidateTodo(content)
    expect(out).toContain("### 2026-05-22")
    expect(out).toContain("### (undated)")
    // Undated group should appear AFTER dated groups
    const lower = out.split("## ── Planned (archive line) ──")[1]!
    expect(lower.indexOf("### 2026-05-22")).toBeLessThan(
      lower.indexOf("### (undated)"),
    )
  })

  it("preserves existing journal section content", () => {
    const content = [
      "# inbox",
      "- [x] new finish 2026-05-23",
      "## ── Planned (archive line) ──",
      "",
      "### 2026-05-10",
      "- [x] old historic item",
    ].join("\n")
    const out = consolidateTodo(content)
    // Old content still present
    expect(out).toContain("- [x] old historic item")
    expect(out).toContain("### 2026-05-10")
    // New checked item lifted to journal
    expect(out).toContain("### 2026-05-23")
    expect(out).toContain("- [x] new finish 2026-05-23")
    // Upper section no longer has [x] lines
    const upper = out.split("## ── Planned (archive line) ──")[0]!
    expect(upper).not.toContain("[x]")
  })

  it("is idempotent (running twice yields same content)", () => {
    const content = [
      "# inbox",
      "- [ ] keep",
      "- [x] done 2026-05-22",
      "- [x] also 2026-05-22",
      "- [x] undated done",
    ].join("\n")
    const once = consolidateTodo(content)
    const twice = consolidateTodo(once)
    expect(twice).toBe(once)
  })
})

describe("cmdTodo", () => {
  it("logs help when --consolidate not passed", async () => {
    const layout = freshLayout()
    const logs: string[] = []
    await cmdTodo(layout, [], (s) => logs.push(s))
    expect(logs.join("\n")).toContain("Usage: ucl todo --consolidate")
  })

  it("logs friendly message when todo.md missing", async () => {
    const layout = freshLayout()
    const logs: string[] = []
    await cmdTodo(layout, ["--consolidate"], (s) => logs.push(s))
    expect(logs.some((l) => l.includes("No todo.md"))).toBe(true)
  })

  it("writes the file when content changes and logs 'consolidated'", async () => {
    const layout = freshLayout()
    writeFileSync(layout.todoFile, [
      "# inbox",
      "- [ ] keep",
      "- [x] done 2026-05-22",
    ].join("\n"))
    const logs: string[] = []
    await cmdTodo(layout, ["--consolidate"], (s) => logs.push(s))
    expect(logs.some((l) => l.includes("consolidated"))).toBe(true)
    const after = readFileSync(layout.todoFile, "utf8")
    expect(after).toContain("## ── Planned (archive line) ──")
    expect(after).toContain("### 2026-05-22")
  })

  it("logs 'already consolidated' when no change", async () => {
    const layout = freshLayout()
    const content = "# inbox\n\n- [ ] just unchecked\n"
    writeFileSync(layout.todoFile, content)
    const logs: string[] = []
    await cmdTodo(layout, ["--consolidate"], (s) => logs.push(s))
    expect(logs.some((l) => l.includes("already consolidated"))).toBe(true)
    expect(readFileSync(layout.todoFile, "utf8")).toBe(content)
  })
})
