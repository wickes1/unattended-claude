# Move Skills to Runtime Dir + Upgrade Mechanism Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Relocate `task-brief` and `task-review` skills from the v2 repo (`.claude/skills/`) into the user's runtime dir (`<runtime_dir>/.claude/skills/`), and introduce a version-stamped upgrade mechanism that preserves user edits while still letting clean installs receive updates.

**Architecture:** Single-task migration (G03). Skills become user-installed data (parallel to `ucl.yaml`). `ucl init` copies templates from `config/skills/` to `<runtime_dir>/.claude/skills/`. `ucl plan` / `ucl review` change cwd to runtime_dir so Claude Code auto-loads the user-installed skill. Upgrade rule: read `template_version: N` from SKILL.md frontmatter; if user has older version, warn but never overwrite — user opts in via `rm <skill-dir> && ucl init`. This is the same "user data is sacred" model as `ucl.yaml`.

**Tech Stack:** TypeScript + Bun. No new deps. Reuse existing `src/yaml-utils.ts` to read SKILL.md frontmatter (yaml is the standard format for SKILL.md frontmatter).

---

## Why the upgrade model is "version-only, never overwrite, user-controlled"

Alternatives considered + rejected:

| Approach | Why rejected |
|---|---|
| Content-hash sidecar file (`.installed_hashes.json`) | Adds invisible state; user accidentally deletes sidecar → false "user-modified" warning forever |
| Frontmatter `template_hash` auto-stamped at install | Hash noise pollutes the file; users see meaningless string they can't reason about |
| Hash-of-prior-template history shipped in repo | Repo must carry every historical hash; bug-prone bookkeeping |
| Interactive `[d]iff [a]ccept [k]eep` prompt at init | `ucl init` is supposed to be largely declarative; multi-choice prompts per skill = annoying |

Chosen: **version-only + never-overwrite**. Cost: stale-but-untouched skill stays stale until user `rm`s. Benefit: predictable, no sidecar, no hash gymnastics, one-line warn tells user exactly how to upgrade.

---

## File structure

**Created:**
- `config/skills/task-brief/SKILL.md` — template (moved from `.claude/skills/`, adds `template_version: 1` frontmatter)
- `config/skills/task-review/SKILL.md` — template (moved + version-stamped)
- `tests/commands-init-skills.test.ts` — fresh tests for skill install + upgrade behavior

**Modified:**
- `src/layout.ts` — add `runtimeSkillsDir` accessor (`<runtime_dir>/.claude/skills/`)
- `src/commands/init.ts` — copy skill templates with upgrade logic
- `src/commands/plan.ts` — change spawn cwd from `findThisRepoDir()` to `cfg.runtimeDir`; drop the `findThisRepoDir` helper
- `src/commands/review.ts` — same cwd change
- `src/commands/doctor.ts` — `checkSkillFolder` checks `<runtime_dir>/.claude/skills/task-brief/SKILL.md` instead of `findRepoDir`-based location
- `tests/commands-doctor.test.ts` — update `checkSkillFolder` test to match new location
- `tests/commands-init.test.ts` — extend "first init" test to assert skills copied
- `tests/commands-plan.test.ts` / `tests/commands-review.test.ts` — update cwd assertions if present
- `QUICK-DEMO.md` — `§3` note that skill loads from `~/unattended/.claude/skills/` and can be edited

**Deleted:**
- `.claude/skills/task-brief/` and `.claude/skills/task-review/` from the v2 repo root (their dev-time access was incidental; the skills are end-user-facing, not v2-dev tooling)

---

## G03 — Skill migration + upgrade

**Files:**
- Move: `.claude/skills/task-brief/SKILL.md` → `config/skills/task-brief/SKILL.md`
- Move: `.claude/skills/task-review/SKILL.md` → `config/skills/task-review/SKILL.md`
- Modify: `src/layout.ts`, `src/commands/init.ts`, `src/commands/plan.ts`, `src/commands/review.ts`, `src/commands/doctor.ts`
- Modify tests: `tests/commands-doctor.test.ts`, `tests/commands-init.test.ts`, plan/review tests if existing
- Create: `tests/commands-init-skills.test.ts`
- Modify: `QUICK-DEMO.md`
- Delete: `.claude/skills/` (entire dir from repo root)

### Spec

**1. Skill template format (frontmatter addition):**

Add to both SKILL.md files at the top of frontmatter (before description):
```yaml
---
name: task-brief
template_version: 1
description: <existing>
---
```

The `template_version` integer is incremented MANUALLY by whoever edits the template content. v1 = current content.

**2. `src/layout.ts` — new accessor:**

```ts
get runtimeSkillsDir(): string {
  return join(this.runtimeDir, ".claude", "skills")
}

skillDir(name: string): string {
  return join(this.runtimeSkillsDir, name)
}

skillFile(name: string): string {
  return join(this.skillDir(name), "SKILL.md")
}
```

Add `runtimeSkillsDir` to the test that asserts Layout structure if such a test exists.

**3. `src/commands/init.ts` — skill copy step:**

After config write + before preflight summary, add new step:

```ts
// 3a. Install skill templates with upgrade rule.
const skillsTemplateDir = opts.skillsTemplateDir
  ?? resolve(import.meta.dir, "..", "..", "config", "skills")
const skillNames = readdirSync(skillsTemplateDir)
  .filter((n) => statSync(join(skillsTemplateDir, n)).isDirectory())

for (const skillName of skillNames) {
  const userSkillDir = layout.skillDir(skillName)
  const userSkillFile = layout.skillFile(skillName)
  const templateSkillFile = join(skillsTemplateDir, skillName, "SKILL.md")

  if (!existsSync(userSkillFile)) {
    // First install — copy verbatim.
    ensureDir(userSkillDir)
    atomicWrite(userSkillFile, readFileSync(templateSkillFile, "utf8"))
    notes.push(`Installed skill ${skillName} at ${userSkillFile}`)
    continue
  }

  // Already installed — version-compare upgrade decision.
  const userVer = readSkillVersion(userSkillFile)
  const tplVer = readSkillVersion(templateSkillFile)
  if (userVer >= tplVer) continue                       // already up to date
  // Template is newer; we never overwrite.
  log(
    `(skill ${skillName}: template v${tplVer} available, you have v${userVer}; not overwriting. To accept upstream: rm -r ${userSkillDir} && ucl init)`,
  )
}
```

Helper added to init.ts (or yaml-utils — put it next to readSkillVersion's first caller, which is here):

```ts
/** Read `template_version` from SKILL.md frontmatter. Returns 0 if missing/malformed. */
function readSkillVersion(skillFile: string): number {
  const src = readFileSync(skillFile, "utf8")
  const m = /^---\n([\s\S]*?)\n---/.exec(src)
  if (!m) return 0
  const verLine = /^template_version:\s*(\d+)\s*$/m.exec(m[1]!)
  return verLine ? Number(verLine[1]) : 0
}
```

Use plain regex (not yaml lib) to avoid pulling Document machinery for a single integer read. The frontmatter is well-formed and the field is fixed-shape.

**4. New `opts.skillsTemplateDir?: string` test override** — added to `cmdInit` opts shape so tests can point at a fake skills dir.

**5. `src/commands/plan.ts` — cwd change:**

Replace `findThisRepoDir()` callsite with `cfg.runtimeDir`. Drop the `findThisRepoDir` helper (delete the function). The `findRepoDir` import from `src/git-utils.ts` stays IF other callers use it — verify with grep; if no other caller, drop that import too.

Verify: spawn site currently is roughly `Bun.spawn({ cwd: findThisRepoDir(), ... })` — change to `Bun.spawn({ cwd: cfg.runtimeDir, ... })`.

**6. `src/commands/review.ts` — mirror change.**

**7. `src/commands/doctor.ts` — `checkSkillFolder` rewrite:**

```ts
export function checkSkillFolder(cfg: Config): CheckResult {
  const layout = new Layout(cfg.runtimeDir)
  const briefFile = layout.skillFile("task-brief")
  const reviewFile = layout.skillFile("task-review")
  const missing: string[] = []
  if (!existsSync(briefFile)) missing.push("task-brief")
  if (!existsSync(reviewFile)) missing.push("task-review")
  if (missing.length === 0) {
    return {
      severity: "pass",
      name: "skill folder",
      detail: layout.runtimeSkillsDir,
    }
  }
  return {
    severity: "error",
    name: "skill folder",
    detail: `missing skill(s): ${missing.join(", ")} at ${layout.runtimeSkillsDir}`,
    remediation: "run `ucl init` to install skill templates",
  }
}
```

Update its signature in `runChecks` callsite — it now needs `cfg`. (Today it takes no arg.)

**8. Tests:**

`tests/commands-init-skills.test.ts` — new file. Six tests:

```ts
test("first init copies all skill templates from config/skills to runtime_dir/.claude/skills", async () => {
  // freshDirs + fakeSkillsTemplateDir with 2 dummy skills (template_version: 1 each)
  // run cmdInit
  // assert both SKILL.md files exist under <runtime_dir>/.claude/skills/
  // assert content matches template byte-for-byte
})

test("first init logs an Installed-skill note per skill", async () => { /* */ })

test("re-init with same template version skips silently (no warn, content unchanged)", async () => {
  // first init at v1; capture log; second init at v1; assert log has no skill-related warn
})

test("re-init with newer template version warns but does NOT overwrite", async () => {
  // first init at v1; user content stays
  // bump template to v2 in fake template dir
  // second init: assert log contains "template v2 available" + "you have v1" + "not overwriting"
  // assert user file content STILL equals v1 (not v2)
})

test("user-modified skill at same version still skips (no warn — version match dominates)", async () => {
  // first init at v1; user edits content; second init at v1
  // assert log has no warn (because version matches even though content diverged)
})

test("missing template_version frontmatter → readSkillVersion returns 0; behaves as if oldest", async () => {
  // template without template_version; assert behavior is "install if missing, warn if present and template has higher version"
})
```

`tests/commands-doctor.test.ts` — modify `checkSkillFolder` test:
- Pre-populate `<runtime_dir>/.claude/skills/task-brief/SKILL.md` + `task-review/SKILL.md` with dummy content
- Pass cfg with `runtimeDir` pointing at the tmpdir
- Assert pass, detail contains the runtime path

Add 1 new test: "checkSkillFolder error when one skill missing":
- Only install task-brief, leave task-review missing
- Assert severity=error, detail mentions `task-review`

`tests/commands-init.test.ts` — extend test 1:
- Add `skillsTemplateDir` opt pointing at fake skills dir with 1 dummy skill
- Assert the dummy skill SKILL.md got copied to `<runtime_dir>/.claude/skills/<name>/SKILL.md`

Plan/review tests — grep for any existing test asserting `cwd: findRepoDir(...)` or similar; update assertion to `cwd: cfg.runtimeDir`.

**9. QUICK-DEMO.md `§3` update:**

Replace the "Plan/review skills load via cwd" callout (currently line 15) with:

> **Plan/review skills load from your runtime dir.** `ucl init` copies `task-brief` and `task-review` skills into `~/unattended/.claude/skills/`. `ucl plan` and `ucl review` spawn claude with `cwd = ~/unattended/` so those skills auto-load. You can edit a skill (e.g., tweak the questions task-brief asks) — your edit survives re-init. Upgrades: when a template version bumps, `ucl init` prints a hint but never overwrites your edits; `rm -r ~/unattended/.claude/skills/<name> && ucl init` to accept upstream.

**10. Delete repo-root `.claude/skills/`:**

```bash
git rm -r .claude/skills/
```

The two skill files are now ONLY at `config/skills/`. The repo's own `.claude/` may still have other dev-tooling subdirs (e.g., `plugins/`) — don't touch those.

### Implementation order

1. Move skill files to `config/skills/` + add `template_version: 1` frontmatter
2. Extend `Layout` with `runtimeSkillsDir` / `skillDir` / `skillFile`
3. Modify `cmdInit` with skill copy + upgrade loop + readSkillVersion helper + new opts field
4. Modify `cmdPlan` + `cmdReview` cwd
5. Rewrite `checkSkillFolder` + update `runChecks` signature
6. Write `tests/commands-init-skills.test.ts`
7. Update `tests/commands-doctor.test.ts` (skill folder test + new missing-skill test)
8. Extend `tests/commands-init.test.ts` test 1
9. Update plan/review tests
10. Delete repo-root `.claude/skills/`
11. Update `QUICK-DEMO.md` §3
12. typecheck + bun test
13. Commit `feat: relocate skills to runtime dir with version-stamped upgrade mechanism`

---

## Self-review

- **Spec coverage:** all 6 spec'd points (skill move, frontmatter version, Layout accessors, init copy + upgrade, cwd change, doctor check rewrite) have a task and a test.
- **No placeholders:** all helper signatures, regex, log strings explicit. `readSkillVersion` regex defined inline.
- **Type consistency:** `checkSkillFolder(cfg: Config)` signature is the only callsite change in `runChecks`; verify the call line is updated.
- **Cross-task interfaces:** `Layout.skillFile(name)` is the seam; init writes via it, doctor reads via it. No literal `.claude/skills` paths anywhere else in the new code.
- **Upgrade-not-overwrite rule:** the log message is the user-facing contract — exact phrasing: `template vN available, you have vM; not overwriting. To accept upstream: rm -r <dir> && ucl init`. Both `vN` and `vM` interpolated.
- **Test for the negative case** (user-modified at SAME version → no warn) explicitly exercises that version-match dominates content-diff. Prevents future hash-based regressions.
