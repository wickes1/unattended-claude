import { describe, expect, it } from "bun:test"

describe("bootstrap", () => {
  it("entrypoint runs and exits 0", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts"], { stdout: "pipe" })
    const code = await proc.exited
    expect(code).toBe(0)
  })
})
