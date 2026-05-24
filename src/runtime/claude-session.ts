/**
 * Layer B — interactive-zellij runtime (v2 §4.4 / §9).
 *
 * Wraps an interactive claude/happy TUI inside a zellij tab: handles dialogs,
 * detects rate-limit / weekly-limit / context-full / completion, and injects
 * a wind-down prompt at a scheduled boundary so the AI can stop cleanly.
 *
 * The ZellijOps interface is the one justified abstraction over v1: it lets
 * pollUntilDone and runClaudeSession be unit-tested without spawning a real
 * zellij server.
 */
import { readFileSync } from "node:fs"
import { RealClock } from "../clock.ts"
import type { Config } from "../config.ts"
import type { Clock, EpisodeResult, InvokeOpts, Logger, Runtime, WindDownInfo } from "../types.ts"
import {
  hasInputPrompt,
  matchContextLimit,
  matchRateLimit,
  matchWeeklyLimit,
  nonEmptyLines,
  PATTERNS,
} from "./detectors.ts"
import { discoverViaStatus } from "./session-discovery.ts"
import {
  capture as realCapture,
  closeTab as realCloseTab,
  killSession,
  newSession,
  newTab as realNewTab,
  pasteFile as realPasteFile,
  pasteFileNoSubmit as realPasteFileNoSubmit,
  pipePane as realPipePane,
  sendKeys as realSendKeys,
  sendText as realSendText,
  sessionAlive as realSessionAlive,
  submitInput as realSubmitInput,
} from "./zellij.ts"

/**
 * Injected when the schedule window is about to end. The AI is expected to
 * stop cleanly so its conversation can be resumed in the next window.
 */
export const WIND_DOWN_PROMPT =
  "Schedule window is ending soon. Please finish the smallest unit you're currently working on (current file edit, running test) and don't start any new large work. Stop and wait once done — I'll close this session shortly. Your conversation history will be preserved and resumed in the next window."

/**
 * Build the HANDOFF-writing prompt the orchestrator injects when context-full
 * is detected. The fresh next session will read this file via
 * PromptBuilder.resumeWithHandoff to pick up.
 */
export function buildHandoffPrompt(handoffPath: string): string {
  return (
    `The context is running low. Before it resets, write a concise HANDOFF.md to ` +
    `${handoffPath} summarizing: (1) original task goal, (2) what you've done so far, ` +
    `(3) current state of code/files, (4) what comes next, (5) any open decisions. ` +
    `Use markdown. After writing the file, reply with the single line: READY`
  )
}

const STRAY_QUESTION_REPLY =
  "Proceed with your best judgment and document the assumption in HANDOFF.md."
const MAX_STRAY_REPLIES = 2

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Whether the last few lines contain a sentence ending with a question mark. */
function hasRecentQuestion(lines: string[]): boolean {
  return lines.slice(-6).some((l) => PATTERNS.QUESTION.test(l))
}

/**
 * Zellij operations consumed by the session driver. Real impl lives in
 * `./zellij.ts`; tests inject a fake.
 */
export interface ZellijOps {
  newTab(session: string, tab: string): Promise<void>
  closeTab(session: string, tab: string): Promise<void>
  sendKeys(session: string, tab: string, ...keys: string[]): Promise<void>
  sendText(session: string, tab: string, text: string): Promise<void>
  pasteFile(session: string, tab: string, file: string): Promise<void>
  pasteFileNoSubmit(session: string, tab: string, file: string): Promise<void>
  submitInput(session: string, tab: string): Promise<void>
  pipePane(session: string, tab: string, file: string): Promise<void>
  capture(session: string, tab: string, lines: number): Promise<string>
  sessionAlive(session: string): Promise<boolean>
}

/** Default ZellijOps backed by the real zellij module. */
export const realZellijOps: ZellijOps = {
  newTab: realNewTab,
  closeTab: realCloseTab,
  sendKeys: realSendKeys,
  sendText: realSendText,
  pasteFile: realPasteFile,
  pasteFileNoSubmit: realPasteFileNoSubmit,
  submitInput: realSubmitInput,
  pipePane: realPipePane,
  capture: realCapture,
  sessionAlive: realSessionAlive,
}

/**
 * Build the shell command that launches Claude inside a zellij pane.
 *
 * In v2 the `--dangerously-skip-permissions` flag is NOT hardcoded here — we
 * rely on `cfg.runtime.extraArgs` (set by the `ucl init` template) so the
 * exact arg list is configurable and we avoid double-flagging.
 *
 * Truth table (F01, 2026-05-23):
 *   bin=claude, first launch  → `claude --session-id <uuid> <extra>`   (claude honors --session-id)
 *   bin=claude, resume        → `claude --resume <uuid> <extra>`
 *   bin=happy,  first launch  → `happy <extra>`                        (NO --session-id; Happy 1.1.8 swallows it)
 *   bin=happy,  resume        → `happy --resume <uuid> <extra>`        (Happy forwards --resume)
 *
 * For bin=happy first launch, opts.claudeSessionId is expected to be empty/unset
 * (the orchestrator does NOT pre-generate). The discovered UUID is captured
 * after launch via discoverViaStatus and persisted for subsequent resumes.
 */
export function buildLaunchCommand(cfg: Config, opts: InvokeOpts): string {
  const flags: string[] = []
  if (opts.resume) {
    flags.push(`--resume ${opts.claudeSessionId}`)
  } else if (cfg.runtime.bin !== "happy") {
    // bin=claude (or any non-happy bin) first launch: pre-gen UUID flows through.
    flags.push(`--session-id ${opts.claudeSessionId}`)
  }
  // bin=happy first launch: emit no session flag — Happy swallows --session-id.
  const args = [...flags, ...cfg.runtime.extraArgs].join(" ")
  // Prepend `command ` so that user shell aliases / functions (e.g. an
  // interactive `alias claude='happy --yolo'` in ~/.zshrc) cannot intercept
  // the launch. `command` is a POSIX builtin (bash + zsh) that bypasses
  // aliases AND functions, falling through to the $PATH lookup. Without this,
  // running `claude` inside a zellij interactive shell hits the user's alias
  // and silently invokes a different binary — surfacing as Bug 2 in the
  // 2026-05-23 live e2e probe.
  return `command ${cfg.runtime.bin} ${args}`.trim().replace(/ +/g, " ")
}

/**
 * Dialog automation (v1 §4.4.1, ported verbatim). Goal-driven: each round
 * first checks whether the input prompt has been reached, otherwise dismisses
 * the trust-folder dialog. Returns true = ready; false = timeout.
 */
export async function handleDialogs(
  session: string,
  tab: string,
  cfg: Config,
  log: Logger,
  clock: Clock,
  z: ZellijOps = realZellijOps,
): Promise<boolean> {
  const deadline = clock.now().getTime() + cfg.detection.dialogTimeoutMs
  let trustHandled = false

  // No settle delay here — the paste race against SessionStart-hook streaming
  // is handled later in S5b by pasteWithVerify (capture-and-retry until the
  // pasted content is visible in the input field). Returning early on first
  // `❯` detection is fine because the verify loop will paste-retry until it
  // lands.

  while (clock.now().getTime() < deadline) {
    const text = await z.capture(session, tab, 40)
    const lines = nonEmptyLines(text)

    if (hasInputPrompt(lines)) return true

    if (!trustHandled && PATTERNS.TRUST_DIALOG.test(text)) {
      log.log("info", "dialog: trust folder → Enter")
      await z.sendKeys(session, tab, "Enter")
      trustHandled = true
    }
    await clock.sleep(cfg.detection.dialogPollIntervalMs)
  }
  log.log("error", "dialog timeout — could not reach the input prompt")
  return false
}

/**
 * After context-full is detected, ask the AI to write HANDOFF.md and wait
 * up to opts.handoffTimeoutMs for the file to appear (authoritative) or for
 * a fresh "READY" line in the captured pane (secondary signal).
 *
 * Returns true = handoff was written (file exists), false = timeout
 * (degraded recovery — next episode will resume with a generic cue).
 *
 * The file existing is the primary contract: if Claude wrote the file but
 * never printed READY, we still treat it as success.
 */
async function writeHandoffOnContextFull(
  opts: InvokeOpts,
  log: Logger,
  clock: Clock,
  z: ZellijOps,
): Promise<boolean> {
  await z.sendText(opts.parentSession, opts.tabName, buildHandoffPrompt(opts.handoffPath))
  const deadline = clock.now().getTime() + opts.handoffTimeoutMs
  // We only count a READY line that appears AFTER the prompt was injected.
  // The injection's own echo can include "READY" (it's inside the prompt
  // text we just sent), so we wait one capture before considering READY.
  let sawCaptureAfterInject = false

  while (clock.now().getTime() < deadline) {
    // Primary signal: file exists.
    if (await Bun.file(opts.handoffPath).exists()) {
      return true
    }
    // Secondary signal: a "READY" line in a capture taken after we injected.
    if (sawCaptureAfterInject) {
      const text = await z.capture(opts.parentSession, opts.tabName, 40)
      if (/^READY\s*$/m.test(text)) {
        // Re-check file: claude may write file *then* print READY.
        if (await Bun.file(opts.handoffPath).exists()) return true
      }
    } else {
      sawCaptureAfterInject = true
    }
    await clock.sleep(1000)
  }

  log.log("warn", `handoff write timed out after ${opts.handoffTimeoutMs}ms (degraded)`)
  return false
}

/**
 * Unified detection loop (v2 §4.4.2).
 *
 * Per-tick checks (in priority order):
 *   1. hard timeout
 *   2. session death
 *   3. every 5 ticks: weekly limit (highest priority) > rate limit
 *   4. context-full
 *   5. wind-down injection (once when clock.now() >= opts.windDownAt)
 *   6. sentinel file (primary completion signal)
 *   7. inactivity at input prompt (secondary signal, with stray-question replies)
 */
export async function pollUntilDone(
  opts: InvokeOpts,
  cfg: Config,
  log: Logger,
  clock: Clock,
  z: ZellijOps = realZellijOps,
): Promise<EpisodeResult> {
  // F03: all flow-control timing routes through the injected Clock so SimClock
  // tests can validate inactivity / hard-timeout / wind-down deterministically
  // without real wall-clock waits.
  const start = clock.now().getTime()
  let lastText: string | null = null
  let stableSince: number | null = null
  let strayReplies = 0
  let tick = 0
  let windDownInfo: WindDownInfo | null = null

  for (;;) {
    // 1. hard timeout
    if (clock.now().getTime() - start >= opts.timeoutMs) {
      return { status: "timeout", windDownInjected: windDownInfo }
    }

    // 2. parent session died
    if (!(await z.sessionAlive(opts.parentSession))) {
      return {
        status: "lost",
        reason: "zellij session died",
        windDownInjected: windDownInfo,
      }
    }

    const text = await z.capture(opts.parentSession, opts.tabName, cfg.execution.captureLines)

    // 3. weekly + rate limit (every 5 ticks) — weekly takes priority
    if (tick % 5 === 0) {
      const weekly = matchWeeklyLimit(text, clock.now())
      if (weekly) {
        log.log("warn", `weekly limit detected, resume at ${weekly.toISOString()}`)
        return { status: "weekly_limited", resumeAt: weekly, windDownInjected: windDownInfo }
      }
      const rate = matchRateLimit(text, clock.now(), cfg.rateLimit.parseFailFallbackMs)
      if (rate) {
        log.log("warn", `rate limit detected, resume at ${rate.toISOString()}`)
        return { status: "rate_limited", resumeAt: rate, windDownInjected: windDownInfo }
      }
    }

    // 4. context-full — inject HANDOFF-writing prompt, wait for file + READY.
    if (matchContextLimit(text)) {
      log.log("warn", "context-full detected; injecting HANDOFF-writing prompt")
      const handoffWritten = await writeHandoffOnContextFull(opts, log, clock, z)
      return { status: "context_full", handoffWritten, windDownInjected: windDownInfo }
    }

    // 5. wind-down injection — exactly once, when the window is about to end.
    // Capture (windDownAt - clock.now()) at the moment we cross the boundary so
    // applyResult can emit a wind_down_injected event with the lag in minutes.
    if (
      windDownInfo === null &&
      opts.windDownAt !== null &&
      clock.now().getTime() >= opts.windDownAt.getTime()
    ) {
      log.log("info", "wind-down boundary reached; injecting wind-down prompt")
      await z.sendText(opts.parentSession, opts.tabName, WIND_DOWN_PROMPT)
      windDownInfo = {
        atMinutesBeforeBoundary: Math.round(
          (opts.windDownAt.getTime() - clock.now().getTime()) / 60_000,
        ),
      }
    }

    // 6. sentinel file (primary signal)
    if (await Bun.file(opts.sentinelFile).exists()) {
      return {
        status: "completed",
        durationMs: clock.now().getTime() - start,
        windDownInjected: windDownInfo,
      }
    }

    // 7. inactivity (secondary signal)
    if (lastText !== null && text === lastText) {
      if (
        stableSince !== null &&
        clock.now().getTime() - stableSince >= cfg.execution.inactivityTimeoutMs
      ) {
        const lines = nonEmptyLines(text)
        if (hasInputPrompt(lines)) {
          if (hasRecentQuestion(lines)) {
            if (strayReplies >= MAX_STRAY_REPLIES) {
              return {
                status: "lost",
                reason: "still stuck after injecting stray-question replies",
                windDownInjected: windDownInfo,
              }
            }
            strayReplies++
            log.log(
              "warn",
              `Claude asked a question in unattended mode; injecting standard reply (${strayReplies})`,
            )
            await z.sendText(opts.parentSession, opts.tabName, STRAY_QUESTION_REPLY)
            lastText = null
            stableSince = null
          } else {
            return {
              status: "completed",
              durationMs: clock.now().getTime() - start,
              windDownInjected: windDownInfo,
            }
          }
        }
        // Idle but not at an input prompt → keep waiting until hard timeout.
      }
    } else {
      lastText = text
      stableSince = clock.now().getTime()
    }

    tick++
    await clock.sleep(1000)
  }
}

/**
 * Pick a probe string from the prompt content — the longest non-empty,
 * non-frontmatter, non-comment line, truncated to ~40 chars. Used to verify
 * the paste landed in the input field by searching for this string in the
 * captured pane.
 *
 * Skips frontmatter (between `---` lines) and markdown headings (`#`) because
 * those are common across task docs and easily collide with rendered UI text.
 */
function pickPasteProbe(text: string): string {
  const lines = text.split("\n")
  let inFrontmatter = false
  let frontmatterCount = 0
  let best = ""
  for (const raw of lines) {
    const line = raw.trim()
    if (line === "---") {
      frontmatterCount++
      inFrontmatter = frontmatterCount < 2
      continue
    }
    if (inFrontmatter) continue
    if (line.length < 8) continue
    if (line.startsWith("#")) continue
    if (line.startsWith("-")) continue // checklist items
    if (line.length > best.length) best = line
  }
  return best.slice(0, 40)
}

/**
 * Paste a prompt file into the claude TUI input field and verify it landed
 * before submitting. Retries up to MAX_ATTEMPTS times if the paste doesn't
 * appear in the captured pane (which happens when claude TUI is mid-render
 * during SessionStart hook output streaming).
 *
 * Why this is necessary: bug 3 from 2026-05-23 live e2e. Plugins like
 * claude-mem inject heavy context into the TUI for many seconds after
 * launch, and pastes during that window are clobbered. A simple sleep
 * doesn't work because the streaming duration is unbounded (depends on how
 * many past sessions the plugin is summarising).
 */
export async function pasteWithVerify(
  session: string,
  tab: string,
  promptFile: string,
  clock: Clock,
  log: Logger,
  z: ZellijOps,
): Promise<void> {
  const MAX_ATTEMPTS = 6
  const PASTE_SETTLE_MS = 1500
  const RETRY_BACKOFF_MS = 2000
  const text = readFileSync(promptFile, "utf8")
  const probe = pickPasteProbe(text)
  if (!probe) {
    // Degenerate prompt (all short / frontmatter / headings) — fall back to
    // the unverified path so we don't deadlock.
    log.log("warn", "pasteWithVerify: no probe candidate, falling back to unverified paste")
    await z.pasteFile(session, tab, promptFile)
    return
  }

  // Two visibility signals — either is good evidence the paste landed:
  //   1. The probe substring is visible verbatim in the captured pane (the
  //      claude TUI echoes the text when it's short enough to render inline).
  //   2. The "[Pasted text #N +M lines]" placeholder is in the input area
  //      (claude's collapsed view for multi-line pastes — the actual content
  //      is in the input buffer, just not echoed). Multi-line task docs
  //      always render as a placeholder.
  const PLACEHOLDER_RE = /\[Pasted text #\d+\s*\+\d+\s*lines?\]/

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await z.pasteFileNoSubmit(session, tab, promptFile)
    await clock.sleep(PASTE_SETTLE_MS)
    const captured = await z.capture(session, tab, 80)
    if (captured.includes(probe) || PLACEHOLDER_RE.test(captured)) {
      // Paste landed visibly in the pane. Submit.
      await z.submitInput(session, tab)
      if (attempt > 1) {
        log.log("info", `pasteWithVerify: succeeded on attempt ${attempt}`)
      }
      return
    }
    // Not visible — claude TUI was mid-render. Clear any partial state and retry.
    log.log(
      "warn",
      `pasteWithVerify: attempt ${attempt}/${MAX_ATTEMPTS} not visible (probe="${probe.slice(0, 30)}"), retrying`,
    )
    await z.sendKeys(session, tab, "Esc") // clear any partial input
    await clock.sleep(RETRY_BACKOFF_MS)
  }
  // All attempts failed. Submit best-effort so pollUntilDone doesn't hang on
  // input prompt forever — the last paste may still have landed.
  log.log("error", `pasteWithVerify: all ${MAX_ATTEMPTS} attempts failed, submitting blind`)
  await z.submitInput(session, tab)
}

/**
 * Run a Claude session (v2 §4.4 S1-S9). Assumes opts.parentSession already
 * exists — the orchestrator creates one zellij session per window and reuses
 * it for every task. Each call owns exactly one tab (opts.tabName).
 *
 * On resume, the wake-up prompt is injected BEFORE the task prompt so the AI
 * sees a "you were paused, continue" cue first.
 */
export async function runClaudeSession(
  opts: InvokeOpts,
  cfg: Config,
  log: Logger,
  clock: Clock,
  z: ZellijOps = realZellijOps,
): Promise<EpisodeResult> {
  await z.newTab(opts.parentSession, opts.tabName) // S1
  try {
    await z.pipePane(opts.parentSession, opts.tabName, opts.rawLogFile) // S2

    // S3 — launch claude/happy
    await z.sendKeys(
      opts.parentSession,
      opts.tabName,
      `cd '${opts.workdir}' && ${buildLaunchCommand(cfg, opts)}`,
      "Enter",
    )

    // S4 — dialog automation
    if (!(await handleDialogs(opts.parentSession, opts.tabName, cfg, log, clock, z))) {
      return { status: "error", reason: "dialog timeout" }
    }

    // S4b — Happy first-launch session-UUID discovery (F01).
    //
    // Happy 1.1.8 swallows --session-id, so for the first episode we must
    // scrape the UUID off the /status panel. claude bin doesn't need this
    // (pre-gen via --session-id is honored); resume doesn't need it either
    // (UUID is already on TaskRuntimeState from the previous episode).
    let discoveredSessionId: string | null = null
    if (cfg.runtime.bin === "happy" && !opts.resume) {
      try {
        discoveredSessionId = await discoverViaStatus(
          z,
          opts.parentSession,
          opts.tabName,
          clock,
          log,
        )
      } catch (e) {
        // Discovery is mandatory for happy first launch — without it the next
        // episode cannot resume. Fail the episode loudly so the user sees it.
        return {
          status: "error",
          reason: `session-id discovery failed: ${String(e instanceof Error ? e.message : e)}`,
        }
      }
    }

    // S5a — wake-up prompt (resume only)
    if (opts.resume && opts.wakeUpPrompt !== null) {
      await z.sendText(opts.parentSession, opts.tabName, opts.wakeUpPrompt)
    }

    // S5b — task prompt, with verify-and-retry to dodge the SessionStart-hook
    // race (bug 3 from 2026-05-23 live e2e).
    //
    // The problem: claude TUI shows the `❯` input prompt very early during
    // startup, while plugins like claude-mem are still streaming SessionStart
    // hook output INTO THE TUI for several seconds. A bracketed paste fired
    // in that window lands in the TUI's input field but is then clobbered
    // by the continuing hook render — never makes it to the model as a user
    // message.
    //
    // The fix: split paste from submit. Paste content into the input field
    // (without pressing Enter), capture the pane after a short settle, and
    // confirm the paste signature is visible in the input area. If not,
    // send Esc to clear any partial state and retry. Only press Enter once
    // we can SEE the prompt sitting in the input field.
    await pasteWithVerify(opts.parentSession, opts.tabName, opts.promptFile, clock, log, z)

    // S6 — detection loop
    const result = await pollUntilDone(opts, cfg, log, clock, z)

    // S7 — /exit on a normal finish (skip on rate/weekly-limit so the resume
    // captures real state, not a cleanly-exited shell).
    if (result.status !== "rate_limited" && result.status !== "weekly_limited") {
      await z.sendKeys(opts.parentSession, opts.tabName, "/exit", "Enter")
      await sleep(2000)
    }
    // Attach the discovered UUID (if any) so the orchestrator can persist it
    // onto TaskRuntimeState for the next episode's --resume.
    if (discoveredSessionId !== null) {
      return { ...result, discoveredSessionId }
    }
    return result
  } finally {
    try {
      await z.closeTab(opts.parentSession, opts.tabName) // S8
    } catch (e) {
      log.log("warn", `closeTab(${opts.tabName}) failed: ${String(e)}`)
    }
  }
}

/**
 * Launch an interactive Claude session for `ucl plan` / `ucl review`. No
 * session-id / resume flags — these surfaces are fresh interactive shells
 * where a human is sitting at the terminal.
 *
 * Caller is responsible for `killSession(name)` after the user detaches/exits.
 */
export async function launchInteractiveSession(
  sessionName: string,
  cwd: string,
  initialMessage: string,
  cfg: Config,
  log: Logger,
): Promise<void> {
  await newSession(sessionName, cfg)
  const tab = "__init__"
  const cmd = `${cfg.runtime.bin} ${cfg.runtime.extraArgs.join(" ")}`.trim()
  await realSendKeys(sessionName, tab, `cd '${cwd}' && ${cmd}`, "Enter")
  if (!(await handleDialogs(sessionName, tab, cfg, log, new RealClock()))) {
    throw new Error("claude TUI did not reach input prompt before dialog timeout")
  }
  await realSendText(sessionName, tab, initialMessage)
}

/**
 * Smoke test (v2 §Q4): zellij + launcher + dialog + sentinel-string echo.
 * Creates and kills its own ephemeral session. Returns true = healthy.
 */
export async function runSmokeTest(cfg: Config, log: Logger): Promise<boolean> {
  const session = `ucl-smoke-${Date.now()}`
  const tab = "__init__"
  try {
    await newSession(session, cfg)
    const cmd = `${cfg.runtime.bin} ${cfg.runtime.extraArgs.join(" ")}`.trim()
    await realSendKeys(session, tab, cmd, "Enter")
    if (!(await handleDialogs(session, tab, cfg, log, new RealClock()))) return false
    // The sentinel token appears twice in the pane: once echoed from the
    // injected prompt, once in Claude's reply. ≥2 occurrences confirms a
    // real reply (single occurrence is just the echo).
    await realSendText(
      session,
      tab,
      "Reply with exactly this token and nothing else: SMOKE_OK",
    )
    const deadline = Date.now() + cfg.detection.dialogTimeoutMs
    while (Date.now() < deadline) {
      const text = await realCapture(session, tab, 80)
      if ((text.match(/SMOKE_OK/g) ?? []).length >= 2) return true
      await sleep(500)
    }
    return false
  } catch (e) {
    log.log("error", `smoke test exception: ${String(e)}`)
    return false
  } finally {
    await killSession(session)
  }
}

/** The only real Runtime implementation in v2. */
export class InteractiveZellijRuntime implements Runtime {
  constructor(
    private cfg: Config,
    private log: Logger,
    private clock: Clock,
  ) {}
  invoke(opts: InvokeOpts): Promise<EpisodeResult> {
    return runClaudeSession(opts, this.cfg, this.log, this.clock)
  }
}
