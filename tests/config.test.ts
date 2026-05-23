import { describe, expect, it } from "bun:test"
import { homedir } from "node:os"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadConfig, parseDuration, resolvePath } from "../src/config.ts"

describe("parseDuration", () => {
  it("parses 30m as 1800000", () => {
    expect(parseDuration("30m")).toBe(1_800_000)
  })
  it("parses 9h as 32400000", () => {
    expect(parseDuration("9h")).toBe(32_400_000)
  })
  it("parses 500ms as 500", () => {
    expect(parseDuration("500ms")).toBe(500)
  })
  it("parses 0s as 0", () => {
    expect(parseDuration("0s")).toBe(0)
  })
  it("throws on garbage", () => {
    expect(() => parseDuration("garbage")).toThrow()
  })
})

describe("resolvePath", () => {
  it("expands ~/x to homedir/x", () => {
    expect(resolvePath("~/x", "/tmp")).toBe(join(homedir(), "x"))
  })
  it("returns absolute path as-is", () => {
    expect(resolvePath("/abs/x", "/tmp")).toBe("/abs/x")
  })
  it("resolves relative path against baseDir", () => {
    expect(resolvePath("rel/x", "/tmp")).toBe("/tmp/rel/x")
  })
})

describe("loadConfig", () => {
  it("loads v2 config/cc.yaml with expected shape", () => {
    const cfg = loadConfig(join(import.meta.dir, "..", "config", "cc.yaml"))
    expect(cfg.runtime.driver).toBe("claude")
    expect(cfg.execution.maxParallelTabs).toBe(3)
    expect(cfg.archive.autoAfterDays).toBe(7)
    expect(cfg.schedule.windows.length).toBe(0)
  })

  it("throws when paths.runtime_dir is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ucl-cfg-"))
    const p = join(dir, "bad.yaml")
    writeFileSync(p, "runtime:\n  driver: claude\n", "utf8")
    try {
      expect(() => loadConfig(p)).toThrow(/paths.runtime_dir/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("throws a clear error when file doesn't exist", () => {
    expect(() => loadConfig("/nonexistent/path/cc.yaml")).toThrow(/Config not found/)
  })
})
