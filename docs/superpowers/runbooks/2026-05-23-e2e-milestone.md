# Live e2e milestone runbook (Phase 1)

> Reference: `DESIGN.md` §十五 (e2e milestone scenario).
> Goal: prove v2 actually demand-shifts against real `claude` / `happy` / `zellij` — not just mock-runtime.
> Status: **not yet executed**. Fill in actual output inline as you run.
> Audience: you (sitting at keyboard, ~2-3h budget).

---

## Why this runbook exists

Every test we have today is mock-based. Cross-window resume, wind-down injection, rate-limit parsing, `--session-id` honor, `usage_snapshot` emission, archive auto-flow — all of it has been verified in `MockRuntime`, never against a real claude TUI for a full window cycle. F01 spike was a one-shot manual probe; this is the supervised end-to-end.

## Acceptance criteria

| # | Property | How verified |
|---|---|---|
| A | `--session-id <uuid>` actually scopes the claude jsonl | `state/tasks/<id>.json.claude_session_id` == jsonl filename basename |
| B | Wind-down prompt fires at T-N min | `state/events.jsonl` has `wind_down_injected` event with `at_remaining_seconds` near `wind_down_lead_minutes * 60` |
| C | Pause at window end is graceful, not hard kill | `state/tasks/<id>.json.paused_reason == "schedule-boundary"` |
| D | Resume picks up history (no context loss) | AI's first message in episode 2 references work from episode 1 verbatim |
| E | `ucl stats` reports non-zero token usage with utilization % | values present, `usage_snapshot` events in `state/events.jsonl` |
| F | Archive moves the bundle (task doc + state + workdir) | `archive/<id>/` contains all 4 expected files |

**Failure of A or D = blocker. Other failures = log + continue.**

---

## Pre-flight

```bash
cd ~/Fonds/Workshop/unattended-claude/unattended-claude

# Tools present
which ucl       # → ~/.local/bin/ucl
which claude    # → claude binary path
which happy     # → happy binary path
which zellij    # → zellij binary path
ucl --version   # → unattended-claude 0.1.0

# Auth state
echo "${ANTHROPIC_API_KEY:-unset}"   # MUST be "unset" — claude CLI will refuse if set
# If set: unset ANTHROPIC_API_KEY

# Clean slate
ls ~/unattended/ 2>&1                # if exists, decide: nuke or keep
zellij list-sessions --no-formatting 2>&1 | grep -i unattended    # if any: zellij delete-session <name> --force
```

**Milestone config overlay** — temporarily override 2 knobs to shorten the cycle:

```yaml
# ~/.config/unattended-claude/ucl.yaml
execution:
  wind_down_lead_minutes: 2          # default 5; shorten for ~5-min cycle
  episode_hard_timeout: 10m          # default 60m; cap blast radius
archive:
  auto_after_days: 0                 # skip auto-archive during milestone; we'll trigger manually
```

Note actual `runtime.bin` in your config — `claude` (pre-gen session-id path) and `happy` (post-hoc `/status` discovery path) have different verification at step 5. **Run the milestone with BOTH bins in sequence if time allows; if not, pick the one you'll actually use in production.**

---

## Steps

### Step 1 — `ucl init`

```bash
ucl init
```

| Check | Expected | Actual |
|---|---|---|
| `~/unattended/` created with subdirs `tasks/ workdirs/ archive/ state/ logs/` | yes | ⬜ |
| `~/.config/unattended-claude/ucl.yaml` exists | yes | ⬜ |
| Idempotent (re-run safe) | yes | ⬜ |

### Step 2 — Edit `~/unattended/todo.md`

```
- write a hello.py at task workdir printing "hello from window 1", sleep 4 min, then print "still alive", then write result.md saying what was done
```

(One line; the workdir will be auto-assigned by plan since none specified.)

### Step 3 — `ucl plan`

```bash
ucl plan
```

Interactive — claude opens, applies `task-brief` skill, grills for purpose/workdir/output/constraints/completion. Answer each. Skill should produce `~/unattended/tasks/2026-05-23-01-<slug>.md`.

| Check | Expected | Actual |
|---|---|---|
| Skill `task-brief` actually loaded (claude greeting mentions it OR follows the 5-question structure) | yes | ⬜ |
| Task doc has frontmatter with `workdir: ~/unattended/workdirs/<id>/` (auto-assigned) | yes | ⬜ |
| Checklist section present | yes | ⬜ |
| `todo.md` line now has `[x]` + link to task doc | yes | ⬜ |

### Step 4 — `ucl run --until +5m`

```bash
ucl run --until +5m
```

| Check | Expected | Actual |
|---|---|---|
| zellij session `unattended-claude` exists (`zellij list-sessions`) | yes | ⬜ |
| Single tab opened with claude TUI active | yes | ⬜ |
| `state/tasks/<id>.json` exists with `state: "running"` | yes | ⬜ |

### Step 5 — Verify `--session-id` honor (CRITICAL — gate A)

```bash
# In another shell, while task is running:
TASK_ID=$(ls ~/unattended/tasks/ | head -1 | sed 's/\.md$//')
SESSION_ID=$(jq -r .claude_session_id ~/unattended/state/tasks/$TASK_ID.json)
echo "Expected session id: $SESSION_ID"

# Find the jsonl claude is writing to
ls -la ~/.claude/projects/*/${SESSION_ID}.jsonl 2>&1
# OR if bin=happy and post-hoc discovery: cat the state file at slightly later time
```

| bin | Check | Expected | Actual |
|---|---|---|---|
| claude | `~/.claude/projects/<encoded-cwd>/${SESSION_ID}.jsonl` exists | yes | ⬜ |
| happy | `state/tasks/<id>.json.claude_session_id` populated within ~30s of run start (via `/status` polling) | yes | ⬜ |

**If FAIL**: this is gate A. Stop here. The `--resume` path won't work later. Investigate `src/runtime/claude-session.ts` Happy mode detection or fall back to `runtime.bin: claude`.

### Step 6 — Watch sleep 4 min

In the zellij tab (`ucl attach`), AI should write hello.py, run it, then enter the sleep. Verify by reading the workdir:

```bash
ls ~/unattended/workdirs/$TASK_ID/
cat ~/unattended/workdirs/$TASK_ID/hello.py
```

### Step 7 — Wind-down injection (T-2min mark; gate B)

At T+3min (= window end - 2min), worker should inject the wind-down prompt.

```bash
# T+3min real-time wall clock — watch
tail -f ~/unattended/state/events.jsonl
# expect a line:
# {"ts":"...","event":"wind_down_injected","task":"<id>","at_remaining_seconds":120,...}
```

| Check | Expected | Actual |
|---|---|---|
| `wind_down_injected` event written | yes | ⬜ |
| `at_remaining_seconds` between 100-130 | yes | ⬜ |
| Prompt visible in zellij tab (AI replies acknowledging) | yes | ⬜ |

### Step 8 — Graceful pause at T+5min (gate C)

At T+5min, worker should:
1. Send `/quit` to each tab
2. Wait 5s
3. Force kill if still up
4. Destroy zellij session
5. Write `state/tasks/<id>.json.paused_reason = "schedule-boundary"`

```bash
# After T+5min:
zellij list-sessions 2>&1            # should NOT list unattended-claude
jq . ~/unattended/state/tasks/$TASK_ID.json
# expect: state="paused", paused_reason="schedule-boundary", claude_session_id preserved
```

| Check | Expected | Actual |
|---|---|---|
| zellij session destroyed | yes | ⬜ |
| `state == "paused"` | yes | ⬜ |
| `paused_reason == "schedule-boundary"` | yes | ⬜ |
| `claude_session_id` UNCHANGED from step 5 | yes | ⬜ |
| `events.jsonl` has `task_paused` with the reason | yes | ⬜ |

### Step 9 — Resume next window (CRITICAL — gate D)

```bash
ucl run --until +5m
```

| Check | Expected | Actual |
|---|---|---|
| zellij session re-created with same name | yes | ⬜ |
| Tab launched with `happy --resume <uuid>` OR `claude --resume <uuid>` (per bin) | yes | ⬜ |
| AI's first visible response references work from prior episode (e.g. "continuing from where I was sleeping") | yes | ⬜ |
| `state/tasks/<id>.json.state == "running"` again | yes | ⬜ |
| Hidden wake-up prompt visible in pane history (`zellij action dump-screen ...`) | yes | ⬜ |

**If FAIL**: this is gate D. The resume isn't picking up history. Check `src/orchestrator/prompt-builder.ts` wake-up branch, and verify the jsonl from step 5 still exists (claude may have moved it).

### Step 10 — Task completion

AI writes `result.md`, signals done (sentinel file OR enters input-idle state).

```bash
# After AI claims done:
cat ~/unattended/workdirs/$TASK_ID/result.md
jq .state ~/unattended/state/tasks/$TASK_ID.json     # → "done"
```

| Check | Expected | Actual |
|---|---|---|
| `result.md` present, content makes sense | yes | ⬜ |
| `state == "done"` | yes | ⬜ |
| `events.jsonl` has `task_done` | yes | ⬜ |

### Step 11 — `ucl review <id>`

```bash
ucl review $TASK_ID
```

| Check | Expected | Actual |
|---|---|---|
| Prints SUMMARY section from task doc | yes | ⬜ |
| No AI invocation (non-interactive single-task path) | yes | ⬜ |

### Step 12 — `ucl stats` (gate E)

```bash
ucl stats
```

| Check | Expected | Actual |
|---|---|---|
| Day row exists for today with task count 1/0 | yes | ⬜ |
| Token usage > 0 | yes | ⬜ |
| Subscription utilization shows N% or `n/a` (depending on `subscription.weekly_token_cap` setting) | yes | ⬜ |
| `state/events.jsonl` has ≥1 `usage_snapshot` event | yes | ⬜ |

**If utilization is `n/a`** — you haven't set `subscription.weekly_token_cap` in config. That's expected on a fresh install; set it if you want the metric.

### Step 13 — Archive (gate F)

```bash
ucl archive $TASK_ID
# or to test the bulk flag:
ucl archive --done-before=0d
```

| Check | Expected | Actual |
|---|---|---|
| `archive/$TASK_ID/task.md` exists | yes | ⬜ |
| `archive/$TASK_ID/state.json` exists | yes | ⬜ |
| `archive/$TASK_ID/workdir/` exists with hello.py + result.md | yes | ⬜ |
| `archive/$TASK_ID/handoff.md` ONLY if context-full was hit (skip otherwise) | n/a | ⬜ |
| Original `tasks/$TASK_ID.md` removed | yes | ⬜ |
| `events.jsonl` has `archive_manual` (or `archive_auto`) | yes | ⬜ |

---

## Failure mode quick reference

| Symptom | Likely cause | Action |
|---|---|---|
| Step 5 `--session-id` mismatch (bin=claude) | claude CLI version doesn't support `--session-id` | check `claude --help` for the flag |
| Step 5 session-id never populates (bin=happy) | `/status` polling not finding info, or happy version mismatch | check `src/runtime/claude-session.ts:91-` Happy mode block; verify happy version with `happy --version` |
| Step 7 no wind-down event | F05 emission not wired, or wind-down check not firing | grep `wind_down_injected` in src/; check `pollUntilDone` clock |
| Step 8 zellij session NOT destroyed | graceful pause hung; force-kill path didn't run | manual `zellij delete-session unattended-claude --force`; investigate `lifecycle.suspendForShutdown` |
| Step 9 AI starts fresh (no history) | gate D fail — resume not actually using `--resume` flag, OR jsonl was moved | check `state/events.jsonl` for `task_resumed` event payload; inspect prompt-builder output |
| Step 12 token usage 0 | `usage_snapshot` not emitted, or stats reading wrong source | check `src/usage.ts` + `src/commands/stats.ts` |

## Post-run hygiene

```bash
# Roll back milestone config overlay
$EDITOR ~/.config/unattended-claude/ucl.yaml
# restore: wind_down_lead_minutes: 5, episode_hard_timeout: 60m, auto_after_days: 7

# Clean up if you want a fresh start
rm -rf ~/unattended/
zellij delete-session unattended-claude --force 2>/dev/null
```

## Reporting

After running, fill the Actual column inline AND add a bottom section:

```markdown
## Run log (yyyy-mm-dd hh:mm)

- bin tested: claude / happy / both
- gates passed: A B C D E F
- gates failed: <list with notes>
- duration: ~Nm
- surprises:
- decisions: e.g. "switch default bin to claude until happy /status timing fixed"
```

Commit when done: `docs(runbooks): live e2e milestone run yyyy-mm-dd`.
