import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdInit } from "../src/commands/init.ts"

function freshDirs(): { runtimeDir: string; configDir: string; configPath: string; templatePath: string } {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ucl-init-rt-"))
  const configDir = mkdtempSync(join(tmpdir(), "ucl-init-cfg-"))
  const configPath = join(configDir, "cc.yaml")
  // Real template lives in repo; reference it directly so we don't depend on copying.
  const templateDir = mkdtempSync(join(tmpdir(), "ucl-init-tpl-"))
  const templatePath = join(templateDir, "cc.yaml")
  writeFileSync(templatePath, "paths:\n  runtime_dir: ~/unattended\n")
  return { runtimeDir, configDir, configPath, templatePath }
}

describe("cmdInit", () => {
  it("creates all runtime subdirs + todo.md + config in empty dirs", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    const res = await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: () => true,
      log: () => {},
    })

    expect(existsSync(join(runtimeDir, "tasks"))).toBe(true)
    expect(existsSync(join(runtimeDir, "workdirs"))).toBe(true)
    expect(existsSync(join(runtimeDir, "archive"))).toBe(true)
    expect(existsSync(join(runtimeDir, "state"))).toBe(true)
    expect(existsSync(join(runtimeDir, "state", "tasks"))).toBe(true)
    expect(existsSync(join(runtimeDir, "state", "handoffs"))).toBe(true)
    expect(existsSync(join(runtimeDir, "logs"))).toBe(true)
    expect(existsSync(join(runtimeDir, "todo.md"))).toBe(true)
    expect(existsSync(configPath)).toBe(true)

    // Config content matches template
    expect(readFileSync(configPath, "utf8")).toBe(readFileSync(templatePath, "utf8"))

    // Result shape
    expect(res.configPath).toBe(configPath)
    expect(res.runtimeDir).toBe(runtimeDir)
    expect(res.notes.some((n) => n.includes("Created config"))).toBe(true)
    expect(res.notes.some((n) => n.includes("Created empty todo.md"))).toBe(true)
  })

  it("is idempotent — second run notes 'Config exists' and does not overwrite", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    await cmdInit({ templatePath, configPath, runtimeDir, toolCheck: () => true, log: () => {} })

    // Mutate the config + todo to verify second run preserves them
    const mutatedConfig = "# user-edited\npaths:\n  runtime_dir: /elsewhere\n"
    writeFileSync(configPath, mutatedConfig)
    const todoPath = join(runtimeDir, "todo.md")
    writeFileSync(todoPath, "# user notes\n")

    const res2 = await cmdInit({ templatePath, configPath, runtimeDir, toolCheck: () => true, log: () => {} })

    expect(readFileSync(configPath, "utf8")).toBe(mutatedConfig)
    expect(readFileSync(todoPath, "utf8")).toBe("# user notes\n")
    expect(res2.notes.some((n) => n.includes("Config exists"))).toBe(true)
    // Should not claim it created anything this time
    expect(res2.notes.some((n) => n.includes("Created config"))).toBe(false)
    expect(res2.notes.some((n) => n.includes("Created empty todo.md"))).toBe(false)
  })

  it("adds a WARN note when toolCheck returns false for a CLI", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    const res = await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: (cmd) => cmd !== "happy",
      log: () => {},
    })
    const warn = res.notes.find((n) => n.startsWith("WARN:"))
    expect(warn).toBeDefined()
    expect(warn).toContain("happy")
    // Other two tools should not warn
    expect(res.notes.filter((n) => n.startsWith("WARN:")).length).toBe(1)
  })

  it("throws when templatePath does not exist (and config needs to be created)", async () => {
    const { runtimeDir, configPath } = freshDirs()
    const bogus = join(tmpdir(), `nonexistent-template-${Date.now()}.yaml`)
    await expect(
      cmdInit({ templatePath: bogus, configPath, runtimeDir, toolCheck: () => true, log: () => {} }),
    ).rejects.toThrow(/init template not found/)
  })

  it("returns InitResult with correct paths", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    const res = await cmdInit({ templatePath, configPath, runtimeDir, toolCheck: () => true, log: () => {} })
    expect(res.configPath).toBe(configPath)
    expect(res.runtimeDir).toBe(runtimeDir)
    expect(Array.isArray(res.notes)).toBe(true)
  })
})
