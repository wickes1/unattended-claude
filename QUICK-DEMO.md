# QUICK-DEMO.md — manual follow-along guide for `ucl`

> 自用 (one user — Wickes). Mixed Chinese/English where natural.
> Goal: walk through every `ucl` feature by hand to confirm v2 actually works on this Mac.

This is **not** an automated test suite. `tests/e2e.test.ts` already covers the orchestrator state-machine via MockRuntime. This doc is for the things you can only verify by watching the screen — zellij tabs spawning, dialog auto-dismiss, wind-down prompt injection, launchd permissions, etc.

---

## Before you start — read this once

- **Runtime dir is `~/unattended/`** (no leading dot, not `~/.unattended-claude/`). Short on purpose.
- **Zellij socket dir is forced to `/tmp/zellij`** by every `ucl` command. macOS `$TMPDIR` is too long for Unix-socket paths (107-byte limit) so we sidestep it. Don't manually `export ZELLIJ_SOCKET_DIR=...` to a long path or zellij will silently fail to find sessions.
- **`runtime.bin` choice matters for resume.** The default template ships `bin: happy`, but T09 spike (2026-05-23) confirmed Happy's `--session-id <uuid>` flag is **not honored** — Happy stores its own internal conversation uuid. So if you want cross-window `--resume` to actually pick up the same Claude conversation, edit `~/.config/unattended-claude/cc.yaml` and set `runtime.bin: claude`. Happy mobile-observability + working `--resume` is **not currently possible** — pick one. (Reference: `src/runtime/claude-session.ts` line 80–103.)
- **Plan/review skills load via cwd.** `ucl plan` and `ucl review` spawn claude with `cwd = v2 repo root`, so `.claude/skills/task-brief/` and `.claude/skills/task-review/` auto-load from the project. You must invoke `ucl` from a shell whose `$PATH` resolves to a `ucl` whose import.meta.dir walks up to the right repo. If you've installed `ucl` system-wide and detached from the repo, the skills won't load — check `findRepoDir()` in `src/commands/plan.ts`.
- **Never `git push` or commit anything `ucl` produced** without reviewing it first. Standard rule.

---

## 1. Prereqs check

**Run:**
```bash
which claude && which happy && which zellij && which bun
claude --version 2>&1 | head -1
happy --version 2>&1 | head -1
zellij --version
bun --version
```

**Expected output:** (versions will drift; just confirm all four resolve)
```
/Users/week-mac/.fnm/.../node_modules/.bin/claude    (or similar)
/Users/week-mac/.fnm/.../node_modules/.bin/happy
/opt/homebrew/bin/zellij
/Users/week-mac/.bun/bin/bun
1.0.x (Claude Code)
happy x.y.z
zellij 0.42.x
1.2.19+
```

**Verify:**
- All four resolve to absolute paths (no "command not found").
- `bun` version is ≥ 1.2.19 (matches `engines.bun` in `package.json`).
- Zellij can be reached on `/tmp/zellij`: `ZELLIJ_SOCKET_DIR=/tmp/zellij zellij list-sessions` returns either a session list or "No active zellij sessions found" (not a connection error).

**If it fails:**
- `claude` missing → `npm install -g @anthropic-ai/claude-code` (or whatever the official install is at the time)
- `happy` missing → only required if you keep `runtime.bin: happy` in cc.yaml. If you switched to `claude`, ignore.
- `zellij` missing → `brew install zellij`
- `bun` too old → `curl -fsSL https://bun.sh/install | bash`

---

## 2. First-time setup — `ucl init`

**Run:**
```bash
cd /Users/week-mac/Fonds/Workshop/unattended-claude/unattended-claude
bun src/index.ts init
# or, if you've linked it: ucl init
```

**Expected output:**
```
unattended-claude initialized.
  - Created empty todo.md at /Users/week-mac/unattended/todo.md
  - Created config at /Users/week-mac/.config/unattended-claude/cc.yaml
  (if any of claude/happy/zellij are missing on PATH, you'll see WARN lines here)

Next steps:
  1. Edit /Users/week-mac/unattended/todo.md — add what you want done.
  2. Run `ucl plan` to convert todos into task docs.
  3. Run `ucl run --until <HH:MM | +Nm | +Nh>` when you're leaving the keyboard.
```

**Verify:**
- `ls ~/unattended/` shows `archive/  logs/  state/  tasks/  todo.md  workdirs/`
- `ls ~/unattended/state/` shows `handoffs/  tasks/` (empty)
- `cat ~/.config/unattended-claude/cc.yaml` matches `config/cc.yaml` in the repo
- Re-running `ucl init` is idempotent — no overwrites, says "Config exists at ... (kept; edit manually if needed)"

**If it fails:**
- "init template not found" → you ran `bun src/index.ts` from somewhere other than the repo. cd to the repo root.
- Permissions on `~/.config/` denied → `mkdir -p ~/.config && chmod u+w ~/.config`
- Want to nuke and redo: `rm -rf ~/unattended ~/.config/unattended-claude` then re-init. (No automatic flag — intentional.)

---

## 3. Add a todo + plan — `ucl plan`

**Run:**
```bash
cat >> ~/unattended/todo.md <<'EOF'
- [ ] write a tiny smoke task: create hello.py that prints "hello from ucl", then write result.md saying "done"
EOF

# Optionally edit the cc.yaml first to set runtime.bin: claude (see callout above)
bun src/index.ts plan
```

**Expected output (terminal):**
```
(zellij attaches; you see a fresh claude session inside a tab named something like
 "unattended-claude-plan-1747900000000")
```

Inside claude, the initial prompt triggers the **task-brief** skill (loaded from `.claude/skills/task-brief/`). It will:
1. Echo the unchecked todo line(s).
2. Ask 1–2 clarifying questions (scope, workdir, serial?).
3. Write `~/unattended/tasks/2026-05-23-01-hello-smoke.md` (or similar) with frontmatter (title, workdir, serial).
4. Rewrite todo.md to mark the line `- [x] ...` with a task-link suffix like `→ 2026-05-23-01-hello-smoke`.
5. `/exit` claude.

When claude exits, the zellij session is killed (see `finally` block in `plan.ts`) and you return to your shell.

**Verify:**
- `ls ~/unattended/tasks/` shows a new `.md` file with a valid task ID (`YYYY-MM-DD-NN-slug.md`).
- `head -10 ~/unattended/tasks/<id>.md` shows frontmatter with `title:`, `workdir:`, `serial: false` (or true if you said serial).
- `cat ~/unattended/todo.md` — the planned line is now `- [x] ... → <id>`.

**If it fails:**
- task-brief skill doesn't load (claude doesn't mention it by name) → you're not in the repo cwd. Check `findRepoDir()` walks up from `src/commands/plan.ts` and finds `.claude/skills/`.
- "Worker is running" refusal → there's a stale running task. `ucl status` to see, then either let it finish or `ucl stop` or `ucl plan --force`.
- zellij can't attach → likely `ZELLIJ_SOCKET_DIR` mismatch. All `ucl` commands force `/tmp/zellij`; if you opened your shell with a different socket dir env var, your interactive zellij won't see ucl's sessions.

---

## 4. Manual run — `ucl run --until +5m`

> `--until` accepts `HH:MM` (24h clock), `+Nm` (N minutes from now), or `+Nh` (N hours from now). `HH:MM` rolls to tomorrow if it's already past.

**Run:**
```bash
# in terminal A
bun src/index.ts run --until +5m
# equivalent (assuming it's currently 22:00):
# bun src/index.ts run --until 22:05
```

**Expected output (in terminal A — orchestrator foreground):**
```
[info] run starting; window ends 2026-05-23T22:05:00.000Z
[info] dispatching task 2026-05-23-01-hello-smoke (episode 1)
[info] zellij newSession unattended-claude
[info] zellij newTab unattended-claude tab=2026-05-23-01-hello-smoke
[info] dialog: trust folder → Enter         (only if the workdir is new)
... (poll loop ticks silently)
```

**In a second terminal (B) — attach and watch:**
```bash
bun src/index.ts attach
```

You should see claude running inside the zellij tab, working on hello.py. Detach without killing:
- Press `Ctrl-o` then `d` — zellij's default detach chord. Your terminal returns to your shell; the worker keeps running in terminal A.

**Verify:**
- `ZELLIJ_SOCKET_DIR=/tmp/zellij zellij list-sessions` shows `unattended-claude` (no EXITED tag).
- `cat ~/unattended/state/tasks/<id>.json` shows `"state": "running"`, `"claude_session_id": "<uuid>"`, `"current_episode": 1`.
- `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` exists and is growing.

**If it fails:**
- `ucl attach` says "No worker running" → check terminal A; the orchestrator may have already finished or crashed. `cat ~/unattended/state/.lock` to see if the PID is still alive.
- claude tab launches but immediately exits → likely a dialog you didn't anticipate (login? auth?). Run `claude` manually once to clear it.
- "Another orchestrator alive (PID xxx). Use --force to override." → real protection. Either `ucl stop` first or `ucl run --force`.
- Detach chord didn't work → check zellij keybindings; some users remap `Ctrl-o`. `zellij detach` from inside also works.

---

## 5. Cross-window resume — paused → resumed

> 這是 v2 最核心 / 最容易出 regression 的路徑。Pre-gen UUID + `--resume` 必須真的把同一個 Claude conversation 接回來。

**Run:** Pick a long-running task in todo.md (something that won't finish in 5 minutes — e.g., "read 10 files and summarize each in 100 words"). After `ucl plan` to freeze it as a task doc:

```bash
# window 1 — terminal A
bun src/index.ts run --until +5m    # short window so we hit wind-down
```

Wait for the wind-down. At T-2min (per default `wind_down_lead_minutes: 5`, but can be reduced via cc.yaml for testing), the orchestrator injects the wind-down prompt into the claude tab. At T-0 the window closes.

**Expected log lines (terminal A):**
```
[info] wind-down injected at <ts>
[info] window ended; pausing task 2026-05-23-NN-... (schedule-boundary)
[info] zellij /quit → graceful shutdown
[info] task state: running → paused (schedule-boundary)
```

**Verify intermediate state:**
```bash
bun src/index.ts status
# Should show:
#   planned: 0  running: 0  paused: 1  done: 0  failed: 0
#   Paused:
#     2026-05-23-NN-...   schedule-boundary
```

**Run window 2 (after window 1 has fully cleaned up):**
```bash
bun src/index.ts run --until +15m
```

**Expected log lines:**
```
[info] run starting; ...
[info] resuming task 2026-05-23-NN-... (paused_reason=schedule-boundary, episode 2)
[info] zellij newTab + launch: claude --resume <same uuid> --dangerously-skip-permissions
[info] wake-up prompt injected: "Schedule window ended. Time to continue — pick up from where you stopped."
... (task completes)
[info] task state: running → done
```

**Verify:**
- `cat ~/unattended/state/tasks/<id>.json` ends at `"state": "done"`, `current_episode: 2`.
- `~/.claude/projects/<encoded-cwd>/<same-uuid>.jsonl` grew during episode 2 (single jsonl, not two separate ones — that's the proof `--resume` worked).
- The SUMMARY section appended to `~/unattended/tasks/<id>.md` mentions context from episode 1 (e.g. "as I started in the previous window…").

**If it fails:**
- `--resume` creates a fresh conversation instead of continuing → you're running `bin: happy` instead of `bin: claude`. Re-read the runtime.bin callout above. Switch to claude, redo the task.
- Wake-up prompt not visible in the tab → check the orchestrator log; `buildWakeUpPrompt` returned non-null but maybe `pasteFile` failed. Look at `state/events.jsonl` for a `resume_started` event.
- task state stuck at `paused` → check the lock file isn't holding the resume back. `cat ~/unattended/state/.lock`; if the PID is dead, `rm` the lockfile and re-run.

---

## 6. Test graceful stop — `ucl stop`

**Run:**
```bash
# terminal A
bun src/index.ts run --until 23:59         # long window

# terminal B (after task is running)
bun src/index.ts stop
```

**Expected output (terminal B):**
```
Sent SIGTERM to orchestrator (PID xxxxx). Waiting for graceful shutdown…
Orchestrator exited cleanly.
```

**Expected output (terminal A):**
```
[info] SIGTERM received — pausing in-flight tasks (user-stop)
[info] task state: running → paused (user-stop)
[info] zellij /quit + cleanup
(orchestrator exits, prompt returns)
```

**Verify:**
- `bun src/index.ts status` shows the task `paused` with reason `user-stop`.
- `ls ~/unattended/state/.lock` is gone (cleared on graceful exit).
- Wake-up prompt on next `ucl run` will be: "Manual stop ended. Continue from where you stopped." (`buildWakeUpPrompt` for `"user-stop"`).

**If it fails:**
- "No worker running (lockfile not found)." → terminal A had already exited. Not actually a failure, just check status.
- 10-second timeout, "Orchestrator did not exit within 10s." → the orchestrator's signal handler is hung. This is a bug; capture `lsof -p <pid>` and check `state/events.jsonl` for the last event.

---

## 7. Test force stop — `ucl stop --now`

**Run:**
```bash
# terminal A
bun src/index.ts run --until 23:59

# terminal B
bun src/index.ts stop --now
```

**Expected output (terminal B):**
```
Sent SIGTERM to orchestrator (PID xxxxx). Waiting for graceful shutdown…
Escalated to SIGKILL (PID xxxxx).
```

(2 second grace period before SIGKILL, per `stop.ts` line 43.)

**Verify:**
- Orchestrator process in terminal A is dead immediately, no graceful pause.
- `~/unattended/state/.lock` is **still on disk** (no cleanup happened — SIGKILL gives no chance to run handlers).
- `bun src/index.ts status` may still show the task as `running` (state file wasn't updated).
- **Next `ucl run` will detect the orphan**: the lockfile PID is no longer alive, the state says running, so the orchestrator marks it `paused-orphan` and wakes up with: "Previous session was interrupted unexpectedly (machine reboot or process death). Continue, but please first verify current file/test state."

**If it fails:**
- SIGKILL didn't kill the process → permission issue or `sudo`-launched orchestrator. Check `ps aux | grep ucl`.
- Next `ucl run` doesn't detect orphan → check `isProcessAlive(pid)` against the leftover lockfile in `state/.lock`. `cat state/.lock` to see the PID, `ps -p <pid>` to confirm it's truly gone.

---

## 8. Schedule install / uninstall — `ucl schedule`

> macOS launchd. Edit `cc.yaml` first to add at least one window.

**Edit `~/.config/unattended-claude/cc.yaml`:**
```yaml
schedule:
  windows:
    - start: "22:00"
      end:   "06:00"
      days:  [mon, tue, wed, thu, fri]
```

**Run:**
```bash
bun src/index.ts schedule list
```

**Expected output:**
```
Configured windows:
  22:00 → 06:00  days=[mon,tue,wed,thu,fri]  label=dev.unattended-claude.2200-0600

Installed plists in /Users/week-mac/Library/LaunchAgents:
  (none)
```

**Install:**
```bash
bun src/index.ts schedule install
```

**Expected:**
```
loaded  /Users/week-mac/Library/LaunchAgents/dev.unattended-claude.2200-0600.plist
```

**Verify:**
- `ls ~/Library/LaunchAgents/dev.unattended-claude.*` shows the plist file.
- `cat ~/Library/LaunchAgents/dev.unattended-claude.2200-0600.plist` — XML with `<Weekday>1</Weekday>` (Mon) through `<Weekday>5</Weekday>` (Fri), `<Hour>22</Hour>`, `<Minute>0</Minute>`.
- `launchctl list | grep unattended` shows the agent loaded.
- `bun src/index.ts schedule list` now lists the installed plist filename.

**Uninstall:**
```bash
bun src/index.ts schedule uninstall
```

**Expected:**
```
removed  /Users/week-mac/Library/LaunchAgents/dev.unattended-claude.2200-0600.plist
```

**Verify uninstall:**
- `ls ~/Library/LaunchAgents/dev.unattended-claude.*` returns "No such file".
- `launchctl list | grep unattended` shows nothing.

**If it fails:**
- `loaded  ...` becomes `wrote (load failed)  ...` → **most likely cause: macOS Full Disk Access**. The `bun` binary (or wherever `process.argv[1]` resolves to) needs FDA to be invoked by launchd. Go to System Settings → Privacy & Security → Full Disk Access, click `+`, add `/Users/week-mac/.bun/bin/bun` (or the linked `ucl` binary).
- The plist exists but doesn't actually fire at 22:00 → `log stream --predicate 'subsystem == "com.apple.xpc.launchd"'` while waiting; check StandardErrorPath at `~/unattended/logs/schedule.err.log`.
- `exePath` in the plist is wrong (points to bun, not ucl) → that's expected for a `bun src/index.ts` invocation; the plist will run `<bun-binary> run --until 06:00` which is **not** what you want — bun's `run` subcommand isn't `ucl run`. **Fix**: build a proper executable wrapper or install `ucl` as a npm/bun bin. For now, until a wrapper exists, treat `schedule install` as code-tested-not-yet-deployed.

---

## 9. Stats / status / review — observation commands

Run a few tasks to completion first so there's data. Then:

### 9a. `ucl status` — instant snapshot

**Run:**
```bash
bun src/index.ts status
```

**Expected:**
```
planned: 0  running: 0  paused: 0  done: 3  failed: 0

In-flight: (none)

Cap: 0/3 used
```

(Or if something's running:)
```
planned: 0  running: 1  paused: 1  done: 3  failed: 0

In-flight:
  2026-05-23-04-thing    episode 2    last update 2026-05-23T21:55:01.123Z

Paused:
  2026-05-23-05-other    rate-limit-5h  (1 compactions)

Cap: 1/3 used
```

### 9b. `ucl stats` — historical token usage

**Run:**
```bash
bun src/index.ts stats              # default 7 days
bun src/index.ts stats --days 30
```

**Expected:** (token numbers depend on real claude jsonl, will be 0 if you only ran MockRuntime tests)
```
Last 7 days:
  Day          Tasks(✓/✗)    Token usage    5h-windows hit limit
  2026-05-17   0/0                     0     0
  2026-05-18   0/0                     0     0
  2026-05-19   0/0                     0     0
  2026-05-20   0/0                     0     0
  2026-05-21   0/0                     0     0
  2026-05-22   1/0               112,830     0
  2026-05-23   3/0               298,442     1

Totals: done=4  failed=0  tokens=411,272
```

**Verify:**
- Token counts are non-zero for days when real claude (not Mock) ran. If they're 0 but you ran real tasks, check `~/.claude/projects/` exists and `findClaudeSessionFile` can find the `<uuid>.jsonl` for the task's `claude_session_id`.

### 9c. `ucl review <id>` — single-task summary (non-interactive)

**Run:**
```bash
ls ~/unattended/tasks/                              # pick an id
bun src/index.ts review 2026-05-23-01-hello-smoke
```

**Expected:** prints the `## Summary` section of the task doc to stdout. If the task doesn't have one yet, prints `(no SUMMARY section yet for <id>)`.

### 9d. `ucl review --synthesize --since=24h` — interactive AI review + report

**Run:**
```bash
bun src/index.ts review --synthesize --since 24h
```

**Expected:** Spawns a fresh claude session inside zellij, attaches your terminal. The initial prompt loads the **task-review** skill from `.claude/skills/task-review/` and feeds it the last 24 hours of `events.jsonl`. The skill walks you through reviewing what was done; on exit, writes a markdown report to `~/unattended/reviews/<ISO-timestamp>.md`.

**Verify:**
- `ls ~/unattended/reviews/` shows a new `<timestamp>.md` file.
- The report covers what got done, failed, key decisions, follow-ups.
- The session was killed cleanly on `/exit` (`zellij list-sessions` doesn't show the review session).

**If it fails:**
- task-review skill doesn't load → same as plan: confirm `findRepoDir()` resolves to the v2 repo root.
- `--since 24h` parses wrong → check `parseReviewArgs` in `review.ts`. Format is `\d+[hmd]`, no spaces, no `=` sign needed.
- No report written → did you `/exit` claude? The skill is expected to write the file *before* exiting. If claude crashed mid-review, the file may be partial or missing.

---

## 10. Archive — `ucl archive <id>` / `--done-before Nd`

**Run (single task):**
```bash
bun src/index.ts archive 2026-05-23-01-hello-smoke
```

**Expected:**
```
archived 2026-05-23-01-hello-smoke → /Users/week-mac/unattended/archive/2026-05-23-01-hello-smoke
```

**Verify bundle structure:**
```bash
ls ~/unattended/archive/2026-05-23-01-hello-smoke/
# task.md  state.json  workdir/    (+ handoff.md if context-full triggered HANDOFF)

cat ~/unattended/archive/2026-05-23-01-hello-smoke/state.json | jq .state
# "done"

ls ~/unattended/tasks/  | grep 2026-05-23-01     # should be gone
ls ~/unattended/state/tasks/ | grep 2026-05-23-01 # should be gone
ls ~/unattended/workdirs/ | grep 2026-05-23-01   # should be gone
```

**Verify event log:**
```bash
grep archive_moved ~/unattended/state/events.jsonl | tail -1
# {"ts":"2026-05-23T...","event":"archive_moved","task":"2026-05-23-01-hello-smoke"}
```

**Run (batch archive — dry-run first!):**
```bash
bun src/index.ts archive --done-before 7d --dry-run
# would archive 3 task(s):
#   2026-05-16-01-foo  (done, last_updated 2026-05-16T...)
#   ...

bun src/index.ts archive --done-before 7d
# archived 2026-05-16-01-foo
# archived ...
```

**Unarchive (test the reverse):**
```bash
bun src/index.ts unarchive 2026-05-23-01-hello-smoke
# unarchived 2026-05-23-01-hello-smoke
```

Verify it reappeared in `tasks/` and `state/tasks/` and `archive/<id>/` is gone.

**If it fails:**
- "already archived" → idempotent guard; nothing to do.
- "nothing to unarchive at ..." → typo on the id, or it was never archived.
- batch archive picks up unexpected tasks → check the `last_updated` timestamps in `state/tasks/*.json`; the cutoff is strict.

---

## 11. Consolidate todo — `ucl todo --consolidate`

After several plan cycles, `~/unattended/todo.md` accumulates `- [x] ... → <id>` lines. Consolidate them into a journal section at the bottom, grouped by date.

**Run:**
```bash
bun src/index.ts todo --consolidate
```

**Expected output:**
```
consolidated /Users/week-mac/unattended/todo.md
```

(If nothing to do: `todo.md already consolidated`.)

**Verify:**
```bash
tail -30 ~/unattended/todo.md
```

You should see a section like:
```markdown
## ── Planned (archive line) ──

### 2026-05-20
- [x] some old thing → 2026-05-20-01-old-thing

### 2026-05-23
- [x] write a tiny smoke task → 2026-05-23-01-hello-smoke

### (undated)
- [x] this one had no date in the line
```

**Verify the unchecked lines stayed in place** — only `[x]` lines moved.

**Idempotency check:** Run `ucl todo --consolidate` again. Output: `todo.md already consolidated`. The file should be byte-identical.

**If it fails:**
- The journal header gets duplicated → bug in `consolidateTodo`. Should split on the FIRST occurrence only. Check `journalIdx = lines.findIndex(...)`.
- New `[x]` lines added after consolidation aren't moved on next run → known limitation, just run `--consolidate` again; it'll find the new ones and merge them into the existing journal (the function preserves `existingJournal`).

---

## 12. Limit smoke-tests — optional (requires burning real quota)

The three limit paths (5-hour rate limit, weekly limit, context-full) **can only be tested by hitting real limits**, which costs real money/quota. For safe verification, lean on the MockRuntime-based e2e test instead:

```bash
cd /Users/week-mac/Fonds/Workshop/unattended-claude/unattended-claude
bun test tests/e2e.test.ts
```

This covers:
- **`paused-rate-limit-5h` → resume**: MockRuntime returns `{status: "rate_limited", resumeAt}`, orchestrator waits, re-dispatches.
- **`paused-weekly-limit` → next window**: MockRuntime returns `{status: "weekly_limited", resumeAt: +7d}`, orchestrator writes `weekly-paused-until.txt`, refuses to run again until cleared.
- **`paused-context-full` → HANDOFF + fresh resume**: MockRuntime returns `{status: "context_full"}`, orchestrator writes `handoff.md`, next episode starts a fresh session and is fed the handoff.

If you really want to test the live detection patterns against real claude:

**Rate-limit (5h):**
- Run a token-heavy task in a fresh 5-hour window until you hit the limit.
- Watch for `[warn] rate limit detected, resume at <ts>` in the orchestrator log.
- `ucl status` should show the task `paused` with reason `rate-limit-5h`.
- Next `ucl run` after resumeAt should auto-resume with wake-up prompt: "The 5-hour rate limit window has reset. Continue from where you stopped."

**Weekly limit:**
- Only triggers when you've actually exhausted weekly quota (rare).
- Verify by inspecting `state/weekly-paused-until.txt` (`cat`-able ISO timestamp).
- All subsequent `ucl run` calls until that timestamp will refuse: `Weekly limit active until <ts>; skipping run. Use --force to override.`

**Context-full:**
- Set `execution.context_compact_threshold` very low in cc.yaml (e.g. 10000) to provoke it artificially. **Don't ship this config**.
- Watch for `[warn] context-full detected`, then a `handoff_written` event in `events.jsonl`, then a fresh-session resume in episode N+1.

---

## End-of-session housekeeping

After demoing all of this, your `~/unattended/` will be cluttered. Clean up:

```bash
# Archive everything done older than 0 days (i.e., everything done)
bun src/index.ts archive --done-before 0d --dry-run
bun src/index.ts archive --done-before 0d

# Consolidate journal
bun src/index.ts todo --consolidate

# Uninstall any schedule plists you installed for testing
bun src/index.ts schedule uninstall

# (Optional) nuke everything and start fresh
rm -rf ~/unattended ~/.config/unattended-claude
```

Don't `git push` from the v2 repo unless you've explicitly reviewed and want to. The standard rule applies here.

---

## Reference — files this doc points at

- `src/index.ts` — CLI dispatcher (12 commands)
- `src/commands/init.ts` — Section 2
- `src/commands/plan.ts` — Section 3 (skill-loading cwd logic)
- `src/commands/run.ts` — Sections 4, 5
- `src/commands/stop.ts` — Sections 6, 7
- `src/commands/schedule.ts` — Section 8 (launchd plist generation)
- `src/commands/status.ts` — Section 9a
- `src/commands/stats.ts` — Section 9b (jsonl token accounting)
- `src/commands/review.ts` — Sections 9c, 9d
- `src/commands/archive.ts` — Section 10 (archive bundle layout)
- `src/commands/todo.ts` — Section 11 (consolidate)
- `src/commands/attach.ts` — Section 4 (zellij attach + detach chord)
- `src/runtime/claude-session.ts` lines 80–103 — happy `--session-id` spike notes
- `tests/e2e.test.ts` — Section 12 (MockRuntime limit simulation)
- `DESIGN.md` §十五 — original e2e milestone this doc is anchored to
