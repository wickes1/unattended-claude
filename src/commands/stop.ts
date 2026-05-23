import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Layout } from "../layout.ts"
import { ensureDir } from "../fs-utils.ts"
import { isProcessAlive } from "../orchestrator/lifecycle.ts"
import { dirname } from "node:path"

export const helpText = `Usage: ucl stop [--now]

Stop the running orchestrator gracefully (SIGTERM). With --now, SIGKILL
after 2 seconds if SIGTERM didn't take effect. The orchestrator's signal
handler pauses in-flight tasks with reason "user-stop" (graceful) or
"user-stop-now" (forced).
`

interface StopArgs { now: boolean }

export function parseStopArgs(argv: string[]): StopArgs {
  return { now: argv.includes("--now") }
}

export async function cmdStop(
  layout: Layout,
  argv: string[] = [],
  log: (s: string) => void = console.log,
): Promise<{ killed: boolean; pid: number | null }> {
  const args = parseStopArgs(argv)
  if (!existsSync(layout.lockFile)) {
    log("No worker running (lockfile not found).")
    return { killed: false, pid: null }
  }
  const pid = Number(readFileSync(layout.lockFile, "utf8").trim())
  if (!isProcessAlive(pid)) {
    log(`Stale lockfile (PID ${pid} not alive).`)
    return { killed: false, pid }
  }
  // SIGTERM
  try {
    process.kill(pid, "SIGTERM")
    log(`Sent SIGTERM to orchestrator (PID ${pid}). Waiting for graceful shutdown…`)
  } catch (e) {
    log(`SIGTERM failed: ${String(e)}`)
    return { killed: false, pid }
  }
  // Wait up to 10s for graceful exit (or 2s with --now)
  const deadline = Date.now() + (args.now ? 2_000 : 10_000)
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      log("Orchestrator exited cleanly.")
      return { killed: true, pid }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  // With --now, escalate to SIGKILL. Write the stop-now flag FIRST so that
  // the next orphan-recovery tick can attribute the abandoned tasks to
  // "user-stop-now" rather than the generic "orphan" reason.
  if (args.now) {
    try {
      ensureDir(dirname(layout.stopNowFlagFile))
      writeFileSync(layout.stopNowFlagFile, new Date().toISOString())
    } catch (e) {
      log(`warn: could not write stop-now flag: ${String(e)}`)
    }
    try {
      process.kill(pid, "SIGKILL")
      log(`Escalated to SIGKILL (PID ${pid}).`)
      return { killed: true, pid }
    } catch (e) {
      log(`SIGKILL failed: ${String(e)}`)
      return { killed: false, pid }
    }
  }
  log("Orchestrator did not exit within 10s. Use `ucl stop --now` to force kill.")
  return { killed: false, pid }
}
