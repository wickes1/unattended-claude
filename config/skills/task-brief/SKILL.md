---
name: task-brief
template_version: 1
description: Grill the user on each todo to produce frozen task docs for unattended execution. Use when ucl plan is invoked or when the user asks to plan tasks for unattended-claude.
---

# task-brief

Host an interactive planning session: take the loose items the user jotted into `~/unattended/todo.md` and turn each one into a self-contained task doc that the unattended-claude orchestrator can execute on its own during the next unattended window.

This is the only interactive checkpoint before the run. Once the worker is running unattended, nobody is there to answer a question, so an ambiguous task left in place will burn an episode and produce nothing. The goal is to *freeze* intent now — resolve every unknown while the user is still at the keyboard.

## Paths

The `ucl plan` command that invoked you passes the current `todo.md` contents and the tasks output directory in the initial prompt. If invoked manually without paths, default to `~/unattended/todo.md` and `~/unattended/tasks/`.

## Procedure

### 1. Read the todo

Read `todo.md`. Each line is a *candidate*. Only consider candidates that are:

- **Unchecked** (no leading `- [x]`)
- **Not skipped** (no trailing `<!-- skip -->` HTML comment on the line)

Ignore anything below a `## ── planned ──` (or similar) journal divider — those are already-processed entries kept for history.

Expect shorthand, half-sentences, and missing detail — resolving that is the whole point of this session.

### 2. Clarify each candidate — one question at a time

Work through the candidates in order. For each one, talk with the user until you can answer everything below. **Ask one question, wait for the answer, then ask the next.** Walls of questions are hard to answer.

- **Purpose** — what result should this task achieve? Why does it matter?
- **Workdir** — the absolute path of the repo / folder where work actually lands.
  - If the user names an existing repo, use that absolute path.
  - If the user is starting something new, propose `~/unattended/workdirs/<task-id>/` (auto-assigned scratch space). Confirm before writing.
  - For pure research / note-taking with no natural home, default to auto-assigned `~/unattended/workdirs/<task-id>/`.
  - Never default to `$HOME` — it pollutes home and causes cross-task conflicts.
- **Success criteria / Done** — concrete observable: what files exist, what tests pass, what report is written. Without this, the worker cannot self-declare done.
- **Context needed** — links, paths, docs, prior decisions the executor must read first.
- **Constraints** — explicit hard rules (e.g. no `git push`, no destructive operations, no touching `main`).
- **Serial flag** — set `serial: true` only if this task cannot run alongside others (whole-repo refactor, heavy git ops, system-config changes). Default `false`.

If an answer already covers a later aspect, skip the redundant question. Push back when a task is too vague to execute, or too large for one window. **Freezing fewer sharp tasks beats freezing many fuzzy ones.**

If the user says something like "just a thought, don't plan it" / "skip" — leave the todo line alone but append ` <!-- skip -->` so the next `ucl plan` does not re-ask. Move on.

### 3. Assign the task ID

Format: `YYYY-MM-DD-NN-slug`

- `YYYY-MM-DD` — today's date.
- `NN` — 01, 02, … incremented across all task docs created today (look at existing `tasks/YYYY-MM-DD-*.md` to find the next free number).
- `slug` — short kebab-case label (e.g. `grep-bench`, `link-check`, `refactor-state-store`).

Example: `2026-05-23-01-grep-bench`.

### 4. Write the task doc

Write to `~/unattended/tasks/<id>.md` using exactly this format:

```
---
id: <id>
title: <human-readable title>
workdir: <absolute path>
serial: <true | false>
created_at: <ISO-8601 timestamp>
---

# <title>

<Description: what this task achieves, why it matters, and the explicit done criteria. Include any context, links, or constraints the executor needs to read up-front.>

## Checklist

- [ ] <first concrete, executable step>
- [ ] <second concrete, executable step>
- [ ] ...

## Summary

```

Why each rule matters:

- **`workdir` is an absolute path to real working code**, never `~/unattended/` itself. Tasks sharing a workdir run sequentially in the same lane; tasks with different workdirs run in parallel. Split granularity with that in mind.
- **Auto-assigned workdirs** live at `~/unattended/workdirs/<id>/`. The worker creates the directory if missing.
- **Checklist items must be concrete and executable.** Each episode tracks progress against them; "improve the code" can't be verified done.
- **Leave `## Summary` empty.** The executor fills it in on task completion.
- **The Checklist section is optional** for tiny tasks where the description alone is enough — omit it rather than fake-pad.

### 5. Mark todo.md

For each candidate that produced a task doc, rewrite its `todo.md` line as:

```
- [x] <original text> → tasks/<id>
```

Preserve the original text; only flip the checkbox and append the arrow + task-id link. Do **not** reorder or rewrite other lines.

For skipped candidates, append ` <!-- skip -->` to the line as described in step 2. Don't tick them.

### 6. Confirm

When every candidate has been processed (planned or skipped), tell the user planning is complete and list the paths of all task docs created. This is an interactive session — no sentinel file needed. After the user confirms, end your message with exactly this sentence (do not paraphrase):

**"To run the tasks now: `ucl run`. To wait for the next scheduled window: leave it; `launchd` will trigger `ucl run` at the configured time."**

Do not invent other `ucl` subcommands.
