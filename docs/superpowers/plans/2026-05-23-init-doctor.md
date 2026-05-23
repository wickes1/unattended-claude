# `ucl init` + `ucl doctor` Restore-and-Optimize Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Restore the interactive `init` wizard and standalone `doctor` command that v1 (`cc-nightshift`) had, with 7 v2-specific optimizations (real-YAML editing, two-prompt flow, bin auto-detect, structured CheckResult reuse, three new v2-specific checks, drop obsolete checks, `--json` mode), plus a corrected billing-mode check that surfaces the server-side extra-usage limitation honestly.

**Architecture:** Two tasks executed sequentially. G01 ships `src/yaml-utils.ts` + `src/commands/doctor.ts` (the pure-function `runChecks` is the seam init reuses). G02 ships the interactive `init` rewrite, importing both modules.

**Tech Stack:** TypeScript + Bun. Uses the existing `yaml` package (already a transitive dep — `parseDocument` for comment-preserving edits, same pattern as F11 `schedule add/remove`). No new dependencies.

---

## Background — what v1 had, what v2 dropped, what's getting fixed

v1 `ccns init` was an interactive 3-prompt readline wizard (`runtime_dir`, `driver`, `start_time`) with regex-based yaml field substitution that preserved user-edited fields on re-init. v1 `ccns doctor` was a 9-check preflight with three-severity output (pass/warn/error), version probes, and exit code 0/1.

v2 dropped both: `ucl init` is now zero-prompt and only warns on missing CLIs; `ucl doctor` doesn't exist.

This plan ports both back, optimized for v2's actual constraints:

| # | v1 behavior | v2 optimization in this plan |
|---|---|---|
| 1 | regex `subYaml` (flat keys only) | `yaml.parseDocument` with path-array set/get — supports nested keys (v2 yaml has `runtime.bin` etc) |
| 2 | 3 prompts including `start_time` | 2 prompts — drop schedule, that's now `ucl schedule add` |
| 3 | always ask `driver`, probe only after pick | probe both bins first; ask only if both installed |
| 4 | `cmdDoctor` monolithic | split into pure `runChecks(cfg): CheckResult[]` + `cmdDoctor` CLI wrapper; init reuses `runChecks` subset |
| 5 | n/a | three new v2 checks: zellij socket `/tmp/zellij` reachable, skill folder reachable from `ucl` binary, `~/.bun/bin/` in PATH |
| 6 | `happy daemon` check, `~/.local/bin` PATH check | drop both (irrelevant to v2 — zellij doesn't need happy daemon, v2 uses `~/.bun/bin/` not `~/.local/bin/`) |
| 7 | n/a | `--json` flag emits CheckResult[] as JSON, exit code preserved |
| 8 | binary "ANTHROPIC_API_KEY set = error" | WARN (not error) on `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`. Always print INFO row: "Doctor can't detect Anthropic's server-side extra-usage opt-in. To enforce a hard ceiling, verify https://claude.com/settings/usage shows extra usage = OFF." |

---

## File structure

**Created:**
- `src/yaml-utils.ts` — comment-preserving YAML editing helpers
- `src/commands/doctor.ts` — `ucl doctor` command + pure `runChecks` function
- `tests/yaml-utils.test.ts` — unit tests for yaml-utils
- `tests/commands-doctor.test.ts` — unit tests for doctor

**Modified:**
- `src/commands/init.ts` — rewrite as interactive wizard
- `src/index.ts` — dispatch `doctor` command
- `tests/commands-init.test.ts` — rewrite for interactive mode (stdin pipe)

**Reference (read-only):**
- `cc-nightshift/src/commands/init.ts` (v1, for `makeAsker` readline pattern + `subYaml`/`readYamlValue` regex baseline we are replacing)
- `cc-nightshift/src/commands/doctor.ts` (v1, for check fn structure + color formatting)
- `src/commands/schedule.ts` (F11 already uses `parseDocument` — read for the established pattern)

---

## G01 — `yaml-utils` + `ucl doctor` command

**Files:**
- Create: `src/yaml-utils.ts`
- Create: `src/commands/doctor.ts`
- Create: `tests/yaml-utils.test.ts`
- Create: `tests/commands-doctor.test.ts`
- Modify: `src/index.ts` (dispatch entry)

### Spec

**`src/yaml-utils.ts` — 4 exports:**

```ts
import { Document, parseDocument } from "yaml"

/** Read a YAML file, return Document preserving comments + key order. Throws if file missing. */
export function readYamlDoc(path: string): Document

/** Stringify Document back to YAML preserving comments. */
export function writeYamlDoc(path: string, doc: Document): void

/** Get a scalar value at the given nested path; returns undefined if path doesn't resolve. */
export function getYamlValue(doc: Document, path: string[]): string | number | boolean | undefined

/** Set a scalar value at the given nested path, creating intermediate maps as needed. */
export function setYamlValue(doc: Document, path: string[], value: string | number | boolean): void
```

Uses `yaml` package's `Document.getIn`/`Document.setIn` which already preserve comments. Path is array form (e.g. `["runtime", "bin"]`).

**`src/commands/doctor.ts` — exports:**

```ts
export type Severity = "pass" | "warn" | "info" | "error"

export interface CheckResult {
  severity: Severity
  name: string
  detail: string
  remediation?: string                          // shown for warn/error
}

/** Pure: run all checks, return ordered results. No stdout, no exit. */
export function runChecks(cfg: Config): CheckResult[]

/** CLI entry. Parses `--json` flag from argv. Prints results + summary. Returns exit code (0/1). */
export async function cmdDoctor(cfg: Config, argv: string[]): Promise<number>

export const helpText: string
```

**Checks (in order, see `runChecks`):**

1. `checkBun()` — `bun --version` → pass/error (port from v1 verbatim)
2. `checkZellij()` — `zellij --version` → pass/error
3. `checkClaude()` — `claude --version` → pass/error
4. `checkHappy(cfg)` — only if `cfg.runtime.bin === "happy"`; `happy --version` → pass/error
5. `checkZellijSocket()` — **NEW v2 check.** `statSync("/tmp/zellij")`. If missing: severity=pass, detail="dir auto-created on first run". If exists + not dir: error. If exists + not writable: error with `chmod u+w /tmp/zellij` remediation.
6. `checkSkillFolder()` — **NEW v2 check.** Walk up from `import.meta.dir` looking for `.claude/skills/task-brief/SKILL.md`. Use `findRepoDir` from `src/git-utils.ts` (already exists, F08). If found: pass with the path. If not: error remediation="run `ucl` from a shell whose PATH resolves to the v2 repo build (`bun link unattended-claude` from the repo root)".
7. `checkConfigFile(cfg)` — `existsSync(cfg.configPath)` → pass/error remediation="run `ucl init`"
8. `checkRuntimeDir(cfg)` — port `checkOvernightDir` from v1, just rename. statSync + isDirectory + accessSync W_OK.
9. `checkBillingEnv()` — **REPLACES v1's `checkAnthropicApiKey`.** Returns ONE CheckResult covering all five vars:
   - If any of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` is set: severity=warn, detail=`<comma-separated names of set vars> is set`, remediation="this forces non-subscription billing; unset before `ucl run` if you want subscription quota to apply"
   - If none set: severity=pass, detail="subscription billing path (no billing env vars set)"
10. `checkBillingServerSide()` — **NEW.** Always severity=info, name="extra-usage opt-in", detail="server-side setting, doctor cannot detect", remediation="verify https://claude.com/settings/usage shows extra usage = OFF before unattended runs if you want a hard ceiling".
11. `checkBunPath()` — **NEW v2 check, REPLACES v1's `~/.local/bin` check.** Checks `~/.bun/bin/` ∈ `$PATH`. If yes: pass. If no: warn remediation="export PATH=\"$HOME/.bun/bin:$PATH\" in your shell rc (needed for launchd scheduled runs to find `ucl`)".

DROPPED from v1: `checkHappyDaemon` (v2 doesn't depend on happy daemon), `checkPath` (replaced by `checkBunPath`).

**`cmdDoctor` body:**
```ts
const json = argv.includes("--json")
const results = runChecks(cfg)
if (json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const r of results) console.log(formatResult(r))
  const summary = { pass: 0, warn: 0, info: 0, error: 0 }
  for (const r of results) summary[r.severity]++
  console.log(
    `Doctor: ${results.length} checks · ${summary.pass} pass · ${summary.warn} warn · ${summary.info} info · ${summary.error} error`,
  )
}
return results.some((r) => r.severity === "error") ? 1 : 0
```

**`formatResult`:** port v1's three-color helpers (`green ✓` / `yellow ⚠` / `red ✗`) + add `blue ℹ` for `info`. Plain text if `!process.stdout.isTTY`.

**`src/index.ts` dispatch:** add `case "doctor":` → `return cmdDoctor(cfg, subcommandArgs(argv))`. Add `doctor` to PER_CMD_HELP map and globalHelpText commands list.

### Tests

**`tests/yaml-utils.test.ts` — six tests:**

```ts
const SAMPLE = `# top comment
paths:
  runtime_dir: ~/unattended    # inline comment
runtime:
  driver: claude
  bin: happy
  extra_args:
    - --flag1
`

test("readYamlDoc throws on missing file", () => {
  expect(() => readYamlDoc("/nonexistent")).toThrow()
})

test("getYamlValue returns nested scalar", () => {
  const doc = parseDocument(SAMPLE)
  expect(getYamlValue(doc, ["runtime", "bin"])).toBe("happy")
})

test("getYamlValue returns undefined for missing path", () => {
  const doc = parseDocument(SAMPLE)
  expect(getYamlValue(doc, ["runtime", "missing"])).toBeUndefined()
})

test("setYamlValue overwrites scalar and preserves comments", () => {
  const doc = parseDocument(SAMPLE)
  setYamlValue(doc, ["runtime", "bin"], "claude")
  const out = doc.toString()
  expect(out).toContain("bin: claude")
  expect(out).toContain("# top comment")
  expect(out).toContain("# inline comment")
})

test("setYamlValue creates intermediate maps if needed", () => {
  const doc = parseDocument("paths:\n  runtime_dir: ~/x\n")
  setYamlValue(doc, ["new", "nested", "key"], "value")
  expect(doc.toString()).toContain("new:")
  expect(doc.toString()).toContain("  nested:")
  expect(doc.toString()).toContain("    key: value")
})

test("writeYamlDoc round-trips through filesystem preserving comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "ucl-yu-"))
  const p = join(dir, "x.yaml")
  writeFileSync(p, SAMPLE)
  const doc = readYamlDoc(p)
  setYamlValue(doc, ["runtime", "driver"], "happy")
  writeYamlDoc(p, doc)
  const back = readFileSync(p, "utf8")
  expect(back).toContain("# top comment")
  expect(back).toContain("driver: happy")
  rmSync(dir, { recursive: true, force: true })
})
```

**`tests/commands-doctor.test.ts` — eleven tests:**

Use `bun.spawnSync` mocking via `mock.module()` to control version probe outcomes. Build a small `mkCfg()` helper returning a minimal `Config` shape with `runtime.bin = "claude"` (and one variant for happy mode).

```ts
test("runChecks returns array with all expected check names in order", () => { /* bin=claude → 10 results (no checkHappy) */ })
test("runChecks includes checkHappy when bin=happy", () => { /* 11 results */ })

test("checkBillingEnv: pass when no env vars set", () => { /* unsetEnv all five; expect pass */ })
test("checkBillingEnv: warn when ANTHROPIC_API_KEY set", () => { /* set, expect warn + detail mentions key name */ })
test("checkBillingEnv: warn lists all set vars", () => { /* set 2, expect detail contains both names */ })

test("checkBillingServerSide always returns info severity", () => { /* expect info + URL in remediation */ })

test("checkBunPath: pass when ~/.bun/bin in PATH", () => { /* mutate process.env.PATH */ })
test("checkBunPath: warn when not in PATH", () => { /* */ })

test("checkSkillFolder pass when running from repo (smoke)", () => { /* findRepoDir from import.meta.dir; this test self-asserts */ })

test("cmdDoctor --json emits valid JSON array, no color codes", () => { /* capture stdout */ })
test("cmdDoctor exit code 0 when no errors", () => { /* */ })
```

For env-var tests, use `beforeEach`/`afterEach` to snapshot+restore `process.env` to avoid cross-test bleed.

### Implementation order inside G01

1. yaml-utils.ts + tests (cheapest, no deps)
2. doctor.ts skeleton (CheckResult type, formatResult, helpText, runChecks shell)
3. Port the 7 reused checks from v1
4. Implement the 3 new v2 checks + checkBillingEnv rewrite + checkBillingServerSide
5. cmdDoctor + index.ts dispatch
6. doctor tests
7. typecheck + bun test
8. Commit: `feat: add ucl doctor command + yaml-utils`

---

## G02 — Rewrite `ucl init` as interactive wizard

**Files:**
- Modify: `src/commands/init.ts`
- Modify: `tests/commands-init.test.ts`

### Spec

**New `cmdInit` signature:**

```ts
export async function cmdInit(opts: {
  templatePath?: string                                    // test override
  configPath?: string                                      // test override
  runtimeDir?: string                                      // test override (skips prompt #1)
  forceBin?: "claude" | "happy"                            // test override (skips prompt #2)
  toolCheck?: (cmd: string) => boolean                     // test override
  rl?: { question: (q: string, cb: (ans: string) => void) => void; close: () => void }  // test override; otherwise build from stdin/stdout
  log?: (s: string) => void
} = {}): Promise<InitResult>
```

Production path: `rl` defaults to `readline.createInterface({ input: process.stdin, output: process.stdout })`. Test path: pass a fake `rl` whose `question` callback fires with the canned answer.

**Behavior:**

1. Detect re-init: if `configPath` exists, load via `readYamlDoc(configPath)` so prompts can show current values as defaults. Else load template via `readYamlDoc(templatePath)`.
2. Probe `claude` and `happy` via `toolCheck`. Store `claudeOK` / `happyOK`.
3. **Bin selection:**
   - If `forceBin` set (test path): use it.
   - Else if both `claudeOK && happyOK`: prompt `Runtime bin — claude or happy [<current or "happy">]:` with retry loop. Validate ∈ {claude, happy}.
   - Else if only one available: use that one silently, log("info", `detected only '<bin>' on PATH — using it`).
   - Else (neither): throw `Error("Neither claude nor happy found on PATH. Install at least one before ucl init.")` — but still print remediation hints from doctor's relevant checks before throwing.
4. **Runtime dir prompt:** `Runtime dir [<current or "~/unattended">]:` — no validation, just trim. Empty answer = use default.
5. Apply choices: `setYamlValue(doc, ["paths", "runtime_dir"], chosenDir)`, `setYamlValue(doc, ["runtime", "bin"], chosenBin)`. Write back to `configPath` via `writeYamlDoc`.
6. Create runtime dir tree (same as current init).
7. Create empty `todo.md` if missing (same as current).
8. **Preflight summary:** call `runChecks(cfg)` from doctor, but only print `warn` and `error` rows (not pass) — surface what user should fix next.
9. Print "Next steps" footer.

**Re-init idempotency requirement:** when the existing yaml has user-edited fields OUTSIDE the two we prompt for (e.g. user changed `execution.max_parallel_tabs: 5`), those values are preserved verbatim because we mutate the parsed Document in place.

**Removed from current init:** the verbose 4-step description in helpText (replace with "Interactive setup wizard. Asks for runtime bin and runtime dir; preserves any other manual edits to ucl.yaml on re-run.").

### Tests

**`tests/commands-init.test.ts` — rewrite. Eight tests:**

Build a `fakeRl(answers: string[])` helper that returns `{ question, close }` shape where each `.question(q, cb)` call shifts one answer off the front and calls cb on next tick.

```ts
test("first init writes config with prompted values, creates runtime tree", async () => {
  /* fakeRl(["~/myrun", "claude"]); toolCheck → both true; expect config has runtime_dir + bin=claude; tasks/ etc exist */
})

test("re-init preserves user-edited fields outside the prompted ones", async () => {
  /* pre-write config with execution.max_parallel_tabs: 9; init with answers ["", ""]; assert max_parallel_tabs still 9 after */
})

test("re-init shows current values as prompt defaults", async () => {
  /* pre-write bin: happy; capture prompt strings via a logger fake; assert one prompt contained "[happy]" */
})

test("only happy installed → no prompt asked, bin auto-selected as happy", async () => {
  /* toolCheck claude→false, happy→true; fakeRl(["~/x"]); expect zero prompt for bin */
})

test("only claude installed → bin auto-selected as claude", async () => { /* mirror */ })

test("neither installed → throws with clear message", async () => {
  /* toolCheck both→false; expect throws containing "Neither claude nor happy" */
})

test("empty answer for runtime dir uses default", async () => { /* */ })

test("invalid bin answer retries until valid", async () => {
  /* fakeRl(["~/x", "bogus", "", "claude"]); expect successful init with bin=claude */
})
```

### Implementation order inside G02

1. Update init.ts using yaml-utils + doctor's runChecks
2. Rewrite tests
3. typecheck + bun test
4. Commit: `feat: rewrite ucl init as interactive wizard`

---

## Self-review

- **Spec coverage:** Q2 (init optimization 1-3, 5) covered by G02. Q3 (doctor optimization 4-7, billing) covered by G01. Plan covers all 7 optimizations + billing-env rewrite as agreed.
- **No placeholders:** code-level field names (`runtime.bin`, env var names), file paths, regex, and CheckResult shape all explicit. No "TODO / handle edge cases".
- **Type consistency:** `CheckResult` shape used identically in G01 (defined) and G02 (consumed via `runChecks`). `cmdInit`'s `rl` shape matches `readline.Interface`'s `question(q, cb)` subset.
- **Cross-task interface:** `runChecks(cfg)` and `setYamlValue/getYamlValue/readYamlDoc/writeYamlDoc` are the exported seams. G02 imports both. No leakage of internal helpers (probeVersion, formatResult, makeAsker) across module boundaries.
