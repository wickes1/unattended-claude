import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDocument } from "yaml"
import { getYamlValue, readYamlDoc, setYamlValue, writeYamlDoc } from "../src/yaml-utils.ts"

const SAMPLE = `# top comment
paths:
  runtime_dir: ~/unattended    # inline comment
runtime:
  driver: claude
  bin: happy
  extra_args:
    - --flag1
`

describe("yaml-utils", () => {
  test("readYamlDoc throws on missing file", () => {
    expect(() => readYamlDoc("/nonexistent")).toThrow()
  })

  test("getYamlValue returns nested scalar", () => {
    const doc = parseDocument(SAMPLE)
    expect(getYamlValue(doc, ["runtime", "bin"])).toBe("happy")
  })

  test("getYamlValue returns undefined for missing path", () => {
    const doc = parseDocument(SAMPLE)
    expect(getYamlValue(doc, ["runtime", "missing"])).toBeUndefined()
  })

  test("setYamlValue overwrites scalar and preserves comments", () => {
    const doc = parseDocument(SAMPLE)
    setYamlValue(doc, ["runtime", "bin"], "claude")
    const out = doc.toString()
    expect(out).toContain("bin: claude")
    expect(out).toContain("# top comment")
    expect(out).toContain("# inline comment")
  })

  test("setYamlValue creates intermediate maps if needed", () => {
    const doc = parseDocument("paths:\n  runtime_dir: ~/x\n")
    setYamlValue(doc, ["new", "nested", "key"], "value")
    expect(doc.toString()).toContain("new:")
    expect(doc.toString()).toContain("  nested:")
    expect(doc.toString()).toContain("    key: value")
  })

  test("writeYamlDoc round-trips through filesystem preserving comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-yu-"))
    const p = join(dir, "x.yaml")
    writeFileSync(p, SAMPLE)
    const doc = readYamlDoc(p)
    setYamlValue(doc, ["runtime", "driver"], "happy")
    writeYamlDoc(p, doc)
    const back = readFileSync(p, "utf8")
    expect(back).toContain("# top comment")
    expect(back).toContain("driver: happy")
    rmSync(dir, { recursive: true, force: true })
  })
})
