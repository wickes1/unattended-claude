# unattended-claude

Demand-shift Claude Code: move queued work off your active 5-hour rate window into off-hours so your peak quota stays available for interactive work.

> **v0.1** — single-task end-to-end live-verified on 2026-05-25 with `bin: claude`. Parallel dispatch, cross-window resume, and the Happy bin path ship green under unit/integration tests but are not yet live-walked against the current Claude CLI; see *Known limitations* below.

## Install

```bash
bun scripts/install.ts
# ucl is now at ~/.local/bin/ucl
ucl --version
```

Re-run the script anytime to refresh the symlink. `bun scripts/uninstall.ts` reverses it (config and runtime data survive).

## 30-second quickstart

| Step | Command | What happens |
|---|---|---|
| 1 | `ucl init` | builds `~/unattended/` and `~/.config/unattended-claude/ucl.yaml` |
| 2 | edit `~/unattended/todo.md` | one inbox line per intent, no checkboxes needed |
| 3 | `ucl plan` | interactive grilling → frozen `tasks/<YYYY-MM-DD-NN-slug>.md` |
| 4 | `ucl run --until 06:30` | daemonizes the worker; add `--foreground` to keep it in the current terminal |
| 5 | next morning, `ucl review` | print the SUMMARY of a recent task (`--synthesize` writes a multi-task report) |

## zellij operation cheat sheet

`ucl run` opens one zellij session (`unattended-claude`) with one tab per in-flight task. Default zellij keybindings inside that session:

| Action | Keys |
|---|---|
| switch tabs forward / backward | `Ctrl-t` then `→` / `←` |
| detach session (worker keeps running) | `Ctrl-o` then `d` |
| send current pane to background | `Ctrl-p` then `e` |
| list sessions from outside | `ZELLIJ_SOCKET_DIR=/tmp/zellij zellij list-sessions` |
| reattach | `ucl attach` (or `zellij attach unattended-claude`) |
| **do NOT kill the session manually** | `Ctrl-q` / `zellij kill-session` will leave tasks stranded with no graceful pause — use `ucl stop` instead |

All `ucl` commands force `ZELLIJ_SOCKET_DIR=/tmp/zellij` (macOS `$TMPDIR` is too long for Unix sockets). If your interactive shell uses a different socket dir, `zellij list-sessions` will not show ucl's session.

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

`~/.config/unattended-claude/ucl.yaml` — runtime dir, schedule windows, parallelism cap, wind-down lead, etc. See `config/ucl.yaml` for the template.

Config fallback: `--config <path>` flag → `UNATTENDED_CLAUDE_CONFIG` env → `~/.config/unattended-claude/ucl.yaml`.

## Known limitations (v0.1)

| Limitation | Root cause | Mitigation |
|---|---|---|
| `bin: happy` `/status` session-id discovery times out | Happy 1.1.8 `/status` panel does not render a parseable `Session ID:` line within the 10s timeout | Switch to `bin: claude` in `ucl.yaml`. Happy support is shipped but flagged experimental |
| `claude --session-id <uuid>` ignored in interactive TUI | Claude CLI 2.1.150 honors `--session-id` only in headless `-p` mode | Single-window single-task path works; cross-window `--resume` is unreliable until upstream behavior changes |
| Cross-window resume under `bin: happy` | Compound of the two above | Use `bin: claude` and single-window tasks under v0.1 |

The v0.1 demo path (`bin: claude`, one task, single window) is the one verified live. The rest of the command surface ships green under unit and integration tests.

## Project status

v0.1 — workflow design plus a live single-task demo. Active development continues but v0.1 is a deliberate freeze point.
