export const helpText = `Usage: ucl attach

Attach to the running unattended-claude zellij session.
Detach without killing with Ctrl-o then d.
Prints a friendly message if no worker is running.
`

export async function cmdAttach(sessionName: string = "unattended-claude", log: (s: string) => void = console.log): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZELLIJ_SOCKET_DIR: process.env.ZELLIJ_SOCKET_DIR ?? "/tmp/zellij",
  }
  // First check if session exists
  const list = Bun.spawnSync(["zellij", "list-sessions", "--no-formatting"], {
    env, stdout: "pipe", stderr: "pipe",
  })
  const stdout = new TextDecoder().decode(list.stdout)
  const running = stdout.split("\n").some((l) => l.trim().startsWith(sessionName) && !/EXITED/i.test(l))
  if (!running) {
    log(`No worker running. Start one with \`ucl run\`.`)
    return
  }
  Bun.spawnSync(["zellij", "attach", sessionName], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
}
