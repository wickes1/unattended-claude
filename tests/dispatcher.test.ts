import { describe, expect, it } from "bun:test"
import pkg from "../package.json" with { type: "json" }

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/index.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe("CLI dispatcher", () => {
  it("--help exits 0 and prints global help", async () => {
    const r = await runCli(["--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("unattended-claude")
    expect(r.stdout).toContain("Usage: ucl <command>")
    expect(r.stdout).toContain("init")
    expect(r.stdout).toContain("plan")
  })

  it("--version exits 0 and prints version", async () => {
    const r = await runCli(["--version"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`unattended-claude ${pkg.version}`)
  })

  it("-V matches --version", async () => {
    const r = await runCli(["-V"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`unattended-claude ${pkg.version}`)
  })

  it("unknown command exits 1", async () => {
    const r = await runCli(["unknown-cmd"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("Unknown command")
  })

  it("init --help prints init helpText", async () => {
    const r = await runCli(["init", "--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("ucl init")
    expect(r.stdout.toLowerCase()).toContain("init")
  })

  it("plan --help prints plan helpText", async () => {
    const r = await runCli(["plan", "--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("ucl plan")
    expect(r.stdout.toLowerCase()).toContain("plan")
  })

  it("archive --help prints archive helpText", async () => {
    const r = await runCli(["archive", "--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("ucl archive")
  })
})
