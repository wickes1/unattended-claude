import { parse as parseYaml } from "yaml"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

export interface ScheduleWindow {
  start: string                                  // "HH:MM"
  end: string                                    // "HH:MM"
  days: string[]                                 // ["mon","tue",...]
}

/** Parsed config — all paths are absolute and all durations are in ms. */
export interface Config {
  configPath: string
  runtimeDir: string
  runtime: {
    driver: string
    bin: string
    extraArgs: string[]
  }
  execution: {
    maxParallelTabs: number
    contextCompactThreshold: number
    windDownLeadMinutes: number
    episodeHardTimeoutMs: number
    inactivityTimeoutMs: number
    captureLines: number
  }
  detection: {
    dialogPollIntervalMs: number
    dialogTimeoutMs: number
  }
  rateLimit: {
    safetyMarginMs: number
    parseFailFallbackMs: number
  }
  archive: { autoAfterDays: number }
  schedule: { windows: ScheduleWindow[] }
  terminal: {
    term: string
    envScrub: string[]
    envSet: Record<string, string>
  }
  logging: { level: string; dir: string }
}

const DUR_MULT: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Parse a duration string: "0s" "500ms" "30m" "9h" "14d" → ms. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(String(s).trim())
  if (!m) throw new Error(`Cannot parse duration: "${s}" (expected e.g. "30m" "9h" "500ms")`)
  return Number(m[1]) * DUR_MULT[m[2]!]!
}

/**
 * Path resolution: ~/x → homedir/x ; absolute path → as-is ;
 * relative path → resolved against baseDir (loadConfig passes homedir()).
 */
export function resolvePath(p: string, baseDir: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2))
  if (p === "~") return homedir()
  if (isAbsolute(p)) return p
  return resolve(baseDir, p)
}

function req<T>(v: T | undefined | null, name: string): T {
  if (v === undefined || v === null) throw new Error(`Config is missing a required field: ${name}`)
  return v
}

/** Load and parse the config. runtime_dir is the single user-set path; everything else derives from it. */
export function loadConfig(configPath: string): Config {
  const absConfig = resolve(configPath)
  if (!existsSync(absConfig)) {
    throw new Error(
      `Config not found: ${absConfig}\nRun \`ucl init\` to create it.`,
    )
  }
  const raw = parseYaml(readFileSync(absConfig, "utf8")) as any
  if (!raw || typeof raw !== "object")
    throw new Error(`Config file is empty or malformed: ${absConfig}`)

  const runtimeDir = resolvePath(req(raw.paths?.runtime_dir, "paths.runtime_dir"), homedir())

  const cfg: Config = {
    configPath: absConfig,
    runtimeDir,
    runtime: {
      driver: raw.runtime?.driver ?? "claude",
      bin: raw.runtime?.bin ?? "happy",
      extraArgs: raw.runtime?.extra_args ?? [],
    },
    execution: {
      maxParallelTabs: raw.execution?.max_parallel_tabs ?? 3,
      contextCompactThreshold: raw.execution?.context_compact_threshold ?? 150000,
      windDownLeadMinutes: raw.execution?.wind_down_lead_minutes ?? 5,
      episodeHardTimeoutMs: parseDuration(raw.execution?.episode_hard_timeout ?? "60m"),
      inactivityTimeoutMs: parseDuration(raw.execution?.inactivity_timeout ?? "30s"),
      captureLines: raw.execution?.capture_lines ?? 3000,
    },
    detection: {
      dialogPollIntervalMs: parseDuration(raw.detection?.dialog_poll_interval ?? "500ms"),
      dialogTimeoutMs: parseDuration(raw.detection?.dialog_timeout ?? "30s"),
    },
    rateLimit: {
      safetyMarginMs: parseDuration(raw.rate_limit?.safety_margin ?? "30s"),
      parseFailFallbackMs: parseDuration(raw.rate_limit?.parse_fail_fallback ?? "1h"),
    },
    archive: {
      autoAfterDays: raw.archive?.auto_after_days ?? 7,
    },
    schedule: {
      windows: (raw.schedule?.windows ?? []) as ScheduleWindow[],
    },
    terminal: {
      term: raw.terminal?.term ?? "xterm-256color",
      envScrub: raw.terminal?.env_scrub ?? ["CLAUDECODE"],
      envSet: raw.terminal?.env_set ?? { CLAUDE_CODE_NO_FLICKER: "1" },
    },
    logging: {
      level: raw.logging?.level ?? "info",
      dir: resolvePath(raw.logging?.dir ?? `${runtimeDir}/logs`, homedir()),
    },
  }
  return cfg
}
