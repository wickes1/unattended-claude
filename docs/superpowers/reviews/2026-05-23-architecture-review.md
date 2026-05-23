# unattended-claude v2 — Architecture Review

Reviewer: T25 (post-implementation architecture pass)
Skill applied: `superpowers:improve-codebase-architecture`
Lens: depth vs shallowness, seams, locality, deletion test, AI-navigability.

## Executive summary

v2 ships clean: 325 passing tests, typecheck green, 26 source files in tight layers (cross-cutting → orchestrator → runtime → commands). The slice-by-slice plan held — most modules read well in isolation, and the SimClock + MockRuntime + ZellijOps seams genuinely let the orchestrator and detection loops be exercised without spawning anything real. The biggest weakness is **drift between DESIGN.md and the code**: a handful of design promises (HANDOFF.md flow, auto-archive, `usage_snapshot` events, `schedule add/remove`, `safety_margin`, `cooldown`, `max_consecutive_errors`, jsonl-size context compaction, `user-stop-now` write path, the proactive `context_compact_threshold` knob) are declared but never reach an emit/read site. Several other smells are localized (no-op ternary, duplicated `findRepoDir`, leaked temp dirs, scope label "cc-nightshift", `findOrphans` accepting a dead parameter, `pollUntilDone` mixing wall-clock and injected clock). Nothing in here is fatal — the runtime works against the milestone scenario — but the surface area accepts more config knobs than it honors, which will mislead operators in v2.1.

## Codebase shape

| metric | value |
|---|---|
| `src/` files | 26 (.ts) |
| `src/` LOC | 4,318 |
| `tests/` files | 26 (.ts) |
| `tests/` LOC | 4,998 |
| Test:src LOC ratio | 1.16 |
| Tests / typecheck | 325 pass / 0 fail / `tsc --noEmit` clean |
| Commits on `main` | 25 (P0 bootstrap → P6 e2e + skills) |

**Strengths**
- Layered structure is honest: `types → config/layout/clock/logger/events/fs-utils → orchestrator/* → runtime/* → commands/* → index.ts`. Imports respect that order.
- `Runtime` interface (`src/types.ts:31`) genuinely has two adapters: `InteractiveZellijRuntime` and `MockRuntime`. **Two adapters = real seam** — this is one of the few places where an abstraction earns its keep.
- `ZellijOps` (`src/runtime/claude-session.ts:57`) similarly has two implementations (`realZellijOps`, `fakeZellij` in tests). Lets the detection loop be unit-tested with scripted pane text.
- `Clock` seam (`src/clock.ts:4`, `:19`) — `SimClock.sleep` advances virtual time, so orchestrator tests run a full overnight in ms.
- `TaskStateStore.update` (`src/orchestrator/state-store.ts:33`) implements a per-id async mutex chain. Concurrent updates to the same task ID serialize; different IDs run in parallel. Genuinely deep — the interface is `update(id, fn)` and the implementation hides per-id serialization, rejection isolation, and atomic write.
- Events log (`events.ts`) is small (38 LOC) and idempotent-friendly — append-only, with crash-safe trailing-line skip on read.

## Critical findings (must address before production use)

### P0-1 — `runtime.bin: happy` template ships a known-broken default

- **Evidence:** `config/cc.yaml:9` (`bin: happy`) vs the spike note in `src/runtime/claude-session.ts:91-95`: *"`happy --session-id <uuid>` does NOT honor the provided uuid... For v2, set `cfg.runtime.bin = "claude"` so resume semantics are correct."*
- **Impact:** The whole `--session-id` / `--resume` cross-window-continuity story (DESIGN §七, the entire reason v2 exists over v1) silently breaks on a fresh install. Resume episodes start fresh-empty conversations instead of replaying history.
- **Recommendation:** Change `config/cc.yaml` default to `bin: claude`. Either keep `extra_args: [--dangerously-skip-permissions]` or move to a CLI that supports it natively. Effort: **S**.

### P0-2 — `context_full` path does not generate or read HANDOFF.md

- **Evidence:**
  - `src/orchestrator/episode.ts:164-183` regenerates `claude_session_id` and bumps `context_compactions`, but never injects a "write HANDOFF.md" prompt before the session ends.
  - `src/commands/run.ts:127` `buildWakeUpPrompt` returns `null` for `context-full` with comment "handled separately by orchestrator" — but the orchestrator does not handle it. The resume episode just pastes `Continue from where you left off in the previous episode.` against a brand-new empty session.
- **Impact:** DESIGN §七 ("HANDOFF.md retreat path") is fully unimplemented. Long-running tasks that hit the 200K context window will silently lose context across the boundary. The user will see `context_compactions: 1` in state and assume the recovery worked.
- **Recommendation:** Before returning `context_full` from `pollUntilDone`, inject the HANDOFF prompt and wait for `state/handoffs/<id>.md` to appear. On resume after `context-full`, the first prompt should be `cat <handoff-path>` instead of "continue". Effort: **M**.

### P0-3 — `pollUntilDone` mixes wall-clock and injected clock

- **Evidence:** `src/runtime/claude-session.ts:117,156,165,207,212,231,238` use `Date.now()` for the dialog deadline, episode start, hard timeout, inactivity timer; the same function takes a `clock: Clock` parameter that is only consulted for `weekly_limit` / `rate_limit` reset comparisons and the wind-down boundary.
- **Impact:**
  - SimClock cannot fast-forward `pollUntilDone` — tests that need to assert hard-timeout or inactivity behavior must actually sleep. (None do today; the failure mode is "unable to write that test ergonomically".)
  - If production ever uses `SimClock` (e.g. for replaying a recorded run), behavior diverges silently.
  - Violates the v2 12-rule discipline ("Rule 7 — surface conflicts, don't average them" — the two patterns are blended).
- **Recommendation:** Replace `Date.now()` with `clock.now().getTime()` inside `pollUntilDone` and `handleDialogs`. Keep the raw-`setTimeout` `sleep` for the dialog poll only if the design wants real-time dialog UX. Effort: **S**.

## Important findings (address in v2.1)

### P1-1 — Four config knobs are parsed but never read

- **Evidence:** `src/config.ts:25,28,29,116`. Greps confirm `episodeHardTimeoutMs`, `cooldownMs`, `maxConsecutiveErrors`, `safetyMarginMs` are referenced only by `src/config.ts` (declaration + parsing) and `tests/helpers.ts` (default builder). No production code consumes them.
- **Impact:** Operators reading `config/cc.yaml` will assume these knobs do something. `execution.episode_hard_timeout: 60m` looks like the knob to lower for fast iteration; it's not — the timeout is hardcoded in `src/orchestrator/episode.ts:61`. Same story for `cooldown` and `max_consecutive_errors`.
- **Recommendation:** Either wire them (cooldown between episode invocations, max consecutive errors → abort lane, safety margin → bump rate-limit `resumeAt`, episode hard timeout → override the hardcoded 60min) **or** delete them from `config.ts` and the template. Suggested split: wire `episodeHardTimeoutMs` and `safetyMarginMs` (load-bearing); delete `cooldownMs` and `maxConsecutiveErrors` as YAGNI. Effort: **S** to wire two, **S** to delete.

### P1-2 — DESIGN ↔ code drift on event schema and stats source

- **Evidence:**
  - `src/types.ts:81` declares event `wind_down_injected` — no `appendEvent` call writes it. `src/runtime/claude-session.ts:200` only logs at info level.
  - `src/types.ts:83` declares `usage_snapshot` — no writer. DESIGN §十二 says "data source is events.jsonl `usage_snapshot` events".
  - `src/commands/stats.ts:124-130` instead reads `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` directly — works, but the design's "events.jsonl as SoT" story doesn't hold.
- **Impact:** Downstream tooling that wants to chart wind-down frequency or token usage from the events log will return empty. Also blocks any post-hoc audit of "did the wind-down prompt fire on time".
- **Recommendation:** Emit `wind_down_injected` and `usage_snapshot` events from the runtime / episode loop, and rebase `cmdStats` on events.jsonl with `claude jsonl` as backfill only. Effort: **S** for emission; **M** for stats rebase.

### P1-3 — `paused_reason: "user-stop-now"` is unreachable

- **Evidence:**
  - `src/types.ts:44` declares the variant.
  - `src/commands/run.ts:131` builds a wake-up prompt for it.
  - `src/commands/stop.ts:10` documents it.
  - But `src/orchestrator/lifecycle.ts:69` always writes `"user-stop"` on SIGTERM, and `cmdStop --now` SIGKILLs — SIGKILL cannot be caught, so no handler runs, so nothing writes `"user-stop-now"`. The only way the state file gets this reason is if something else writes it — and nothing does.
  - On reboot/process-death after SIGKILL, the next `ucl run` preflight marks the orphan as `"orphan"` (`src/orchestrator/main.ts:128`), not `"user-stop-now"`.
- **Impact:** Cosmetic correctness: a documented reason that the runtime cannot produce. Mild confusion for whoever reads `state/tasks/<id>.json` expecting it.
- **Recommendation:** Either (a) drop `"user-stop-now"` from `PausedReason` and merge its wake-up prompt into `"orphan"`, or (b) have `cmdStop --now` write the reason to disk **before** SIGKILL (race-prone but cheap). Recommend (a). Effort: **S**.

### P1-4 — `findOrphans(store, liveTabNames)` accepts a parameter that production always sets to `new Set()`

- **Evidence:** `src/orchestrator/lifecycle.ts:106` signature accepts `liveTabNames: Set<string>`. The only production call site (`src/orchestrator/main.ts:125`) passes `new Set()`. The comment justifies it (no zellij tabs exist before this run starts), but the signature pretends a runtime-introspection capability that isn't there.
- **Impact:** Shallow seam — the parameter exists "for testability" but every production call is the same. Misleading for anyone reading the signature.
- **Recommendation:** Either drop the parameter (`findOrphans(store)`), or wire it for mid-run orphan detection (where a tab dies but the state file still says "running"). Today the orchestrator does not re-check during a run. Drop the parameter unless mid-run detection is added. Effort: **S**.

### P1-5 — Per-episode temp directories leaked

- **Evidence:** `src/commands/run.ts:104` `mkdtempSync(join(tmpdir(), "ucl-prompt-"))` creates a fresh dir per episode. No `rmSync` ever fires. A long-running window with 30 episodes leaks 30 dirs.
- **Impact:** Minor disk leak; macOS `/tmp` gets cleaned on reboot, so practical impact is small. Annoying when debugging.
- **Recommendation:** Reuse a single `<runtime>/state/prompts/` dir (under `Layout`), or `rmSync` after the orchestrator returns. Effort: **S**.

### P1-6 — `findRepoDir` and zellij-env spread duplicated across commands

- **Evidence:**
  - `src/commands/plan.ts:38` and `src/commands/review.ts:115` define identical `findRepoDir()` helpers (walks up looking for `.claude/skills`). Two adapters = real seam, but here they're literal duplicates with no diverging needs.
  - The `{ ...process.env, ZELLIJ_SOCKET_DIR: ... }` spread appears in `plan.ts:81`, `review.ts:103`, `attach.ts:9` — three copies of the same defensive env reconstruction. Also exists inside `zellij.ts:14` as `ZELLIJ_ENV`.
- **Impact:** Future drift risk. If the zellij socket path strategy changes, four sites must update in lockstep.
- **Recommendation:** Hoist `findRepoDir()` to a shared module (e.g. `src/commands/_shared.ts` or `src/runtime/zellij.ts`). Export `ZELLIJ_ENV` from `zellij.ts` and reuse. Effort: **S**.

### P1-7 — `archive.autoAfterDays` doesn't auto-archive

- **Evidence:** `src/config.ts:121` parses the knob; no scheduler or hook in `src/` calls `archiveOne` or `findArchiveCandidates` automatically. DESIGN §三 says "7天後 done/failed 自動搬 archive/" — implementation only acts on explicit `ucl archive --done-before 7d`.
- **Impact:** Operator surprise. The default config implies hygiene happens for free; it doesn't.
- **Recommendation:** Either (a) call `findArchiveCandidates(layout, cfg.archive.autoAfterDays, now)` + `archiveOne` once at the end of each `ucl run` (or `ucl status`), or (b) document the manual workflow explicitly and drop `archive.auto_after_days` from the template. Recommend (a). Effort: **S**.

### P1-8 — `--until` argument format inconsistency

- **Evidence:** `src/commands/run.ts:33` accepts only `HH:MM`. DESIGN §六/§十五 examples use `--until +5m` shorthand. `tests/commands-run.test.ts` only covers HH:MM.
- **Impact:** The end-to-end milestone demonstration (`ucl run --until +5m`) won't work as documented.
- **Recommendation:** Extend `parseRunArgs` to accept `+Ns / +Nm / +Nh` relative-time form (reuse `parseDuration` from `config.ts`). Effort: **S**.

### P1-9 — `runtime.bin` config not honored in `runSmokeTest` is consistent but template-broken (see P0-1)

Tracked under P0-1.

### P1-10 — `schedule add/remove` documented but not implemented

- **Evidence:** DESIGN §四 lists `ucl schedule add/list/remove/install/uninstall`. `src/commands/schedule.ts:107` only dispatches `list/install/uninstall`. To add a window the user must edit YAML by hand.
- **Impact:** Doc-vs-reality drift; quick-demo will hit "Unknown subcommand: add".
- **Recommendation:** Either implement `add <HH:MM-HH:MM> [days]` and `remove <label>` mutating cc.yaml in place (atomic write), or remove from DESIGN §四. Implementing is small but invites YAML-mutation bugs; recommend dropping for v2 and updating DESIGN. Effort: **S** either direction.

## Minor findings (backlog candidates)

### P2-1 — No-op ternary in dispatcher

- **Evidence:** `src/index.ts:140` `return r.reason === "queue_empty" ? 0 : 0` — both branches return 0.
- **Recommendation:** `return 0`. Effort: **S** (one line).

### P2-2 — Logger `scope: "cc-nightshift"` and test fixture `cc-nightshift-x` strings remnant from v1

- **Evidence:** `src/logger.ts:9` `scope: "cc-nightshift"`. `tests/zellij.test.ts:53-57` test fixtures use `cc-nightshift-x`.
- **Recommendation:** Rename scope to `"unattended-claude"` (or `"ucl"`). Update test fixtures. Effort: **S**.

### P2-3 — `mock-runtime.ts` ships in `src/` but is test-only

- **Evidence:** No production import path reaches `MockRuntime`; only tests reference it (`tests/orchestrator.test.ts`, `tests/e2e.test.ts`, `tests/mock-runtime.test.ts`).
- **Recommendation:** Move to `tests/fixtures/mock-runtime.ts`. Keeps prod bundle clean. Effort: **S**.

### P2-4 — `cfg.logging` parsed but unused

- **Evidence:** `src/config.ts:131-134`; greps show no consumer.
- **Recommendation:** Wire `ConsoleLogger` to filter by `cfg.logging.level`, OR drop the knob. Effort: **S**.

### P2-5 — Untested modules

- `src/clock.ts` — trivial, but no test asserts `RealClock.sleep` or `SimClock.advance` semantics.
- `src/fs-utils.ts` — `atomicWrite` has no direct test (covered transitively by state-store / archive tests).
- `src/logger.ts` — `MemoryLogger.has` covered transitively only.
- `src/commands/attach.ts` — fully untested (uses subprocess spawn; mockable).
- `src/runtime/zellij.ts` Layer A (newSession, newTab, sendKeys, capture, closeTab, pipePane) — depend on a real `zellij` binary; only the pure parsers are unit tested. Documented as deferred but never picked up.
- **Recommendation:** Add a single test per trivial module (clock, fs-utils, logger). Build an integration test harness that spawns a real zellij in CI (or skip-by-env-var) for Layer A. Effort: **S** for trivia, **M** for the zellij integration harness.

### P2-6 — `TaskStateStore.update` and `lifecycle.suspendForShutdown` bypass the injected clock

- **Evidence:** `src/orchestrator/state-store.ts:39,50`, `src/orchestrator/lifecycle.ts:72` — all use `new Date()` directly. The `EpisodeCtx` already carries a `clock`; the store and lifecycle don't.
- **Impact:** State-file `last_updated` timestamps and `task_paused` event timestamps cannot be controlled by SimClock. Tests that assert exact timestamps must use the real clock.
- **Recommendation:** Thread `clock` into `TaskStateStore` and `suspendForShutdown`. Effort: **S**.

### P2-7 — Sentinel file is documented as "primary completion signal" but never written

- **Evidence:** `src/runtime/claude-session.ts:206` checks `opts.sentinelFile`. No prompt template / skill tells the AI to `touch <sentinelFile>`. In practice, "inactivity at input prompt" (the secondary signal) is doing all the work.
- **Recommendation:** Either inject sentinel-touch instructions into the prompt (and the skill SKILL.md), or stop calling it "primary" and rename to "fast-path early exit". Effort: **S**.

## Deepening opportunities

These are not bugs — they're places where the **deletion test** suggests rearranging would concentrate complexity instead of moving it.

### D-1 — Promote a `PromptBuilder` module

Today the runtime contract is "give me a `promptFile`". Two callers build it (`buildPromptFile`, `buildPlanInitialPrompt`, `buildReviewInitialPrompt`) and each has its own conventions. A small `PromptBuilder` module owning *all* prompt assembly (initial, resume, wake-up, wind-down, HANDOFF-resume) would:

- Collapse the duplicated tmp-dir creation (P1-5).
- Give a single seam to inject HANDOFF restoration (P0-2).
- Let prompt content be unit-tested as pure strings, not via file roundtrip.

Deletion test: if you delete the proposed module, the same logic reappears in `commands/run.ts`, `commands/plan.ts`, `commands/review.ts`, `orchestrator/episode.ts`. That's the "complexity reappears across N callers" signal — **deep**, worth promoting.

### D-2 — `findOrphans` + `findResumableTasks` + planned-task selection are all queries against `TaskStateStore`

`runOrchestrator` lines 124–168 is 45 lines of queue-shape decisions. Today it works, but as soon as auto-archive (P1-7) or per-window task selection (e.g. "only run tasks tagged X tonight") get added, this region will swell. Extracting a `RunQueueBuilder(store, weeklyGate, docs, clock) → TaskDoc[]` (interface = "give me an ordered queue") would:

- Make queue-shape decisions independently testable (today they're tested through `runOrchestrator`'s integration tests).
- Give a single seam to plug filtering policies.

Deletion test: removing `RunQueueBuilder` puts the same `paused-resumable + planned` interleaving logic back inline. Two future callers (auto-resume from a separate cron, manual `ucl run <id>` if ever added) would re-derive it. **Deep enough to extract.**

### D-3 — Treat `events.jsonl` writes as a single typed sink

Today, 11 sites scattered across `lifecycle.ts`, `episode.ts`, `main.ts`, `archive.ts` build `Event` objects inline with `appendEvent(layout, { ts: clock.now().toISOString(), event: "...", ... })`. That's fine, but:

- Timestamp source is inconsistent (some use `clock.now()`, some `new Date()` — see P2-6).
- The `task_paused` event is written in 3 places (`episode.ts:140,156`, `lifecycle.ts:71`, `main.ts:130`). Each repeats the structure.

A thin `Journal(layout, clock)` with typed methods (`journal.taskPaused(taskId, episode, reason)`) would lock in consistent timestamps and reduce the surface area for "I forgot to write the matching event when state transitions". **Worth exploring**, not strong — the duplication is shallow enough that today's pattern survives.

### D-4 — `pollUntilDone` has 7 detection priorities; the test surface is "pass a captureScript that returns one of N strings"

Today the detection-priority order is encoded by the position of each `if` in a 90-line function. Tests pass a `captureScript` that returns whatever text triggers the branch under test. As detectors accumulate (already 4: dialog, rate, weekly, context — sentinel + inactivity makes 6), this becomes harder to navigate. A table-driven approach (`const PRIORITIES: Detector[] = [...]; for (const d of PRIORITIES) if (d.matches(ctx)) return d.result(ctx)`) would:

- Make priority order explicit and reorderable.
- Let each detector be unit-tested with a tiny harness.
- Improve AI-navigability — a fresh reader doesn't have to scroll the function body to find what fires first.

**Worth exploring.** Don't do it pre-emptively; do it when the 7th detector arrives.

## Known gaps already flagged

The plan/owner-supplied list, with cross-references to evidence in this review:

- `happy --session-id` passthrough fails — `runtime.bin: claude` recommended → see **P0-1**.
- `schedule install` uses `process.argv[1]` (broken under `bun src/index.ts`) → `src/commands/schedule.ts:105`. When the CLI is launched as `bun src/index.ts run`, `process.argv[1]` is the absolute `src/index.ts` path, not a self-contained binary. plists generated will reference that path; if the repo moves, plists break.
- `consecutive_errors` `RunResult.reason` missing → no `"too_many_errors"` reason variant in `RunReason`; the orchestrator has no path that aborts a lane on consecutive errors (related to dead `maxConsecutiveErrors` knob — see **P1-1**).
- `--until` only `HH:MM` (not `+5m` shorthand) → see **P1-8**.
- `findRepoDir` duplicated in `plan.ts` and `review.ts` → see **P1-6**.

## Recommended follow-up tasks

Ordered by impact × cost. Each is independently shippable.

| # | Task | Effort | Why now |
|---|---|---|---|
| 1 | Change template `bin: claude`; update QUICK-DEMO + DESIGN | S | P0-1, unblocks resume |
| 2 | Implement HANDOFF.md write + read on `context-full` | M | P0-2, only real ship-blocker |
| 3 | Replace `Date.now()` in `pollUntilDone`/`handleDialogs` with `clock.now()` | S | P0-3, restores SimClock invariant |
| 4 | Wire `episodeHardTimeoutMs` + `safetyMarginMs`; delete `cooldownMs` + `maxConsecutiveErrors` from config | S | P1-1, stop misleading operators |
| 5 | Emit `wind_down_injected` + `usage_snapshot` events; rebase `cmdStats` on events.jsonl | M | P1-2, makes events.jsonl actually SoT |
| 6 | Drop `user-stop-now` variant; merge wake-up into `orphan` | S | P1-3, kill dead state |
| 7 | Simplify `findOrphans` signature; if mid-run detection wanted, wire properly | S | P1-4 |
| 8 | Hoist `findRepoDir`, share `ZELLIJ_ENV` | S | P1-6, ahead of next driver/cmd |
| 9 | Auto-archive at end of `ucl run` OR delete the knob | S | P1-7 |
| 10 | `--until +Nm` support | S | P1-8, matches DESIGN/demo |
| 11 | Drop `schedule add/remove` from DESIGN OR implement | S | P1-10 |
| 12 | Trivia: no-op ternary, scope label, mock-runtime move, cfg.logging wiring | S | P2-1..4 batch |
| 13 | Tests for clock, fs-utils, logger, attach; zellij Layer A integration harness | S+M | P2-5 |
| 14 | Thread `clock` through `TaskStateStore` + `suspendForShutdown` | S | P2-6 |
| 15 | Promote `PromptBuilder` module (D-1) | M | unblocks #2, lays seam for next driver |
| 16 | Extract `RunQueueBuilder` (D-2) when next queue-policy lands | M | only after a second policy appears |

**Recommended sequencing:** ship #1, #2, #3 as v2.0.1 (correctness). Bundle #4–#11 + #12 + #15 as v2.1 (consistency + deepening). #13, #14, #16 follow as v2.2 hygiene.

## Files reviewed

- `DESIGN.md`
- `config/cc.yaml`
- `src/clock.ts`
- `src/commands/archive.ts`
- `src/commands/attach.ts`
- `src/commands/init.ts`
- `src/commands/plan.ts`
- `src/commands/review.ts`
- `src/commands/run.ts`
- `src/commands/schedule.ts`
- `src/commands/stats.ts`
- `src/commands/status.ts`
- `src/commands/stop.ts`
- `src/commands/todo.ts`
- `src/config.ts`
- `src/events.ts`
- `src/fs-utils.ts`
- `src/index.ts`
- `src/layout.ts`
- `src/logger.ts`
- `src/orchestrator/episode.ts`
- `src/orchestrator/lifecycle.ts`
- `src/orchestrator/main.ts`
- `src/orchestrator/rate-limit.ts`
- `src/orchestrator/state-store.ts`
- `src/runtime/claude-session.ts`
- `src/runtime/detectors.ts`
- `src/runtime/mock-runtime.ts`
- `src/runtime/zellij.ts`
- `src/schedule.ts`
- `src/types.ts`
- `tests/helpers.ts`
- `tests/dispatcher.test.ts`, `tests/e2e.test.ts`, `tests/smoke.test.ts`, `tests/zellij.test.ts`, `tests/claude-session.test.ts` (spot-checked for surface + structure; remaining 21 test files inventoried but not opened individually)

---

# Delta — v2.0.1 / v2.1 / v2.2 fix pass (2026-05-23, same day)

11 commits land on top of the reviewed state. Test count 325 → 451 (+126), 1 skip, 0 fail. Typecheck clean.

## Fix matrix vs original findings

| Finding | Severity | Resolution | Commit |
|---|---|---|---|
| P0-1 `bin: happy` swallows `--session-id` | P0 | F01: dual-mode launch + `/status` slash-command capture for happy mode (jsonl-fallback dropped per user — `/status` is guaranteed). bin=claude still pre-gens via `--session-id`. Live-verified against happy 1.1.8 + claude 2.1.150. | `0e4a525` |
| P0-2 HANDOFF.md never written/read on context_full | P0 | F02: pollUntilDone injects HANDOFF-writing prompt + waits for file (file-existence authoritative, READY sentinel optional); applyResult emits `handoff_written`; `makeBuildPromptFile` reads handoff + emits `handoff_resumed` on next episode; `handoff_pending` flag on TaskRuntimeState. | `e3e82f4` |
| P0-3 pollUntilDone mixes `Date.now()` and injected clock | P0 | F03: 6 wall-clock sites → `clock.now().getTime()`; 4 SimClock tests pin inactivity-completion, hard-timeout, duration, wind-down trigger. | `3ae824d` |
| P1 dead config knobs: `cooldown`, `max_consecutive_errors`, unused `episode_hard_timeout`, unused `safety_margin` | P1 | F04: first two deleted from schema/yaml/tests (whole-repo grep clean); `episodeHardTimeoutMs` wired through `EpisodeCtx` (replaces hardcoded 60min in buildInvokeOpts); `safetyMarginMs` plumbed into RateLimitGate constructor (default 0 for back-compat in test sites). | `3b7c1c8` |
| P1 declared-unemitted events: `wind_down_injected`, `usage_snapshot` | P1 | F05: pollUntilDone now attaches `windDownInjected: WindDownInfo \| null` to every EpisodeResult; applyResult emits `wind_down_injected` + best-effort `usage_snapshot`. Stats rebased on events.jsonl with jsonl-scan fallback when no snapshots in window. New `src/usage.ts` extracts shared usage helpers to break a layer-inversion. Event field naming aligned to existing `event`/`task` convention. | `29f1264` |
| P1 schedule install uses `process.argv[1]` | P1 | F06: `resolveProgramPrefix` detects compiled (`ucl`/`unattended-claude` basename) vs source (bun + script path) modes; `--bin <path>` override flag accepted in any position. | `2ef8d1f` |
| P1 `--until` HH:MM-only | P1 | F07: extracted `parseUntil(input, now)`; `+Nm` / `+Nh` shorthand; QUICK-DEMO updated. | `ecf0c96` |
| P1 `findRepoDir` duplicated + buildPromptFile tmpdir leak + TaskStateStore bypasses clock | P1/P2 | F08: extracted to `src/git-utils.ts` (verified marker is `.claude/skills` not `.git/` — both copies were byte-identical); `withPromptsDir` wraps cmdRun for single-tmpdir-per-run with `process.on('exit')` cleanup; TaskStateStore constructor takes `Clock`, `update()` uses it. **Out-of-scope flags surfaced**: TaskStateStore.init() and lifecycle.suspendForShutdown also use raw `new Date()` — same bug class, left per Rule 3. | `a31ab2d` |
| P1 archive.auto_after_days dead | P1 | F10: orchestrator step "5b" runs `findArchiveCandidates` + `archiveOne` (reused verbatim from commands/archive.ts) when threshold > 0; emits `archive_auto` per moved task; per-task try/catch so failure doesn't abort the run. Runs after orphan-recovery (terminal-state tasks are never orphan candidates). | `1593eae` |
| P2 unreachable `user-stop-now` paused_reason | P2 | F11(a): stop.ts `--now` writes `${stateDir}/stop-now.flag` BEFORE escalating to SIGKILL; lifecycle's new `recoverOrphans` helper picks up the flag and sets `paused_reason="user-stop-now"`, then deletes the flag. SIGTERM path stays "user-stop". | `e736fbc` |
| P2 `findOrphans` dead Set param | P2 | F11(b): signature now `findOrphans(states)`; call site cleaned. | `e736fbc` |
| P2 zellij Layer B integration tests deferred from T06 | P2 | F11(d): `tests/zellij-integration.test.ts` spawns real zellij in tmp dir; 5 active tests + 1 skip-when-zellij-absent; closeTab downgraded to "function returns + tracking reset" (zellij 0.44.3 headless does NOT actually remove tabs server-side — verified manually, real upstream limitation, NOT a bug in our code). | `e736fbc` |
| P2 `schedule add`/`remove` undocumented | P2 | F11(c): `ucl schedule add HH:MM HH:MM` appends to cc.yaml schedule.windows + auto-reinstalls plist; `ucl schedule remove N` removes 1-indexed; both preserve yaml comments via `parseDocument`/`stringify` round-trip. | `e736fbc` |
| F09 PromptBuilder consolidation | (enabling refactor) | F09: 4 prompt sites collapsed into `src/orchestrator/prompt-builder.ts`; F02 then extended it for HANDOFF resume. `WIND_DOWN_PROMPT` stayed exported from claude-session.ts as single source of truth — PromptBuilder imports it (no duplication, no circular). | `a342b7b` |

## What's still NOT addressed

These items were either out of scope for this pass (Rule 3 — surgical) or surfaced during the work but deliberately deferred. None are production-blockers.

| Item | Why deferred |
|---|---|
| `TaskStateStore.init()` uses raw `new Date()` | Same bug class as F08(c) but caller side-effect of init is rare; SimClock-controlled init isn't currently needed by any test. Flagged in F08 commit body. |
| `lifecycle.suspendForShutdown` uses raw `new Date()` when emitting `task_paused` events | Same class — affects event timestamps under SimClock, not behavior. Flagged in F08 commit body. |
| zellij headless `closeTab` doesn't remove tabs server-side | Upstream limitation in zellij 0.44.3, not our code. Test downgraded with explanatory comment. |
| Proactive context-compact at `context_compact_threshold` tokens (DESIGN §七) | Reactive compact via `matchContextLimit` + HANDOFF is now end-to-end; proactive jsonl-size monitoring would be additive optimization, not a fix. |
| `archiveOne` constructs its own RealClock-backed TaskStateStore | Doesn't break anything; rendering paths read strings. If sim-controlled archive timestamps become useful, refactor then. |

## Quality bar verification

- **451 pass / 1 skip / 0 fail** across 34 test files (was 325 / 0 / 0 across 26 files)
- `tsc --noEmit` clean
- Each fix landed as one commit with a clear conventional-commit subject
- No `git push` performed (per user's hard rule)
- All subagents reported DONE; surprises documented; no BLOCKED state in the chain

**Verdict update:** The post-pass surface is now what DESIGN.md promised. The "drift between DESIGN.md and code" called out in the original executive summary is closed for the items reviewed. Out-of-scope flags are tracked above for a future v2.2.1 if desired, but none of them affect the demand-shifting north-star scenario.

