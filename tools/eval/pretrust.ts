// Pre-trust: before a live run's AUT starts, start each real harness the case uses once in the
// sandbox repo, answer its trust dialogs with the trusting choice, and quit it without a prompt (no
// model tokens). A user's own repo was trusted long ago; a fresh sandbox repo was not, and without
// this a worker of a harness the AUT is not stalls at a dialog the AUT never saw (claude's folder
// trust, which its worktree inherits from the repo only once the repo is trusted; codex's hook
// review, which a per-sandbox CODEX_HOME asks for once).
//
// - claude: the user's claude (bin/claude, the AUT pane's env) records the folder trust in the
//   user's ~/.claude.json itself, keyed by the folder's real path; the rig only reads that file.
//   An ssh host's clone (<sandbox>/hosts/<h>/home/repo) is trusted the same way: the host's HOME
//   links the same ~/.claude.json, and the host's worktrees are worktrees of that clone.
// - codex (EVAL_CODEX_HOOKS=codex-home only): codex records hook trust in the sandbox CODEX_HOME's
//   config.toml as `hooks.state."<CODEX_HOME>/hooks.json:<event>:<group>:<n>".trusted_hash`, keyed
//   by the hooks file, not the project, so one trust covers every codex pane of the run (workers'
//   worktrees included; mu's codex preset trusts a worker's worktree folder by real path).
// - cursor-agent and Muse Code need nothing: mu's spawn presets pass `--trust` /
//   `--trust-workspace` for a worktree.
//
// Bounded: each start has a deadline, and a step that cannot confirm adds a note to the run's
// notes instead of failing the run. Hook calls of the pre-trust session record nothing in
// hooks.log (EVAL_WORKER_DIR is blanked in its pane).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { CodexHooks } from "./harness.ts";
import { realPaneIO, trustDialogKeys } from "./runner-pane.ts";
import { realTmux } from "./sandbox.ts";
import type { Sandbox, Scenario } from "./types.ts";

export type PretrustHarness = "claude" | "codex";

export interface PretrustTarget {
  harness: PretrustHarness;
  dir: string;
}

/** What pre-trust does to the outside world; tests replace it (test/eval/pretrust.test.ts). */
export interface PretrustIO {
  /** A new pane on the sandbox's tmux server running `command` in `dir`; its id, null on failure. */
  open(sb: Sandbox, dir: string, command: string): string | null;
  capture(sb: Sandbox, pane: string): string | null;
  keys(sb: Sandbox, pane: string, key: string): void;
  /** The pane's process, null when it has exited or the pane is gone. */
  pid(sb: Sandbox, pane: string): number | null;
  close(sb: Sandbox, pane: string): void;
  /** Whether the harness's trust for `dir` is on record; null when it cannot tell. */
  trusted(sb: Sandbox, h: PretrustHarness, dir: string): boolean | null;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const TICK_MS = 500;
/** Default deadline for one harness to show a ready prompt. */
export const PRETRUST_TIMEOUT_MS = 150_000;
/** How long a quit harness gets to exit before its pane is killed. */
const QUIT_MS = 5_000;
const MAX_ANSWERS = 4;

/**
 * Which harnesses need a pre-trust and where: claude whenever it runs (the AUT, or a worker named in
 * the case's mix), in the repo and each ssh host's clone; codex likewise, only with a sandbox
 * CODEX_HOME (`global` keeps the user's own codex home, whose trust persists). None without a
 * hook-harness case or with fake workers.
 */
export function pretrustTargets(
  sb: Pick<Sandbox, "dir" | "repoDir">,
  scenario: Pick<Scenario, "hookHarnesses">,
  o: { aut: string; codexHooks: CodexHooks },
): PretrustTarget[] {
  const workers = (scenario.hookHarnesses?.workers ?? []).join(" ");
  const uses = (h: PretrustHarness) => o.aut === h || new RegExp(`\\b${h}\\b`).test(workers);
  const out: PretrustTarget[] = [];
  if (uses("claude")) {
    out.push({ harness: "claude", dir: sb.repoDir });
    for (const repo of hostRepos(sb.dir)) out.push({ harness: "claude", dir: repo });
  }
  if (uses("codex") && o.codexHooks === "codex-home")
    out.push({ harness: "codex", dir: sb.repoDir });
  return out;
}

function hostRepos(dir: string): string[] {
  const hosts = join(dir, "hosts");
  if (!existsSync(hosts)) return [];
  return readdirSync(hosts)
    .map((h) => join(hosts, h, "home", "repo"))
    .filter((r) => existsSync(r));
}

/**
 * The harness's own TUI shows its input prompt, read strictly per harness: no trust dialog, no
 * other selector or notice waiting for a key, and the harness's own ready marks. Anything else on
 * the screen proves nothing: before the TUI draws, the pane holds the login shell's prompt (a zsh
 * line that ends with or starts with `❯`) and a launcher's banner and its `Installing
 * <plugin>@<market> ...` lines (live, codex: a generic "a line led by ❯" check quit it there, before
 * its trust dialogs).
 *
 * - codex: its footer (`? for shortcuts`, or `context left` in the same line) and its `›` input
 *   line (`› Ask Codex to do anything`, any placeholder) that is not a numbered option.
 * - claude: its footer (`? for shortcuts`), or its input box: a `>`/`❯` line right under the box's
 *   top rule (`─`, `╭`), not a numbered option.
 */
export function promptReady(screen: string, harness: PretrustHarness): boolean {
  if (screen.trim() === "" || trustDialogKeys(screen) !== null) return false;
  if (/enter to (confirm|continue|select)|esc to cancel|press enter/i.test(screen)) return false;
  const lines = screen.split("\n");
  const option = (l: string) => /^\s*[│|]?\s*[>❯›]\s*\d+\./.test(l);
  const footer = lines.some((l) => /\? for shortcuts|\d+% context left/i.test(l));
  if (harness === "codex") {
    return footer && lines.some((l) => /^\s*›(\s|$)/.test(l) && !option(l));
  }
  if (footer) return true;
  return lines.some(
    (l, i) => /^\s*[│|]?\s*[>❯](\s|$)/.test(l) && !option(l) && /^\s*[─╭]/.test(lines[i - 1] ?? ""),
  );
}

/** One harness in one directory; a note when the step could not confirm, else null. */
export async function pretrustOne(
  sb: Sandbox,
  t: PretrustTarget,
  io: PretrustIO,
  timeoutMs = PRETRUST_TIMEOUT_MS,
): Promise<string | null> {
  const what = `pre-trust ${t.harness} in ${t.dir === sb.repoDir ? "the sandbox repo" : t.dir}`;
  if (io.trusted(sb, t.harness, t.dir) === true) return null;
  const pane = io.open(sb, t.dir, join(sb.binDir, t.harness));
  if (pane === null) return `${what}: could not open a pane`;
  const deadline = io.now() + timeoutMs;
  let answered = 0;
  let lastScreen = "";
  let readyTicks = 0;
  let outcome: "ready" | "exited" | "timeout" = "timeout";
  while (io.now() < deadline) {
    await io.sleep(TICK_MS);
    if (io.pid(sb, pane) === null) {
      outcome = "exited";
      break;
    }
    const screen = io.capture(sb, pane) ?? "";
    const keys = trustDialogKeys(screen);
    if (keys !== null) {
      readyTicks = 0;
      // answer each dialog once; a screen that has not changed yet is still redrawing
      if (screen !== lastScreen && answered < MAX_ANSWERS) {
        for (const k of keys) io.keys(sb, pane, k);
        answered++;
        lastScreen = screen;
      }
      continue;
    }
    readyTicks = promptReady(screen, t.harness) ? readyTicks + 1 : 0;
    if (readyTicks >= 2) {
      outcome = "ready";
      break;
    }
  }
  // quit without a prompt: Ctrl-C twice exits claude and codex from an empty input
  if (io.pid(sb, pane) !== null) {
    io.keys(sb, pane, "C-c");
    await io.sleep(300);
    io.keys(sb, pane, "C-c");
    const quitBy = io.now() + QUIT_MS;
    while (io.pid(sb, pane) !== null && io.now() < quitBy) await io.sleep(TICK_MS);
  }
  io.close(sb, pane);
  const recorded = io.trusted(sb, t.harness, t.dir);
  const dialogs = `${answered} dialog${answered === 1 ? "" : "s"} answered`;
  if (recorded === false)
    return `${what}: trust not on record after the step (${outcome}, ${dialogs}); its panes may stop at a trust dialog`;
  if (outcome === "ready") return null;
  const why =
    outcome === "exited"
      ? "it exited before showing a prompt"
      : `no ready prompt within ${Math.round(timeoutMs / 1000)} s`;
  return recorded === true
    ? null
    : `${what}: could not confirm (${why}, ${dialogs}); its panes may stop at a trust dialog`;
}

/** Every target in turn; the notes of those that could not confirm. Never throws. */
export async function pretrust(
  sb: Sandbox,
  targets: PretrustTarget[],
  io: PretrustIO = realPretrustIO,
  timeoutMs?: number,
): Promise<string[]> {
  const notes: string[] = [];
  for (const t of targets) {
    try {
      const n = await pretrustOne(sb, t, io, timeoutMs);
      if (n !== null) notes.push(n);
    } catch (e) {
      notes.push(`pre-trust ${t.harness}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return notes;
}

// ---- trust records (read only) -------------------------------------------------------------------

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * claude: `dir` itself has `hasTrustDialogAccepted` in the user's ~/.claude.json. An ancestor's
 * record is not enough: the sandbox repo's .claude/settings.json pre-approves tools, and Claude
 * Code asks about such a folder even under a trusted parent (live E1, codex AUT, with /private/tmp
 * trusted: the claude worker stopped at the dialog).
 */
export function claudeTrusted(claudeJson: string, dir: string): boolean | null {
  let doc: { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> };
  try {
    doc = JSON.parse(readFileSync(claudeJson, "utf8")) as typeof doc;
  } catch {
    return null;
  }
  return doc.projects?.[real(dir)]?.hasTrustDialogAccepted === true;
}

/** codex's key of a hook event in `hooks.state`: `UserPromptSubmit` is `user_prompt_submit`. */
const snakeEvent = (event: string): string =>
  event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * codex: the codex home's config.toml trusts EVERY hook of its own hooks.json: each has a
 * `[hooks.state."<home>/hooks.json:<snake_event>:<group>:<index>"]` table with a `trusted_hash`
 * (the home spelled as given or by its real path). One trusted hook is not enough: codex asks to
 * review the rest, and a worker would stop there. null when either file is unreadable.
 */
export function codexHooksTrusted(codexHome: string): boolean | null {
  let config: string;
  let doc: { hooks?: unknown };
  try {
    config = readFileSync(join(codexHome, "config.toml"), "utf8");
    doc = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8")) as typeof doc;
  } catch {
    return null;
  }
  const files = [...new Set([join(codexHome, "hooks.json"), join(real(codexHome), "hooks.json")])];
  const trusted = (id: string): boolean =>
    files.some((f) => {
      const at = config.indexOf(`[hooks.state."${f}:${id}"]`);
      return at >= 0 && /^\s*trusted_hash\s*=/m.test(config.slice(at).split("\n[")[0] ?? "");
    });
  const events =
    typeof doc.hooks === "object" && doc.hooks !== null
      ? (doc.hooks as Record<string, unknown>)
      : {};
  const ids: string[] = [];
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g: unknown, gi) => {
      const hooks = (g as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(hooks)) return;
      hooks.forEach((_h, hi) => {
        ids.push(`${snakeEvent(event)}:${gi}:${hi}`);
      });
    });
  }
  return ids.every(trusted);
}

function tmux(sb: Sandbox, args: string[]): string | null {
  try {
    return execFileSync(realTmux(), ["-L", sb.tmuxSocket, ...args], {
      env: sb.env,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

let sessionSeq = 0;

export const realPretrustIO: PretrustIO = {
  open: (sb, dir, command) => {
    const out = tmux(sb, [
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      `eval-pretrust-${++sessionSeq}`,
      "-x",
      "200",
      "-y",
      "50",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      dir,
      // the observer records nothing for this session (hook-observer.ts reads EVAL_WORKER_DIR)
      "-e",
      "EVAL_WORKER_DIR=",
      command,
    ]);
    return out?.startsWith("%") ? out : null;
  },
  capture: realPaneIO.capture,
  keys: realPaneIO.keys,
  pid: realPaneIO.pid,
  close: (sb, pane) => {
    tmux(sb, ["kill-pane", "-t", pane]);
  },
  trusted: (sb, h, dir) => {
    if (h === "codex")
      return sb.env.CODEX_HOME === undefined ? null : codexHooksTrusted(sb.env.CODEX_HOME);
    const configDir = sb.env.CLAUDE_CONFIG_DIR ?? sb.env.HOME;
    return configDir === undefined ? null : claudeTrusted(join(configDir, ".claude.json"), dir);
  },
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};
