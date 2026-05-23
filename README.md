# unattended-claude

Demand-shift Claude Code: move queued work off your active 5-hour window into off-hours, so your peak quota stays yours.

## Install

```bash
bun scripts/install.ts
# ucl is now at ~/.local/bin/ucl
ucl --version
```

Re-run the script anytime to refresh the symlink and install metadata. `bun scripts/uninstall.ts` reverses it (config and runtime data survive).

## 30-second quickstart

| Step | Command | What happens |
|---|---|---|
| 1 | `ucl init` | builds `~/unattended/` and `~/.config/unattended-claude/ucl.yaml` |
| 2 | edit `~/unattended/todo.md` | one inbox line per intent, no checkboxes |
| 3 | `ucl plan` | interactive grilling → frozen `tasks/<YYYY-MM-DD-NN-slug>.md` |
| 4 | `ucl run --until 06:30` | starts the zellij worker session, runs until the window ends |
| 5 | next morning, `ucl review` | AI walks you through what happened, optional `--synthesize` report |

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
| `ucl run [--until HH:MM\|+Nm]` | start the worker; stops at the window edge, queue empty, or `ucl stop` |
| `ucl stop [--now]` | graceful pause (`--now` for hard kill) |
| `ucl schedule list / add / remove / install / uninstall` | manage launchd entries from `schedule.windows` |
| `ucl status` | queue snapshot, no AI |
| `ucl stats [--days N]` | historical token usage, no AI |
| `ucl review [<id>] [--synthesize] [--since 24h]` | review a recent run; print one task's SUMMARY; or write a synthesis report |
| `ucl archive <id> / --done-before Nd` | archive a task bundle |
| `ucl unarchive <id>` | restore from archive |
| `ucl todo --consolidate` | move all `[x]` lines in `todo.md` to a dated journal section |
| `ucl attach` | reattach the worker zellij session |
| `ucl doctor [--json]` | preflight / health check |

`ucl <command> --help` for command-specific flags.

## Configuration

`~/.config/unattended-claude/ucl.yaml` — runtime dir, schedule windows, parallelism cap, wind-down lead, etc. See `config/ucl.yaml` for the template and `DESIGN.md` §十三 for the full schema.

Config fallback: `--config <path>` flag → `UNATTENDED_CLAUDE_CONFIG` env → `~/.config/unattended-claude/ucl.yaml`.

## Architecture / design

- [DESIGN.md](./DESIGN.md) — single source of truth for design decisions
- [QUICK-DEMO.md](./QUICK-DEMO.md) — full manual runbook for verifying behavior on a real machine

## Status

v2, in active development. v1 lives at `../legacy/cc-nightshift/` for reference only.
