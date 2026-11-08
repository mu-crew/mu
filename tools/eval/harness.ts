// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The harness half of a sandbox: which agent CLI the AUT is, which harness binaries its workers
// get (the user's real ones, or the fake ones of fake-harness.ts), and the hook entries that make
// every hook harness report through the worktree builds of murmur, mu and muzzle.
//
// Hook entries are written where the harness reads project hooks, inside the sandbox repo and
// committed there (so every worktree and the ssh host's clone has them): `.claude/settings.json`,
// `.cursor/hooks.json`, `.muse/hooks.json`. codex reads hooks only from its home: in a fake run
// that is the sandbox HOME's `.codex/hooks.json`; in a live run see `CodexHooks` below. The user's
// own ~/.claude, ~/.cursor and Muse config are never written. The surface's mu skill goes where
// each orchestrator harness reads it (`autSkill` below).
//
// A user's own entries still fire in a live run (the harness reads them too). They spell `murmur
// hook <harness>`, `mu hook stop` and `muzzle hook`, which the sandbox PATH resolves to the
// sandbox's shims, and those shims drop exactly these calls: only the rig's entries, which run the
// worktree builds by absolute path, record anything. Every other call through a shim runs with the
// sandbox's isolation variables, whatever the caller's env says (isolation.ts).
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FAKE_HARNESSES, type FakeHarness } from "./fake-payloads.ts";
import { pinScript } from "./isolation.ts";
import { stageRig } from "./rig-guard.ts";
import type { Sandbox, Surface } from "./types.ts";

/** The orchestrator harnesses a case runs under. pi over rpc (runner.ts); the four hook harnesses in a pane (runner-pane.ts). */
export const AUT_HARNESSES = ["pi", "claude", "codex", "cursor-agent", "muse"] as const;
export type AutHarness = (typeof AUT_HARNESSES)[number];
/** An AUT that runs in a pane: every one but pi. */
export type PaneHarness = Exclude<AutHarness, "pi">;

/**
 * What a pane AUT's command adds to the harness, because `mu orchestrate` adds none: mu's spawn
 * presets (the row's trust and auto-approve flags, src/harnesses.ts, spec D6) are a worker's, and
 * an unattended orchestrator in a fresh sandbox repo needs both. claude and codex need nothing:
 * the repo's `.claude/settings.json` allows the commands a claude AUT runs, the pre-trust
 * (pretrust.ts) answers their trust dialogs, and codex's hook trust is answered in the pane. The
 * values mirror the harness table (the rig imports nothing from src/):
 *
 * - cursor-agent: `--trust` (workspace trust; it never saves it) and `--sandbox enabled`, mu's
 *   auto-approve preset (commands run in its sandbox without asking; `--force` stays opt-in).
 * - muse: `--trust-workspace` (not saved) and `--approval-mode never`.
 */
export const AUT_FLAGS: Record<PaneHarness, readonly string[]> = {
  claude: [],
  codex: [],
  "cursor-agent": ["--trust", "--sandbox", "enabled"],
  muse: ["--trust-workspace", "--approval-mode", "never"],
};

export function parseAutHarness(v: string): AutHarness {
  if ((AUT_HARNESSES as readonly string[]).includes(v)) return v as AutHarness;
  throw new Error(`--harness must be one of ${AUT_HARNESSES.join(", ")}, got ${JSON.stringify(v)}`);
}

/** The worker harnesses a mix may name. */
export const WORKER_HARNESSES = ["claude", "codex", "cursor-agent", "muse", "pi"] as const;
export type WorkerHarness = (typeof WORKER_HARNESSES)[number];

export type HookHarness = FakeHarness;
export const HOOK_HARNESSES: readonly HookHarness[] = FAKE_HARNESSES;

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
export const OBSERVER_TS: string = join(EVAL_DIR, "hook-observer.ts");

/** The worktree builds a hook entry runs, by absolute path. */
export interface HookTools {
  node: string;
  /** The surface's dist/cli.js. */
  mu: string;
  /** murmur's dist/cli.js. */
  murmur: string;
  /** The muzzle binary; null when EVAL_MUZZLE is unset (no muzzle entries then). */
  muzzle: string | null;
  observer: string;
}

export class HarnessToolsError extends Error {}

/**
 * EVAL_MURMUR names a murmur checkout (or its dist/cli.js); EVAL_MUZZLE a muzzle checkout (its
 * target/release or target/debug binary) or the binary itself. murmur is required: without it no
 * hook harness reports anything.
 */
export function resolveTools(surface: Surface, env: NodeJS.ProcessEnv = process.env): HookTools {
  const m = env.EVAL_MURMUR?.trim() ?? "";
  if (m === "")
    throw new HarnessToolsError(
      "hook-harness scenarios need a murmur build: set EVAL_MURMUR=<murmur checkout> (npm run build there first)",
    );
  const murmur = m.endsWith(".js") ? m : join(m, "dist", "cli.js");
  if (!existsSync(murmur))
    throw new HarnessToolsError(`EVAL_MURMUR: no ${murmur} (build murmur first)`);
  const z = env.EVAL_MUZZLE?.trim() ?? "";
  let muzzle: string | null = null;
  if (z !== "") {
    const cands = existsSync(join(z, "Cargo.toml"))
      ? [join(z, "target", "release", "muzzle"), join(z, "target", "debug", "muzzle")]
      : [z];
    muzzle = cands.find((c) => existsSync(c)) ?? null;
    if (muzzle === null)
      throw new HarnessToolsError(`EVAL_MUZZLE: no muzzle binary at ${cands.join(" or ")}`);
  }
  return { node: process.execPath, mu: surface.cli, murmur, muzzle, observer: OBSERVER_TS };
}

/** The events murmur's `init` hooks per harness (murmur src/hook-install.ts HOOK_TARGETS). */
export const MURMUR_EVENTS: Record<HookHarness, readonly string[]> = {
  claude: [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "Stop",
    "StopFailure",
    "SessionEnd",
  ],
  codex: [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Stop",
    "Interrupt",
    "SessionEnd",
  ],
  "cursor-agent": [
    "sessionStart",
    "beforeSubmitPrompt",
    "afterAgentResponse",
    "stop",
    "sessionEnd",
  ],
  muse: [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "Interrupt",
    "SessionEnd",
  ],
};

/** Events whose handlers must be declared async (Muse delivers `Interrupt` only to those). */
const ASYNC_EVENTS: Record<HookHarness, readonly string[]> = {
  claude: [],
  codex: [],
  "cursor-agent": [],
  muse: ["Interrupt"],
};

/** mu's Stop entry (mu init, D7): none for Muse, whose block does not deliver the reason. */
export const MU_STOP_EVENT: Record<HookHarness, string | null> = {
  claude: "Stop",
  codex: "Stop",
  "cursor-agent": "stop",
  muse: null,
};

/** muzzle's entry (muzzle src/init/plan.rs TARGETS). */
export const MUZZLE_ENTRY: Record<HookHarness, { event: string; matcher?: string; arg: string }> = {
  claude: { event: "PreToolUse", matcher: "Bash", arg: "claude" },
  codex: { event: "PreToolUse", matcher: "^Bash$", arg: "codex" },
  "cursor-agent": { event: "beforeShellExecution", arg: "cursor" },
  muse: { event: "PreToolUse", matcher: "bash", arg: "claude" },
};

export interface HookPaths {
  /** murmur's state for this machine of the sandbox. */
  murmurState: string;
  workerDir: string;
  /** XDG_STATE_HOME muzzle keeps its slots under. */
  stateHome: string;
  /** mu's Stop entry timeout (seconds): mu init's 600 live, shorter in a fake run. */
  stopTimeoutS: number;
}

export interface HookEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  async?: boolean;
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Every entry the rig writes for `h`: the observer and murmur on each murmur event, mu on the stop
 * event, muzzle on its tool event. Muse clears its hooks' environment, so its commands name the
 * sandbox paths themselves; the others read them from the env, which keeps codex's entries the
 * same from run to run (codex asks to trust a new or changed hook once).
 */
export function hookEntries(h: HookHarness, tools: HookTools, paths: HookPaths): HookEntry[] {
  const pin = h === "muse";
  const node = q(tools.node);
  const out: HookEntry[] = [];
  for (const event of MURMUR_EVENTS[h]) {
    const isAsync = ASYNC_EVENTS[h].includes(event);
    out.push({
      event,
      command: `${node} ${q(tools.observer)} ${h}${pin ? ` ${q(join(paths.workerDir, "hooks.log"))}` : ""}`,
      ...(isAsync ? { async: true } : {}),
    });
    out.push({
      event,
      command: `${pin ? `MURMUR_STATE_DIR=${q(paths.murmurState)} ` : ""}${node} ${q(tools.murmur)} hook ${h}`,
      ...(isAsync ? { async: true } : {}),
    });
  }
  const stop = MU_STOP_EVENT[h];
  if (stop !== null)
    out.push({
      event: stop,
      command: `${node} ${q(tools.mu)} hook stop ${h} --timeout ${paths.stopTimeoutS} || true`,
      timeout: paths.stopTimeoutS,
    });
  if (tools.muzzle !== null) {
    const z = MUZZLE_ENTRY[h];
    out.push({
      event: z.event,
      ...(z.matcher !== undefined ? { matcher: z.matcher } : {}),
      command: `${pin ? `XDG_STATE_HOME=${q(paths.stateHome)} ` : ""}${q(tools.muzzle)} hook ${z.arg}`,
    });
  }
  return out;
}

/** The config document holding `entries`, in the harness's own shape. */
export function hookDoc(h: HookHarness, entries: HookEntry[]): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  if (h === "cursor-agent") {
    for (const e of entries) {
      const list = hooks[e.event] ?? [];
      hooks[e.event] = list;
      list.push({
        command: e.command,
        ...(e.timeout !== undefined ? { timeout: e.timeout, loop_limit: null } : {}),
      });
    }
    return { version: 1, hooks };
  }
  for (const e of entries) {
    const groups = (hooks[e.event] ?? []) as { matcher?: string; hooks: unknown[] }[];
    hooks[e.event] = groups;
    let g = groups.find((x) => x.matcher === e.matcher);
    if (g === undefined) {
      g = { ...(e.matcher !== undefined ? { matcher: e.matcher } : {}), hooks: [] };
      groups.push(g);
    }
    g.hooks.push({
      type: "command",
      command: e.command,
      ...(e.timeout !== undefined ? { timeout: e.timeout } : {}),
      ...(e.async ? { async: true } : {}),
    });
  }
  return { hooks };
}

/**
 * Commands a claude in the sandbox may run without asking (project settings): mu, git, the eval
 * worker's own scripts and plain reads. A claude worker runs in `acceptEdits` (mu's preset), which
 * asks before any other shell command; a dialog would stall a live run.
 */
export const CLAUDE_ALLOW = [
  "Bash(mu:*)",
  "Bash(git:*)",
  "Bash(eval-worker)",
  "Bash(eval-worker:*)",
  "Bash(eval-slow)",
  "Bash(cat:*)",
  "Bash(ls:*)",
  "Bash(grep:*)",
  "Bash(sed:*)",
  "Bash(node -e:*)",
];

/** Project hook files, relative to the repo root: every hook harness but codex. */
export function projectHookFiles(tools: HookTools, paths: HookPaths): Record<string, string> {
  const file = (h: HookHarness, extra: Record<string, unknown> = {}) =>
    `${JSON.stringify({ ...extra, ...hookDoc(h, hookEntries(h, tools, paths)) }, null, 2)}\n`;
  return {
    ".claude/settings.json": file("claude", { permissions: { allow: CLAUDE_ALLOW } }),
    ".cursor/hooks.json": file("cursor-agent"),
    ".muse/hooks.json": file("muse"),
  };
}

/** Files the harnesses may leave in a project that must not dirty a worktree. */
const PROJECT_IGNORES = [
  ".claude/settings.local.json",
  ".claude/*.lock",
  ".cursor/*.db",
  ".muse/sessions/",
];

// ---- codex ---------------------------------------------------------------------------------------

/**
 * How a live run gives codex the rig's hooks. codex reads hooks only from its home
 * (`$CODEX_HOME`, else ~/.codex; `realCodexDir`):
 *
 * - `global` (default): its hooks.json is copied to `hooks.json.mu-eval-<pid>`, the rig's entries
 *   are added to it, and the copy is moved back when the last live sandbox of the process closes
 *   (on SIGINT/SIGTERM and crashes too; a later run restores a backup whose owner is dead before
 *   it starts, and refuses while a live one holds it). Sandboxes of one process share the install
 *   when their entries are the same (one surface); a second surface's sandbox is refused while one
 *   is live. The user's own entries stay and are dropped by the shims. The entries are the same
 *   every run, so codex's hook trust, recorded in its config.toml by codex, is asked for once.
 *   codex then reads the user's own skills (`autSkill`).
 * - `codex-home`: CODEX_HOME points at <sandbox>/codex-home, which holds the rig's hooks.json, a
 *   copy of config.toml, links to every other top-level file of the real home (auth), and a
 *   skills/ holding the surface's mu skill beside links to the user's other skills. Nothing in the
 *   real home is written by the rig, but codex records hook trust in the copy, so it asks again in
 *   every run.
 */
export type CodexHooks = "global" | "codex-home";

export function parseCodexHooks(v: string | undefined): CodexHooks {
  if (v === undefined || v === "" || v === "global") return "global";
  if (v === "codex-home") return "codex-home";
  throw new Error(`EVAL_CODEX_HOOKS must be global or codex-home, got ${JSON.stringify(v)}`);
}

const BACKUP = /^hooks\.json\.mu-eval-(\d+)$/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Restore a backup a crashed run left in `codexDir`; refuse while another live run owns one. */
export function recoverCodexBackup(codexDir: string): void {
  if (!existsSync(codexDir)) return;
  for (const f of readdirSync(codexDir)) {
    const m = BACKUP.exec(f);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && alive(pid))
      throw new Error(
        `another live eval run (pid ${pid}) holds ${join(codexDir, "hooks.json")}; wait for it`,
      );
    restoreFrom(codexDir, join(codexDir, f));
  }
}

function restoreFrom(codexDir: string, backup: string): void {
  const target = join(codexDir, "hooks.json");
  const body = readFileSync(backup, "utf8");
  if (body === "") rmSync(target, { force: true });
  else writeFileSync(target, body);
  rmSync(backup, { force: true });
}

/** The codex home a live run's codex reads: the caller's CODEX_HOME, else ~/.codex. */
export function realCodexDir(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.CODEX_HOME?.trim() ?? "";
  return h !== "" && isAbsolute(h) ? h : join(homedir(), ".codex");
}

/** The process's install into a global codex home, shared by its live sandboxes. */
let globalInstall: { dir: string; doc: string; users: number; restore: () => void } | null = null;

/**
 * Merge the rig's entries into codexDir/hooks.json after backing it up; returns the release. The
 * file is restored when the last sandbox of this process that installed releases it; a sandbox
 * with other entries (another surface's mu) is refused while the install is live.
 */
export function installCodexGlobal(codexDir: string, doc: Record<string, unknown>): () => void {
  const body = JSON.stringify(doc);
  if (globalInstall === null) {
    globalInstall = { dir: codexDir, doc: body, users: 0, restore: mergeCodexHooks(codexDir, doc) };
  } else if (globalInstall.dir !== codexDir || globalInstall.doc !== body) {
    throw new Error(
      `a live sandbox of this run already holds ${join(globalInstall.dir, "hooks.json")} with other hook entries (another surface); run such cases with --concurrency 1, or set EVAL_CODEX_HOOKS=codex-home`,
    );
  }
  const mine = globalInstall;
  mine.users++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mine.users--;
    if (mine.users > 0) return;
    if (globalInstall === mine) globalInstall = null;
    mine.restore();
  };
}

function mergeCodexHooks(codexDir: string, doc: Record<string, unknown>): () => void {
  recoverCodexBackup(codexDir);
  mkdirSync(codexDir, { recursive: true });
  const target = join(codexDir, "hooks.json");
  const backup = join(codexDir, `hooks.json.mu-eval-${process.pid}`);
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  writeFileSync(backup, before);
  let base: { hooks?: Record<string, unknown[]> } = {};
  try {
    base = before === "" ? {} : (JSON.parse(before) as typeof base);
  } catch {
    rmSync(backup, { force: true });
    throw new Error(`${target} is not JSON; not touching it`);
  }
  const hooks: Record<string, unknown[]> = { ...(base.hooks ?? {}) };
  for (const [ev, groups] of Object.entries((doc.hooks ?? {}) as Record<string, unknown[]>))
    hooks[ev] = [...(hooks[ev] ?? []), ...groups];
  writeFileSync(target, `${JSON.stringify({ ...base, hooks }, null, 2)}\n`);
  return () => {
    if (existsSync(backup)) restoreFrom(codexDir, backup);
  };
}

/**
 * A sandbox codex home: the rig's hooks.json, a copy of config.toml, links to the other files, and
 * skills/ with `skillDir` as mu beside links to the user's other skills.
 */
export function makeCodexHome(
  dir: string,
  realDir: string,
  doc: Record<string, unknown>,
  skillDir?: string,
): void {
  mkdirSync(dir, { recursive: true });
  if (existsSync(realDir)) {
    for (const f of readdirSync(realDir)) {
      if (f === "hooks.json" || BACKUP.test(f)) continue;
      const src = join(realDir, f);
      if (!lstatSync(src).isFile()) continue;
      if (f === "config.toml") copyFileSync(src, join(dir, f));
      else symlinkSync(src, join(dir, f));
    }
  }
  writeFileSync(join(dir, "hooks.json"), `${JSON.stringify(doc, null, 2)}\n`);
  if (skillDir === undefined || !existsSync(skillDir)) return;
  const skills = join(dir, "skills");
  mkdirSync(skills, { recursive: true });
  const realSkills = join(realDir, "skills");
  if (existsSync(realSkills))
    for (const f of readdirSync(realSkills))
      if (f !== "mu") symlinkSync(join(realSkills, f), join(skills, f));
  cpSync(skillDir, join(skills, "mu"), { recursive: true });
}

// ---- skills --------------------------------------------------------------------------------------

/** Where the surface's skill goes in the sandbox repo: claude's project skills. */
export const PROJECT_SKILL = ".claude/skills/mu";

/**
 * Where an AUT that reads no claude project skill finds the surface's copy, committed beside
 * `PROJECT_SKILL` only when it is the AUT (so a claude or codex run's repo is unchanged):
 *
 * - cursor-agent: `.cursor/skills/`, its first-party project skills ("Project Skill" in its own
 *   UI). Read from cursor-agent 2026.10.22's bundle: it loads `<workspace>/<dir>/skills` for
 *   `.cursor` and `.agents`, and as third-party dirs `.claude`, `.codex` and `.grok`, so it may
 *   list the claude copy too (same bytes).
 * - muse: `.agents/skills/`, Muse Code's project scope (its built-in skill-authoring instructions,
 *   Muse Code 1.4.15). Never written for another AUT: pi, codex and cursor-agent read that
 *   directory as well; the sandbox's pi runs with `--no-skills`, so no pi sees it.
 */
export const AUT_PROJECT_SKILL: Partial<Record<AutHarness, string>> = {
  "cursor-agent": ".cursor/skills/mu",
  muse: ".agents/skills/mu",
};

const skillText = (dir: string): string | null => {
  try {
    return readFileSync(join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
};

/** The HOME dot-dirs whose `skills/` cursor-agent loads as personal skills (its 2026.10.22 bundle). */
export const CURSOR_PERSONAL_SKILL_DIRS = [".cursor", ".claude", ".codex", ".agents", ".grok"];

/**
 * Which mu skill a live pane AUT reads, when it may not be the surface's; null when it is.
 *
 * - claude: the repo's project skill (`PROJECT_SKILL`, the surface's copy), but a personal skill
 *   of the same name (~/.claude/skills/mu) takes precedence over a project one.
 * - codex: `codex-home` gives it the surface's skill; `global` leaves it the user's own
 *   <codex home>/skills/mu, whatever version that is.
 */
export function autSkill(
  h: AutHarness,
  surfaceSkill: string,
  o: { home: string; codexDir: string; codexHooks: CodexHooks },
): string | null {
  const want = skillText(surfaceSkill);
  if (h === "claude") {
    const mine = join(o.home, ".claude", "skills", "mu");
    const got = skillText(mine);
    if (got === null || got === want) return null;
    return `claude AUT: ${mine} differs from the surface's skill and takes precedence over the project copy, so the AUT reads that one`;
  }
  if (h === "codex" && o.codexHooks === "global") {
    const mine = join(o.codexDir, "skills", "mu");
    const got = skillText(mine);
    if (got === want) return null;
    return `codex AUT: EVAL_CODEX_HOOKS=global leaves codex the user's skills, and ${mine} ${got === null ? "does not exist" : "differs from the surface's skill"}; set EVAL_CODEX_HOOKS=codex-home to give it the surface's`;
  }
  if (h === "cursor-agent") {
    // its personal skill dirs, all under HOME (its build ignores CLAUDE_CONFIG_DIR and CODEX_HOME;
    // cursor-agent 2026.10.22 loads <dir>/skills for each of these)
    const differ = CURSOR_PERSONAL_SKILL_DIRS.map((d) => join(o.home, d, "skills", "mu")).filter(
      (d) => {
        const got = skillText(d);
        return got !== null && got !== want;
      },
    );
    if (differ.length === 0) return null;
    return `cursor-agent AUT: ${differ.join(", ")} ${differ.length === 1 ? "differs" : "differ"} from the surface's skill, and cursor-agent loads personal skills beside the project copy (${AUT_PROJECT_SKILL["cursor-agent"]}), so the AUT may read that one`;
  }
  if (h === "muse")
    return `muse AUT: the surface's skill is the project skill ${AUT_PROJECT_SKILL.muse}; a mu skill installed through \`muse skills\` or a plugin loads too, and the rig cannot see those`;
  return null;
}

// ---- the ssh host's HOME -------------------------------------------------------------------------

/**
 * What a live run links from the caller's HOME into the ssh host's: each harness's config, auth
 * and install (claude's ~/.claude and ~/.claude.json, codex's, cursor's, pi's, ~/.config for
 * cursor-agent, Muse and mise, ~/.local/share for Muse and launcher installs, ~/.local/bin, and
 * on macOS ~/Library, where the keychain holds claude's and cursor's logins). The host's HOME
 * itself stays <hostRoot>/home, so mu's state there (~/.local/state/mu-next: anchors, remote
 * worktrees) is the sandbox's.
 */
export const HOST_HOME_LINKS = [
  ".claude",
  ".claude.json",
  ".codex",
  ".cursor",
  ".pi",
  ".config",
  ".local/share",
  ".local/bin",
  "Library",
] as const;

/** Link HOST_HOME_LINKS that exist in `callerHome` into `hostHome`. */
export function linkHostHome(hostHome: string, callerHome: string): void {
  for (const rel of HOST_HOME_LINKS) {
    const src = join(callerHome, rel);
    const dst = join(hostHome, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst);
  }
}

// ---- binaries ------------------------------------------------------------------------------------

function writeExec(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** `name` on `pathEnv`, skipping `skip` (the sandbox bin). */
export function which(
  name: string,
  pathEnv: string | undefined,
  skip: string[] = [],
): string | null {
  for (const d of (pathEnv ?? "").split(":")) {
    if (!isAbsolute(d) || skip.includes(d)) continue;
    const p = join(d, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * A fake harness binary: `<dir>/.rt/fake/<h>.mjs` imports fake-harness.ts, so `ps` shows `node
 * …/<h>.mjs`, which murmur reads as that harness; bin/<h> starts it.
 */
export function installFakeHarness(
  dir: string,
  binDir: string,
  h: HookHarness,
  node: string,
): void {
  const stub = join(dir, ".rt", "fake", `${h}.mjs`);
  mkdirSync(dirname(stub), { recursive: true });
  writeFileSync(
    stub,
    `import ${JSON.stringify(pathToFileURL(stageRig(dir, "fake-harness.ts")).href)};\n`,
  );
  writeExec(join(binDir, h), `#!/bin/sh\nexec ${q(node)} ${q(stub)} "$@"\n`);
}

/** A real harness binary: bin/<h> execs the user's launcher (found on the caller's PATH). False when there is none. */
export function installRealHarness(
  binDir: string,
  h: HookHarness,
  pathEnv: string | undefined,
): boolean {
  const real = which(h, pathEnv, [binDir]);
  if (real === null) return false;
  writeExec(join(binDir, h), `#!/bin/sh\nexec ${q(real)} "$@"\n`);
  return true;
}

/** bin/murmur: the worktree build, minus harness hook calls (a user's own entries); `pin` is isolation.ts's pinScript. */
export function murmurShim(tools: HookTools, pin = ""): string {
  return `#!/bin/sh
case "$1 $2" in "hook claude"|"hook codex"|"hook cursor-agent"|"hook muse") exit 0;; esac
${pin}exec ${q(tools.node)} ${q(tools.murmur)} "$@"
`;
}

/**
 * bin/muzzle: the worktree build, minus hook calls (a user's own entries), its state (queue,
 * slots, run log) in the sandbox even when the caller's XDG_STATE_HOME is set. `muzzle hook` reads
 * no state; the `muzzle run` it rewrites a command to resolves to this shim. `pin` (isolation.ts)
 * keeps the commands muzzle runs on the sandbox's mu state too.
 */
export function muzzleShim(muzzle: string, stateHome: string, pin = ""): string {
  return `#!/bin/sh
[ "$1" = hook ] && exit 0
${pin}XDG_STATE_HOME=${q(stateHome)} exec ${q(muzzle)} "$@"
`;
}

export interface HarnessSetup {
  live: boolean;
  tools: HookTools;
  codexHooks: CodexHooks;
  /** Undo what the setup changed outside the sandbox (codex's global hooks.json); idempotent. */
  restore: () => void;
}

/** bin/murmur and bin/muzzle, each with the sandbox's pins (isolation.ts) baked in. */
export function writeToolShims(
  sb: Pick<Sandbox, "env" | "binDir">,
  tools: HookTools,
  stateHome: string,
): void {
  const pin = pinScript(sb.env, sb.binDir);
  writeExec(join(sb.binDir, "murmur"), murmurShim(tools, pin));
  if (tools.muzzle !== null)
    writeExec(join(sb.binDir, "muzzle"), muzzleShim(tools.muzzle, stateHome, pin));
}

/**
 * Give a sandbox its hook harnesses: the binaries (fake, or the user's in a live run), the tool
 * shims, and the hook entries (committed project files, and codex's).
 */
export async function setupHarnesses(
  sb: Sandbox,
  o: {
    live: boolean;
    tools: HookTools;
    codexHooks?: CodexHooks;
    stopTimeoutS?: number;
    /** Fake harness binaries (default: fake unless live). */
    fake?: boolean;
    /** The sandbox's copy of the surface's mu skill, for the harnesses that read one from the repo or their home. */
    skillDir?: string;
  },
): Promise<HarnessSetup> {
  const fake = o.fake ?? !o.live;
  const paths: HookPaths = {
    murmurState: sb.env.MURMUR_STATE_DIR ?? join(sb.dir, "murmur2"),
    workerDir: sb.workerDir,
    stateHome: join(sb.dir, "home", ".local", "state"),
    stopTimeoutS: o.stopTimeoutS ?? (fake ? 30 : 600),
  };
  for (const h of HOOK_HARNESSES) {
    if (fake) installFakeHarness(sb.dir, sb.binDir, h, o.tools.node);
    else installRealHarness(sb.binDir, h, sb.env.EVAL_CALLER_PATH ?? process.env.PATH);
  }
  writeToolShims(sb, o.tools, paths.stateHome);

  for (const [rel, body] of Object.entries(projectHookFiles(o.tools, paths))) {
    mkdirSync(dirname(join(sb.repoDir, rel)), { recursive: true });
    writeFileSync(join(sb.repoDir, rel), body);
  }
  const autSkillDir = AUT_PROJECT_SKILL[(sb.env.EVAL_AUT_HARNESS ?? "pi") as AutHarness];
  if (o.skillDir !== undefined && existsSync(o.skillDir)) {
    cpSync(o.skillDir, join(sb.repoDir, PROJECT_SKILL), { recursive: true });
    if (autSkillDir !== undefined)
      cpSync(o.skillDir, join(sb.repoDir, autSkillDir), { recursive: true });
  }
  const ignore = join(sb.repoDir, ".gitignore");
  const had = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  writeFileSync(ignore, `${had}${PROJECT_IGNORES.join("\n")}\n`);
  const extra = existsSync(join(sb.repoDir, ".agents")) ? [".agents"] : [];
  execFileSync("git", ["add", "-A", ".claude", ".cursor", ".muse", ...extra, ".gitignore"], {
    cwd: sb.repoDir,
    env: sb.env,
  });
  execFileSync("git", ["commit", "-q", "-m", "eval: hook entries"], {
    cwd: sb.repoDir,
    env: sb.env,
  });

  const codexDoc = hookDoc("codex", hookEntries("codex", o.tools, paths));
  const codexHooks = o.codexHooks ?? "global";
  let restore = (): void => {};
  if (!o.live) {
    // a fake codex reads the sandbox HOME's ~/.codex/hooks.json, as the real one reads the user's
    const d = join(sb.env.HOME ?? join(sb.dir, "home"), ".codex");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "hooks.json"), `${JSON.stringify(codexDoc, null, 2)}\n`);
  } else if (codexHooks === "codex-home") {
    makeCodexHome(join(sb.dir, "codex-home"), realCodexDir(), codexDoc, o.skillDir);
  } else {
    restore = installCodexGlobal(realCodexDir(), codexDoc);
  }
  return { live: o.live, tools: o.tools, codexHooks, restore };
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
