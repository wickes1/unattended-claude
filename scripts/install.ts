#!/usr/bin/env bun
/**
 * Install `ucl` to ~/.local/bin and record install metadata for runtime lookups.
 *
 * Idempotent — re-run anytime to refresh the binary or metadata. Does NOT touch
 * config; that's `ucl init`.
 *
 * Metadata at ~/.local/share/unattended-claude/install.json is the SoT for:
 *   - `skills_dir` — where the .claude/skills/ tree lives (used by plan/review)
 *   - `binary_path` — the absolute ucl binary path (used by `schedule install`
 *     when writing plist ProgramArguments)
 *
 * The metadata path is fixed by XDG convention; downstream callers must use
 * the same path.
 */
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { lstatSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import pkg from "../package.json" with { type: "json" }

const repoRoot = join(import.meta.dir, "..")
const home = homedir()
const localBin = join(home, ".local", "bin")
const binPath = join(localBin, "ucl")
const metadataDir = join(home, ".local", "share", "unattended-claude")
const metadataPath = join(metadataDir, "install.json")
const skillsDir = join(repoRoot, ".claude", "skills")
const entryScript = join(repoRoot, "src", "index.ts")

// 1. Sanity: entry script must exist; without it the symlink is dead on arrival.
if (!existsSync(entryScript)) {
  console.error(`install: ${entryScript} not found — are you running from the repo root?`)
  process.exit(1)
}

// 2. Symlink ~/.local/bin/ucl → <repo>/src/index.ts.
//    The script's shebang (#!/usr/bin/env bun) makes it directly executable
//    once the symlink target points to it, so no compile step is needed.
mkdirSync(localBin, { recursive: true })
if (existsSync(binPath) || isSymlink(binPath)) {
  // Replace whatever's there — could be a stale symlink or a previous file.
  unlinkSync(binPath)
}
symlinkSync(entryScript, binPath)

// 3. Write install metadata.
mkdirSync(metadataDir, { recursive: true })
const metadata = {
  repo_root: repoRoot,
  skills_dir: skillsDir,
  binary_path: binPath,
  installed_at: new Date().toISOString(),
  version: pkg.version,
}
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n")

// 4. PATH check — warn but don't fail; user might have their own bin layout.
const onPath = (process.env.PATH ?? "").split(":").includes(localBin)
if (!onPath) {
  console.log("")
  console.log(`WARNING: ${localBin} is not on your PATH. Add this line to ~/.zshrc:`)
  console.log(`    export PATH="$HOME/.local/bin:$PATH"`)
  console.log("")
}

console.log(`installed ucl → ${binPath}`)
console.log(`metadata    → ${metadataPath}`)
console.log(`skills_dir  → ${skillsDir}`)
console.log("")
console.log("Run `ucl --version` to verify, then `ucl init` for first-time config.")

/** True iff `p` exists AND is a symlink (existsSync follows symlinks, so the
 * combo `existsSync || isSymlink` covers both live and dangling links). */
function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}
