/** Layer A — zellij primitives (spec-zellij-cockpit §2). Used only by the real runtime.
 *  Each session can host multiple tabs; the pane id for a (session, tab) pair is
 *  not part of the public signatures — it is resolved internally by the
 *  module-level `tabs` Map keyed on `${session}::${tab}`. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { Config } from "../config.ts"

// On macOS the $TMPDIR path is too long, so zellij's default socket path would
// exceed the 103-byte unix socket limit. ZELLIJ_SOCKET_DIR is not in the
// original process environment, so a short path is injected explicitly via the
// module-level ZELLIJ_ENV constant; every spawn in zellijCmd and newSession
// carries it, ensuring server and client connect to the same socket.
const _socketDir = process.env.ZELLIJ_SOCKET_DIR ?? "/tmp/zellij"
const ZELLIJ_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ZELLIJ_SOCKET_DIR: _socketDir,
}

// ANSI / OSC sequence regexes — dump-screen already strips ANSI by default,
// but these are kept as a safety net and to strip \r.
const OSC_RE = new RegExp("\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", "g")
const CSI_RE = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g")
const FE_RE = new RegExp("\\u001b[@-_]", "g")

/** Strip ANSI / OSC sequences and CR. */
export function stripAnsi(s: string): string {
  return s.replace(OSC_RE, "").replace(CSI_RE, "").replace(FE_RE, "").replace(/\r/g, "")
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Write a full raw-log snapshot every N capture calls. */
const RAWLOG_SNAPSHOT_EVERY = 20

/** Per-tab runtime state. One tab per task, multiple tabs per window session. */
interface TabEntry {
  paneId: string // the working pane id, e.g. "terminal_3"
  rawLogFile: string | null // forensic log target registered by pipePane
  captureCount: number // capture call counter (drives the snapshot cadence)
}

/** `${session}::${tab}` → TabEntry. */
const tabs = new Map<string, TabEntry>()

function tabKey(session: string, tab: string): string {
  return `${session}::${tab}`
}

function entry(session: string, tab: string): TabEntry {
  const e = tabs.get(tabKey(session, tab))
  if (!e)
    throw new Error(
      `zellij: unknown tab "${tab}" in session "${session}" (newTab not called, or already closed)`,
    )
  return e
}

export interface ZellijResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a single zellij command. The env always carries ZELLIJ_SOCKET_DIR to
 *  ensure connection to the correct server. */
export async function zellijCmd(args: string[]): Promise<ZellijResult> {
  const proc = Bun.spawn(["zellij", ...args], { env: ZELLIJ_ENV, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, stdout, stderr }
}

/** Build `--session <name> action <...>` arguments. */
function actionArgs(session: string, action: string[]): string[] {
  return ["--session", session, "action", ...action]
}

/**
 * Parse the table output of `zellij action list-panes`, returning all terminal
 * pane ids. Each line is "PANE_ID  TYPE  TITLE"; the header and plugin rows
 * must be filtered out. Note: this table format varies by zellij version; it
 * has been verified against zellij 0.44.x.
 */
export function parsePaneList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c[1] === "terminal" && /^terminal_\d+$/.test(c[0] ?? ""))
    .map((c) => c[0]!)
}

/**
 * Parse the output of `zellij list-sessions --no-formatting`. Each line is
 * "<name> [Created ...]"; a dead session carries "(EXITED ...)".
 */
export function parseSessionList(stdout: string): { name: string; exited: boolean }[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => ({ name: l.split(/\s+/)[0]!, exited: /EXITED/i.test(l) }))
}

/** Numerically-sorted ids from a list-panes dump (ascending by terminal_N suffix). */
function sortedIds(stdout: string): string[] {
  const ids = parsePaneList(stdout)
  ids.sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]))
  return ids
}

/** Find a terminal pane id inside a session that is not already tracked. */
async function discoverNewPane(session: string, knownIds: Set<string>): Promise<string> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const r = await zellijCmd(actionArgs(session, ["list-panes"]))
    const fresh = sortedIds(r.stdout).filter((id) => !knownIds.has(id))
    if (fresh.length) return fresh[fresh.length - 1]!
    await sleep(300)
  }
  throw new Error(`zellij: no fresh terminal pane appeared in session "${session}"`)
}

/** Collect the set of pane ids already tracked for `session` (across all tabs). */
function trackedPaneIds(session: string): Set<string> {
  const prefix = `${session}::`
  const set = new Set<string>()
  for (const [k, v] of tabs) {
    if (k.startsWith(prefix)) set.add(v.paneId)
  }
  return set
}

/**
 * Create a headless session (one per window). Each task gets a tab inside it
 * via newTab. The env is carried in from this process's environment — the
 * zellij server is born here and the pane shell inherits its environment
 * (needed for K1 environment propagation). A headless session defaults to 48
 * columns; in practice the claude TUI renders fine at this width, and the
 * detection layer's word-wrap handling is already covered by matchRateLimit
 * flattening whitespace (spec-zellij-cockpit §2.3 / §6).
 *
 * The initial pane is tracked under tab id `__init__` for clean session
 * teardown; callers do not interact with it directly.
 */
export async function newSession(name: string, cfg: Config): Promise<void> {
  mkdirSync(_socketDir, { recursive: true }) // the socket dir must exist before the server is born
  const env: Record<string, string> = { ...ZELLIJ_ENV }
  for (const k of cfg.terminal.envScrub) delete env[k]
  env.TERM = cfg.terminal.term
  for (const [k, v] of Object.entries(cfg.terminal.envSet)) env[k] = v

  const create = Bun.spawn(["zellij", "attach", "--create-background", name], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  if ((await create.exited) !== 0) {
    throw new Error(`zellij attach --create-background failed: ${name}`)
  }

  await sleep(1000) // wait for the server + pane shell to be ready
  const paneId = await discoverNewPane(name, new Set())
  tabs.set(tabKey(name, "__init__"), { paneId, rawLogFile: null, captureCount: 0 })
}

/**
 * Open a new tab inside an existing session. The tab is named so the user
 * can navigate to it via `go-to-tab-name`; the freshly created terminal pane
 * is captured and tracked for subsequent send/capture calls.
 */
export async function newTab(session: string, tabName: string): Promise<void> {
  const known = trackedPaneIds(session)
  const r = await zellijCmd(actionArgs(session, ["new-tab", "--name", tabName]))
  if (r.code !== 0) {
    throw new Error(`zellij new-tab failed for "${tabName}" in "${session}": ${r.stderr.trim()}`)
  }
  const paneId = await discoverNewPane(session, known)
  tabs.set(tabKey(session, tabName), { paneId, rawLogFile: null, captureCount: 0 })
}

/**
 * Close a tab in a session. Focuses by name first (so the close targets the
 * intended tab), then issues close-tab. The (session, tab) tracking is dropped
 * even if zellij returns an error — keeping stale entries around would only
 * cause confusing follow-on failures.
 */
export async function closeTab(session: string, tabName: string): Promise<void> {
  const key = tabKey(session, tabName)
  const e = tabs.get(key)
  if (e) {
    if (e.rawLogFile) {
      await zellijCmd(
        actionArgs(session, [
          "dump-screen",
          "--pane-id",
          e.paneId,
          "--full",
          "--path",
          e.rawLogFile,
        ]),
      )
    }
  }
  await zellijCmd(actionArgs(session, ["go-to-tab-name", tabName]))
  await zellijCmd(actionArgs(session, ["close-tab"]))
  tabs.delete(key)
}

/** delete-session — a non-existent session is not treated as an error. Drops
 *  all per-tab tracking for this session. */
export async function killSession(name: string): Promise<void> {
  const prefix = `${name}::`
  for (const k of [...tabs.keys()]) if (k.startsWith(prefix)) tabs.delete(k)
  await zellijCmd(["delete-session", name, "--force"])
}

/** Whether the session is alive (EXITED counts as dead). */
export async function sessionAlive(name: string): Promise<boolean> {
  const r = await zellijCmd(["list-sessions", "--no-formatting"])
  if (r.code !== 0) return false
  const s = parseSessionList(r.stdout).find((x) => x.name === name)
  return s ? !s.exited : false
}

/** List all session names (including EXITED) — used by index.ts's cmdAttach. */
export async function listSessions(): Promise<string[]> {
  const r = await zellijCmd(["list-sessions", "--no-formatting"])
  if (r.code !== 0) return []
  return parseSessionList(r.stdout).map((x) => x.name)
}

/**
 * send-keys — tmux's send-keys takes both text and key names; zellij splits
 * them: text goes through write-chars, key names through send-keys. Named keys
 * known to the codebase (Enter, Esc) are forwarded to `zellij action send-keys`;
 * everything else is treated as literal text via write-chars.
 */
const NAMED_KEYS = new Set(["Enter", "Esc"])

export async function sendKeys(session: string, tab: string, ...keys: string[]): Promise<void> {
  const { paneId } = entry(session, tab)
  for (const k of keys) {
    if (NAMED_KEYS.has(k)) {
      await zellijCmd(actionArgs(session, ["send-keys", "--pane-id", paneId, k]))
    } else {
      await zellijCmd(actionArgs(session, ["write-chars", "--pane-id", paneId, k]))
    }
  }
}

/** Inject multi-line text via bracketed paste (avoiding line-by-line submit),
 *  WITHOUT submitting. Caller must call submitInput() separately.
 *
 *  The `--` end-of-options sentinel before `text` is critical: zellij's CLI
 *  parser otherwise interprets any text starting with `--` or `---` (e.g.
 *  YAML frontmatter delimiters in task doc bodies) as a flag and rejects the
 *  whole command. Discovered the hard way in the 2026-05-23 live e2e — paste
 *  silently failed on every task doc because they start with `---`. */
async function pasteNoSubmit(session: string, tab: string, text: string): Promise<void> {
  const { paneId } = entry(session, tab)
  await zellijCmd(actionArgs(session, ["paste", "--pane-id", paneId, "--", text]))
}

/** Inject multi-line text via bracketed paste, then press Enter to submit. */
async function paste(session: string, tab: string, text: string): Promise<void> {
  await pasteNoSubmit(session, tab, text)
  await sleep(200)
  await submitInput(session, tab)
}

/** Just press Enter on the input field (no paste). Used by the verify-and-retry
 *  path in claude-session.ts S5b, where the paste step is separated from the
 *  submit step so the caller can confirm the paste actually landed before
 *  committing to a submission. */
export async function submitInput(session: string, tab: string): Promise<void> {
  const { paneId } = entry(session, tab)
  await zellijCmd(actionArgs(session, ["send-keys", "--pane-id", paneId, "Enter"]))
}

/** Inject arbitrary text (short text, e.g. a stray-question reply). */
export async function sendText(session: string, tab: string, text: string): Promise<void> {
  await paste(session, tab, text)
}

/** Paste an entire file's content into the TUI — the safe path for prompt injection. */
export async function pasteFile(session: string, tab: string, file: string): Promise<void> {
  await paste(session, tab, readFileSync(file, "utf8"))
}

/** Paste an entire file's content WITHOUT submitting. Caller must verify and
 *  then call submitInput() separately. Used by claude-session.ts S5b to dodge
 *  the SessionStart-hook race documented at the call site. */
export async function pasteFileNoSubmit(session: string, tab: string, file: string): Promise<void> {
  await pasteNoSubmit(session, tab, readFileSync(file, "utf8"))
}

/**
 * capture-pane equivalent. zellij has no "take last N lines" option, so dump
 * the full scrollback and slice the last N lines — matching tmux's
 * `capture-pane -S -N` semantics.
 * Side effect: if a raw-log target has been registered via pipePane, write a
 * full snapshot every RAWLOG_SNAPSHOT_EVERY calls.
 */
export async function capture(session: string, tab: string, lines: number): Promise<string> {
  const e = entry(session, tab)
  const r = await zellijCmd(
    actionArgs(session, ["dump-screen", "--pane-id", e.paneId, "--full"]),
  )
  const text = stripAnsi(r.stdout)
  e.captureCount++
  if (e.rawLogFile && e.captureCount % RAWLOG_SNAPSHOT_EVERY === 0) {
    try {
      writeFileSync(e.rawLogFile, text)
    } catch {
      /* best-effort observability */
    }
  }
  return text.split("\n").slice(-lines).join("\n")
}

/**
 * zellij has no equivalent of tmux pipe-pane's "continuous stream". Instead it
 * registers a raw-log target: capture writes a periodic full snapshot, and
 * closeTab writes a final snapshot (spec-zellij-cockpit §2.3 — observability
 * is downgraded to periodic snapshots, best-effort, which is acceptable).
 */
export async function pipePane(session: string, tab: string, file: string): Promise<void> {
  entry(session, tab).rawLogFile = file
  writeFileSync(file, "") // create the file immediately so downstream existsSync is not misled
}
