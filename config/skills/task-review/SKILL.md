---
name: task-review
template_version: 1
description: Walk through recent unattended-claude tasks (completed, paused, failed) with the user. Diagnose failures, suggest remediation, optionally produce a synthesis report. Use when ucl review is invoked.
---

# task-review

Brief the user on what unattended-claude has done since the last review. Lead with the conclusion, surface failures honestly, and make every next step actionable. The raw events and task docs already exist — your job is to *present* them well, not re-derive them.

## Paths

The `ucl review` command that invoked you passes a filtered subset of `state/events.jsonl` directly in the initial prompt, plus the absolute paths to `tasks/` (per-task docs with `## Summary` sections) and `state/tasks/` (per-task mutable state JSON). If `--synthesize` is set, the prompt also names a markdown report path you must write at the end.

If invoked manually, default to `~/unattended/`: read `state/events.jsonl` (most recent `run_start` onward), and pair each task ID seen there with `tasks/<id>.md` and `state/tasks/<id>.json`.

## Procedure

### 1. Read what happened since last run

From the event log subset in the prompt, extract every task ID and group events by task. For each task, also read:

- `tasks/<id>.md` — especially the `## Summary` section and the `## Checklist` tick state.
- `state/tasks/<id>.json` — current `state`, `paused_reason`, `context_compactions`, episode count.

You do not need to re-read the full event log line by line; you have it in the prompt. Use it to confirm timing, paused reasons, and episode boundaries.

### 2. Present concisely — do not paste raw data

Lead with **one sentence summarising the window**, then the **three most important facts**. Examples of the headline:

- "3 tasks done, 1 failed, 0 paused — net positive run."
- "1 task done, 2 paused at the window boundary (will auto-resume next window), 1 failed early."
- "Nothing finished — all 3 tasks paused on the 5-hour limit before progressing."

Ask whether the user wants the full per-task breakdown. Don't dump the report on them.

### 3. Diagnose every failed or paused task

For each task whose current `state` is `failed` or `paused` (other than the benign `schedule-boundary` pause, which is normal), give a concrete diagnosis:

- **Failed** — pull the symptom from `## Summary` (or the last few events if Summary is empty); name the single most useful next step. Vague ("it didn't work") is not acceptable.
- **Paused** — distinguish the reason: `rate-limit-5h`, `weekly-limit`, `context-full`, `user-stop`, `user-stop-now`, `orphan`. For `context-full`, mention how many compactions the task has accumulated — if it's climbing, suggest splitting the task. For `weekly-limit`, mention that *all* runs are frozen until the reset.

For `schedule-boundary` pauses, just note them — they resume automatically next window and need no action.

### 4. Surface trends and follow-ups

Briefly call out anything the user should act on outside of individual task fixes:

- Repeated context-full pauses on the same task → scope is too large; suggest splitting.
- Repeated 5-hour-limit hits across multiple windows → subscription utilisation is saturated; suggest shortening windows or reducing parallelism.
- Tasks still in `tasks/` long after completion → suggest `ucl archive --done-before=7d` to keep the active set lean.

Keep this to bullets. No essays.

### 5. Synthesis mode (only when the prompt names a report file)

If the initial prompt provides a synthesis file path, write a markdown report there before ending the session. Structure:

```
# Review — <ISO date range>

## Headline
<one sentence>

## Done
- <id> — <one-line outcome>
...

## Failed
- <id> — <symptom> → <suggested next step>
...

## Paused (non-boundary)
- <id> — <reason> → <suggested next step>
...

## Trends
- <bullets, only if applicable>

## Follow-ups
- <bullets, only if applicable>
```

Confirm to the user that the report was written, with its absolute path.

## Discipline

- **Be honest about failure.** A window where two of three tasks failed is a two-failure window — say so clearly. The user can only act on problems they are told about.
- **Schedule-boundary pauses are not failures.** Don't pad the failure count with them.
- **Don't suggest fixes you can't justify from the evidence.** If the summary is empty and the events are sparse, say "summary missing, can't diagnose from here — re-run with more logging" rather than guess.
- **End cleanly.** This is an interactive session: stop after the user is satisfied; no sentinel file needed.
