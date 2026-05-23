import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findRepoDir, readInstallMetadata } from "../src/git-utils.ts"

/**
 * Most tests below pass an explicit `metadataPath` pointing to a non-existent
 * tmpfile so the cwd-walk fallback is exercised in isolation. The
 * "uses install metadata when present" test exercises the priority path.
 */
function noMetadata(): string {
  return join(mkdtempSync(join(tmpdir(), "ucl-no-meta-")), "install.json")
}

describe("findRepoDir — cwd-walk fallback", () => {
  it("returns the directory that itself contains .claude/skills", () => {
    const root = mkdtempSync(join(tmpdir(), "ucl-git-utils-"))
    mkdirSync(join(root, ".claude", "skills"), { recursive: true })
    expect(findRepoDir(root, noMetadata())).toBe(root)
  })

  it("walks up to find the ancestor containing .claude/skills", () => {
    const root = mkdtempSync(join(tmpdir(), "ucl-git-utils-"))
    mkdirSync(join(root, ".claude", "skills"), { recursive: true })
    const child = join(root, "a", "b", "c")
    mkdirSync(child, { recursive: true })
    expect(findRepoDir(child, noMetadata())).toBe(root)
  })

  it("returns null when no ancestor contains .claude/skills", () => {
    const root = mkdtempSync(join(tmpdir(), "ucl-git-utils-noroot-"))
    const child = join(root, "x", "y")
    mkdirSync(child, { recursive: true })
    expect(findRepoDir(child, noMetadata())).toBeNull()
  })

  it("stops at the filesystem root (no infinite loop)", () => {
    const root = mkdtempSync(join(tmpdir(), "ucl-git-utils-deep-"))
    const deep = join(root, "a", "b", "c", "d", "e", "f", "g", "h")
    mkdirSync(deep, { recursive: true })
    expect(findRepoDir(deep, noMetadata())).toBeNull()
  })
})

describe("findRepoDir — install metadata priority", () => {
  it("uses skills_dir from install metadata when the dir exists", () => {
    // Lay down a fake repo with .claude/skills/, plus an unrelated tree that
    // the cwd-walk would otherwise resolve to. The metadata path wins.
    const installedRepo = mkdtempSync(join(tmpdir(), "ucl-installed-"))
    const skillsDir = join(installedRepo, ".claude", "skills")
    mkdirSync(skillsDir, { recursive: true })

    const otherTree = mkdtempSync(join(tmpdir(), "ucl-other-tree-"))
    mkdirSync(join(otherTree, ".claude", "skills"), { recursive: true })

    const metaDir = mkdtempSync(join(tmpdir(), "ucl-meta-"))
    const metaPath = join(metaDir, "install.json")
    writeFileSync(metaPath, JSON.stringify({ skills_dir: skillsDir }))

    // Even though the cwd-walk from otherTree would return otherTree, the
    // install metadata points at installedRepo — metadata wins.
    expect(findRepoDir(otherTree, metaPath)).toBe(installedRepo)
  })

  it("falls back to cwd-walk when metadata's skills_dir does not exist on disk", () => {
    // Metadata file exists but its skills_dir is a stale path. Walk fallback
    // must kick in.
    const repo = mkdtempSync(join(tmpdir(), "ucl-fallback-"))
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true })

    const metaDir = mkdtempSync(join(tmpdir(), "ucl-meta-stale-"))
    const metaPath = join(metaDir, "install.json")
    writeFileSync(metaPath, JSON.stringify({
      skills_dir: "/nonexistent/.claude/skills",
    }))

    expect(findRepoDir(repo, metaPath)).toBe(repo)
  })

  it("falls back to cwd-walk when metadata is malformed JSON", () => {
    const repo = mkdtempSync(join(tmpdir(), "ucl-malformed-"))
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true })

    const metaDir = mkdtempSync(join(tmpdir(), "ucl-meta-bad-"))
    const metaPath = join(metaDir, "install.json")
    writeFileSync(metaPath, "{not valid json")

    expect(findRepoDir(repo, metaPath)).toBe(repo)
  })

  it("returns null when neither metadata nor cwd-walk finds anything", () => {
    const empty = mkdtempSync(join(tmpdir(), "ucl-nothing-"))
    expect(findRepoDir(empty, noMetadata())).toBeNull()
  })
})

describe("readInstallMetadata", () => {
  it("returns null when file does not exist", () => {
    expect(readInstallMetadata(noMetadata())).toBeNull()
  })

  it("returns parsed metadata when file is valid JSON", () => {
    const metaDir = mkdtempSync(join(tmpdir(), "ucl-meta-read-"))
    const metaPath = join(metaDir, "install.json")
    writeFileSync(metaPath, JSON.stringify({
      skills_dir: "/x/.claude/skills",
      binary_path: "/x/bin/ucl",
      version: "0.1.0",
    }))
    const meta = readInstallMetadata(metaPath)
    expect(meta).not.toBeNull()
    expect(meta?.skills_dir).toBe("/x/.claude/skills")
    expect(meta?.binary_path).toBe("/x/bin/ucl")
    expect(meta?.version).toBe("0.1.0")
  })

  it("returns null on malformed JSON", () => {
    const metaDir = mkdtempSync(join(tmpdir(), "ucl-meta-bad-read-"))
    const metaPath = join(metaDir, "install.json")
    writeFileSync(metaPath, "not json")
    expect(readInstallMetadata(metaPath)).toBeNull()
  })
})
