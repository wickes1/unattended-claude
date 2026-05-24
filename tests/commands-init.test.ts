import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDocument } from "yaml"
import { cmdInit, type RlLike } from "../src/commands/init.ts"

function freshDirs(): {
  runtimeDir: string
  configDir: string
  configPath: string
  templatePath: string
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ucl-init-rt-"))
  const configDir = mkdtempSync(join(tmpdir(), "ucl-init-cfg-"))
  const configPath = join(configDir, "ucl.yaml")
  const templateDir = mkdtempSync(join(tmpdir(), "ucl-init-tpl-"))
  const templatePath = join(templateDir, "ucl.yaml")
  // Minimal template — paths.runtime_dir is the only required field; everything
  // else defaults via loadConfig. Other init-prompted keys are added by the wizard.
  writeFileSync(
    templatePath,
    "# template\npaths:\n  runtime_dir: ~/unattended\nruntime:\n  bin: happy\n",
  )
  return { runtimeDir, configDir, configPath, templatePath }
}

/**
 * Fake readline interface. `answers` are dequeued one per `.question` call.
 * `seenQuestions` captures every prompt string the wizard sent, for assertions
 * like "the prompt contained `[happy]` as the default".
 */
function fakeRl(answers: string[]): RlLike & { seenQuestions: string[]; closed: boolean } {
  const queue = [...answers]
  const seenQuestions: string[] = []
  let closed = false
  const rl = {
    seenQuestions,
    get closed(): boolean { return closed },
    question(q: string, cb: (ans: string) => void): void {
      seenQuestions.push(q)
      const ans = queue.shift()
      if (ans === undefined) {
        throw new Error(`fakeRl: ran out of answers; got prompt "${q}"`)
      }
      // Defer to next tick to mimic real readline async behavior.
      setImmediate(() => cb(ans))
    },
    close(): void { closed = true },
  } as RlLike & { seenQuestions: string[]; closed: boolean }
  return rl
}

describe("cmdInit (interactive wizard)", () => {
  it("first init writes config with prompted values, creates runtime tree", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    // Fake skills template dir with one dummy skill — proves the install loop
    // is wired and respects the opts override (avoids hitting the real config/skills).
    const skillsTemplateDir = mkdtempSync(join(tmpdir(), "ucl-init-skills-"))
    const dummySkillName = "dummy-skill"
    const dummySkillDir = join(skillsTemplateDir, dummySkillName)
    mkdirSync(dummySkillDir, { recursive: true })
    writeFileSync(
      join(dummySkillDir, "SKILL.md"),
      "---\nname: dummy-skill\ntemplate_version: 1\ndescription: test\n---\n\n# dummy\n",
    )
    // Prompt order: bin first, then runtime dir.
    const rl = fakeRl(["claude", "~/myrun"])
    const res = await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: () => true,
      rl,
      skillsTemplateDir,
      log: () => {},
    })

    // Config was written with the prompted values.
    expect(existsSync(configPath)).toBe(true)
    const written = readFileSync(configPath, "utf8")
    const doc = parseDocument(written)
    expect(doc.getIn(["paths", "runtime_dir"])).toBe("~/myrun")
    expect(doc.getIn(["runtime", "bin"])).toBe("claude")

    // Runtime tree exists.
    expect(existsSync(join(runtimeDir, "tasks"))).toBe(true)
    expect(existsSync(join(runtimeDir, "workdirs"))).toBe(true)
    expect(existsSync(join(runtimeDir, "archive"))).toBe(true)
    expect(existsSync(join(runtimeDir, "state"))).toBe(true)
    expect(existsSync(join(runtimeDir, "state", "tasks"))).toBe(true)
    expect(existsSync(join(runtimeDir, "state", "handoffs"))).toBe(true)
    expect(existsSync(join(runtimeDir, "logs"))).toBe(true)
    expect(existsSync(join(runtimeDir, "todo.md"))).toBe(true)

    // Skill template was copied to runtime_dir/.claude/skills/<name>/SKILL.md.
    const dummyDst = join(runtimeDir, ".claude", "skills", dummySkillName, "SKILL.md")
    expect(existsSync(dummyDst)).toBe(true)

    // Result shape.
    expect(res.configPath).toBe(configPath)
    expect(res.runtimeDir).toBe(runtimeDir)
    expect(res.notes.some((n) => n.includes("Created config"))).toBe(true)
    expect(res.notes.some((n) => n.includes("Created empty todo.md"))).toBe(true)
    expect(rl.closed).toBe(false) // we supplied the rl, so wizard should NOT close it
  })

  it("re-init preserves user-edited fields outside the prompted ones", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    // First init to create a baseline config.
    await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: () => true,
      rl: fakeRl(["claude", "~/unattended"]),
      log: () => {},
    })

    // User hand-edits an unrelated field. Template (see freshDirs above) has no
    // execution block, so append it — the re-init must preserve it.
    const baseline = readFileSync(configPath, "utf8")
    writeFileSync(configPath, baseline + "\nexecution:\n  max_parallel_tabs: 9\n")

    // Re-init — accept defaults for both prompts (empty string).
    await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: () => true,
      rl: fakeRl(["", ""]),
      log: () => {},
    })

    const after = readFileSync(configPath, "utf8")
    const doc = parseDocument(after)
    expect(doc.getIn(["execution", "max_parallel_tabs"])).toBe(9)
  })

  it("re-init shows current values as prompt defaults", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    // Pre-write a config with bin=happy + runtime_dir=~/preset so we know the defaults.
    writeFileSync(
      configPath,
      "paths:\n  runtime_dir: ~/preset\nruntime:\n  bin: happy\n",
    )

    const rl = fakeRl(["", ""])
    await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: () => true,
      rl,
      log: () => {},
    })

    // The bin prompt should advertise [happy], the dir prompt should advertise [~/preset].
    expect(rl.seenQuestions.some((q) => q.includes("[happy]"))).toBe(true)
    expect(rl.seenQuestions.some((q) => q.includes("[~/preset]"))).toBe(true)
  })

  it("only happy installed → no prompt asked for bin, auto-selected as happy", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    // Only one answer in the queue — the runtime dir prompt. If the wizard tries
    // to ask a 2nd question, fakeRl throws.
    const rl = fakeRl(["~/x"])
    await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: (cmd) => cmd === "happy",
      rl,
      log: () => {},
    })

    expect(rl.seenQuestions.length).toBe(1)
    expect(rl.seenQuestions[0]).toContain("Runtime dir")
    const doc = parseDocument(readFileSync(configPath, "utf8"))
    expect(doc.getIn(["runtime", "bin"])).toBe("happy")
  })

  it("only claude installed → bin auto-selected as claude", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    const rl = fakeRl(["~/x"])
    await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: (cmd) => cmd === "claude",
      rl,
      log: () => {},
    })

    expect(rl.seenQuestions.length).toBe(1)
    const doc = parseDocument(readFileSync(configPath, "utf8"))
    expect(doc.getIn(["runtime", "bin"])).toBe("claude")
  })

  it("neither installed → throws with clear message", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    const rl = fakeRl([])
    await expect(
      cmdInit({
        templatePath,
        configPath,
        runtimeDir,
        toolCheck: () => false,
        rl,
        log: () => {},
      }),
    ).rejects.toThrow(/Neither claude nor happy/)
    // Should have aborted before any prompt.
    expect(rl.seenQuestions.length).toBe(0)
  })

  it("empty answer for runtime dir uses default", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    // Template's runtime_dir default is "~/unattended"; empty answer should keep it.
    const rl = fakeRl(["claude", ""])
    await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: () => true,
      rl,
      log: () => {},
    })

    const doc = parseDocument(readFileSync(configPath, "utf8"))
    expect(doc.getIn(["paths", "runtime_dir"])).toBe("~/unattended")
  })

  it("invalid bin answer retries until valid", async () => {
    const { runtimeDir, configPath, templatePath } = freshDirs()
    // 1st: "bogus" → invalid retry; 2nd: "" → would accept default but we want to
    // verify the retry path explicitly picks the next valid answer; 3rd: "claude".
    const rl = fakeRl(["bogus", "claude", "~/x"])
    await cmdInit({
      templatePath,
      configPath,
      runtimeDir,
      toolCheck: () => true,
      rl,
      log: () => {},
    })

    // Two bin prompts (1st rejected, 2nd accepted) + 1 runtime-dir prompt = 3 total.
    expect(rl.seenQuestions.length).toBe(3)
    const binPrompts = rl.seenQuestions.filter((q) => q.includes("Runtime bin"))
    expect(binPrompts.length).toBe(2)
    const doc = parseDocument(readFileSync(configPath, "utf8"))
    expect(doc.getIn(["runtime", "bin"])).toBe("claude")
  })
})
