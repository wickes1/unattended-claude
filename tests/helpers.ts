/** Shared test utilities — minimum surface needed by claude-session.test.ts. */
import type { Config } from "../src/config.ts"

/** Build a v2 Config for tests. Overrides allow per-test tweaks. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    configPath: "/dev/null",
    runtimeDir: "/tmp/ucl-test",
    runtime: {
      bin: "happy",
      extraArgs: ["--dangerously-skip-permissions"],
    },
    execution: {
      maxParallelTabs: 3,
      windDownLeadMinutes: 5,
      episodeHardTimeoutMs: 60 * 60_000,
      inactivityTimeoutMs: 30_000,
      captureLines: 3000,
    },
    detection: { dialogPollIntervalMs: 500, dialogTimeoutMs: 30_000 },
    rateLimit: { safetyMarginMs: 30_000, parseFailFallbackMs: 60 * 60_000 },
    archive: { autoAfterDays: 7 },
    schedule: { windows: [] },
    terminal: {
      term: "xterm-256color",
      envScrub: ["CLAUDECODE"],
      envSet: { CLAUDE_CODE_NO_FLICKER: "1" },
    },
    logging: { level: "info", dir: "/tmp/ucl-test/logs" },
  }
  return { ...base, ...overrides }
}
