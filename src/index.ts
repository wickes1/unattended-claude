#!/usr/bin/env bun
/** unattended-claude CLI entry point. */
import { homedir } from "node:os"
import { join } from "node:path"
import pkg from "../package.json" with { type: "json" }

import { cmdInit, helpText as initHelpText } from "./commands/init.ts"
import { cmdStatus, helpText as statusHelpText } from "./commands/status.ts"
import { cmdAttach, helpText as attachHelpText } from "./commands/attach.ts"
import { cmdRun, helpText as runHelpText } from "./commands/run.ts"
import { cmdStop, helpText as stopHelpText } from "./commands/stop.ts"
import { cmdSchedule, helpText as scheduleHelpText } from "./commands/schedule.ts"
import { cmdPlan, helpText as planHelpText } from "./commands/plan.ts"
import { cmdReview, helpText as reviewHelpText } from "./commands/review.ts"
import { cmdStats, helpText as statsHelpText } from "./commands/stats.ts"
import { cmdArchive, helpText as archiveHelpText } from "./commands/archive.ts"
import { cmdTodo, helpText as todoHelpText } from "./commands/todo.ts"

import { loadConfig } from "./config.ts"
import { Layout } from "./layout.ts"
import type { Config } from "./config.ts"

const globalHelpText = `unattended-claude — demand-shifting unattended Claude Code runtime

Usage: ucl <command> [--config <path>] [--help]

Commands:
  init        One-time setup (idempotent)
  plan        Interactive: convert new todo.md entries → task docs
  run         Start the worker (optionally --until HH:MM)
  stop        Stop the worker (graceful; --now for force)
  schedule    Manage launchd schedule (list / install / uninstall)
  status      Print current queue snapshot (no AI)
  stats       Print historical utilization (no AI)
  review      Review tasks (interactive AI, or print SUMMARY by id)
  archive     Archive task bundles (by id or --done-before Nd)
  unarchive   Restore a task bundle from archive
  todo        Manage todo.md (--consolidate)
  attach      Attach to running zellij session

Flags:
  --config <path>   path to cc.yaml (default ~/.config/unattended-claude/cc.yaml)
  --version, -V     print version and exit
  --help, -h        print this help

Run \`ucl <command> --help\` for command-specific help.
`

const PER_CMD_HELP: Record<string, string> = {
  init: initHelpText,
  plan: planHelpText,
  run: runHelpText,
  stop: stopHelpText,
  schedule: scheduleHelpText,
  status: statusHelpText,
  stats: statsHelpText,
  review: reviewHelpText,
  archive: archiveHelpText,
  unarchive: archiveHelpText,
  todo: todoHelpText,
  attach: attachHelpText,
}

function resolveConfigPath(argv: string[]): string {
  const i = argv.indexOf("--config")
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!
  if (process.env.UNATTENDED_CLAUDE_CONFIG) return process.env.UNATTENDED_CLAUDE_CONFIG
  return join(homedir(), ".config", "unattended-claude", "cc.yaml")
}

/** Filter out global flags before passing argv to sub-commands. */
function subcommandArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") { i++; continue }       // skip flag + value
    if (argv[i] === "--help" || argv[i] === "-h") continue
    if (argv[i] === "--version" || argv[i] === "-V") continue
    out.push(argv[i]!)
  }
  return out
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  // --version / -V at top-level only
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(`unattended-claude ${pkg.version}`)
    return 0
  }

  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    console.log(globalHelpText)
    return 0
  }

  // Per-command help: `ucl <cmd> --help`
  if (cmd in PER_CMD_HELP && (argv.includes("--help") || argv.includes("-h"))) {
    console.log(PER_CMD_HELP[cmd])
    return 0
  }

  // init runs before any config — don't loadConfig
  if (cmd === "init") {
    await cmdInit({})
    return 0
  }

  // Validate the command before loading config so unknown commands don't
  // surface a confusing "config not found" error.
  const KNOWN = new Set([
    "plan", "run", "stop", "schedule", "status", "stats",
    "review", "archive", "unarchive", "todo", "attach",
  ])
  if (!KNOWN.has(cmd)) {
    console.error(`Unknown command: ${cmd}`)
    console.error(`Run \`ucl --help\` for usage.`)
    return 1
  }

  // Load config for everything else
  let cfg: Config
  try {
    cfg = loadConfig(resolveConfigPath(argv))
  } catch (e) {
    console.error(`config error: ${String(e)}`)
    return 1
  }

  const layout = new Layout(cfg.runtimeDir)
  const subArgv = subcommandArgs(argv.slice(1))

  switch (cmd) {
    case "plan":
      await cmdPlan(cfg, subArgv)
      return 0
    case "run": {
      const r = await cmdRun(cfg, subArgv)
      return r.reason === "queue_empty" ? 0 : 0   // all reasons are "expected"; keep exit 0
    }
    case "stop":
      await cmdStop(layout, subArgv)
      return 0
    case "schedule":
      await cmdSchedule(cfg, subArgv)
      return 0
    case "status":
      await cmdStatus(layout, cfg.execution.maxParallelTabs)
      return 0
    case "stats":
      await cmdStats(cfg, subArgv)
      return 0
    case "review":
      await cmdReview(cfg, subArgv)
      return 0
    case "archive":
      await cmdArchive(layout, subArgv)
      return 0
    case "unarchive":
      // pass --unarchive flag transparently
      await cmdArchive(layout, ["--unarchive", ...subArgv])
      return 0
    case "todo":
      await cmdTodo(layout, subArgv)
      return 0
    case "attach":
      await cmdAttach()
      return 0
    default:
      console.error(`Unknown command: ${cmd}`)
      console.error(`Run \`ucl --help\` for usage.`)
      return 1
  }
}

const exitCode = await main()
process.exit(exitCode)
