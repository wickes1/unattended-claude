#!/usr/bin/env bun
/**
 * Reverse of scripts/install.ts.
 *
 * Removes:
 *   - ~/.local/bin/ucl (the symlink only — does NOT delete the repo)
 *   - ~/.local/share/unattended-claude/install.json
 *
 * Idempotent; missing artifacts are reported as "not present", not errors.
 * Does NOT touch ~/.config/unattended-claude/ucl.yaml or ~/unattended/ —
 * that data survives uninstall on purpose (user can reinstall without losing
 * config or task history).
 */
import { existsSync, lstatSync, rmdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const home = homedir()
const binPath = join(home, ".local", "bin", "ucl")
const metadataDir = join(home, ".local", "share", "unattended-claude")
const metadataPath = join(metadataDir, "install.json")

let removed = 0

if (existsSync(binPath) || isSymlink(binPath)) {
  unlinkSync(binPath)
  console.log(`removed  ${binPath}`)
  removed++
} else {
  console.log(`not present  ${binPath}`)
}

if (existsSync(metadataPath)) {
  unlinkSync(metadataPath)
  console.log(`removed  ${metadataPath}`)
  removed++
  // Best-effort: clean up the metadata dir if now empty. rmdirSync errors
  // when non-empty, which is the intent ("only if empty").
  try { rmdirSync(metadataDir) } catch { /* not empty / missing — ignore */ }
} else {
  console.log(`not present  ${metadataPath}`)
}

if (removed === 0) {
  console.log("")
  console.log("nothing to remove — ucl was not installed via scripts/install.ts")
} else {
  console.log("")
  console.log(`uninstalled (${removed} artifact${removed === 1 ? "" : "s"} removed).`)
  console.log("Config at ~/.config/unattended-claude/ and runtime at ~/unattended/ were preserved.")
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}
