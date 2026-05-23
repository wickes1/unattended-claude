/**
 * Comment-preserving YAML editing helpers built on the `yaml` package's
 * `parseDocument` AST. All edits round-trip through `Document` so comments,
 * key order, and unrelated keys are preserved.
 *
 * Path arguments are arrays of string keys (e.g. `["runtime", "bin"]`), which
 * lets us address nested maps without parsing dotted strings.
 */
import { readFileSync } from "node:fs"
import { Document, parseDocument } from "yaml"
import { atomicWrite } from "./fs-utils.ts"

/** Read a YAML file, return Document preserving comments + key order. Throws if file missing. */
export function readYamlDoc(path: string): Document {
  const src = readFileSync(path, "utf8")
  return parseDocument(src)
}

/** Stringify Document back to YAML preserving comments. Writes atomically — a crash mid-write leaves the original file intact. */
export function writeYamlDoc(path: string, doc: Document): void {
  atomicWrite(path, doc.toString())
}

/** Get a scalar value at the given nested path; returns undefined if path doesn't resolve. */
export function getYamlValue(
  doc: Document,
  path: string[],
): string | number | boolean | undefined {
  const v = doc.getIn(path, true) as unknown
  if (v === undefined || v === null) return undefined
  // doc.getIn(_, true) returns the AST Scalar node when keepScalar=true; unwrap.
  if (typeof v === "object" && v !== null && "value" in v) {
    const inner = (v as { value: unknown }).value
    if (typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean") {
      return inner
    }
    return undefined
  }
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v
  return undefined
}

/** Set a scalar value at the given nested path, creating intermediate maps as needed. */
export function setYamlValue(
  doc: Document,
  path: string[],
  value: string | number | boolean,
): void {
  doc.setIn(path, value)
}
