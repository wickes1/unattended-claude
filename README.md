# unattended-claude

**Use your Claude Pro/Max subscription overnight.** `ucl` queues Claude Code work into a brief, walks each task through a real `claude` session in the background, and appends a summary you read in the morning — so your peak-hour quota stays for interactive work.

```
todo.md  ──►  ucl plan  ──►  tasks/<id>.md  ──►  ucl run  ──►  ## Summary
 (inbox)      (grill +     (frozen brief)     (zellij +     (appended to
              freeze)                          claude)        the same doc)
```

## Why this exists

If you pay for Claude Pro or Max, the 5-hour rate window is yours to spend — but most of it falls outside the hours you sit at the keyboard. `ucl` shifts queued work into that idle quota.

Three things are deliberately different from related tools:

1. **Subscription-native.** Every task runs through a real `claude` CLI session in a zellij pane. No API key, no per-token billing — your Pro/Max quota is the only cost.
2. **Brief-first discipline.** You don't toss prompts at the runtime. `ucl plan` interactively grills each todo into a frozen task brief (scope, workdir, completion criteria) before it runs. The runtime appends `## Summary` to the same doc when done, so every task leaves a paper trail.
3. **Happy Coder integration for remote / mobile / web monitoring.** Set `bin: happy` in `ucl.yaml` (after [setting up Happy Coder](https://happy.engineering)) and `ucl` routes every task through the `happy` wrapper instead of bare `claude`. The prompt builder forces each task to call `mcp__happy__change_title`, so every unattended task surfaces in the Happy mobile app and at [app.happy.engineering](https://app.happy.engineering/) with a `[ucl] <title>` label — watch progress, interrupt, or hand the task fresh instructions from your phone or any browser while you're away from the desk.

## How it compares

| | unattended-claude | [Claude Code](https://github.com/anthropics/claude-code) | [claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry) | [Hermes Agent](https://hermes-agent.nousresearch.com/) | [OpenClaw](https://github.com/openclaw/openclaw) |
|---|---|---|---|---|---|
| **AI backend** | Claude subscription (Pro/Max) | Subscription or API | Subscription (wraps `claude`) | BYOK / API | BYOK / API |
| **Marginal cost per task** | $0 (within quota) | $0 if subscription, else $/token | $0 (within quota) | $/token | $/token |
| **Off-hours / scheduled runs** | ✅ launchd windows, `--until HH:MM` | ❌ interactive only | ⚠️ unblocks after rate limit, not scheduled start | ✅ scheduled automations | ❌ chat-driven |
| **Parallel multi-task** | ✅ zellij tabs (`max_parallel_tabs`) | ❌ one session | ❌ one session | ✅ subagents | ❌ |
| **Brief → run → summary discipline** | ✅ enforced by `ucl plan` | ❌ ad-hoc | ❌ pass-through | ⚠️ memory/skills, no frozen brief | ❌ |
| **Cross-window resume after rate limit** | ⚠️ `--resume` + HANDOFF.md path is implemented; reliability currently blocked by the upstream issues listed under [Known limitations](#known-limitations) | ❌ | ✅ waits + sends "continue" | n/a | n/a |
| **Remote / mobile / web monitoring** | ✅ via Happy Coder (`bin: happy` — mobile app + [app.happy.engineering](https://app.happy.engineering/)) | ❌ desk only | ❌ desk only | ✅ chat platforms | ✅ chat platforms |
| **Primary surface** | CLI + your terminal (+ Happy mobile / web, optional) | CLI / IDE | Shell wrapper | CLI + chat platforms | Multi-platform chat |
| **Best fit** | Heavy Claude subscription user with backlog of well-scoped tasks | Anyone using Claude | Hitting rate limits during long sessions | Generic personal AI agent | Personal assistant in your chat apps |

If you don't already pay for Claude Pro/Max, the subscription-native angle isn't useful to you — Hermes Agent or any BYOK orchestrator is a closer fit.

## Install

### Homebrew

```bash
brew install wickes1/tap/unattended-claude
```

The formula lives in [wickes1/homebrew-tap](https://github.com/wickes1/homebrew-tap). If `brew` reports the formula is not available yet, the tap may still be catching up — fall back to *From source* below.

### From source (today)

```bash
git clone https://github.com/wickes1/unattended-claude.git
cd unattended-claude
bun install
bun scripts/install.ts          # symlinks ucl → ~/.local/bin/ucl
ucl --version
```

Requires `bun >= 1.2.19`, `zellij >= 0.44`, and the `claude` CLI (Anthropic's Claude Code) on `$PATH`. `bun scripts/uninstall.ts` reverses the install. Re-run the install script anytime to refresh the symlink.

## Quick demo

```bash
# 1. one-time setup
ucl init                                    # → ~/unattended/ + ~/.config/unattended-claude/ucl.yaml

# 2. drop an intent
echo "- write fib.py that prints first 12 Fibonacci numbers, save to fib.txt" \
    >> ~/unattended/todo.md

# 3. grill it into a frozen brief (interactive — task-brief skill asks scope/workdir/done-when)
ucl plan
# → tasks/2026-05-25-01-fib-twelve.md

# 4. run unattended (returns to shell immediately; window closes at 06:30)
ucl run --until 06:30
# orchestrator detached as PID 22443, logs at ~/unattended/logs/orchestrator-*.log

# 5. come back — read the verdict
ucl status
# planned: 0  running: 0  paused: 0  done: 1  failed: 0
ucl review 2026-05-25-01-fib-twelve
# ## Summary
# - Wrote fib.py in the workdir; outputs first 12 Fibonacci numbers, one per line.
# - Executed `python3 fib.py > fib.txt`; fib.txt contains the expected 12 lines.
# - All checklist items satisfied; no network or git operations used.
```

If you want to watch live, swap step 4 for `ucl run --foreground` or `ucl attach` after it daemonizes.

## Commands

| Command | Purpose |
|---|---|
| `ucl init` | first-time setup; idempotent |
| `ucl plan [--force]` | interactive: convert new `todo.md` lines into frozen task docs |
| `ucl run [--until HH:MM\|+Nm] [--foreground]` | start the worker; stops at the window edge, queue empty, or `ucl stop` |
| `ucl stop [--now]` | graceful pause (`--now` for hard kill) |
| `ucl schedule list / add / remove / install / uninstall` | manage launchd entries from `schedule.windows` |
| `ucl status` | queue snapshot, no AI |
| `ucl stats [--days N]` | historical token usage, no AI |
| `ucl review [<id>] [--synthesize] [--since 24h]` | print a recent task's SUMMARY, or synthesize a report across tasks |
| `ucl archive <id> / --done-before Nd` | archive a task bundle |
| `ucl unarchive <id>` | restore from archive |
| `ucl todo --consolidate` | move all `[x]` lines in `todo.md` to a dated journal section |
| `ucl attach` | reattach the worker zellij session |
| `ucl doctor [--json]` | preflight / health check |

`ucl <command> --help` for command-specific flags.

## Configuration

`~/.config/unattended-claude/ucl.yaml` — runtime dir, schedule windows, parallelism cap, wind-down lead, etc. See `config/ucl.yaml` for the annotated template.

Config fallback: `--config <path>` flag → `UNATTENDED_CLAUDE_CONFIG` env → `~/.config/unattended-claude/ucl.yaml`.

## zellij operation cheat sheet

`ucl run` opens one zellij session (`unattended-claude`) with one tab per in-flight task.

| Action | Keys |
|---|---|
| switch tabs forward / backward | `Ctrl-t` then `→` / `←` |
| detach session (worker keeps running) | `Ctrl-o` then `d` |
| send current pane to background | `Ctrl-p` then `e` |
| list sessions from outside | `ZELLIJ_SOCKET_DIR=/tmp/zellij zellij list-sessions` |
| reattach | `ucl attach` (or `zellij attach unattended-claude`) |
| **do NOT kill the session manually** | `Ctrl-q` / `zellij kill-session` strands tasks — use `ucl stop` instead |

All `ucl` commands force `ZELLIJ_SOCKET_DIR=/tmp/zellij` (macOS `$TMPDIR` is too long for Unix sockets). If your interactive shell uses a different socket dir, `zellij list-sessions` won't show ucl's session.

## Known limitations

| Limitation | Root cause | Mitigation |
|---|---|---|
| `bin: happy` session-id discovery times out (logged as warn, not fatal) | Happy 1.1.8's `/status` panel doesn't render a parseable `Session ID:` line within 10s | Tasks run and complete fine; only cross-window `--resume` and per-episode `ucl stats` for this task are unavailable (no UUID to look up the jsonl by). Switch to `bin: claude` if you need either |
| `claude --session-id <uuid>` ignored in interactive TUI | Claude CLI 2.1.150 honors `--session-id` only in headless `-p` mode | Single-window single-task path works; cross-window `--resume` is unreliable until upstream behavior changes |
| Cross-window resume reliability | Compound of the two above | Use `bin: claude` and size tasks to fit one rate window |

Both single-task paths — `bin: claude` and `bin: happy` — have been verified live end-to-end. The rest of the command surface is covered by unit and integration tests.
