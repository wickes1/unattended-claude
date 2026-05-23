import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

/** Atomic write: write to .tmp, then rename. Rename is atomic within a filesystem. */
export function atomicWrite(path: string, content: string): void {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}
