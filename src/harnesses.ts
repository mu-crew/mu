// mu — the harness table: what mu knows about each blessed agent CLI, as data.
//
// One frozen row per harness (claude, codex, cursor-agent, muse, pi). The
// names and shape murmur keeps are shared: `HARNESSES` is the id tuple,
// `Harness` the id, `HARNESS_TABLE` the rows, and each row carries murmur's
// argv-match fields (`names`, `packages`) so the two tools agree on which
// process is which harness. mu's rows add the rest of D6. Values were read
// from the installed binaries and the U0 spike (spec "Every harness
// first-class", D6). A `null` cell is a fact U0 has not yet verified: a
// caller must treat it as unknown, never as "none". Nothing here starts,
// configures or authenticates a harness; each launcher keeps its own sandbox,
// auth and model access (D1).

import { join, resolve } from "node:path";
import { shellWord } from "./shell-quote.js";

/** The agent CLIs mu treats as first-class. */
export const HARNESSES = ["claude", "codex", "cursor-agent", "muse", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

/** The channel a harness's panes use unless told otherwise (spec D4). */
export type HarnessChannel = "ctl" | "hooks";

/**
 * One native hook event. `status` qualifies it when the harness reuses one
 * event name for several outcomes: cursor-agent's `stop` carries
 * `status: completed | error | aborted`. Absent: the name alone decides.
 */
export interface NativeEvent {
  name: string;
  status?: string;
}

/** The normalized hook events mu and murmur act on, and each harness's native events for them. */
export interface HarnessEvents {
  prompt_submitted: readonly NativeEvent[];
  permission_requested: readonly NativeEvent[];
  turn_stopped: readonly NativeEvent[];
  /** null: not verified. */
  turn_failed: readonly NativeEvent[] | null;
  /** Empty: the harness fires nothing on an interrupt (mu writes the event itself). */
  interrupted: readonly NativeEvent[];
  session_start: readonly NativeEvent[];
  session_end: readonly NativeEvent[];
}

export interface HarnessRow {
  id: Harness;
  /** murmur's argv match: executable basenames, after stripping a `.real`, `.js`, `.mjs` or `.cjs` suffix. */
  names: readonly string[];
  /** murmur's argv match: package directories an interpreted entry point can live in (`…/pi-coding-agent/dist/cli.js`). */
  packages: readonly string[];
  /** The product name, for messages. */
  displayName: string;
  defaultChannel: HarnessChannel;
  /**
   * The process chain from the launcher down, by executable name. A harness
   * that runs under an interpreter (pi under `bun`, `node` or `pi`;
   * cursor-agent under `node`) is matched by argv (`names`, `packages`), never
   * by this.
   */
  processChain: readonly string[];
  /** Where its hooks are configured. */
  hookConfig: readonly string[];
  /** `full`: hooks inherit the pane env. `allowlist`: a fixed allowlist (no `TMUX*`, no `MU_*`). */
  hookEnv: "full" | "allowlist" | "n/a";
  /** Whether hooks run inside the harness sandbox; null where it has no hooks. */
  hooksSandboxed: boolean | null;
  events: HarnessEvents;
  /** Where a settled turn's final assistant text comes from. */
  lastText: string;
  /**
   * Whether that text can arrive after the turn's stop: cursor-agent sends it
   * in its own `afterAgentResponse`, which can land after `stop` (hooks run
   * concurrently), so a settled turn with no text yet may still get one.
   */
  textFollowsStop: boolean;
  /** Events to drop before they reach state. */
  dropEvents: readonly string[];
  /** Fields and env vars never stored. */
  neverStore: readonly string[];
  /** The command that starts a fresh conversation. */
  freshCommand: string;
  /**
   * When the fresh command's new session reports `session_start`:
   * `immediate` (claude's `/clear` fires `SessionStart` with source `clear`),
   * or `first-prompt` (codex and muse fire `SessionStart` on the first
   * prompt). null: not verified; mu treats it as `first-prompt`, which never
   * waits for an event that may not come.
   */
  freshSessionStart: "immediate" | "first-prompt" | null;
  /**
   * When a newly launched harness reports its session: `immediate` (claude,
   * cursor-agent and pi fire `session_start` as they start), or `first-prompt`
   * (codex and muse fire `SessionStart` only with their first prompt, U0). A
   * hooks task spawn waits for an immediate one before it pastes the brief
   * pointer, and never for a first-prompt one (spec D17).
   */
  startupSessionStart: "immediate" | "first-prompt";
  /** tmux key names. */
  interruptKey: string;
  /** null: the harness is not driven by keys. pi's is used only on its `hooks` fallback (spec D15). */
  clearInputKey: string | null;
  /** Whether a Stop hook can hold the turn open with a reason the model follows. */
  canBlockOnStop: boolean;
  /** Env vars that mark a process as running inside the harness. */
  sandboxMarkerEnv: readonly string[];
  /** Where sessions live for backup; null: not verified. */
  sessions: string | null;
  /** Whether museum backs its sessions up. */
  sessionsBackedUp: boolean;
  /** argv that skips the folder-trust dialog in a new worktree (`<realpath>` is filled in, escaped for a TOML or JSON string). Empty: none needed. */
  trustFlag: readonly string[];
  modelFlag: string;
  /** argv for the auto-approve mode a spawn preset uses (in the harness's sandbox, or its launcher's). Empty: none. */
  autoApproveFlags: readonly string[];
  /**
   * Every option by which a command picks its own approval or sandbox mode:
   * the auto-approve options, their aliases, and the modes that conflict with
   * them. A command that uses any of them (`--opt`, `--opt=v`, `-ov`) gets no
   * auto-approve flags: mu never overrides the choice, and codex refuses
   * `--sandbox` twice or `--yolo` with `-a`.
   */
  approvalOptions: readonly string[];
  /** Where its skills install; null: not verified. */
  skillLocation: string | null;
}

/** Freeze a value and everything it holds. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Native events by name alone. */
function on(...names: string[]): NativeEvent[] {
  return names.map((name) => ({ name }));
}

const CLAUDE_EVENTS: HarnessEvents = {
  prompt_submitted: on("UserPromptSubmit"),
  permission_requested: on("PermissionRequest", "Notification"),
  turn_stopped: on("Stop"),
  turn_failed: on("StopFailure"),
  interrupted: [],
  session_start: on("SessionStart"),
  session_end: on("SessionEnd"),
};

export const HARNESS_TABLE: Readonly<Record<Harness, HarnessRow>> = deepFreeze({
  claude: {
    id: "claude",
    names: ["claude"],
    packages: [],
    displayName: "Claude Code",
    defaultChannel: "hooks",
    processChain: ["claude", "claude"],
    hookConfig: ["~/.claude/settings.json", ".claude/settings.json"],
    hookEnv: "full",
    hooksSandboxed: true,
    events: CLAUDE_EVENTS,
    lastText: "Stop.last_assistant_message",
    textFollowsStop: false,
    dropEvents: ["chains that do not reach tmux (detached children)"],
    neverStore: [],
    freshCommand: "/clear",
    freshSessionStart: "immediate",
    startupSessionStart: "immediate",
    interruptKey: "Escape",
    clearInputKey: "C-u",
    canBlockOnStop: true,
    sandboxMarkerEnv: ["CLAUDECODE", "CLAUDE_PID"],
    sessions: "~/.claude/projects/<slug>/<uuid>.jsonl",
    sessionsBackedUp: true,
    trustFlag: [],
    modelFlag: "--model",
    autoApproveFlags: ["--permission-mode", "acceptEdits"],
    approvalOptions: ["--permission-mode", "--dangerously-skip-permissions"],
    skillLocation: "~/.claude/skills/",
  },
  codex: {
    id: "codex",
    names: ["codex"],
    packages: [],
    displayName: "Codex",
    defaultChannel: "hooks",
    processChain: ["codex", "codex.real"],
    hookConfig: ["~/.codex/hooks.json"],
    hookEnv: "full",
    hooksSandboxed: false,
    events: {
      prompt_submitted: on("UserPromptSubmit"),
      permission_requested: on("PermissionRequest"),
      turn_stopped: on("Stop"),
      turn_failed: null,
      interrupted: on("Interrupt"),
      session_start: on("SessionStart"),
      session_end: on("SessionEnd"),
    },
    lastText: "Stop.last_assistant_message",
    textFollowsStop: false,
    dropEvents: ["transcript_path: null (title-generation session)"],
    neverStore: [],
    freshCommand: "/new",
    freshSessionStart: "first-prompt",
    startupSessionStart: "first-prompt",
    interruptKey: "Escape",
    clearInputKey: "C-u",
    canBlockOnStop: true,
    sandboxMarkerEnv: ["CODEX_SESSION_ID", "CODEX_THREAD_ID"],
    sessions: "~/.codex/sessions/YYYY/MM/DD/*.jsonl",
    sessionsBackedUp: true,
    // An inline table, not `projects."<realpath>".trust_level`: codex 0.164 splits a `-c` key on
    // every dot and keeps the quotes, so that spelling names no project and the trust dialog
    // still shows (observed 2026-11-06, a fresh worktree under /private/tmp). The worktree's own
    // real path is the one checked; `/tmp/...` for `/private/tmp/...` is not.
    trustFlag: ["-c", 'projects={"<realpath>"={trust_level="trusted"}}'],
    modelFlag: "--model",
    // Not `-s workspace-write -a never`: codex's seatbelt cannot start under a launcher that
    // already runs codex inside its own sandbox-exec profile (every command failed with
    // `sandbox-exec: sandbox_apply: Operation not permitted`, observed 2026-11-06 on macOS), and
    // mu cannot tell such a launcher from a stock codex. So every codex worker, local or remote,
    // runs with no codex sandbox and no approvals; only a launcher's sandbox (if any) confines it,
    // and the one observed still allows writes to every home dot-dir. Where codex's own sandbox
    // works, `MU_CODEX_COMMAND='codex -s workspace-write -a never'` keeps it (that command picks
    // a mode, so the preset skips).
    autoApproveFlags: ["--dangerously-bypass-approvals-and-sandbox"],
    approvalOptions: [
      "-s",
      "--sandbox",
      "-a",
      "--ask-for-approval",
      "--full-auto",
      "--approve-for-me",
      "--dangerously-bypass-approvals-and-sandbox",
      "--yolo",
    ],
    // `$CODEX_HOME/skills`, read from codex 0.164's binary. It also reads
    // `~/.agents/skills`, which is pi's too: never that one.
    skillLocation: "~/.codex/skills/",
  },
  "cursor-agent": {
    id: "cursor-agent",
    names: ["cursor-agent"],
    packages: ["cursor-agent"],
    displayName: "cursor-agent",
    defaultChannel: "hooks",
    processChain: ["cursor-agent"],
    hookConfig: ["~/.cursor/hooks.json", ".cursor/hooks.json"],
    hookEnv: "full",
    hooksSandboxed: false,
    events: {
      prompt_submitted: on("beforeSubmitPrompt"),
      permission_requested: [],
      turn_stopped: [{ name: "stop", status: "completed" }],
      // An `error` stop that follows an `aborted` one is dropped (dropEvents), not a failure.
      turn_failed: [{ name: "stop", status: "error" }],
      interrupted: [{ name: "stop", status: "aborted" }],
      session_start: on("sessionStart"),
      session_end: on("sessionEnd"),
    },
    lastText: "afterAgentResponse.text",
    textFollowsStop: true,
    dropEvents: ["the error stop after an aborted stop of the same generation_id"],
    neverStore: ["user_email", "CURSOR_USER_EMAIL", "CURSOR_ASKPASS_SECRET"],
    freshCommand: "/new-chat",
    freshSessionStart: null,
    startupSessionStart: "immediate",
    interruptKey: "Escape",
    clearInputKey: "C-u",
    canBlockOnStop: true,
    sandboxMarkerEnv: ["CURSOR_AGENT", "CURSOR_CONVERSATION_ID"],
    sessions: "SQLite chats",
    sessionsBackedUp: false,
    trustFlag: ["--trust"],
    modelFlag: "--model",
    // `--sandbox` takes a value (`enabled` or `disabled`): bare, cursor-agent refuses to start.
    autoApproveFlags: ["--sandbox", "enabled"],
    approvalOptions: ["--sandbox", "-f", "--force", "--yolo"],
    // Its first-party personal skills, read from cursor-agent 2026.10.22's
    // bundle (`skills-cursor/` is its own built-ins). It also reads
    // `~/.agents/skills`, which is pi's too: never that one.
    skillLocation: "~/.cursor/skills/",
  },
  muse: {
    id: "muse",
    names: ["muse"],
    packages: [],
    displayName: "Muse Code",
    defaultChannel: "hooks",
    processChain: ["muse", "muse.real"],
    hookConfig: ["~/.config/muse/settings.json", ".muse/hooks.json"],
    hookEnv: "allowlist",
    hooksSandboxed: true,
    events: {
      prompt_submitted: on("UserPromptSubmit"),
      permission_requested: on("PermissionRequest"),
      turn_stopped: on("Stop"),
      turn_failed: null,
      interrupted: on("Interrupt"),
      session_start: on("SessionStart"),
      session_end: on("SessionEnd"),
    },
    lastText: "Stop.last_assistant_message",
    textFollowsStop: false,
    dropEvents: ["SubagentStop"],
    neverStore: [],
    freshCommand: "/new",
    freshSessionStart: "first-prompt",
    startupSessionStart: "first-prompt",
    interruptKey: "Escape",
    clearInputKey: "C-u",
    canBlockOnStop: false,
    sandboxMarkerEnv: ["MUSE_SESSION_ID", "MUSE_THREAD_ID"],
    sessions: null,
    sessionsBackedUp: false,
    trustFlag: ["--trust-workspace"],
    modelFlag: "--model",
    autoApproveFlags: ["--approval-mode", "never"],
    approvalOptions: ["--approval-mode", "--yolo", "--disable-approval"],
    skillLocation: "muse skills",
  },
  pi: {
    id: "pi",
    names: ["pi"],
    packages: ["pi-coding-agent"],
    displayName: "pi",
    defaultChannel: "ctl",
    processChain: ["pi"],
    hookConfig: ["murmur's and mu's pi extensions"],
    hookEnv: "n/a",
    hooksSandboxed: null,
    events: {
      prompt_submitted: on("input"),
      permission_requested: on("ui_prompt_start"),
      turn_stopped: on("agent_settled"),
      turn_failed: null,
      interrupted: [],
      session_start: on("session_start"),
      session_end: on("session_shutdown"),
    },
    lastText: "event payload",
    textFollowsStop: false,
    dropEvents: [],
    neverStore: [],
    freshCommand: "/new",
    freshSessionStart: "immediate",
    startupSessionStart: "immediate",
    interruptKey: "Escape",
    // Pressed only on the `hooks` fallback (spec D15); ctl never types keys.
    // pi's editor binds C-u to delete to the line start.
    clearInputKey: "C-u",
    canBlockOnStop: true,
    sandboxMarkerEnv: [],
    sessions: "~/.pi/agent/sessions/**/*.jsonl",
    sessionsBackedUp: true,
    trustFlag: [],
    modelFlag: "--model",
    autoApproveFlags: [],
    approvalOptions: [],
    skillLocation: "pi package",
  },
} satisfies Record<Harness, HarnessRow>);

/**
 * The harnesses mu installs `mu hook stop` for: a Stop hook that can block
 * with a reason the model follows (D7). Muse Code cannot, and pi has its
 * settle nudge.
 */
export function takesMuStopHook(h: Harness): boolean {
  return h !== "pi" && HARNESS_TABLE[h].canBlockOnStop;
}

/** The harness's own hook config file (D6 `hookConfig`), home-relative; undefined: none (pi). */
export function homeHookConfig(h: Harness): string | undefined {
  if (h === "pi") return undefined;
  return HARNESS_TABLE[h].hookConfig.find((p) => p.startsWith("~/"))?.slice(2);
}

/**
 * The variable that moves a harness's home config directory, as the harness
 * itself reads it: `CLAUDE_CONFIG_DIR` for `~/.claude`, `CODEX_HOME` for
 * `~/.codex`. murmur, museum and muzzle honour the same two. cursor-agent's
 * and Muse Code's stay under the home directory.
 */
export const CONFIG_DIR_ENV: Readonly<Partial<Record<Harness, { name: string; dir: string }>>> =
  Object.freeze({
    claude: { name: "CLAUDE_CONFIG_DIR", dir: ".claude" },
    codex: { name: "CODEX_HOME", dir: ".codex" },
  });

/**
 * Where home-relative `rel` (`.claude/settings.json`, `.codex/skills`) is for
 * harness `h`: under `home`, unless the harness's variable (`CONFIG_DIR_ENV`)
 * is set and `rel` lies in the directory it moves. An empty value is unset; a
 * relative one resolves against the cwd, as murmur resolves it.
 */
export function harnessHomePath(
  h: Harness,
  rel: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const moved = CONFIG_DIR_ENV[h];
  const value = moved === undefined ? "" : (env[moved.name] ?? "");
  if (moved === undefined || value === "") return join(home, rel);
  if (rel !== moved.dir && !rel.startsWith(`${moved.dir}/`)) return join(home, rel);
  return join(resolve(value), rel.slice(moved.dir.length));
}

/** The harness's own hook config file as `harnessHomePath` places it; undefined: none (pi). */
export function hookConfigPath(
  h: Harness,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const rel = homeHookConfig(h);
  return rel === undefined ? undefined : harnessHomePath(h, rel, home, env);
}

/**
 * The hook config file for a message: `~/.claude/settings.json`, or with the
 * harness's variable, `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`.
 */
export function hookConfigLabel(h: Harness): string {
  const rel = homeHookConfig(h) ?? "";
  const moved = CONFIG_DIR_ENV[h];
  if (moved === undefined || !rel.startsWith(`${moved.dir}/`)) return `~/${rel}`;
  return `\${${moved.name}:-~/${moved.dir}}${rel.slice(moved.dir.length)}`;
}

/** True when `value` names a blessed harness (murmur's `isHarness`). */
export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/** The row for a cli key, or undefined for a CLI that is not a blessed harness. */
export function harnessFor(cli: string): HarnessRow | undefined {
  return isHarness(cli) ? HARNESS_TABLE[cli] : undefined;
}

/** An executable's basename, with the suffixes murmur strips (`codex.real`, `cli.js`). */
function executableName(argv0: string): string {
  const base = argv0.slice(argv0.lastIndexOf("/") + 1);
  return base.replace(/\.(real|js|mjs|cjs)$/, "");
}

/**
 * The harness a spawn runs, or undefined for a CLI outside the blessed five.
 * cli keys are free-form (`pi-meta`, `claude-big`), so the key alone is not
 * enough: the command's argv0 decides when it names a harness, then the key
 * itself, then the key's prefix before `-` or `_` (spec D17).
 */
export function harnessOfCli(cli: string, command?: string): Harness | undefined {
  const argv0 = executableName(command?.trim().split(/\s+/)[0] ?? "");
  for (const name of [argv0, cli, cli.split(/[-_]/)[0] ?? ""]) {
    const row = HARNESSES.find((h) => HARNESS_TABLE[h].names.includes(name));
    if (row !== undefined) return row;
  }
  return undefined;
}

/**
 * True when this process runs inside an agent: a mu-managed one
 * (`MU_MANAGED_AGENT=1`), or any harness whose sandbox marker env is set
 * (`CLAUDECODE`, `CODEX_SESSION_ID`, …). Such a process must not start the
 * tmux server it would spawn agents into: the server's children inherit the
 * server's sandbox, not the client's (spec D10).
 */
export function insideAgent(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MU_MANAGED_AGENT === "1") return true;
  return HARNESSES.some((h) =>
    HARNESS_TABLE[h].sandboxMarkerEnv.some((k) => (env[k] ?? "") !== ""),
  );
}

/** Every harness's sandbox marker env names (test setup clears them all). */
export function sandboxMarkerEnvNames(): string[] {
  return HARNESSES.flatMap((h) => [...HARNESS_TABLE[h].sandboxMarkerEnv]);
}

/** True when command word `word` uses option `option`: `--opt`, `--opt=v`, or a short `-o` with its value attached (`-sread-only`). */
function usesOption(word: string, option: string): boolean {
  if (word === option || word.startsWith(`${option}=`)) return true;
  return /^-[^-]$/.test(option) && !word.startsWith("--") && word.startsWith(option);
}

/** What a spawn asks of a harness's launch command (spec D17). */
export interface SpawnPresets {
  /** `--model`: passed through the row's model flag. */
  model?: string;
  /** Add the row's auto-approve flags (a worker, from a command mu resolved). */
  approve: boolean;
  /** A worktree mu created for this spawn: its real path, for the row's trust flag. */
  trustPath?: string;
}

/**
 * `command` with the harness row's spawn presets appended, as shell words
 * (spec D6, D17): the model flag with `model`; with `approve`, the
 * auto-approve flags, unless the command already picks its approval or
 * sandbox mode (any of the row's `approvalOptions`; pi has none: its
 * `--approve` is folder trust); with `trustPath`, the trust flag, `<realpath>`
 * filled in. A command outside the blessed five is returned as it is (the
 * spawn refuses `--model` for one).
 */
export function withSpawnPresets(
  command: string,
  harness: Harness | undefined,
  presets: SpawnPresets,
): string {
  if (harness === undefined) return command;
  const row = HARNESS_TABLE[harness];
  const words = command.trim().split(/\s+/);
  const extra: string[] = [];
  const choosesApproval = words.some((w) => row.approvalOptions.some((o) => usesOption(w, o)));
  if (presets.approve && !choosesApproval) extra.push(...row.autoApproveFlags);
  if (presets.trustPath !== undefined) {
    const path = presets.trustPath;
    // the placeholder sits inside a TOML basic string (codex's `-c` value)
    const quoted = path.replace(/["\\]/g, (c) => `\\${c}`);
    extra.push(...row.trustFlag.map((w) => w.replace("<realpath>", () => quoted)));
  }
  if (presets.model !== undefined) extra.push(row.modelFlag, presets.model);
  if (extra.length === 0) return command;
  return [command.trimEnd(), ...extra.map(shellWord)].join(" ");
}
