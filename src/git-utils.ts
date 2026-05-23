import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Path to the install metadata written by scripts/install.ts. */
export const INSTALL_METADATA_PATH = join(
  homedir(), ".local", "share", "unattended-claude", "install.json",
)

interface InstallMetadata {
  repo_root?: string
  skills_dir?: string
  binary_path?: string
  installed_at?: string
  version?: string
}

/**
 * Read install.json written by scripts/install.ts. Returns null on any error
 * (missing file, malformed JSON, unreadable) — callers must always have a
 * fallback path because dev-mode (running from the repo without install) skips
 * the metadata entirely.
 */
export function readInstallMetadata(
  path: string = INSTALL_METADATA_PATH,
): InstallMetadata | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, "utf8")) as InstallMetadata
  } catch {
    return null
  }
}

/**
 * Locate the `.claude/skills/` directory that `ucl plan`/`ucl review` need
 * to launch claude from. Two strategies, in order:
 *
 *   1. Read install metadata (~/.local/share/unattended-claude/install.json).
 *      If it has a `skills_dir` that exists on disk, use it. This is the
 *      production path — survives running `ucl` from any cwd.
 *   2. Walk up from `startPath` looking for a directory with `.claude/skills/`.
 *      Returns the directory CONTAINING `.claude/skills/`, i.e. the repo root,
 *      not the skills dir itself. This is the dev-mode fallback for when the
 *      tree was never installed.
 *
 * Returns null when both fail.
 *
 * Marker note: v2 uses `.claude/skills` as the repo marker rather than `.git/`
 * because plan/review need the *skills* directory present, not just any repo.
 */
export function findRepoDir(
  startPath: string,
  metadataPath: string = INSTALL_METADATA_PATH,
): string | null {
  // Strategy 1: install metadata. skills_dir is the absolute path to
  // `<repo>/.claude/skills/`; we return its grandparent (the repo root)
  // because launchInteractiveSession sets cwd to the repo root, not to
  // the skills dir.
  const meta = readInstallMetadata(metadataPath)
  if (meta?.skills_dir && existsSync(meta.skills_dir)) {
    return dirname(dirname(meta.skills_dir))
  }

  // Strategy 2: cwd-upward walk for dev mode.
  let dir = startPath
  while (true) {
    if (existsSync(join(dir, ".claude", "skills"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
