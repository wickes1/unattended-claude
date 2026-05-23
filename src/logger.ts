import type { LogLevel, Logger } from "./types.ts"

/** Structured log — one JSON line per event (collected automatically by systemd journalctl). */
export class ConsoleLogger implements Logger {
  log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      scope: "unattended-claude",
      level,
      msg,
      ...extra,
    })
    if (level === "error") console.error(line)
    else console.log(line)
  }
}

/** For tests: collect logs into an array instead of writing to stdout. */
export class MemoryLogger implements Logger {
  readonly lines: Array<{ level: LogLevel; msg: string }> = []
  log(level: LogLevel, msg: string): void {
    this.lines.push({ level, msg })
  }
  has(level: LogLevel, substr: string): boolean {
    return this.lines.some((l) => l.level === level && l.msg.includes(substr))
  }
}
