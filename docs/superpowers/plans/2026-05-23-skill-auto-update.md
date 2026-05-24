# Skill Auto-Update via Hash-Stamp Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Fix G03's "stale forever" gap. Re-init now silently upgrades user-installed skills that the user hasn't edited; user-edited skills stay protected with the existing warn-and-skip behavior. Mechanism: stamp a content hash into the user's SKILL.md frontmatter at install time, compare on re-init.

**Architecture:** Single task (G04). Extends G03's init skill-install loop. No new files; just hash-aware logic in `src/commands/init.ts` and matching tests.

**Tech Stack:** TypeScript + Bun. Use Bun's built-in `Bun.CryptoHasher("sha256")` — no new dep.

---

## Mechanism

### At install time

When `ucl init` first installs a skill, it:
1. Reads the template content (e.g. `config/skills/task-brief/SKILL.md`)
2. Computes `sha256` of that content as `templateHash`
3. Writes user's copy = template content with `template_hash: sha256:<templateHash>` line **inserted into the frontmatter** (right after `template_version:`)

### At re-init

For each skill that already exists at the user's location:
1. Read user's SKILL.md
2. Extract `template_hash` from user's frontmatter (call it `storedHash`)
3. Compute `currentHash` = sha256 of user file content **with the `template_hash:` line stripped** (so the line itself doesn't perturb the comparison)
4. Compare `currentHash` to `storedHash`:
   - **Match** → user has NOT edited since install → **silent upgrade**: overwrite with fresh template + new hash + new `template_version` (basically re-do step 3 of install). Log line: `(skill X: upgraded v<old> → v<new>; your installation was unmodified)`
   - **Mismatch** → user HAS edited → keep G03's behavior: warn `(skill X: template v<new> available, you have v<old>; not overwriting your edits. To accept upstream: rm -r <dir> && ucl init)`, do nothing
5. Edge: if user file has no `template_hash` line (e.g., installed by an older `ucl init` before this feature shipped), treat as "modified" so we warn instead of overwriting unknowingly. Migration path documented in QUICK-DEMO.

### Version-comparison cross-check

If `template_version` matches between user and template, the upgrade flow short-circuits before doing the hash check (skip silently; user is up to date). Same as G03. The hash check only fires when versions differ.

---

## File structure

**Modified:**
- `src/commands/init.ts` — extend the skill install loop with hash stamp on install + hash-comparing upgrade decision on re-init
- `tests/commands-init-skills.test.ts` — extend with 4 new tests (silent-upgrade-when-unmodified, warn-when-modified, hash-stamped-on-install, missing-hash-treated-as-modified)

**Not touched:**
- `config/skills/*/SKILL.md` templates — they do NOT carry `template_hash`; that's stamped by init at install time only
- `src/yaml-utils.ts` — frontmatter manipulation here uses regex (simple, single line edit) not the yaml lib, consistent with G03's `readSkillVersion`

---

## G04 — Add hash-stamped silent upgrade

**Files:**
- Modify: `src/commands/init.ts`
- Modify: `tests/commands-init-skills.test.ts`

### Spec

**New helpers in init.ts (file-local):**

```ts
import { CryptoHasher } from "bun"

/** Compute sha256 of skill content with the `template_hash:` line stripped. */
function computeSkillHash(content: string): string {
  const stripped = content.split("\n")
    .filter((l) => !/^template_hash:\s/.test(l))
    .join("\n")
  return new CryptoHasher("sha256").update(stripped).digest("hex")
}

/** Read `template_hash` from SKILL.md frontmatter. Returns null if missing. */
function readSkillHash(skillFile: string): string | null {
  const src = readFileSync(skillFile, "utf8")
  const m = /^---\n([\s\S]*?)\n---/.exec(src)
  if (!m) return null
  const hashLine = /^template_hash:\s*sha256:([a-f0-9]{64})\s*$/m.exec(m[1]!)
  return hashLine ? hashLine[1]! : null
}

/** Insert (or replace) `template_hash: sha256:<hash>` line into the frontmatter,
 *  right after the `template_version:` line. */
function stampSkillHash(content: string, hash: string): string {
  // Remove any existing template_hash line first.
  const cleaned = content.split("\n")
    .filter((l) => !/^template_hash:\s/.test(l))
    .join("\n")
  // Insert after template_version line.
  return cleaned.replace(
    /^(template_version:\s*\d+\s*$)/m,
    `$1\ntemplate_hash: sha256:${hash}`,
  )
}
```

**Replace the install loop in cmdInit with:**

```ts
for (const skillName of skillNames) {
  const userSkillDir = layout.skillDir(skillName)
  const userSkillFile = layout.skillFile(skillName)
  const templateSkillFile = join(skillsTemplateDir, skillName, "SKILL.md")
  const templateContent = readFileSync(templateSkillFile, "utf8")
  const templateHash = computeSkillHash(templateContent)
  const tplVer = readSkillVersion(templateSkillFile)

  if (!existsSync(userSkillFile)) {
    // Fresh install — stamp hash into the user's copy.
    ensureDir(userSkillDir)
    atomicWrite(userSkillFile, stampSkillHash(templateContent, templateHash))
    notes.push(`Installed skill ${skillName} at ${userSkillFile}`)
    continue
  }

  // Already installed. Quick out if versions match.
  const userVer = readSkillVersion(userSkillFile)
  if (userVer === tplVer) continue

  // Template is newer. Decide silent-upgrade vs warn based on hash.
  const storedHash = readSkillHash(userSkillFile)
  const userContent = readFileSync(userSkillFile, "utf8")
  const userHash = computeSkillHash(userContent)
  const unmodified = storedHash !== null && storedHash === userHash

  if (unmodified) {
    // User hasn't edited since install — silent upgrade.
    atomicWrite(userSkillFile, stampSkillHash(templateContent, templateHash))
    log(`(skill ${skillName}: upgraded v${userVer} → v${tplVer}; your installation was unmodified)`)
  } else {
    // User edited (or missing hash = unknown provenance) — protect their work.
    log(
      `(skill ${skillName}: template v${tplVer} available, you have v${userVer}; not overwriting your edits. To accept upstream: rm -r ${userSkillDir} && ucl init)`,
    )
  }
}
```

The G03 warn message remains exactly as-is. New silent-upgrade log line uses the format above.

**No frontmatter parsing dependency on yaml-utils** — same reasoning as G03's `readSkillVersion`. Single-line regex reads + writes are fine for fixed-shape frontmatter fields.

### Tests

Extend `tests/commands-init-skills.test.ts` with 4 new tests (at the end of the file, after the 6 G03 tests):

```ts
test("first install stamps template_hash into user's SKILL.md frontmatter", async () => {
  // Run init; read user skill file; assert frontmatter contains template_hash: sha256:<64-hex>
})

test("re-init silently upgrades unmodified skill to new template version", async () => {
  // First install at v1, captures template_hash_v1
  // Bump template to v2 (different content + bumped template_version: 2)
  // Second init: assert user file content == v2 template (with new stamped hash for v2)
  // Assert log contains "upgraded v1 → v2" and "unmodified"
  // Assert no warn message
})

test("re-init does NOT upgrade user-modified skill (hash mismatch protects)", async () => {
  // First install at v1
  // User edits the SKILL.md (e.g., append " EDITED" to a heading line)
  // Bump template to v2
  // Second init: assert user file content STILL has user's edit
  // Assert log contains the v2-available warn (not upgrade)
})

test("re-init treats missing template_hash as modified (safety fallback)", async () => {
  // Pre-create user skill file at v1 WITHOUT template_hash in frontmatter
  // (simulates skill installed by pre-G04 ucl)
  // Bump template to v2
  // Second init: assert NO overwrite, assert warn message
})
```

For tests that bump the template version: use a small helper inside the test file:

```ts
function writeFakeTemplate(dir: string, name: string, version: number, body: string): void {
  const content = `---
name: ${name}
template_version: ${version}
description: fake template
---
${body}
`
  ensureDir(join(dir, name))
  writeFileSync(join(dir, name, "SKILL.md"), content)
}
```

### Implementation order

1. Add the 3 helpers (`computeSkillHash`, `readSkillHash`, `stampSkillHash`) at the bottom of init.ts next to `readSkillVersion`
2. Replace the skill install loop body with the new hash-aware version
3. Add the 4 new tests to `tests/commands-init-skills.test.ts`
4. `bun run typecheck` green
5. `bun test` all green
6. Commit `feat: skill auto-update via hash-stamped silent upgrade`

---

## Self-review

- **Spec coverage:** silent-upgrade-when-unmodified, warn-when-modified, missing-hash-fallback, fresh-install-stamps-hash — all four user-facing scenarios have a test.
- **No placeholders:** all helper bodies, regex, log strings, frontmatter format explicit.
- **Forward-compat:** when (7) Embed-in-binary lands as a future architecture, only the install source switches (file → string constant). The hash stamping + comparison logic on user-side is identical.
- **Backward compat:** users who installed skills via G03 (no hash field) get a warn on next init, not silent overwrite. They can `rm + reinit` to opt into auto-update. Documented in the message itself.
- **No new deps:** `Bun.CryptoHasher` is built-in.
