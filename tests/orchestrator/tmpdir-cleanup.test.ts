/**
 * F08 (b): per-run promptsDir cleanup.
 *
 * The previous implementation left a fresh `mkdtempSync` directory on disk
 * for every `ucl run` invocation. `withPromptsDir` wraps the body so the
 * directory is removed when the body returns (normal/exception) AND when
 * the process exits via signal (lifecycle's SIGINT/SIGTERM handler calls
 * process.exit(0), which fires Node's synchronous 'exit' event).
 */
import { describe, expect, it } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { withPromptsDir } from "../../src/commands/run.ts"

describe("withPromptsDir", () => {
  it("creates a fresh dir for the body and removes it after normal return", async () => {
    let observed: string | null = null
    await withPromptsDir(async (dir) => {
      observed = dir
      expect(existsSync(dir)).toBe(true)
    })
    expect(observed).not.toBeNull()
    expect(existsSync(observed!)).toBe(false)
  })

  it("cleans up even when the body throws", async () => {
    let observed: string | null = null
    await expect(
      withPromptsDir(async (dir) => {
        observed = dir
        // Drop a file in the dir to confirm rmSync handles non-empty
        writeFileSync(`${dir}/garbage.md`, "x")
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(observed).not.toBeNull()
    expect(existsSync(observed!)).toBe(false)
  })

  it("registers and removes the 'exit' listener (no listener leak across runs)", async () => {
    const before = process.listenerCount("exit")
    await withPromptsDir(async (dir) => {
      // While running, the listener should be registered.
      expect(process.listenerCount("exit")).toBe(before + 1)
      expect(existsSync(dir)).toBe(true)
    })
    // After return, the listener must be gone (otherwise repeated `ucl run`
    // calls in long-running tests would leak listeners and Node would warn).
    expect(process.listenerCount("exit")).toBe(before)
  })

  it("exit-listener path: cleanup runs even if the try/finally is bypassed", async () => {
    // Simulate what happens when the SIGINT handler calls process.exit():
    // the inner await never resolves, but the 'exit' event still fires
    // synchronously and our listener must rmSync the dir. We can't call
    // process.exit() inside a test (it would kill the test runner), so
    // instead we manually emit the 'exit' event after capturing the dir.
    let captured: string | null = null
    const p = withPromptsDir(async (dir) => {
      captured = dir
      expect(existsSync(dir)).toBe(true)
      // Force the 'exit' listener to fire while still inside the body.
      // Node's emit() invokes synchronous listeners immediately.
      process.emit("exit", 0)
      // After emit, the dir should already be cleaned up.
      expect(existsSync(dir)).toBe(false)
    })
    await p
    expect(captured).not.toBeNull()
    // Still gone after the body completes (the finally cleanup is a no-op
    // because cleaned=true was already set inside the 'exit' handler).
    expect(existsSync(captured!)).toBe(false)
  })
})
