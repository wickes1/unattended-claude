# unattended-claude v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Each task is self-contained — the agent is briefed with this plan + `../../../DESIGN.md` + (where porting) the v1 source file path. Steps use `- [ ]` checkboxes.

**Goal:** Implement `unattended-claude` v2 — a demand-shifting unattended Claude Code runtime — from scratch in the `unattended-claude/` directory at `Workshop/unattended-claude/unattended-claude/`. Reference v1 (`Workshop/unattended-claude/cc-nightshift/`) for vetted modules.

**Architecture:** Constant state + episodic execution. zellij driver (program-controlled multi-tab) + claude `--session-id`/`--resume` for cross-window continuity + paused-state machine + window-aware schedule enforcement. See `../../../DESIGN.md` for full design.

**Tech Stack:** TypeScript + Bun, `yaml` for config, native macOS `launchd` for scheduling, zellij as the program-controlled TUI host, Happy as the Claude wrapper.

**Discipline (from DESIGN §十四):** Single goal = parity + 4 new features (`--resume` / weekly-limit / context-limit HANDOFF / wind-down). No "while-I'm-here" refactors. Every module ships with tests. `bun test` + `tsc --noEmit` must stay green between commits. 2-week hard deadline.

**Language policy:** Project is global-facing. All English for:
- CLI output, help text, error messages
- Internal log lines, code comments, identifiers
- Skill content (`task-brief`, `task-review`) — skills are AI-facing, English convention
- Prompt injections to claude (wind-down, wake-up, HANDOFF instruction)
- README.md, generated reports

Exceptions (Chinese OK):
- `DESIGN.md` (internal design memo, frozen as-is)
- `docs/superpowers/plans/*.md` (this plan, internal)
- `QUICK-DEMO.md` (T24, owner-facing personal doc, bilingual OK)
- Git commit messages (English convention)

---

## Path Conventions

- **v2 repo root:** `/Users/week-mac/Fonds/Workshop/unattended-claude/unattended-claude/` (referred to below as `<v2>/`)
- **v1 reference:** `/Users/week-mac/Fonds/Workshop/unattended-claude/cc-nightshift/` (referred to below as `<v1>/`)
- **Runtime data:** `~/unattended/` (created at runtime by `ucl init`)
- **Config:** `~/.config/unattended-claude/cc.yaml`

All file paths in tasks below are **relative to `<v2>/`** unless prefixed with `<v1>/`.

---

## File Structure (after Phase 6 complete)

```
<v2>/
├── DESIGN.md                    (already exists)
├── README.md                    (placeholder; full README post-impl)
├── package.json
├── tsconfig.json
├── bun.lock
├── .gitignore
├── config/cc.yaml               template installed by ucl init
├── docs/superpowers/plans/2026-05-23-v2-implementation.md    (this file)
├── src/
│   ├── index.ts                 CLI dispatcher
│   ├── types.ts                 domain types + Runtime interface
│   ├── config.ts                YAML parser + Config interface
│   ├── layout.ts                runtime dir abstraction
│   ├── clock.ts                 RealClock / SimClock
│   ├── logger.ts                ConsoleLogger / MemoryLogger
│   ├── events.ts                events.jsonl writer/reader + event types
│   ├── runtime/
│   │   ├── zellij.ts            zellij primitives (port from v1)
│   │   ├── detectors.ts         matchRateLimit + matchContextLimit + matchWeeklyLimit
│   │   ├── claude-session.ts    interactive claude driver (new --session-id support)
│   │   └── mock-runtime.ts      test runtime
│   ├── orchestrator/
│   │   ├── state-store.ts       per-task state.json + global state
│   │   ├── rate-limit.ts        gate (5h + weekly)
│   │   ├── episode.ts           single-episode runner + wind-down
│   │   ├── lifecycle.ts         window start/end, auto-resume paused
│   │   └── main.ts              orchestrator loop
│   ├── commands/
│   │   ├── init.ts
│   │   ├── plan.ts
│   │   ├── run.ts
│   │   ├── stop.ts
│   │   ├── schedule.ts          launchd plist generator
│   │   ├── status.ts
│   │   ├── stats.ts
│   │   ├── review.ts
│   │   ├── archive.ts
│   │   ├── todo.ts              consolidate sub-command
│   │   └── attach.ts
│   └── schedule.ts              schedule window math
├── tests/
│   ├── helpers.ts
│   ├── config.test.ts
│   ├── layout.test.ts
│   ├── events.test.ts
│   ├── zellij.test.ts
│   ├── detectors.test.ts
│   ├── claude-session.test.ts
│   ├── state-store.test.ts
│   ├── rate-limit.test.ts
│   ├── episode.test.ts
│   ├── lifecycle.test.ts
│   ├── orchestrator.test.ts
│   ├── commands.test.ts
│   ├── schedule.test.ts
│   ├── e2e.test.ts              the milestone task
│   └── fixtures/
└── .claude/
    └── skills/
        ├── task-brief/SKILL.md
        └── task-review/SKILL.md
```

---

## Phase Dependency Graph

```
P0 Bootstrap
  ↓
P1 Foundation  (T02, T03, T04, T05 in parallel)
  ↓
P2 Runtime Layer  (T06, T07, T08 in parallel)
  ↓
P3 Claude Session  (T09)
  ↓
P4 Orchestration  (T10, T11 parallel → T12 → T13 → T14)
  ↓
P5 Commands  (T15, T16, T17, T18, T19, T20 in parallel groups)
  ↓
P6 Skills + E2E  (T21 || T22)
```

---

# Phase 0 — Bootstrap

### Task T01: Project skeleton

**Files (create):**
- `package.json`
- `tsconfig.json`
- `.gitignore`
- `README.md` (one-paragraph placeholder)
- `src/index.ts` (one-liner placeholder for now: `console.log("unattended-claude v2 - bootstrap ok")`)
- `tests/smoke.test.ts` (smoke that `bun src/index.ts` exits 0)

**Reference:** `<v1>/package.json`, `<v1>/tsconfig.json`, `<v1>/.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "unattended-claude",
  "version": "0.1.0",
  "description": "Demand-shifting unattended Claude Code runtime",
  "private": true,
  "type": "module",
  "bin": { "ucl": "./src/index.ts" },
  "scripts": {
    "start": "bun src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "yaml": "^2.9.0" },
  "devDependencies": { "@types/bun": "^1.3.14", "typescript": "^6.0.3" }
}
```

- [ ] **Step 2: Copy `tsconfig.json` verbatim from `<v1>/tsconfig.json`**

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
bun.lock
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 4: Write minimal `src/index.ts`**

```typescript
#!/usr/bin/env bun
console.log("unattended-claude v2 - bootstrap ok")
```

- [ ] **Step 5: Write `README.md` placeholder**

```markdown
# unattended-claude

v2 in progress. See [DESIGN.md](./DESIGN.md) for current design and [docs/superpowers/plans/](./docs/superpowers/plans/) for the implementation plan.
```

- [ ] **Step 6: Write smoke test `tests/smoke.test.ts`**

```typescript
import { describe, expect, it } from "bun:test"

describe("bootstrap", () => {
  it("entrypoint runs and exits 0", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts"], { stdout: "pipe" })
    const code = await proc.exited
    expect(code).toBe(0)
  })
})
```

- [ ] **Step 7: `bun install` (creates bun.lock)**

- [ ] **Step 8: `bun test` — verify smoke passes**

- [ ] **Step 9: `bun run typecheck` — verify tsc passes**

- [ ] **Step 10: Commit**

```bash
git init                           # if not already
git add .
git commit -m "feat(p0): bootstrap unattended-claude v2 skeleton"
```

---

# Phase 1 — Foundation (4 parallel tasks)

### Task T02: Domain types

**Files (create):**
- `src/types.ts`

**Reference:** `<v1>/src/types.ts` for `InvokeOpts`, `EpisodeResult`, `Runtime`, `Clock`, `Logger` interfaces — these port verbatim. Other types (`Task`, `OvernightState`, `ProgressEvent`) replaced by new types below.

**Acceptance:** `types.ts` exports cover entire domain; `tsc --noEmit` clean.

- [ ] **Step 1: Define core types**

```typescript
// src/types.ts

// ── Runtime adapter (port verbatim from v1) ─────────────────
export interface InvokeOpts {
  workdir: string
  promptFile: string
  sentinelFile: string
  timeoutMs: number
  parentSession: string
  tabName: string
  rawLogFile: string
  /** NEW v2: pre-generated claude session UUID, passed as --session-id. */
  claudeSessionId: string
  /** NEW v2: when true, launch with --resume <claudeSessionId>. */
  resume: boolean
}

export type EpisodeResult =
  | { status: "completed"; durationMs: number }
  | { status: "rate_limited"; resumeAt: Date }
  | { status: "weekly_limited"; resumeAt: Date }      // NEW v2
  | { status: "context_full" }                         // NEW v2
  | { status: "timeout" }
  | { status: "error"; reason: string }
  | { status: "lost"; reason: string }

export interface Runtime {
  invoke(opts: InvokeOpts): Promise<EpisodeResult>
}

// ── Task state machine (NEW v2 — replaces v1 OvernightState) ───────
export type TaskState = "planned" | "running" | "paused" | "done" | "failed" | "archived"

export type PausedReason =
  | "schedule-boundary"
  | "rate-limit-5h"
  | "weekly-limit"
  | "context-full"
  | "user-stop"
  | "user-stop-now"
  | "orphan"

/** Per-task mutable state. Lives at ~/unattended/state/tasks/<id>.json. */
export interface TaskRuntimeState {
  schema_version: 1
  task_id: string
  state: TaskState
  paused_reason: PausedReason | null
  claude_session_id: string                      // pre-generated UUID
  current_episode: number                        // 0-based episode counter
  context_compactions: number                    // count of HANDOFF-based restarts
  created_at: string                             // ISO 8601
  last_updated: string                           // ISO 8601
  workdir: string                                // absolute path
}

// ── Task doc (parsed from tasks/<id>.md frontmatter) ───────
export interface TaskDoc {
  id: string                                     // "YYYY-MM-DD-NN-slug"
  title: string
  workdir: string
  serial: boolean                                // §九 serial flag
  file: string                                   // absolute path to the .md
}

// ── events.jsonl events ──────────────────────────
export type Event =
  | { ts: string; event: "run_start"; until: string | null }
  | { ts: string; event: "run_end"; reason: string }
  | { ts: string; event: "task_started"; task: string; episode: number; resumed: boolean }
  | { ts: string; event: "task_paused"; task: string; episode: number; reason: PausedReason }
  | { ts: string; event: "task_done"; task: string; episode: number }
  | { ts: string; event: "task_failed"; task: string; reason: string }
  | { ts: string; event: "rate_limit"; task: string; episode: number; resume_at: string }
  | { ts: string; event: "weekly_limit"; resume_at: string }
  | { ts: string; event: "context_compaction"; task: string; episode: number }
  | { ts: string; event: "wind_down_injected"; task: string; episode: number }
  | { ts: string; event: "queued_due_to_concurrency_cap"; task: string }
  | { ts: string; event: "usage_snapshot"; task: string; episode: number; session_tokens: number }
  | { ts: string; event: "archive_moved"; task: string }
  | { ts: string; event: "error"; reason: string }

// ── Cross-cutting (port from v1) ────────────────────
export interface Clock {
  now(): Date
  sleep(ms: number): Promise<void>
}
export type LogLevel = "debug" | "info" | "warn" | "error"
export interface Logger {
  log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void
}
```

- [ ] **Step 2: Verify `tsc --noEmit` passes**

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(p1): domain types — task state machine + events"
```

---

### Task T03: clock + logger (port verbatim)

**Files (create):**
- `src/clock.ts` — verbatim copy of `<v1>/src/clock.ts`
- `src/logger.ts` — verbatim copy of `<v1>/src/logger.ts`, with one change: add `"debug"` level

**Acceptance:** `tsc --noEmit` passes; no behavior change vs v1 except the new debug level.

- [ ] **Step 1: Copy `<v1>/src/clock.ts` verbatim to `src/clock.ts`. Verify imports still resolve.**

- [ ] **Step 2: Copy `<v1>/src/logger.ts` to `src/logger.ts`. Update the `LogLevel` import to match the new `types.ts` (which adds `"debug"`):**

```typescript
import type { LogLevel, Logger } from "./types.ts"
```

(The `MemoryLogger.has()` and `log()` methods unchanged.)

- [ ] **Step 3: Tests live in `tests/helpers.ts` reusable; no separate clock/logger tests needed (covered by orchestrator tests).**

- [ ] **Step 4: Commit**

```bash
git add src/clock.ts src/logger.ts
git commit -m "feat(p1): port clock + logger"
```

---

### Task T04: Config + layout

**Files (create):**
- `src/config.ts`
- `src/layout.ts`
- `config/cc.yaml` (template — see DESIGN §十三)
- `tests/config.test.ts`
- `tests/layout.test.ts`

**Reference:** `<v1>/src/config.ts` for `parseDuration`, `resolvePath` (port verbatim), and structure. `<v1>/src/layout.ts` for inspiration only — completely different structure for v2 (flat, no per-night).

**Acceptance:** Config parses DESIGN §十三 sample YAML; Layout returns correct paths under `~/unattended/`; all tests pass.

- [ ] **Step 1: Write `config/cc.yaml` (verbatim from DESIGN §十三, with comments)**

- [ ] **Step 2: Write `src/config.ts` — new schema, smaller than v1 (no synthesis / self-extending / GC fields):**

```typescript
import { parse as parseYaml } from "yaml"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

export interface ScheduleWindow {
  start: string                                  // "HH:MM"
  end: string                                    // "HH:MM"
  days: string[]                                 // ["mon","tue",...]
}

export interface Config {
  configPath: string
  runtimeDir: string                             // ~/unattended
  runtime: {
    driver: string                               // "claude" | future "opencode"
    bin: string                                  // "happy" | "claude"
    extraArgs: string[]
  }
  execution: {
    maxParallelTabs: number
    contextCompactThreshold: number              // tokens
    windDownLeadMinutes: number
    episodeHardTimeoutMs: number
    inactivityTimeoutMs: number
    captureLines: number
    cooldownMs: number
    maxConsecutiveErrors: number
  }
  detection: {
    dialogPollIntervalMs: number
    dialogTimeoutMs: number
  }
  rateLimit: {
    safetyMarginMs: number
    parseFailFallbackMs: number
  }
  archive: { autoAfterDays: number }
  schedule: { windows: ScheduleWindow[] }
  terminal: { term: string; envScrub: string[]; envSet: Record<string, string> }
  logging: { level: string; dir: string }
}

// Port parseDuration + resolvePath verbatim from v1.
// loadConfig: read + validate, defaults match DESIGN §十三 sample.
// Throws on missing required fields. Sample defaults:
// - max_parallel_tabs: 3, context_compact_threshold: 150000,
// - wind_down_lead_minutes: 5, episode_hard_timeout: 60m,
// - archive.auto_after_days: 7
```

- [ ] **Step 3: Write `tests/config.test.ts` — at minimum:**
  - `parseDuration` correctness on "30m", "9h", "500ms"
  - `loadConfig` of `<v2>/config/cc.yaml` template returns expected shape
  - missing required field throws clear message
  - `~/` paths expand correctly

- [ ] **Step 4: Write `src/layout.ts`:**

```typescript
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Date format YYYY-MM-DD (local TZ). */
export function fmtDate(d: Date): string { /* ...port from v1... */ }

/** Task ID format check: YYYY-MM-DD-NN-slug. */
export function isValidTaskId(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-\d{2}-[a-z0-9-]+$/.test(s)
}

/** Generate next task ID for today, given existing IDs (yields NN+1). */
export function nextTaskId(today: string, existing: string[], slug: string): string {
  const sameDate = existing
    .map((id) => /^(\d{4}-\d{2}-\d{2})-(\d{2})-/.exec(id))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === today)
    .map((m) => Number(m[2]))
  const next = (sameDate.length === 0 ? 0 : Math.max(...sameDate)) + 1
  return `${today}-${String(next).padStart(2, "0")}-${slug}`
}

/** All runtime paths centralized. */
export class Layout {
  constructor(readonly runtimeDir: string) {}

  get todoFile(): string { return join(this.runtimeDir, "todo.md") }
  get tasksDir(): string { return join(this.runtimeDir, "tasks") }
  get workdirsDir(): string { return join(this.runtimeDir, "workdirs") }
  get archiveDir(): string { return join(this.runtimeDir, "archive") }
  get stateDir(): string { return join(this.runtimeDir, "state") }
  get eventsJsonl(): string { return join(this.stateDir, "events.jsonl") }
  get taskStatesDir(): string { return join(this.stateDir, "tasks") }
  get handoffsDir(): string { return join(this.stateDir, "handoffs") }
  get weeklyPausedFile(): string { return join(this.stateDir, "weekly-paused-until.txt") }
  get logsDir(): string { return join(this.runtimeDir, "logs") }

  taskDocFile(id: string): string { return join(this.tasksDir, `${id}.md`) }
  taskStateFile(id: string): string { return join(this.taskStatesDir, `${id}.json`) }
  handoffFile(id: string): string { return join(this.handoffsDir, `${id}.md`) }
  taskWorkdir(id: string): string { return join(this.workdirsDir, id) }
  taskArchiveDir(id: string): string { return join(this.archiveDir, id) }
  episodeLogFile(id: string, n: number): string {
    return join(this.logsDir, `${id}-${n}.log`)
  }
  sentinelFile(id: string, n: number): string {
    return join(this.stateDir, `episode-${id}-${n}.done`)
  }
}
```

- [ ] **Step 5: Write `tests/layout.test.ts` — at minimum:**
  - `fmtDate` and `isValidTaskId` correctness
  - `nextTaskId` increments correctly with various existing IDs
  - Layout returns expected paths for `runtimeDir = "/tmp/x"`

- [ ] **Step 6: `bun test` — verify all pass; `bun run typecheck`**

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/layout.ts config/cc.yaml tests/config.test.ts tests/layout.test.ts
git commit -m "feat(p1): config + layout + cc.yaml template"
```

---

### Task T05: Events writer

**Files (create):**
- `src/events.ts`
- `tests/events.test.ts`

**Reference:** `<v1>/src/orchestrator/state.ts` `appendProgress` / `readProgress` (port shape; rename to events).

**Acceptance:** Atomic append, parse-safe reads (skip incomplete trailing lines), tests pass.

- [ ] **Step 1: Write `src/events.ts`**

```typescript
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { ensureDir } from "./fs-utils.ts"     // create this helper below
import type { Event } from "./types.ts"
import type { Layout } from "./layout.ts"

export function appendEvent(layout: Layout, ev: Event): void {
  ensureDir(layout.stateDir)
  appendFileSync(layout.eventsJsonl, JSON.stringify(ev) + "\n")
}

export function readEvents(layout: Layout): Event[] {
  if (!existsSync(layout.eventsJsonl)) return []
  const raw = readFileSync(layout.eventsJsonl, "utf8")
  const out: Event[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as Event) } catch { /* skip incomplete trailing */ }
  }
  return out
}

/** Query helpers (used by status / stats / review --since). */
export function eventsSince(layout: Layout, since: Date): Event[] {
  return readEvents(layout).filter((e) => new Date(e.ts).getTime() >= since.getTime())
}

export function eventsForTask(layout: Layout, taskId: string): Event[] {
  return readEvents(layout).filter((e) => "task" in e && e.task === taskId)
}
```

- [ ] **Step 2: Write `src/fs-utils.ts`**

```typescript
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

export function atomicWrite(path: string, content: string): void {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}
```

- [ ] **Step 3: Write `tests/events.test.ts` — at minimum:**
  - append → read returns same event
  - multiple appends → read returns in order
  - corrupted trailing line is skipped (write valid + half-written, then `readEvents` returns only valid)
  - `eventsSince` filters by timestamp
  - `eventsForTask` filters by task field

- [ ] **Step 4: `bun test` passes; `bun run typecheck`**

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/fs-utils.ts tests/events.test.ts
git commit -m "feat(p1): events.jsonl writer + reader"
```

---

# Phase 2 — Runtime Layer (3 parallel tasks after P1)

### Task T06: Port zellij.ts

**Files (create):**
- `src/runtime/zellij.ts`
- `tests/zellij.test.ts`

**Reference (port verbatim with renames):**
- `<v1>/src/runtime/zellij.ts` → `src/runtime/zellij.ts`
- `<v1>/tests/zellij.test.ts` → `tests/zellij.test.ts`

**Renames during port:**
- All comment / log references to "night" → "window"
- `Config` import path:`../config.ts` (path unchanged but ensure new Config shape compatible — `terminal.term`, `terminal.envScrub`, `terminal.envSet` all exist)
- No other changes — this is hard-won, do not "improve"

**Acceptance:** `tests/zellij.test.ts` passes (some tests in v1 mock zellij commands; those mocks still apply). `bun run typecheck` clean.

- [ ] **Step 1: Copy `<v1>/src/runtime/zellij.ts` to `src/runtime/zellij.ts`**

- [ ] **Step 2: Search/replace "night" → "window" in comments only (not in code identifiers — verify each change). Example diff:**
  - Comment "one per night" → "one per window"
  - No identifier changes

- [ ] **Step 3: Copy `<v1>/tests/zellij.test.ts` to `tests/zellij.test.ts`. Adjust imports if path differs.**

- [ ] **Step 4: `bun test tests/zellij.test.ts` — all green**

- [ ] **Step 5: `bun run typecheck` clean**

- [ ] **Step 6: Commit**

```bash
git add src/runtime/zellij.ts tests/zellij.test.ts
git commit -m "feat(p2): port zellij.ts driver from v1"
```

---

### Task T07: Detectors (matchRateLimit + new matchContextLimit + matchWeeklyLimit)

**Files (create):**
- `src/runtime/detectors.ts`
- `tests/detectors.test.ts`

**Reference:** `<v1>/src/runtime/claude-session.ts` lines containing `PATTERNS`, `matchRateLimit`, `hasInputPrompt`, `nonEmptyLines` — port these verbatim, then add two new detectors.

**Acceptance:** `matchRateLimit` parity with v1 tests; new `matchContextLimit` and `matchWeeklyLimit` covered by new tests.

- [ ] **Step 1: Port `PATTERNS`, `matchRateLimit`, `hasInputPrompt`, `nonEmptyLines`, `stripAnsi` (the latter from zellij.ts) into `src/runtime/detectors.ts` as exports. Keep them functional only — no side effects.**

- [ ] **Step 2: Add new detectors:**

```typescript
/** PATTERNS additions */
export const PATTERNS_EXT = {
  CONTEXT_FULL: [
    /Conversation (?:too long|exceeds|reached the max)/i,
    /Context (?:window|limit) (?:exceeded|reached|full)/i,
    /This conversation is too long/i,
  ],
  WEEKLY_LIMIT: [
    /Weekly limit reached/i,                     // confirmed from user-provided screenshot
    /weekly (?:usage )?limit/i,                  // looser fallback
  ],
  WEEKLY_RESET: [
    // "resets Oct 9 at 10:30am" — confirmed format from screenshot
    /resets?\s+(\w{3,9})\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i,
  ],
}

/** Returns true if claude TUI text indicates context is full. */
export function matchContextLimit(text: string): boolean {
  const flat = text.replace(/\s+/g, " ")
  return PATTERNS_EXT.CONTEXT_FULL.some((re) => re.test(flat))
}

/**
 * Returns a Date when the weekly limit resets, or null.
 * Parses the confirmed format "resets Oct 9 at 10:30am".
 * If matched but reset time unparseable, returns now + 24h as conservative fallback.
 */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

export function matchWeeklyLimit(text: string, now: Date): Date | null {
  const flat = text.replace(/\s+/g, " ")
  if (!PATTERNS_EXT.WEEKLY_LIMIT.some((re) => re.test(flat))) return null
  const m = PATTERNS_EXT.WEEKLY_RESET[0]!.exec(flat)
  if (m) {
    const monthKey = (m[1] ?? "").toLowerCase().slice(0, 3)
    const month = MONTHS[monthKey]
    const day = Number(m[2])
    let hour = Number(m[3])
    const minute = Number(m[4])
    const meridiem = m[5]?.toLowerCase()
    if (month !== undefined && Number.isFinite(day) && Number.isFinite(hour)) {
      if (meridiem === "pm" && hour < 12) hour += 12
      if (meridiem === "am" && hour === 12) hour = 0
      const reset = new Date(now.getFullYear(), month, day, hour, minute, 0, 0)
      // If the parsed date is already in the past (e.g. Jan 5 parsed in Dec), bump to next year.
      if (reset.getTime() < now.getTime()) reset.setFullYear(now.getFullYear() + 1)
      return reset
    }
  }
  // Matched weekly-limit but couldn't parse reset — conservative 24h fallback.
  return new Date(now.getTime() + 24 * 60 * 60 * 1000)
}

/** Token-equivalent estimate from jsonl bytes — used by context-compact threshold check. */
export function estimateTokensFromJsonl(jsonlBytes: number): number {
  // Rough heuristic: 1 token ≈ 4 chars; jsonl includes JSON overhead (~20%).
  // For threshold-comparison purposes this overestimate is acceptable —
  // it just means we compact slightly earlier than strictly necessary.
  return Math.floor(jsonlBytes / 4)
}
```

- [ ] **Step 3: Write `tests/detectors.test.ts`:**
  - Port v1's rate-limit detection tests verbatim
  - New tests for `matchContextLimit` with sample claude TUI text for "Conversation too long" — pass/fail cases
  - New tests for `matchWeeklyLimit` — when text contains "weekly limit" but no parseable reset, returns now+24h
  - `estimateTokensFromJsonl(600_000)` returns 150_000 (sanity)

- [ ] **Step 4: `bun test tests/detectors.test.ts` — all green**

- [ ] **Step 5: Commit**

```bash
git add src/runtime/detectors.ts tests/detectors.test.ts
git commit -m "feat(p2): detectors (rate-limit port + context-full + weekly-limit)"
```

---

### Task T08: Mock runtime (port + extend)

**Files (create):**
- `src/runtime/mock-runtime.ts`
- `tests/mock-runtime.test.ts`

**Reference (port + extend):**
- `<v1>/src/runtime/mock-runtime.ts` → port the `MockRuntime` class, `simComplete`, `simRateLimited`, `simTimeout`, `simError`, `simLost` factories
- New behaviors to add: `simContextFull`, `simWeeklyLimited`

**Acceptance:** existing v1 mock behaviors port cleanly; new ones return correct `EpisodeResult` shapes; tests pass.

- [ ] **Step 1: Copy `<v1>/src/runtime/mock-runtime.ts` to `src/runtime/mock-runtime.ts`. Update imports for new types. Remove `simSynthesis` (no longer needed — `synthesisBehavior` parameter can be removed from `MockRuntime` constructor).**

- [ ] **Step 2: Add new factories:**

```typescript
export function simContextFull(clock: SimClock, durationMin = 5): MockBehavior {
  return () => {
    clock.advance(durationMin * 60_000)
    return { status: "context_full" }
  }
}

export function simWeeklyLimited(clock: SimClock, resetInHours: number): MockBehavior {
  return () => {
    clock.advance(2 * 60_000)
    return {
      status: "weekly_limited",
      resumeAt: new Date(clock.now().getTime() + resetInHours * 3600_000),
    }
  }
}
```

- [ ] **Step 3: Simplify `MockRuntime` constructor — drop `synthesisBehavior` param (and the synthesis routing). `MockRuntime` constructor now just takes `episodeScript`.**

- [ ] **Step 4: Write `tests/mock-runtime.test.ts`:**
  - For each `sim*` factory: returns correct `EpisodeResult.status`
  - `simComplete` writes deliverables + handoff + sentinel correctly (port v1 tests)
  - `simContextFull` returns `{ status: "context_full" }`
  - `simWeeklyLimited(2)` returns `{ status: "weekly_limited", resumeAt: ~+2h }`

- [ ] **Step 5: `bun test tests/mock-runtime.test.ts` — green**

- [ ] **Step 6: Commit**

```bash
git add src/runtime/mock-runtime.ts tests/mock-runtime.test.ts
git commit -m "feat(p2): mock-runtime — port + add context-full + weekly-limit"
```

---

# Phase 3 — Claude Session

### Task T09: claude-session.ts with --session-id + --resume + wind-down

**Files (create):**
- `src/runtime/claude-session.ts`
- `tests/claude-session.test.ts`

**Reference:** `<v1>/src/runtime/claude-session.ts`. Port `buildLaunchCommand`, `handleDialogs`, `pollUntilDone`, `runClaudeSession` shape; **major changes** for new flags and paused-state outcomes.

**Behavior additions vs v1:**

1. `buildLaunchCommand(cfg, opts)` takes `InvokeOpts` to access `claudeSessionId` and `resume`. Adds `--session-id <uuid>` always; adds `--resume <uuid>` when `opts.resume` is true.
2. `pollUntilDone` checks for context-limit (`matchContextLimit`) and weekly-limit (`matchWeeklyLimit`) in addition to rate-limit. Returns appropriate `EpisodeResult.status` (`context_full`, `weekly_limited`).
3. **Wind-down injection**: `runClaudeSession` accepts an optional `windDownAt: Date | null` and a `clock`. While polling, when `clock.now() >= windDownAt`, injects the wind-down prompt (DESIGN §六) **once** and continues polling. The "graceful close at boundary" is the orchestrator's responsibility (it kills the tab via `closeTab`), not this function.
4. **Wake-up prompt on resume**: when `opts.resume === true`, after `handleDialogs` returns ready, inject a short wake-up prompt **before** `pasteFile(opts.promptFile)`. The wake-up prompt text depends on `paused_reason` — passed via `opts.wakeUpPrompt: string | null` (added to `InvokeOpts`). Orchestrator builds the right text per DESIGN §五 wake-up table.

**Acceptance:** Tests verify launch command shape; integration via MockRuntime simulates wind-down injection + paused outcomes.

- [ ] **Step 1: Update `InvokeOpts` in `src/types.ts`** to add:

```typescript
windDownAt: Date | null
wakeUpPrompt: string | null
```

- [ ] **Step 2: Write `buildLaunchCommand`:**

```typescript
export function buildLaunchCommand(cfg: Config, opts: InvokeOpts): string {
  const skip = " --dangerously-skip-permissions"
  const sessionFlag = opts.resume
    ? ` --resume ${opts.claudeSessionId}`
    : ` --session-id ${opts.claudeSessionId}`
  const extra = cfg.runtime.extraArgs.length ? " " + cfg.runtime.extraArgs.join(" ") : ""
  return `${cfg.runtime.bin}${skip}${sessionFlag}${extra}`
}
```

- [ ] **Step 3: Test (`tests/claude-session.test.ts`):**

```typescript
it("buildLaunchCommand new session", () => {
  const opts = { ...baseOpts, claudeSessionId: "abc-123", resume: false }
  expect(buildLaunchCommand(cfg, opts)).toBe(
    "happy --dangerously-skip-permissions --session-id abc-123",
  )
})

it("buildLaunchCommand resume", () => {
  const opts = { ...baseOpts, claudeSessionId: "abc-123", resume: true }
  expect(buildLaunchCommand(cfg, opts)).toBe(
    "happy --dangerously-skip-permissions --resume abc-123",
  )
})
```

- [ ] **Step 4: Port `handleDialogs` verbatim (no changes vs v1).**

- [ ] **Step 5: Rewrite `pollUntilDone` with new detection. Outline:**

```typescript
async function pollUntilDone(opts, cfg, log, clock): Promise<EpisodeResult> {
  const start = Date.now()
  let lastText: string | null = null
  let stableSince: number | null = null
  let windDownInjected = false
  let tick = 0

  for (;;) {
    if (Date.now() - start >= opts.timeoutMs) return { status: "timeout" }
    if (!(await sessionAlive(opts.parentSession))) return { status: "lost", reason: "zellij session died" }

    const text = await capture(opts.parentSession, opts.tabName, cfg.execution.captureLines)

    // Wind-down injection (once)
    if (!windDownInjected && opts.windDownAt && clock.now() >= opts.windDownAt) {
      await sendText(opts.parentSession, opts.tabName, WIND_DOWN_PROMPT)
      windDownInjected = true
      // Caller logs the event; this function just injects.
    }

    // Limits (check every 5 ticks)
    if (tick % 5 === 0) {
      const now = clock.now()
      const wl = matchWeeklyLimit(text, now)
      if (wl) return { status: "weekly_limited", resumeAt: wl }
      const rl = matchRateLimit(text, now, cfg.rateLimit.parseFailFallbackMs)
      if (rl) return { status: "rate_limited", resumeAt: rl }
      if (matchContextLimit(text)) return { status: "context_full" }
    }

    if (await Bun.file(opts.sentinelFile).exists()) {
      return { status: "completed", durationMs: Date.now() - start }
    }

    // Inactivity detection (port from v1 — same logic for stuck-at-input-prompt)
    // ...

    tick++
    await sleep(1000)
  }
}

const WIND_DOWN_PROMPT = `Schedule window is ending soon. Please finish the smallest unit you're currently working on (current file edit, running test) and don't start any new large work. Stop and wait once done — I'll close this session shortly. Your conversation history will be preserved and resumed in the next window.`
```

- [ ] **Step 6: Update `runClaudeSession` to inject `opts.wakeUpPrompt` after dialogs if `opts.resume` is true. Wake-up is injected **before** `pasteFile(opts.promptFile)`. If `opts.resume`, the promptFile is the wake-up file (or the orchestrator sends wake-up + skips promptFile). Decision: keep simple — `wakeUpPrompt` is a short string, `pasteFile` writes the new round's prompt. On resume, the new round's prompt IS the wake-up text — written into a one-line file by the orchestrator.**

- [ ] **Step 7: Test wind-down injection with MockRuntime:**

```typescript
it("pollUntilDone injects wind-down once when windDownAt passes", async () => {
  // Set up a mock zellij that captures sendText calls
  // Set windDownAt to clock.now() + 1ms
  // Run pollUntilDone with a sentinel that never fires (timeout-bounded test)
  // Verify sendText called exactly once with WIND_DOWN_PROMPT
})
```

- [ ] **Step 8: Test detection priorities** — given text containing both rate-limit and context-full markers, verify weekly > rate > context order

- [ ] **Step 9: `bun test tests/claude-session.test.ts` — green**

- [ ] **Step 10: Commit**

```bash
git add src/runtime/claude-session.ts src/types.ts tests/claude-session.test.ts
git commit -m "feat(p3): claude-session — --session-id, --resume, wind-down, new detectors wired"
```

---

# Phase 4 — Orchestration

### Task T10: State store (per-task state.json + global helpers)

**Files (create):**
- `src/orchestrator/state-store.ts`
- `tests/state-store.test.ts`

**Reference:** `<v1>/src/orchestrator/state-store.ts` for the async mutex pattern. v2's state is per-task, so the mutex is per-task-id.

**Acceptance:** Atomic per-task state writes; concurrent updates serialized per task ID; cross-task updates parallel.

- [ ] **Step 1: Write `src/orchestrator/state-store.ts`:**

```typescript
import { existsSync, readFileSync } from "node:fs"
import { atomicWrite, ensureDir } from "../fs-utils.ts"
import type { Layout } from "../layout.ts"
import type { TaskRuntimeState } from "../types.ts"

export class TaskStateStore {
  /** Per-task async mutex chain to serialize writes per id. */
  private chains = new Map<string, Promise<unknown>>()

  constructor(private layout: Layout) {}

  /** Read or initialize a task's state file. */
  load(id: string): TaskRuntimeState | null {
    const f = this.layout.taskStateFile(id)
    if (!existsSync(f)) return null
    try { return JSON.parse(readFileSync(f, "utf8")) as TaskRuntimeState } catch { return null }
  }

  /** Serial update for one task; parallel across tasks. */
  update<T>(id: string, fn: (s: TaskRuntimeState) => T): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve()
    const run = prev.then(() => {
      const cur = this.load(id)
      if (!cur) throw new Error(`task state not initialized: ${id}`)
      const r = fn(cur)
      cur.last_updated = new Date().toISOString()
      ensureDir(this.layout.taskStatesDir)
      atomicWrite(this.layout.taskStateFile(id), JSON.stringify(cur, null, 2))
      return r
    })
    this.chains.set(id, run.then(() => {}, () => {}))
    return run
  }

  /** Initialize a fresh task state (used at task creation). */
  init(id: string, workdir: string, claudeSessionId: string): void {
    const now = new Date().toISOString()
    const state: TaskRuntimeState = {
      schema_version: 1,
      task_id: id,
      state: "planned",
      paused_reason: null,
      claude_session_id: claudeSessionId,
      current_episode: 0,
      context_compactions: 0,
      created_at: now,
      last_updated: now,
      workdir,
    }
    ensureDir(this.layout.taskStatesDir)
    atomicWrite(this.layout.taskStateFile(id), JSON.stringify(state, null, 2))
  }

  /** Read all task state files (used by status / orchestrator startup). */
  listAll(): TaskRuntimeState[] {
    if (!existsSync(this.layout.taskStatesDir)) return []
    const { readdirSync } = require("node:fs")
    return readdirSync(this.layout.taskStatesDir)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => this.load(f.replace(".json", "")))
      .filter((s: TaskRuntimeState | null): s is TaskRuntimeState => s !== null)
  }
}
```

- [ ] **Step 2: Write `tests/state-store.test.ts`:**
  - `init` creates file with correct shape
  - `update` modifies + atomic-writes
  - 100 concurrent `update("same-id", ...)` calls produce final state with all increments (per-task serialization)
  - Updates to different IDs run in parallel (verify with timing)
  - `listAll` returns all initialized tasks

- [ ] **Step 3: `bun test tests/state-store.test.ts` — green**

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/state-store.ts tests/state-store.test.ts
git commit -m "feat(p4): per-task state store with async mutex"
```

---

### Task T11: Rate-limit gate (port + extend for weekly)

**Files (create):**
- `src/orchestrator/rate-limit.ts`
- `tests/rate-limit.test.ts`

**Reference:** `<v1>/src/orchestrator/rate-limit.ts` and tests. Port `RateLimitGate` verbatim, then add weekly gate.

**Acceptance:** Both gates work; weekly gate writes/reads `weekly-paused-until.txt`.

- [ ] **Step 1: Port `<v1>/src/orchestrator/rate-limit.ts` to `src/orchestrator/rate-limit.ts` verbatim.**

- [ ] **Step 2: Add `WeeklyLimitGate`:**

```typescript
import { existsSync, readFileSync } from "node:fs"
import { atomicWrite } from "../fs-utils.ts"
import type { Layout } from "../layout.ts"
import type { Clock } from "../types.ts"

export class WeeklyLimitGate {
  constructor(private layout: Layout) {}

  /** Read persisted pause time. */
  pausedUntil(): Date | null {
    if (!existsSync(this.layout.weeklyPausedFile)) return null
    const t = Date.parse(readFileSync(this.layout.weeklyPausedFile, "utf8").trim())
    return Number.isNaN(t) ? null : new Date(t)
  }

  /** Trip — persists across processes (schedule plists check this). */
  trip(resumeAt: Date): void {
    atomicWrite(this.layout.weeklyPausedFile, resumeAt.toISOString())
  }

  /** Clear after reset has passed. */
  clearIfExpired(now: Date): boolean {
    const u = this.pausedUntil()
    if (u && now.getTime() >= u.getTime()) {
      try { require("node:fs").unlinkSync(this.layout.weeklyPausedFile) } catch {}
      return true
    }
    return false
  }

  blocked(now: Date): boolean {
    const u = this.pausedUntil()
    return u !== null && now.getTime() < u.getTime()
  }
}
```

- [ ] **Step 3: Port v1's `tests/rate-limit.test.ts` to `tests/rate-limit.test.ts`. Add tests for `WeeklyLimitGate`:**
  - `trip` then `pausedUntil` round-trip
  - `blocked` true before resumeAt, false after
  - `clearIfExpired` deletes file and returns true

- [ ] **Step 4: `bun test tests/rate-limit.test.ts` — green**

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/rate-limit.ts tests/rate-limit.test.ts
git commit -m "feat(p4): rate-limit gate port + weekly gate"
```

---

### Task T12: Episode loop

**Files (create):**
- `src/orchestrator/episode.ts`
- `tests/episode.test.ts`

**Reference:** `<v1>/src/orchestrator/episode.ts` for `runEpisode` / `applyResult` shape. v2 changes: emits new events, handles new paused reasons.

**Behavior:**
- `runEpisode(task, ctx)` builds `InvokeOpts` (including `claudeSessionId` from task state, `resume` based on `current_episode > 0`, `windDownAt` from orchestrator), calls `runtime.invoke`, returns result.
- `applyResult(task, result, ctx)` writes events.jsonl entry and updates task state:
  - `completed` → state=`done`, append `task_done`
  - `rate_limited` → state=`paused`, paused_reason=`rate-limit-5h`, append `task_paused`
  - `weekly_limited` → state=`paused`, paused_reason=`weekly-limit`, trip WeeklyLimitGate, append `task_paused` + `weekly_limit`
  - `context_full` → trigger HANDOFF compaction (new claudeSessionId generated, context_compactions++), state=`paused`, paused_reason=`context-full`, append `task_paused` + `context_compaction`
  - `timeout` / `error` / `lost` → state=`failed`, append `task_failed`

**Acceptance:** Tests with MockRuntime verify each result type leads to correct state transition + event emission.

- [ ] **Step 1: Write `src/orchestrator/episode.ts` (sketch ~150 lines, follow v1 structure but use TaskStateStore + appendEvent)**

- [ ] **Step 2: Tests:** For each result type from MockRuntime, verify:
  - Correct task state after `applyResult`
  - Correct event in events.jsonl
  - For `context_full`: new claude_session_id assigned, context_compactions incremented

- [ ] **Step 3: `bun test tests/episode.test.ts` — green**

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/episode.ts tests/episode.test.ts
git commit -m "feat(p4): episode loop with new paused-reason handling"
```

---

### Task T13: Lifecycle (window start/end, auto-resume paused)

**Files (create):**
- `src/orchestrator/lifecycle.ts`
- `src/schedule.ts` (window math helpers)
- `tests/lifecycle.test.ts`
- `tests/schedule.test.ts`

**Reference:** `<v1>/src/orchestrator/lifecycle.ts` for `acquireLock`, `releaseLock`, `installSignalHandlers`, `isProcessAlive` — port verbatim. New: window boundary logic, paused-task resume queue.

**Behavior:**
- `lockfile` path: `~/unattended/state/.lock` (instead of v1's per-night lock)
- `windowEndsAt(cfg, now): Date | null` — returns `--until` time from the currently-active schedule window, or null if no window active.
- `nextWindowStart(cfg, now): Date` — for `ucl schedule` info display.
- `wasOrphaned(state): boolean` — true if state=`running` but no zellij tab for this task. Used in preflight.
- `suspendForShutdown(taskStates, layout, log)` — marks all `running` tasks as `paused` with `paused_reason: user-stop` (or `user-stop-now` for hard kill — orchestrator distinguishes).
- `findResumableTasks(taskStateStore, layout): TaskRuntimeState[]` — returns all `paused` tasks (excluding `weekly-limit` if weekly gate active), in FIFO by `last_updated`.

**Acceptance:** All helpers tested in isolation.

- [ ] **Step 1: Write `src/schedule.ts`:**

```typescript
import type { Config, ScheduleWindow } from "./config.ts"

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

export function parseHHMM(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) throw new Error(`invalid HH:MM: ${s}`)
  return { h: Number(m[1]), m: Number(m[2]) }
}

/** Active window at `now`, or null. Handles overnight windows (end < start). */
export function activeWindow(cfg: Config, now: Date): ScheduleWindow | null {
  const day = DAYS[now.getDay()]!
  for (const w of cfg.schedule.windows) {
    if (!w.days.includes(day)) continue
    const { h: sh, m: sm } = parseHHMM(w.start)
    const { h: eh, m: em } = parseHHMM(w.end)
    const startMin = sh * 60 + sm
    const endMin = eh * 60 + em
    const nowMin = now.getHours() * 60 + now.getMinutes()
    if (startMin <= endMin) {
      if (nowMin >= startMin && nowMin < endMin) return w
    } else {
      // overnight (e.g. 22:30 → 06:30)
      if (nowMin >= startMin || nowMin < endMin) return w
    }
  }
  return null
}

/** Compute the end Date for `--until`, given the active window. */
export function windowEndsAt(window: ScheduleWindow, now: Date): Date {
  const { h, m } = parseHHMM(window.end)
  const end = new Date(now)
  end.setHours(h, m, 0, 0)
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1)
  return end
}

/** Compute the next window start (for `ucl schedule list` / `ucl status`). */
export function nextWindowStart(cfg: Config, now: Date): Date | null {
  // ...iterate days/windows to find next; returns null if schedule empty
}
```

- [ ] **Step 2: Write `src/orchestrator/lifecycle.ts` — port v1's lockfile + signal helpers verbatim (adjust paths to use Layout). Add `findResumableTasks`, `suspendForShutdown`, `wasOrphaned` per behavior above.**

- [ ] **Step 3: Tests for schedule.ts:**
  - `activeWindow` with regular daytime window
  - `activeWindow` with overnight window (22:30-06:30) at 23:00, 03:00, 07:00, 21:00
  - `windowEndsAt` rolls to next day correctly
  - `nextWindowStart` returns earliest upcoming

- [ ] **Step 4: Tests for lifecycle.ts:**
  - lockfile acquire / release / stale-overwrite
  - `findResumableTasks` returns paused tasks in FIFO by `last_updated`
  - `findResumableTasks` excludes `weekly-limit` reasons when weekly gate is active
  - `wasOrphaned` true when state=`running` but no zellij session

- [ ] **Step 5: `bun test tests/lifecycle.test.ts tests/schedule.test.ts` — green**

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/lifecycle.ts src/schedule.ts tests/lifecycle.test.ts tests/schedule.test.ts
git commit -m "feat(p4): lifecycle (window boundary, resume queue, orphan detection)"
```

---

### Task T14: Orchestrator main loop

**Files (create):**
- `src/orchestrator/main.ts`
- `tests/orchestrator.test.ts`

**Behavior:**
1. Acquire lock, install signal handlers (SIGTERM → graceful pause).
2. Preflight: clear-expired-weekly + orphan-recovery.
3. Create zellij session `unattended-claude`.
4. Build queue: paused tasks (FIFO) + planned tasks (FIFO by task ID).
5. Group by workdir lane; obey `max_parallel_tabs` cap; honor `serial: true`.
6. For each lane: run tasks sequentially. For each task: run episodes until DONE/FAILED/PAUSED.
7. Wind-down: orchestrator monitors clock; at `windowEndsAt - windDownLeadMinutes`, signals episode loops to inject wind-down. At `windowEndsAt`, graceful pause (closeTab on all in-flight).
8. On shutdown signal: same as window end — graceful pause all, set paused_reason based on signal type.
9. Cleanup: killSession, release lock, write final events.

**Acceptance:** E2E with MockRuntime simulates a full run with mixed completed/paused/rate-limited outcomes; state transitions correctly recorded in events.jsonl + task state files.

- [ ] **Step 1: Write `src/orchestrator/main.ts` (~250 lines). Use MockRuntime in test mode to keep tests deterministic.**

- [ ] **Step 2: Write `tests/orchestrator.test.ts`:**
  - Empty queue → exits immediately, writes `run_start` + `run_end`
  - Single task completes normally → state=`done`, events emitted
  - Task hits rate-limit-5h with reset < windowEndsAt → sleeps to reset, resumes, completes
  - Task hits rate-limit-5h with reset > windowEndsAt → graceful pause
  - Task hits weekly-limit → all tasks paused, weekly gate tripped, run_end with reason
  - Task hits context-full → HANDOFF compaction triggered, new session id, continues
  - SIGTERM during run → graceful pause all in-flight, lock released
  - Window end at `--until` → wind-down injected at T-leadMin, graceful pause at T
  - Concurrency cap: 5 tasks in 5 different workdirs with cap=3 → 3 run parallel, 2 queue with `queued_due_to_concurrency_cap` event

- [ ] **Step 3: `bun test tests/orchestrator.test.ts` — all green**

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/main.ts tests/orchestrator.test.ts
git commit -m "feat(p4): orchestrator main loop with window enforcement and auto-resume"
```

---

# Phase 5 — Commands (mostly parallel)

### Task T15: init / status / attach (simple commands, 1 agent)

**Files (create):**
- `src/commands/init.ts`
- `src/commands/status.ts`
- `src/commands/attach.ts`
- `tests/commands.test.ts` (shared, also used by T16/T17/T19/T20)

**Behavior:**
- `init`: idempotent — creates `~/unattended/{tasks,workdirs,archive,state/{tasks,handoffs},logs}/`, creates `~/.config/unattended-claude/cc.yaml` from template (asks before overwrite if exists), preflight-checks claude/happy/zellij CLIs (warn but don't fail), prints next-step hint.
- `status`: Reads task state dir + events.jsonl; prints queue snapshot per DESIGN §十二.
- `attach`: If zellij session `unattended-claude` alive → `zellij attach`. If not → "目前無 worker;啟動用 `ucl run`".

**Acceptance:** Each command has at least 2 unit tests.

- [ ] **Step 1: Write `src/commands/init.ts` (~80 lines). Reuse `<v1>/src/commands/init.ts` `installConfig` pattern.**

- [ ] **Step 2: Write `src/commands/status.ts` (~60 lines).**

- [ ] **Step 3: Write `src/commands/attach.ts` (~30 lines, mostly shells out to `zellij attach`).**

- [ ] **Step 4: Tests:**
  - `init` in empty dir creates expected structure
  - `init` is idempotent (second run doesn't break)
  - `status` with empty state prints `(no tasks)`
  - `status` with mixed task states prints correct counts

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts src/commands/status.ts src/commands/attach.ts tests/commands.test.ts
git commit -m "feat(p5): init / status / attach commands"
```

---

### Task T16: run / stop commands

**Files (create):**
- `src/commands/run.ts`
- `src/commands/stop.ts`

**Behavior:**
- `run [--until HH:MM] [--force]`: Preflight — check weekly-paused, check no other worker. Compute `--until` from arg or active schedule window. Launches `orchestrator/main.ts` (in foreground by default; `--detach` runs background via `setsid`).
- `stop [--now]`: SIGTERM the orchestrator (read PID from lockfile). `--now` sends SIGKILL fallback after 2s.

**Acceptance:** preflight behaviors tested; signal dispatch tested with mock process.

- [ ] **Step 1: Write `src/commands/run.ts`. Reference `<v1>/src/commands/run.ts` for the setsid pattern.**

- [ ] **Step 2: Write `src/commands/stop.ts`. Reference `<v1>/src/index.ts` `cmdStop` for SIGTERM-then-kill pattern.**

- [ ] **Step 3: Tests:**
  - `run` preflight refuses if weekly-paused-until.txt exists and not expired
  - `run` preflight refuses if lockfile alive (and not `--force`)
  - `run --until 06:30` passes correct end time to orchestrator
  - `run` without `--until` derives from active schedule window
  - `stop` sends SIGTERM to PID from lockfile
  - `stop --now` follows SIGTERM with SIGKILL after 2s

- [ ] **Step 4: Commit**

```bash
git add src/commands/run.ts src/commands/stop.ts tests/commands.test.ts
git commit -m "feat(p5): run + stop with preflight and signal handling"
```

---

### Task T17: schedule (launchd plist generator)

**Files (create):**
- `src/commands/schedule.ts`
- `tests/schedule-cmd.test.ts`

**Behavior:**
- `schedule list` — prints windows from config.
- `schedule install` — writes one `.plist` per window to `~/Library/LaunchAgents/dev.unattended-claude.<window-name>.plist`; runs `launchctl load <plist>` for each.
- `schedule uninstall` — `launchctl unload` + remove plists.
- `schedule add` / `remove` — modifies the YAML config (rewrite preserving formatting) + re-runs install/uninstall.

**Acceptance:** Plist text generation tested; actual launchctl shell-out smoke-tested but not asserted on (depends on host).

- [ ] **Step 1: Write `generatePlist(window, exe): string`:**

```typescript
export function generatePlist(window: ScheduleWindow, exePath: string, runtimeDir: string): string {
  const { h, m } = parseHHMM(window.start)
  // launchd StartCalendarInterval array: one entry per active day
  // ...
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.unattended-claude.window-${window.start}-${window.end}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exePath}</string>
    <string>run</string>
    <string>--until</string><string>${window.end}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>${/* entries per day */ ""}</array>
  <key>StandardOutPath</key><string>${runtimeDir}/logs/schedule.out.log</string>
  <key>StandardErrorPath</key><string>${runtimeDir}/logs/schedule.err.log</string>
</dict>
</plist>`
}
```

- [ ] **Step 2: Write `src/commands/schedule.ts` with sub-commands `list`, `install`, `uninstall`.**

- [ ] **Step 3: Tests:**
  - `generatePlist(window, exe, runtimeDir)` produces valid plist (parseable by `plutil -lint`?)
  - Plist contains all `days` as `StartCalendarInterval` entries with correct Weekday + Hour + Minute
  - `parseHHMM` agreement with `src/schedule.ts`

- [ ] **Step 4: Commit**

```bash
git add src/commands/schedule.ts tests/schedule-cmd.test.ts
git commit -m "feat(p5): schedule install/uninstall via launchd plist"
```

---

### Task T18: plan / review (skill-driven interactive)

**Files (create):**
- `src/commands/plan.ts`
- `src/commands/review.ts`

**Behavior:**
- `plan` — preflight check no `running` task; spawn foreground `happy` (or `claude`) in `<v2>/` cwd so `.claude/skills/task-brief/` auto-loads. Initial prompt: "Run the task-brief skill. todo.md: `<paste todo.md content>`. Existing task IDs: `<list>`. Workdir for auto-assigned: `~/unattended/workdirs/<id>/`."  Wait for claude to exit; user has done plan interactively.
- `review` — same pattern but loads `task-review` skill. Default context: events.jsonl since most recent `run_start`. With `<id>`: non-interactive — print `tasks/<id>.md` SUMMARY section. With `--synthesize --since=24h`: AI session that writes `~/unattended/reviews/<timestamp>.md`.

**Acceptance:** preflight tested; the skill-spawn path is integration-tested via shelling out (skipped in CI by default).

- [ ] **Step 1: Write `src/commands/plan.ts`. Reference `<v1>/src/commands/plan.ts` for interactive-session launch pattern.**

- [ ] **Step 2: Write `src/commands/review.ts` with three modes (no-args / `<id>` / `--synthesize`).**

- [ ] **Step 3: Tests:**
  - `plan` preflight refuses when `running` task exists
  - `plan --force` skips preflight
  - `review <id>` reads `tasks/<id>.md`, prints content between `## Summary` heading and end (or "(no SUMMARY yet)")

- [ ] **Step 4: Commit**

```bash
git add src/commands/plan.ts src/commands/review.ts
git commit -m "feat(p5): plan + review interactive commands"
```

---

### Task T19: stats command

**Files (create):**
- `src/commands/stats.ts`
- `tests/stats.test.ts`

**Behavior:** Read events.jsonl + claude jsonl files to compute:
- Per-day: task completion count, failures, total tokens (sum from claude jsonl `~/.claude/projects/.../<uuid>.jsonl` files referenced by claude_session_id in each task state)
- 5h-windows hit rate (count of `rate_limit` events per day)
- Subscription utilization estimate (sum tokens / Claude Max approx limit — use 100K/day as placeholder if unknown)

**Acceptance:** With known events.jsonl + sample jsonl fixtures, output matches expected table.

- [ ] **Step 1: Write helper to parse claude jsonl and sum token counts. Each line has `usage: { input_tokens: N, output_tokens: N, ... }`. Sum input+output per task.**

- [ ] **Step 2: Write aggregator that groups events by day, counts completions/failures, joins token totals.**

- [ ] **Step 3: Write text-table renderer per DESIGN §十二 stats example.**

- [ ] **Step 4: Tests:**
  - Fixture with 3 days of events → correct row counts
  - jsonl with known token usage → correct sum
  - rate_limit events counted correctly

- [ ] **Step 5: Commit**

```bash
git add src/commands/stats.ts tests/stats.test.ts
git commit -m "feat(p5): stats command — jsonl token accounting + daily aggregation"
```

---

### Task T20: archive / todo commands

**Files (create):**
- `src/commands/archive.ts`
- `src/commands/todo.ts`
- `tests/archive.test.ts`
- `tests/todo.test.ts`

**Behavior:**
- `archive <id>` — moves `tasks/<id>.md` + `state/tasks/<id>.json` + `state/handoffs/<id>.md` + `workdirs/<id>/` (if exists) into `archive/<id>/{task.md, state.json, handoff.md, workdir/}`. Appends `archive_moved` event.
- `archive --done-before=Nd [--dry-run]` — finds tasks with state=`done` or `failed` and `last_updated < now - N days`. With `--dry-run`, prints what would move. Without, moves them.
- `unarchive <id>` — reverse of `archive`.
- `todo --consolidate` — read `todo.md`, group `[x]` lines by date (extract from referenced task ID), move them to bottom under `## ── 已 plan 線 ──` heading.

**Acceptance:** All file-move operations tested via tmp dirs; idempotency tested (re-archiving same task is a no-op).

- [ ] **Step 1: Write `src/commands/archive.ts`. Helper `moveTaskToArchive(id, layout)`.**

- [ ] **Step 2: Write `src/commands/todo.ts` with `consolidate` sub-command.**

- [ ] **Step 3: Tests for each behavior.**

- [ ] **Step 4: Commit**

```bash
git add src/commands/archive.ts src/commands/todo.ts tests/archive.test.ts tests/todo.test.ts
git commit -m "feat(p5): archive + todo consolidate commands"
```

---

### Task T21: CLI dispatcher (final wiring)

**Files (modify):**
- `src/index.ts` — replace placeholder with full dispatcher

**Behavior:** Mirror `<v1>/src/index.ts` structure. Subcommands: init, plan, run, stop, schedule, status, stats, review, archive, unarchive, todo, attach. Global flags: `--config`, `--version`, `--help`. Per-command `--help` text.

**Acceptance:** `ucl --help` lists all commands; each `ucl <cmd> --help` shows command-specific help; running unknown command exits 1.

- [ ] **Step 1: Write full dispatcher. Reference `<v1>/src/index.ts`.**

- [ ] **Step 2: Per-command help text strings (one per command).**

- [ ] **Step 3: Test:** Spawn `bun src/index.ts --help` and `bun src/index.ts unknown-cmd` and verify expected output / exit codes.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(p5): full CLI dispatcher wiring"
```

---

# Phase 6 — Skills + E2E

### Task T22: Skills (task-brief, task-review)

**Files (create):**
- `.claude/skills/task-brief/SKILL.md`
- `.claude/skills/task-review/SKILL.md`

**Reference:** `<v1>/.claude/skills/bedtime-brief/SKILL.md` and `<v1>/.claude/skills/morning-review/SKILL.md`.

**Edits:**
- Drop all "overnight" / "bedtime" / "morning" wording → "unattended window" / "before run" / "after run"
- task-brief: input is rolling todo.md (not per-batch); output is `tasks/YYYY-MM-DD-NN-slug.md`; checkbox-mark the planned entries in todo.md
- task-review: input is events.jsonl filtered by `--since`; output is interactive discussion + optional `--synthesize` report file

**Acceptance:** Skills load when `ucl plan` / `ucl review` spawn claude in the v2 repo cwd (verified manually).

- [ ] **Step 1: Copy v1 skills, do the rename + content adjustments.**

- [ ] **Step 2: Manual verification:** `cd <v2>/ && claude --resume <non-existent>` — see if skill names appear in claude's skill list.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/
git commit -m "feat(p6): task-brief + task-review skills"
```

---

### Task T23: E2E milestone test

**Files (create):**
- `tests/e2e.test.ts`
- `tests/fixtures/milestone-task.md`

**Behavior:** Implements DESIGN §十五 milestone. Uses MockRuntime (not real claude) — verifies orchestrator behavior end-to-end through paused→resumed flow, but does NOT exercise actual happy/claude binary.

**Scenarios within the test:**
1. `ucl init` (programmatic equivalent) creates dirs
2. Plan a fixture task with `workdir: auto`
3. Orchestrator starts with `--until +5m` (mocked clock, advances rapidly)
4. MockRuntime simulates: 3min of work → wind-down injected → graceful pause
5. State written: paused, paused_reason=schedule-boundary, claude_session_id captured
6. Orchestrator starts again with `--until +5m`
7. MockRuntime sees `opts.resume === true`, completes immediately
8. State written: done
9. `ucl review <id>` returns SUMMARY
10. `ucl stats` returns 2 episodes, token counts (from jsonl mock)
11. Time-skip 7 days, `ucl archive --done-before=7d` moves task to archive/

**Acceptance:** Test runs end-to-end in < 5 seconds via SimClock; all assertions pass.

- [ ] **Step 1: Write fixture task `tests/fixtures/milestone-task.md` (frontmatter with `serial: false`, no explicit workdir).**

- [ ] **Step 2: Write `tests/e2e.test.ts` driving all 11 scenarios.**

- [ ] **Step 3: `bun test tests/e2e.test.ts` — green**

- [ ] **Step 4: Commit**

```bash
git add tests/e2e.test.ts tests/fixtures/milestone-task.md
git commit -m "test(p6): e2e milestone — paused→resume→done→archive"
```

---

### Task T24: QUICK-DEMO.md (manual follow-along guide)

**Files (create):**
- `<v2>/QUICK-DEMO.md`

**Audience:** The user (project owner) — for hand-walking through every command after T01-T23 ship. Can mix Chinese / English; this is a personal doc, not user-facing product copy.

**Content (sections):**

1. **Prereqs check** — `which claude && which happy && which zellij && which bun`
2. **First-time setup** — `ucl init` → expected output → verify `~/unattended/` + `~/.config/unattended-claude/cc.yaml`
3. **Add a todo + plan** — append a line to `~/unattended/todo.md`, run `ucl plan`, walk through interactive task-brief skill
4. **Manual run** — `ucl run --until +5m`, observe zellij session created, attach with `ucl attach`, detach with `Ctrl-o d`
5. **Test paused → resumed cross-window** — wait for window end, verify task state shows `paused-schedule-boundary`, run `ucl run --until +5m` again, verify `--resume` happens, task completes
6. **Test stop** — start `ucl run`, then `ucl stop` from another terminal, verify graceful pause
7. **Test stop --now** — start, then `ucl stop --now`, verify hard kill + `paused-orphan` on next run
8. **Schedule install/uninstall** — `ucl schedule install`, check `~/Library/LaunchAgents/`, then `uninstall`
9. **Stats / status / review** — after running a few tasks: `ucl status`, `ucl stats`, `ucl review <id>`, `ucl review --synthesize --since=24h`
10. **Archive** — `ucl archive <id>`, verify `archive/<id>/{task.md, state.json, workdir/}` bundle structure
11. **todo consolidate** — after several `[x]` accumulate: `ucl todo --consolidate`, verify journal section
12. **Limit smoke-tests (optional, requires hitting limits)** — note that 5h / weekly / context limits can only be tested by burning real quota; consult `tests/e2e.test.ts` for MockRuntime-based simulation as the safer verification

**Format:** Each step has: command + expected output + verification check + troubleshooting note for common failures.

- [ ] **Step 1: Write `<v2>/QUICK-DEMO.md` with 12 sections above, each runnable in ≤ 5 min.**

- [ ] **Step 2: Walk through the doc manually (you, after agents finish T23) to verify every step works as written.**

- [ ] **Step 3: Commit**

```bash
git add QUICK-DEMO.md
git commit -m "docs(p6): QUICK-DEMO.md — manual follow-along guide"
```

---

# Self-Review Checklist (run before declaring plan complete)

- [x] Every DESIGN.md section covered by at least one task (DESIGN §一-十七 mapped)
- [x] No `TODO` / `TBD` / `add error handling` placeholders
- [x] Type names consistent across tasks (TaskState, PausedReason, Event, etc.)
- [x] Each task has explicit Files + Reference + Acceptance + Steps
- [x] Test code shown where it's load-bearing (new logic); skipped where porting verbatim
- [x] Each commit is buildable + testable
- [x] No "improvements" / refactors snuck in
- [x] 2-week timeline fits: P0+P1 = day 1-2, P2+P3 = day 3-5, P4 = day 6-9, P5 = day 10-12, P6 = day 13-14

---

## Open decisions left for the user (LAST CHANCE)

The user said this is the last opportunity for course corrections. Concrete items I want explicit OK on before dispatching agents:

1. **Plan doc location** — saved to `<v2>/docs/superpowers/plans/2026-05-23-v2-implementation.md`. OK or move?
2. **Git init** — should the new repo `<v2>/` be its own git repo (`git init` in T01), or do you want it tracked by an existing parent repo? Current parent `Workshop/unattended-claude/` is the workshop dir (not a git repo from what I can see).
3. **Bun version pinning** — `package.json` doesn't pin Bun. Add `"engines": { "bun": ">=1.2.19" }`?
4. **`runtime.bin` default** — currently `happy`. Confirm: stick with `happy` (the wrapper) so Happy mobile app keeps working.
5. **`schedule.windows` default in template** — empty (user opts in) or pre-populated with nightly 22:30-06:30? I lean empty to avoid surprise; user adds via `ucl schedule add`.
6. **Test isolation** — each test gets a fresh `tmp` runtime dir? Or shared `tests/fixtures/runtime/` that's gitignored? I lean fresh-tmp.
7. **Logging during tests** — MemoryLogger by default so test output stays clean?
8. **Wake-up prompt language** — Chinese (matches DESIGN), English, or bilingual? I lean Chinese (your default language for this project).
9. **HANDOFF.md prompt language** — same as above.
10. **`ucl schedule add` syntax** — `ucl schedule add "22:30-06:30" --days mon..fri` or simpler `ucl schedule add 22:30-06:30`? I lean the longer form for clarity.

After your confirmation/edits on these 10 items, I dispatch the agents.
