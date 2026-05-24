/** `ucl init` — interactive setup wizard. */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface, type Interface } from "node:readline"
import { stdin as procStdin, stdout as procStdout } from "node:process"
import { atomicWrite, ensureDir } from "../fs-utils.ts"
import { Layout } from "../layout.ts"
import { loadConfig, resolvePath } from "../config.ts"
import {
  getYamlValue,
  readYamlDoc,
  setYamlValue,
  writeYamlDoc,
} from "../yaml-utils.ts"
import {
  checkBun,
  checkClaude,
  checkHappy,
  checkZellij,
  formatResult,
  runChecks,
  type CheckResult,
} from "./doctor.ts"

export const helpText = `Usage: ucl init

Interactive setup wizard. Asks for runtime bin and runtime dir; preserves any
other manual edits to ucl.yaml on re-run.

Existing data is never overwritten. Re-running shows current values as prompt
defaults — press Enter to keep, type a new value to change.
`

export interface InitResult {
  /** Absolute path to the config file (created or pre-existing). */
  configPath: string
  /** Absolute path to the runtime dir. */
  runtimeDir: string
  /** Notes the wizard surfaced (warnings, info). */
  notes: string[]
}

/** Minimal subset of node:readline.Interface that init needs. Tests can fake. */
export interface RlLike {
  question: (q: string, cb: (ans: string) => void) => void
  close: () => void
}

/**
 * Ask via the async-iterator pattern — sidesteps a Bun quirk where
 * `readline.question` hangs on the 2nd prompt with piped stdin.
 *
 * Only used for the production `node:readline.Interface` path. Fake `rl`
 * objects supplied by tests use the callback form directly via {@link askVia}.
 */
function makeAsker(rl: Interface): (q: string) => Promise<string> {
  const iter = rl[Symbol.asyncIterator]()
  return async function ask(q: string): Promise<string> {
    procStdout.write(q)
    const { value, done } = await iter.next()
    if (done) return ""
    return (value as string).trim()
  }
}

/** Callback-based ask, used when caller supplied a fake `rl`. */
function askVia(rl: RlLike): (q: string) => Promise<string> {
  return (q: string) =>
    new Promise<string>((resolveAns) => {
      rl.question(q, (ans) => resolveAns(ans.trim()))
    })
}

export async function cmdInit(opts: {
  templatePath?: string
  configPath?: string
  runtimeDir?: string
  /**
   * Test-only escape hatch: skip the interactive bin prompt and force a value.
   * Bypasses the `claudeOK || happyOK` availability guard, so a runtime warning
   * is logged if the forced bin isn't actually installed — surfaces hints in
   * test failures without throwing.
   */
  forceBin?: "claude" | "happy"
  toolCheck?: (cmd: string) => boolean
  /** Test override: a fake `rl` skips construction of node:readline. */
  rl?: RlLike
  /** Test override: point at a fake skills template dir instead of `config/skills/`. */
  skillsTemplateDir?: string
  log?: (s: string) => void
} = {}): Promise<InitResult> {
  const log = opts.log ?? console.log
  const templatePath = opts.templatePath
    ?? resolve(import.meta.dir, "..", "..", "config", "ucl.yaml")
  const configPath = opts.configPath
    ?? join(homedir(), ".config", "unattended-claude", "ucl.yaml")
  const notes: string[] = []

  // 1. Load existing config (for re-init defaults) or template (for first init).
  const isReInit = existsSync(configPath)
  const sourcePath = isReInit ? configPath : templatePath
  if (!existsSync(sourcePath)) {
    throw new Error(`init template not found: ${sourcePath}`)
  }
  const doc = readYamlDoc(sourcePath)

  // 2. Determine current/default values for prompts.
  const currentBinRaw = getYamlValue(doc, ["runtime", "bin"])
  const defaultBin: "claude" | "happy" =
    currentBinRaw === "claude" || currentBinRaw === "happy" ? currentBinRaw : "happy"
  const currentRuntimeDirRaw = getYamlValue(doc, ["paths", "runtime_dir"])
  const defaultRuntimeDir =
    typeof currentRuntimeDirRaw === "string" && currentRuntimeDirRaw.length > 0
      ? currentRuntimeDirRaw
      : "~/unattended"

  // 3. Probe both bins. We need this regardless of `forceBin` so we can decide
  //    silent-pick vs prompt vs throw.
  const toolCheck = opts.toolCheck ?? defaultToolCheck
  const claudeOK = toolCheck("claude")
  const happyOK = toolCheck("happy")

  // 4. Set up the asker. If neither bin is present we'll throw before any prompt,
  //    so build the readline interface lazily only when we know we'll need it.
  //    The asker function is built ONCE on first use and cached — no per-prompt
  //    allocation, no `as Interface` cast in the hot path.
  let rl: RlLike | undefined = opts.rl
  let ownRl = false
  let cachedAsk: ((q: string) => Promise<string>) | undefined
  const ask = (q: string): Promise<string> => {
    if (!cachedAsk) {
      if (rl) {
        // Fake `rl` supplied by tests — use the callback form.
        cachedAsk = askVia(rl)
      } else {
        const real = createInterface({ input: procStdin, output: procStdout })
        rl = real
        ownRl = true
        cachedAsk = makeAsker(real)
      }
    }
    return cachedAsk(q)
  }

  try {
    // 5. Bin selection.
    let chosenBin: "claude" | "happy"
    if (opts.forceBin !== undefined) {
      chosenBin = opts.forceBin
      const forcedOK = opts.forceBin === "claude" ? claudeOK : happyOK
      if (!forcedOK) {
        log(`warn: forceBin='${opts.forceBin}' but '${opts.forceBin}' is not on PATH`)
      }
    } else if (claudeOK && happyOK) {
      chosenBin = await promptBin(ask, log, defaultBin)
    } else if (claudeOK) {
      chosenBin = "claude"
      log(`info: detected only 'claude' on PATH — using it`)
    } else if (happyOK) {
      chosenBin = "happy"
      log(`info: detected only 'happy' on PATH — using it`)
    } else {
      // Neither installed — print remediation hints from doctor, then throw.
      const hints: CheckResult[] = [checkBun(), checkZellij(), checkClaude(), checkHappy()]
      for (const r of hints) {
        if (r.severity === "error" || r.severity === "warn") {
          log(formatResult(r))
        }
      }
      throw new Error(
        "Neither claude nor happy found on PATH. Install at least one before `ucl init`.",
      )
    }

    // 6. Runtime dir prompt (no validation; empty answer = default).
    const runtimeAns = await ask(`Runtime dir [${defaultRuntimeDir}]: `)
    const chosenRuntimeDir = runtimeAns.length > 0 ? runtimeAns : defaultRuntimeDir

    // 7. Apply choices to the in-memory Document and write back atomically.
    //    Mutating in place preserves any user-edited fields outside what we prompted for.
    setYamlValue(doc, ["paths", "runtime_dir"], chosenRuntimeDir)
    setYamlValue(doc, ["runtime", "bin"], chosenBin)

    ensureDir(dirname(configPath))
    writeYamlDoc(configPath, doc)
    notes.push(isReInit ? `Updated config at ${configPath}` : `Created config at ${configPath}`)

    // 8. Resolve runtime dir and create the tree.
    const runtimeDir = opts.runtimeDir ?? resolvePath(chosenRuntimeDir, homedir())
    const layout = new Layout(runtimeDir)
    ensureDir(runtimeDir)
    ensureDir(layout.tasksDir)
    ensureDir(layout.workdirsDir)
    ensureDir(layout.archiveDir)
    ensureDir(layout.stateDir)
    ensureDir(layout.taskStatesDir)
    ensureDir(layout.handoffsDir)
    ensureDir(layout.logsDir)

    if (!existsSync(layout.todoFile)) {
      writeFileSync(
        layout.todoFile,
        "# unattended-claude — todo inbox\n\n" +
          "Add lines below. `[x]` means already planned (you don't have to add it manually — `ucl plan` does).\n\n",
      )
      notes.push(`Created empty todo.md at ${layout.todoFile}`)
    }

    // 8a. Install skill templates with upgrade rule.
    //     First-install copies verbatim. Re-init with a newer template_version
    //     warns the user but never overwrites — user opts in via
    //     `rm -r <skill-dir> && ucl init`. Same "user data is sacred" model as
    //     ucl.yaml. See plan 2026-05-23-skills-to-runtime.md.
    const skillsTemplateDir = opts.skillsTemplateDir
      ?? resolve(import.meta.dir, "..", "..", "config", "skills")
    if (existsSync(skillsTemplateDir)) {
      const skillNames = readdirSync(skillsTemplateDir)
        .filter((n) => statSync(join(skillsTemplateDir, n)).isDirectory())
      for (const skillName of skillNames) {
        const userSkillDir = layout.skillDir(skillName)
        const userSkillFile = layout.skillFile(skillName)
        const templateSkillFile = join(skillsTemplateDir, skillName, "SKILL.md")
        if (!existsSync(templateSkillFile)) continue

        if (!existsSync(userSkillFile)) {
          // First install — copy verbatim.
          ensureDir(userSkillDir)
          atomicWrite(userSkillFile, readFileSync(templateSkillFile, "utf8"))
          notes.push(`Installed skill ${skillName} at ${userSkillFile}`)
          continue
        }

        // Already installed — version-compare upgrade decision.
        const userVer = readSkillVersion(userSkillFile)
        const tplVer = readSkillVersion(templateSkillFile)
        if (userVer >= tplVer) continue // already up to date
        // Template is newer; we never overwrite.
        log(
          `(skill ${skillName}: template v${tplVer} available, you have v${userVer}; not overwriting. To accept upstream: rm -r ${userSkillDir} && ucl init)`,
        )
      }
    }

    // 9. Preflight summary — only show warn + error rows so the user sees what
    //    they still need to fix. Pass/info are noise here.
    let preflightResults: CheckResult[] = []
    try {
      const cfg = loadConfig(configPath)
      preflightResults = runChecks(cfg).filter(
        (r) => r.severity === "warn" || r.severity === "error",
      )
    } catch (err) {
      // If loadConfig somehow fails right after we wrote a valid YAML, skip the
      // preflight rather than masking the original init success — but surface
      // a note so the user knows checks didn't run.
      log(`(preflight skipped: ${String(err)})`)
    }

    // 10. Print summary + next steps.
    log("")
    log(isReInit ? "unattended-claude re-initialized." : "unattended-claude initialized.")
    for (const n of notes) log(`  - ${n}`)
    if (preflightResults.length > 0) {
      log("")
      log("Preflight issues to address:")
      for (const r of preflightResults) log(`  ${formatResult(r)}`)
    }
    log("")
    log("Next steps:")
    log(`  1. Edit ${join(runtimeDir, "todo.md")} — add what you want done.`)
    log("  2. Run `ucl plan` to convert todos into task docs.")
    log("  3. Run `ucl run --until <HH:MM>` when you're leaving the keyboard.")

    return { configPath, runtimeDir, notes }
  } finally {
    if (ownRl && rl) rl.close()
  }
}

/**
 * Loop until user gives a valid bin name. Empty answer → default. Anything
 * other than "claude" / "happy" → re-prompt with a hint.
 */
async function promptBin(
  ask: (q: string) => Promise<string>,
  log: (s: string) => void,
  defaultBin: "claude" | "happy",
): Promise<"claude" | "happy"> {
  while (true) {
    const ans = (await ask(`Runtime bin — claude or happy [${defaultBin}]: `)).toLowerCase()
    const pick = ans.length === 0 ? defaultBin : ans
    if (pick === "claude" || pick === "happy") return pick
    log(`  invalid — expected "claude" or "happy"`)
  }
}

function defaultToolCheck(cmd: string): boolean {
  const r = Bun.spawnSync(["which", cmd], { stdout: "pipe", stderr: "pipe" })
  return r.exitCode === 0
}

/**
 * Read `template_version` from a SKILL.md frontmatter block. Returns 0 if the
 * file has no frontmatter or no `template_version` line — treats missing as
 * "oldest" so a template that adds the field for the first time still warns
 * once the user has installed.
 *
 * Plain regex — not yaml-utils — because the frontmatter is small, fixed
 * shape, and pulling Document machinery for a single integer read is overkill.
 */
function readSkillVersion(skillFile: string): number {
  const src = readFileSync(skillFile, "utf8")
  const m = /^---\n([\s\S]*?)\n---/.exec(src)
  if (!m) return 0
  const verLine = /^template_version:\s*(\d+)\s*$/m.exec(m[1]!)
  return verLine ? Number(verLine[1]) : 0
}
