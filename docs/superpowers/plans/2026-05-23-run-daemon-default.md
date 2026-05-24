# `ucl run` Default-Daemon Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Make `ucl run` daemonize by default — fork, detach from the controlling terminal, log to file, return shell prompt immediately. Add `--foreground` flag for debug / live-stream JSON output.

**Architecture:** Single task (G05). Modifies `src/commands/run.ts` with a fork-then-exec pattern using `Bun.spawn({ detached: true })`. Parent process does preflight + fail-fast, then forks; child re-enters `cmdRun` with `UCL_DAEMON_CHILD=1` env set and runs the orchestrator. Existing `ucl stop` (kills via lockfile PID) continues to work unchanged.

**Tech Stack:** TypeScript + Bun. Use `Bun.spawn` for fork; `node:fs.openSync` for log fd; existing `Layout` for paths.

---

## Why default-daemon

The tool name "unattended-claude" implies background execution. Foreground-by-default makes the user manually `nohup`/`&` for the primary use case (overnight runs, schedule windows). Better: daemonize by default, `--foreground` for the niche debug use.

Aligns with modern service tools (`brew services`, `systemctl start`, `pm2 start`) which all default to background.

---

## Fork-vs-validate ordering (critical)

Parent process MUST do the following BEFORE forking, surfacing any error to user's shell immediately:

1. Parse args (`parseRunArgs` — already exists)
2. Load + validate config (already happens via `loadConfig` in `index.ts` before `cmdRun` is called)
3. Preflight: weekly-paused check, lockfile-alive check (already in `cmdRun` lines 226-241)
4. Compute window-end from `--until` or schedule (already in `deriveWindowEnd`)

Only AFTER all four pass does the parent fork the child. This way, an error like "another orchestrator alive (PID xxx)" or "Config not found" surfaces to the user's shell, NOT silently into a logfile they have to remember to tail.

The fork point is exactly between the existing log line `run starting; window ends <ts>` and the `new InteractiveZellijRuntime(...)` instantiation.

---

## File structure

**Modified:**
- `src/commands/run.ts` — add `--foreground` flag parsing, add fork-before-runtime branch, surface parent vs child distinction
- `src/layout.ts` — add `daemonLogFile(ts: Date)` accessor returning `<runtimeDir>/logs/orchestrator-<iso>.log`
- `src/commands/run.ts` (helpText) — update to reflect new default + describe `--foreground` 
- `QUICK-DEMO.md` §4 — flip `ucl run --until +5m` to default-daemon flow + add `--foreground` debug variant
- `README.md` (cheat sheet section, if any) — same

**Tests:**
- Extend `tests/commands-run.test.ts` (or create if missing) — test that `parseRunArgs` parses `--foreground`; test that parent-mode short-circuits and returns daemonized result when `UCL_DAEMON_CHILD` env is unset and `--foreground` is not given; test that child-mode (UCL_DAEMON_CHILD=1) skips the fork branch

Fork-itself integration test (does `Bun.spawn detached` actually detach?) is OS-coupled and brittle in unit-test environments. Skip — verify manually post-merge by running `ucl run` and confirming shell returns.

---

## G05 — Daemonize `ucl run` by default

**Files:**
- Modify: `src/commands/run.ts`
- Modify: `src/layout.ts`
- Modify: `QUICK-DEMO.md`
- Modify: `README.md` (only if it has a `ucl run` reference)
- Create or extend: `tests/commands-run.test.ts`

### Spec

**1. `src/layout.ts` — add accessor:**

```ts
/** Path for one daemonized orchestrator run's log file. ISO timestamp avoids collisions across runs. */
daemonLogFile(ts: Date): string {
  const iso = ts.toISOString().replace(/[:.]/g, "-")   // 2026-05-23T22-10-00-000Z
  return join(this.logsDir, `orchestrator-${iso}.log`)
}
```

**2. `src/commands/run.ts` — args + helpText:**

Extend `RunArgs` interface:
```ts
interface RunArgs {
  until: string | null
  force: boolean
  foreground: boolean    // NEW
}
```

`parseRunArgs` recognizes `--foreground` (no value, sets `foreground: true`).

Update `helpText` to:
```
Usage: ucl run [--until <time>] [--force] [--foreground]

Start the unattended worker. Default: detaches (daemonizes) and returns
the shell prompt immediately; orchestrator log goes to
<runtime>/logs/orchestrator-<ts>.log. Use --foreground for live JSON
log stream (debug / first-time use).

  --until <time>     end the run window at this time (otherwise: until queue empty)
                     accepts HH:MM (24h clock), +Nm (N minutes from now),
                     or +Nh (N hours from now); HH:MM rolls to tomorrow if past
                     if omitted, derived from active schedule window in config
  --force            bypass preflight (weekly-paused / lockfile alive checks)
  --foreground       run in the current terminal; do not detach
```

**3. `src/commands/run.ts` — fork branch in `cmdRun`:**

Insert AFTER preflight checks + window-end resolution AND BEFORE `new InteractiveZellijRuntime(...)`. Exact location: between the existing `log.log("info", "run starting; ...")` line and the `runtime` const.

```ts
// Daemonize unless --foreground or already a daemon child (re-exec'd by parent).
const isDaemonChild = process.env.UCL_DAEMON_CHILD === "1"
if (!args.foreground && !isDaemonChild) {
  const logPath = layout.daemonLogFile(clock.now())
  ensureDir(dirname(logPath))
  const fd = openSync(logPath, "a")
  try {
    const child = Bun.spawn({
      cmd: process.argv,
      env: { ...process.env, UCL_DAEMON_CHILD: "1" },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    })
    // Detach: parent does not wait for child; child becomes session leader.
    child.unref()
    console.log(`orchestrator detached as PID ${child.pid}, logs at ${logPath}`)
    return { reason: "daemonized", taskCount: 0 }
  } finally {
    closeSync(fd)
  }
}
// Foreground or daemon-child path continues below.
```

Imports needed: `closeSync, openSync` from `node:fs`; `dirname` from `node:path`.

The `RunResult` type union must accept `reason: "daemonized"` — extend it in `src/orchestrator/main.ts` (or wherever the type lives) if needed.

**4. Child-process consistency:**

When the parent forks via `Bun.spawn({ cmd: process.argv, ... })`, the child re-executes `bun src/index.ts run <args>` (or `ucl run <args>` depending on how user invoked). `index.ts` re-parses args, loads config, dispatches to `cmdRun`. In `cmdRun`, the `UCL_DAEMON_CHILD === "1"` check short-circuits the fork branch, and the child runs the orchestrator normally.

The child inherits `process.argv` from the parent — so `--until +5m`, `--force` etc. all pass through correctly. Only the env var changes.

**5. Preflight error surfacing remains in parent:**

Existing preflight check (around lines 226-241 of run.ts) runs BEFORE the new fork branch. So "weekly limit active" and "another orchestrator alive" still surface to the user's terminal, not the log file. Critical UX property.

**6. `QUICK-DEMO.md` §4 update:**

Replace the current §4 "Manual run" intro with:

```markdown
## 4. Manual run — `ucl run --until +5m`

> `--until` accepts `HH:MM`, `+Nm`, or `+Nh`. HH:MM rolls to tomorrow if past.
> Default daemonizes. Add `--foreground` to keep it in the current terminal.

**Daemonized (default):**
\`\`\`bash
ucl run --until +5m
\`\`\`

Returns immediately with `orchestrator detached as PID <pid>, logs at /path/orchestrator-<ts>.log`. Watch the log:

\`\`\`bash
tail -f ~/unattended/logs/orchestrator-*.log | jq -r '.msg'
\`\`\`

**Foreground (debug):**
\`\`\`bash
ucl run --until +5m --foreground
\`\`\`

Blocks the shell with live JSON log stream. Ctrl-C → graceful pause.
```

Plus the rest of §4 (zellij attach, verification, troubleshooting) stays as-is — it works under both modes.

**7. README cheat sheet:** if README has an `ucl run` example, update it to mention default-daemon + `--foreground` debug.

### Tests

Add to `tests/commands-run.test.ts` (or new file if absent):

```ts
import { describe, expect, test } from "bun:test"
import { parseRunArgs } from "../src/commands/run.ts"

describe("parseRunArgs --foreground", () => {
  test("default foreground is false (daemonize)", () => {
    expect(parseRunArgs([]).foreground).toBe(false)
  })

  test("--foreground sets flag true", () => {
    expect(parseRunArgs(["--foreground"]).foreground).toBe(true)
  })

  test("--foreground composes with --until and --force", () => {
    const a = parseRunArgs(["--until", "+5m", "--foreground", "--force"])
    expect(a.foreground).toBe(true)
    expect(a.until).toBe("+5m")
    expect(a.force).toBe(true)
  })
})

describe("cmdRun daemon dispatch", () => {
  test("when UCL_DAEMON_CHILD=1 in env, cmdRun does NOT fork (child path runs orchestrator)", async () => {
    // Hard to assert directly without mocking Bun.spawn; instead, verify the env-check
    // branch by reading the source once via a unit-level helper. Alternative: skip and
    // rely on manual verification post-merge. Note that limitation in test comment.
  })
})
```

For the daemon-dispatch test: full integration testing requires actually spawning Bun, which is brittle. **Acceptable**: stub-out via a `forkChild` callback injected into cmdRun for testability, OR skip and document manual verification. Implementer's call — prefer the callback if it's <20 lines of refactor; else skip the test.

### Implementation order

1. Add `RunResult.reason` union member `"daemonized"`
2. Add `Layout.daemonLogFile(ts)`
3. Extend `RunArgs` + `parseRunArgs` with `--foreground`
4. Update `helpText`
5. Insert fork branch into `cmdRun`
6. Update QUICK-DEMO + README
7. Add parseRunArgs tests
8. `bun run typecheck` green
9. `bun test` all green (496 baseline + ~3 new = ~499)
10. **Manual verification:** run `ucl run --until +5m` in a real terminal; verify shell prompt returns immediately and log file appears at `~/unattended/logs/orchestrator-<ts>.log`. Verify `ucl stop` still kills the daemon. Document result in commit message.
11. Commit `feat: ucl run daemonizes by default; --foreground for debug`

---

## Self-review

- **Spec coverage:** fork-after-validate ordering is the safety property — explicitly called out in section "Fork-vs-validate ordering" with exact insertion point.
- **No placeholders:** all imports, env var name (`UCL_DAEMON_CHILD`), log path format, helpText wording, RunArgs interface delta — all explicit.
- **`ucl stop` compatibility:** unchanged. `cmdStop` reads PID from lockfile and SIGTERM/SIGKILLs it. Daemon child writes its own PID to lockfile (existing `runOrchestrator` already does this).
- **Error surfacing UX:** preflight runs in parent BEFORE fork — explicit constraint in section 5. Avoids silent-into-logfile failures.
- **Tests acknowledge fork is hard to unit-test:** parseRunArgs is unit-testable (cheap); fork branch is left as manual verification (documented in plan).
- **Forward compat with future Q8 extensions:** if we later add `ucl run --no-detach-on-exit` or similar lifecycle flags, the daemon-child env-var check stays the seam.
