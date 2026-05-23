import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findRepoDir } from "../src/git-utils.ts"

describe("findRepoDir", () => {
  it("returns the directory that itself contains .claude/skills", () => {
    const root = mkdtempSync(join(tmpdir(), "ucl-git-utils-"))
    mkdirSync(join(root, ".claude", "skills"), { recursive: true })
    expect(findRepoDir(root)).toBe(root)
  })

  it("walks up to find the ancestor containing .claude/skills", () => {
    const root = mkdtempSync(join(tmpdir(), "ucl-git-utils-"))
    mkdirSync(join(root, ".claude", "skills"), { recursive: true })
    const child = join(root, "a", "b", "c")
    mkdirSync(child, { recursive: true })
    expect(findRepoDir(child)).toBe(root)
  })

  it("returns null when no ancestor contains .claude/skills", () => {
    // Use a fresh tmpdir tree with no .claude/skills anywhere along the way.
    const root = mkdtempSync(join(tmpdir(), "ucl-git-utils-noroot-"))
    const child = join(root, "x", "y")
    mkdirSync(child, { recursive: true })
    expect(findRepoDir(child)).toBeNull()
  })

  it("stops at the filesystem root (no infinite loop)", () => {
    // "/" is guaranteed not to have .claude/skills under it (on a clean system),
    // and crucially `findRepoDir` must terminate.
    // We can't fully assert null without depending on environment, but we can
    // assert it terminates in finite time by passing a deep path that will
    // exhaust the walk-up.
    const root = mkdtempSync(join(tmpdir(), "ucl-git-utils-deep-"))
    const deep = join(root, "a", "b", "c", "d", "e", "f", "g", "h")
    mkdirSync(deep, { recursive: true })
    // Just calling it should not hang and should return null since no
    // .claude/skills exists in this subtree.
    expect(findRepoDir(deep)).toBeNull()
  })
})
