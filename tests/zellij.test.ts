/**
 * zellij Layer A — pure-function unit tests.
 *
 * Only covers the parsers and ANSI stripper exported from zellij.ts. Layer B
 * (newSession/newTab/sendText/capture/closeTab/killSession/sessionAlive) and
 * the runClaudeSession integration tests are deferred to T09 — they depend on
 * a real zellij binary and on `claude-session.ts`, which has not yet been
 * ported.
 */
import { describe, expect, test } from "bun:test"
import { parsePaneList, parseSessionList, stripAnsi } from "../src/runtime/zellij.ts"

describe("stripAnsi", () => {
  test("strips CSI sequences", () => {
    const ESC = "\x1b"
    const t = `${ESC}[1;31mhello${ESC}[0m world`
    expect(stripAnsi(t)).toBe("hello world")
  })

  test("strips OSC sequences (BEL-terminated)", () => {
    const t = "\x1b]0;titlebar\x07plain"
    expect(stripAnsi(t)).toBe("plain")
  })

  test("strips CR", () => {
    expect(stripAnsi("abc\rdef")).toBe("abcdef")
  })

  test("removes CSI sequences and CR in one pass", () => {
    expect(stripAnsi("a\x1b[31mb\x1b[0m\rc")).toBe("abc")
  })
})

describe("parsePaneList", () => {
  test("extracts terminal panes, ignoring the header and plugins", () => {
    const out =
      "PANE_ID  TYPE  TITLE\n" +
      "plugin_0  plugin  (.) - zellij:link\n" +
      "terminal_0  terminal  Pane #1\n" +
      "terminal_2  terminal  Pane #1\n"
    expect(parsePaneList(out)).toEqual(["terminal_0", "terminal_2"])
  })

  test("returns an empty array for empty input", () => {
    expect(parsePaneList("")).toEqual([])
  })
})

describe("parseSessionList", () => {
  test("parses names and EXITED status", () => {
    const out =
      "unique-mouse [Created 10h ago]\n" +
      "cc-nightshift-x [Created 1s ago]\n" +
      "cc-nightshift-dead [Created 2h ago] (EXITED - attach to resurrect)\n"
    expect(parseSessionList(out)).toEqual([
      { name: "unique-mouse", exited: false },
      { name: "cc-nightshift-x", exited: false },
      { name: "cc-nightshift-dead", exited: true },
    ])
  })
})
