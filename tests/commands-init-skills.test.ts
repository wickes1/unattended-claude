/**
 * Skill install + upgrade behavior for `ucl init`.
 *
 * The contract under test: skills are user-installed data — first init copies
 * verbatim, subsequent inits never overwrite. Version comparison is the ONLY
 * trigger for the upgrade warning. Content diffs at matching versions are
 * silent. See plan 2026-05-23-skills-to-runtime.md "Why the upgrade model is
 * version-only, never overwrite, user-controlled".
 */
import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdInit, type RlLike } from "../src/commands/init.ts"

function freshDirs(): {
  runtimeDir: string
  configPath: string
  templatePath: string
  skillsTemplateDir: string
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ucl-skills-rt-"))
  const configDir = mkdtempSync(join(tmpdir(), "ucl-skills-cfg-"))
  const configPath = join(configDir, "ucl.yaml")
  const templateDir = mkdtempSync(join(tmpdir(), "ucl-skills-tpl-"))
  const templatePath = join(templateDir, "ucl.yaml")
  writeFileSync(
    templatePath,
    "# template\npaths:\n  runtime_dir: ~/unattended\nruntime:\n  bin: happy\n",
  )
  const skillsTemplateDir = mkdtempSync(join(tmpdir(), "ucl-skills-src-"))
  return { runtimeDir, configPath, templatePath, skillsTemplateDir }
}

function fakeRl(answers: string[]): RlLike {
  const queue = [...answers]
  return {
    question(_q: string, cb: (ans: string) => void): void {
      const ans = queue.shift() ?? ""
      setImmediate(() => cb(ans))
    },
    close(): void { /* noop */ },
  }
}

function writeTemplateSkill(
  skillsTemplateDir: string,
  name: string,
  body: string,
): string {
  const dir = join(skillsTemplateDir, name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "SKILL.md")
  writeFileSync(file, body)
  return file
}

function makeSkillBody(name: string, version: number, marker = "v1 body"): string {
  return `---
name: ${name}
template_version: ${version}
description: test skill ${name}
---

# ${name}

${marker}
`
}

async function runInit(opts: {
  runtimeDir: string
  configPath: string
  templatePath: string
  skillsTemplateDir: string
  log?: (s: string) => void
}): Promise<void> {
  await cmdInit({
    templatePath: opts.templatePath,
    configPath: opts.configPath,
    runtimeDir: opts.runtimeDir,
    toolCheck: () => true,
    rl: fakeRl(["claude", "~/x"]),
    skillsTemplateDir: opts.skillsTemplateDir,
    log: opts.log ?? (() => {}),
  })
}

describe("cmdInit skill install + upgrade", () => {
  it("first init installs all skill templates with stamped frontmatter (body preserved, hash + version + name retained)", async () => {
    const d = freshDirs()
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1, "brief-distinct-marker"))
    writeTemplateSkill(d.skillsTemplateDir, "task-review", makeSkillBody("task-review", 1, "review-distinct-marker"))

    await runInit(d)

    const briefDst = join(d.runtimeDir, ".claude", "skills", "task-brief", "SKILL.md")
    const reviewDst = join(d.runtimeDir, ".claude", "skills", "task-review", "SKILL.md")
    expect(existsSync(briefDst)).toBe(true)
    expect(existsSync(reviewDst)).toBe(true)

    // G04 stamps `template_hash` into frontmatter — file is no longer byte-equal
    // to the template, but body + key frontmatter fields are preserved.
    const briefInstalled = readFileSync(briefDst, "utf8")
    expect(briefInstalled).toContain("brief-distinct-marker")
    expect(briefInstalled).toContain("name: task-brief")
    expect(briefInstalled).toContain("template_version: 1")
    expect(briefInstalled).toMatch(/^template_hash:\s*sha256:[a-f0-9]{64}\s*$/m)

    const reviewInstalled = readFileSync(reviewDst, "utf8")
    expect(reviewInstalled).toContain("review-distinct-marker")
    expect(reviewInstalled).toContain("name: task-review")
    expect(reviewInstalled).toContain("template_version: 1")
    expect(reviewInstalled).toMatch(/^template_hash:\s*sha256:[a-f0-9]{64}\s*$/m)
  })

  it("first init logs an Installed-skill note per skill", async () => {
    const d = freshDirs()
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1))
    writeTemplateSkill(d.skillsTemplateDir, "task-review", makeSkillBody("task-review", 1))

    const lines: string[] = []
    await runInit({ ...d, log: (s) => { lines.push(s) } })
    const joined = lines.join("\n")
    expect(joined).toContain("Installed skill task-brief")
    expect(joined).toContain("Installed skill task-review")
  })

  it("re-init with same template version skips silently (no warn, content unchanged)", async () => {
    const d = freshDirs()
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1))
    // First init.
    await runInit(d)
    const dst = join(d.runtimeDir, ".claude", "skills", "task-brief", "SKILL.md")
    const before = readFileSync(dst, "utf8")

    // Second init at same v1 — no warn, no rewrite.
    const lines: string[] = []
    await runInit({ ...d, log: (s) => { lines.push(s) } })
    const after = readFileSync(dst, "utf8")
    expect(after).toBe(before)
    const joined = lines.join("\n")
    expect(joined).not.toMatch(/not overwriting/)
    expect(joined).not.toMatch(/template v\d+ available/)
    // No re-install note either — file already exists.
    expect(joined).not.toContain("Installed skill task-brief")
  })

  it("re-init with newer template version + user-modified skill → warn, no overwrite", async () => {
    const d = freshDirs()
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1, "v1 body"))
    await runInit(d)
    const dst = join(d.runtimeDir, ".claude", "skills", "task-brief", "SKILL.md")

    // Simulate a user edit — breaks the stamped hash so re-init at v2 must
    // warn rather than silently upgrading.
    const userEdited = readFileSync(dst, "utf8") + "\n# my edit\n"
    writeFileSync(dst, userEdited)

    // Bump template to v2.
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 2, "v2 body"))

    const lines: string[] = []
    await runInit({ ...d, log: (s) => { lines.push(s) } })
    const joined = lines.join("\n")
    expect(joined).toContain("template v2 available")
    expect(joined).toContain("you have v1")
    expect(joined).toContain("not overwriting")
    // User file still contains their edit — never overwritten.
    expect(readFileSync(dst, "utf8")).toBe(userEdited)
  })

  it("user-modified skill at same version still skips (no warn — version match dominates)", async () => {
    // This is the contract: version-match dominates content-diff. If we ever
    // add hash comparison, this test fails — and rightly so, because invisible
    // sidecar state is exactly what the design rejected.
    const d = freshDirs()
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1))
    await runInit(d)
    const dst = join(d.runtimeDir, ".claude", "skills", "task-brief", "SKILL.md")
    // User hand-edits the body (keeps v1 frontmatter).
    const userEdited = makeSkillBody("task-brief", 1, "user-customized body — DO NOT REVERT")
    writeFileSync(dst, userEdited)

    const lines: string[] = []
    await runInit({ ...d, log: (s) => { lines.push(s) } })
    expect(readFileSync(dst, "utf8")).toBe(userEdited)
    const joined = lines.join("\n")
    expect(joined).not.toMatch(/not overwriting/)
    expect(joined).not.toMatch(/template v\d+ available/)
  })

  it("missing template_version frontmatter → readSkillVersion returns 0; behaves as if oldest", async () => {
    const d = freshDirs()
    // Template WITHOUT template_version line.
    const noVerBody = `---
name: task-brief
description: legacy skill
---

# task-brief

legacy body
`
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", noVerBody)
    await runInit(d)
    const dst = join(d.runtimeDir, ".claude", "skills", "task-brief", "SKILL.md")
    expect(existsSync(dst)).toBe(true)

    // Now bump the template to v1; user file has no version (treated as 0).
    // Expect a warn.
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1))
    const lines: string[] = []
    await runInit({ ...d, log: (s) => { lines.push(s) } })
    const joined = lines.join("\n")
    expect(joined).toContain("template v1 available")
    expect(joined).toContain("you have v0")
  })

  // --- G04: hash-stamped silent upgrade ---

  it("first install stamps template_hash into user's SKILL.md frontmatter", async () => {
    const d = freshDirs()
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1))
    await runInit(d)
    const dst = join(d.runtimeDir, ".claude", "skills", "task-brief", "SKILL.md")
    const installed = readFileSync(dst, "utf8")
    // template_hash sits in the frontmatter as `sha256:<64-hex>`.
    expect(installed).toMatch(/^template_hash:\s*sha256:[a-f0-9]{64}\s*$/m)
    // Confirmed to be in the frontmatter block (between the two `---` fences).
    const fm = /^---\n([\s\S]*?)\n---/.exec(installed)
    expect(fm).not.toBeNull()
    expect(fm![1]).toMatch(/^template_hash:\s*sha256:[a-f0-9]{64}\s*$/m)
  })

  it("re-init silently upgrades unmodified skill to new template version", async () => {
    const d = freshDirs()
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1, "v1 body"))
    await runInit(d)
    const dst = join(d.runtimeDir, ".claude", "skills", "task-brief", "SKILL.md")

    // Bump template to v2 with a distinctive body marker.
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 2, "v2-upgraded-marker"))

    const lines: string[] = []
    await runInit({ ...d, log: (s) => { lines.push(s) } })

    const after = readFileSync(dst, "utf8")
    // User file now contains the v2 body and v2 version, with a fresh hash stamp.
    expect(after).toContain("v2-upgraded-marker")
    expect(after).toContain("template_version: 2")
    expect(after).toMatch(/^template_hash:\s*sha256:[a-f0-9]{64}\s*$/m)

    const joined = lines.join("\n")
    expect(joined).toContain("upgraded v1 → v2")
    expect(joined).toContain("unmodified")
    // No warn — clean upgrade.
    expect(joined).not.toMatch(/not overwriting/)
    expect(joined).not.toMatch(/template v2 available/)
  })

  it("re-init does NOT upgrade user-modified skill (hash mismatch protects)", async () => {
    const d = freshDirs()
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1, "v1 body"))
    await runInit(d)
    const dst = join(d.runtimeDir, ".claude", "skills", "task-brief", "SKILL.md")

    // User edits the file — breaks the stamped hash.
    const userEdited = readFileSync(dst, "utf8") + "\n# user added section\n"
    writeFileSync(dst, userEdited)

    // Bump template to v2.
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 2, "v2 body"))

    const lines: string[] = []
    await runInit({ ...d, log: (s) => { lines.push(s) } })

    // File still has the user's edit verbatim.
    expect(readFileSync(dst, "utf8")).toBe(userEdited)
    const joined = lines.join("\n")
    expect(joined).toContain("template v2 available")
    expect(joined).toContain("not overwriting")
    // Not silently upgraded.
    expect(joined).not.toMatch(/upgraded v\d+ → v\d+/)
  })

  it("re-init treats missing template_hash as modified (safety fallback for pre-G04 installs)", async () => {
    const d = freshDirs()
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 1))
    // Pre-create the user skill file at v1 WITHOUT template_hash — simulates
    // a skill installed by a pre-G04 ucl (frontmatter has template_version but
    // no template_hash line).
    const userDir = join(d.runtimeDir, ".claude", "skills", "task-brief")
    mkdirSync(userDir, { recursive: true })
    const dst = join(userDir, "SKILL.md")
    const preG04Content = makeSkillBody("task-brief", 1, "pre-G04 install body")
    writeFileSync(dst, preG04Content)

    // Bump template to v2.
    writeTemplateSkill(d.skillsTemplateDir, "task-brief", makeSkillBody("task-brief", 2, "v2 body"))

    const lines: string[] = []
    await runInit({ ...d, log: (s) => { lines.push(s) } })

    // No overwrite — user file unchanged.
    expect(readFileSync(dst, "utf8")).toBe(preG04Content)
    const joined = lines.join("\n")
    expect(joined).toContain("template v2 available")
    expect(joined).toContain("not overwriting")
    expect(joined).not.toMatch(/upgraded v\d+ → v\d+/)
  })
})
