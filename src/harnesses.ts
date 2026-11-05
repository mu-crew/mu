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
  /** Events to drop before they reach state. */
  dropEvents: readonly string[];
  /** Fields and env vars never stored. */
  neverStore: readonly string[];
  /** The command that starts a fresh conversation. */
  freshCommand: string;
  /** tmux key names. */
  interruptKey: string;
  /** null: the harness is not driven by keys (pi uses its control socket). */
  clearInputKey: string | null;
  /** Whether a Stop hook can hold the turn open with a reason the model follows. */
  canBlockOnStop: boolean;
  /** Env vars that mark a process as running inside the harness. */
  sandboxMarkerEnv: readonly string[];
  /** Where sessions live for backup; null: not verified. */
  sessions: string | null;
  /** Whether museum backs its sessions up. */
  sessionsBackedUp: boolean;
  /** argv that skips the folder-trust dialog in a new worktree (`<realpath>` is filled in). Empty: none needed. */
  trustFlag: readonly string[];
  modelFlag: string;
  /** argv for the in-sandbox auto-approve mode a spawn preset uses. Empty: none. */
  autoApproveFlags: readonly string[];
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
    dropEvents: ["chains that do not reach tmux (detached children)"],
    neverStore: [],
    freshCommand: "/clear",
    interruptKey: "Escape",
    clearInputKey: "C-u",
    canBlockOnStop: true,
    sandboxMarkerEnv: ["CLAUDECODE", "CLAUDE_PID"],
    sessions: "~/.claude/projects/<slug>/<uuid>.jsonl",
    sessionsBackedUp: true,
    trustFlag: [],
    modelFlag: "--model",
    autoApproveFlags: ["--permission-mode", "acceptEdits"],
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
    dropEvents: ["transcript_path: null (title-generation session)"],
    neverStore: [],
    freshCommand: "/new",
    interruptKey: "Escape",
    clearInputKey: "C-u",
    canBlockOnStop: true,
    sandboxMarkerEnv: ["CODEX_SESSION_ID", "CODEX_THREAD_ID"],
    sessions: "~/.codex/sessions/YYYY/MM/DD/*.jsonl",
    sessionsBackedUp: true,
    trustFlag: ["-c", 'projects."<realpath>".trust_level="trusted"'],
    modelFlag: "--model",
    autoApproveFlags: ["-s", "workspace-write", "-a", "never"],
    skillLocation: null,
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
    dropEvents: ["the error stop after an aborted stop of the same generation_id"],
    neverStore: ["user_email", "CURSOR_USER_EMAIL", "CURSOR_ASKPASS_SECRET"],
    freshCommand: "/new-chat",
    interruptKey: "Escape",
    clearInputKey: "C-u",
    canBlockOnStop: true,
    sandboxMarkerEnv: ["CURSOR_AGENT", "CURSOR_CONVERSATION_ID"],
    sessions: "SQLite chats",
    sessionsBackedUp: false,
    trustFlag: ["--trust"],
    modelFlag: "--model",
    autoApproveFlags: ["--sandbox"],
    skillLocation: null,
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
    dropEvents: ["SubagentStop"],
    neverStore: [],
    freshCommand: "/new",
    interruptKey: "Escape",
    clearInputKey: "C-u",
    canBlockOnStop: false,
    sandboxMarkerEnv: ["MUSE_SESSION_ID", "MUSE_THREAD_ID"],
    sessions: null,
    sessionsBackedUp: false,
    trustFlag: ["--trust-workspace"],
    modelFlag: "--model",
    autoApproveFlags: ["--approval-mode", "never"],
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
    dropEvents: [],
    neverStore: [],
    freshCommand: "/new",
    interruptKey: "Escape",
    clearInputKey: null,
    canBlockOnStop: true,
    sandboxMarkerEnv: [],
    sessions: "~/.pi/agent/sessions/**/*.jsonl",
    sessionsBackedUp: true,
    trustFlag: [],
    modelFlag: "--model",
    autoApproveFlags: [],
    skillLocation: "pi package",
  },
} satisfies Record<Harness, HarnessRow>);

/** True when `value` names a blessed harness (murmur's `isHarness`). */
export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/** The row for a cli key, or undefined for a CLI that is not a blessed harness. */
export function harnessFor(cli: string): HarnessRow | undefined {
  return isHarness(cli) ? HARNESS_TABLE[cli] : undefined;
}
