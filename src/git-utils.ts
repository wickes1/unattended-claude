import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Walk up the directory tree from `startPath` looking for a `.claude/skills`
 * directory (the v2 repo root marker — claude must be launched from there so
 * the bundled skills load). Returns the first ancestor that has one, or null
 * if the walk reaches the filesystem root without finding one.
 *
 * Marker note: the v2 repo uses `.claude/skills` as its marker rather than
 * `.git/` because `ucl plan`/`ucl review` need the *skills* directory present,
 * not just any git repo.
 */
export function findRepoDir(startPath: string): string | null {
  let dir = startPath
  while (true) {
    if (existsSync(join(dir, ".claude", "skills"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
