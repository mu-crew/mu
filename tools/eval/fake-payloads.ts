// Pure half of the fake harness binaries (fake-harness.ts): which config files each harness reads
// its hooks from, which handlers an event runs, the payload each event carries, and what a hook's
// reply means. No I/O, so vitest pins every rule. Black box: nothing here imports src/.
//
// The payload shapes are the ones the real harnesses sent in the U0 spike (spec "Every harness
// first-class", U0 results): the same keys per harness and event, synthetic values. Fields that
// the real ones carry and must never be stored (cursor-agent's user_email) carry a placeholder.
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

/** The AUT's agent names in a pane run: the orchestrator, and its replacement after a crash. */
export const AUT_NAMES = ["aut", "aut-2"] as const;

/** The harnesses a fake binary stands in for: the four that report through hooks. */
export const FAKE_HARNESSES = ["claude", "codex", "cursor-agent", "muse"] as const;
export type FakeHarness = (typeof FAKE_HARNESSES)[number];

export function isFakeHarness(v: string): v is FakeHarness {
  return (FAKE_HARNESSES as readonly string[]).includes(v);
}

/** What happened, in the harness-neutral words the fake works in. */
export type FakeEvent =
  | "session_start"
  | "prompt"
  | "stop"
  | "failed"
  | "interrupt"
  | "session_end"
  | "pre_tool";

/** Native event names per harness. null: the harness fires nothing for it (U0). */
export const NATIVE: Record<FakeHarness, Record<FakeEvent, string | null>> = {
  claude: {
    session_start: "SessionStart",
    prompt: "UserPromptSubmit",
    stop: "Stop",
    failed: "StopFailure",
    interrupt: null,
    session_end: "SessionEnd",
    pre_tool: "PreToolUse",
  },
  codex: {
    session_start: "SessionStart",
    prompt: "UserPromptSubmit",
    stop: "Stop",
    failed: null,
    interrupt: "Interrupt",
    session_end: "SessionEnd",
    pre_tool: "PreToolUse",
  },
  "cursor-agent": {
    session_start: "sessionStart",
    prompt: "beforeSubmitPrompt",
    stop: "stop",
    failed: "stop",
    interrupt: "stop",
    session_end: "sessionEnd",
    pre_tool: "beforeShellExecution",
  },
  muse: {
    session_start: "SessionStart",
    prompt: "UserPromptSubmit",
    stop: "Stop",
    failed: "StopFailure",
    interrupt: "Interrupt",
    session_end: "SessionEnd",
    pre_tool: "PreToolUse",
  },
};

/** How a config file nests handlers: `hooks.<Event>[].hooks[]` (claude, codex, muse) or cursor's flat `hooks.<event>[]`. */
export type HookShape = "grouped" | "flat";

export const SHAPE: Record<FakeHarness, HookShape> = {
  claude: "grouped",
  codex: "grouped",
  "cursor-agent": "flat",
  muse: "grouped",
};

/** When a new session reports itself: at launch, or with its first prompt (codex and muse, U0). */
export const STARTUP: Record<FakeHarness, "immediate" | "first-prompt"> = {
  claude: "immediate",
  codex: "first-prompt",
  "cursor-agent": "immediate",
  muse: "first-prompt",
};

/**
 * The model a fake reports in its payloads: a name for claude and codex (whose family is their
 * harness's), and values shaped like a live cursor-agent's and Muse's on their defaults (U0):
 * cursor-agent reports `default`; Muse names a concrete in-house model id (and an in-house
 * `model_provider`, MUSE_PROVIDER), which is no vendor's. Neither says which vendor runs, so the
 * judge never reads them for a family (harness-cases.ts autFamily).
 */
export const FAKE_MODEL: Record<FakeHarness, string> = {
  claude: "fake-model",
  codex: "fake-model",
  "cursor-agent": "default",
  muse: "mm-1005",
};

/** Muse's `model_provider` in a fake payload: an in-house name, as a live one's is (U0). */
export const MUSE_PROVIDER = "inhouse";

/** The command that starts a fresh conversation (D6). */
export const FRESH: Record<FakeHarness, string> = {
  claude: "/clear",
  codex: "/new",
  "cursor-agent": "/new-chat",
  muse: "/new",
};

/** The shell tool's name in a tool hook's payload, which a matcher tests. */
export const SHELL_TOOL: Record<FakeHarness, string> = {
  claude: "Bash",
  codex: "Bash",
  "cursor-agent": "Shell",
  muse: "bash",
};

/** Muse Code starts every settings or project hook with a cleared environment and this allowlist (D6). */
export const MUSE_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "SHELL",
  "LANG",
  "TERM",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

/** The environment a hook process gets: the harness's own, or Muse's allowlist of it. */
export function hookEnv(
  h: FakeHarness,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (h === "muse" && !(MUSE_ENV_ALLOWLIST as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The harness homes `hookFiles` takes from an environment: `CLAUDE_CONFIG_DIR` and `CODEX_HOME`,
 * each only when non-empty (an empty one is unset, as the harnesses read it).
 */
export function hookHomes(env: NodeJS.ProcessEnv): { claudeHome?: string; codexHome?: string } {
  return {
    ...(env.CLAUDE_CONFIG_DIR ? { claudeHome: env.CLAUDE_CONFIG_DIR } : {}),
    ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}),
  };
}

/**
 * The config files a harness reads hooks from, in the order it runs them: the project's (the
 * project root is the git top level of the cwd), then the user's: claude's in
 * `$CLAUDE_CONFIG_DIR`, else `~/.claude`. codex has no project file: its hooks are global,
 * `$CODEX_HOME/hooks.json`, else `~/.codex/hooks.json`. The homes come from `hookHomes`.
 */
export function hookFiles(
  h: FakeHarness,
  o: { projectRoot: string; home: string; claudeHome?: string; codexHome?: string },
): { path: string; key: "hooks" }[] {
  const at = (...p: string[]) => ({ path: join(...p), key: "hooks" as const });
  switch (h) {
    case "claude":
      return [
        at(o.projectRoot, ".claude", "settings.json"),
        at(o.projectRoot, ".claude", "settings.local.json"),
        at(o.claudeHome ?? join(o.home, ".claude"), "settings.json"),
      ];
    case "codex":
      return [at(o.codexHome ?? join(o.home, ".codex"), "hooks.json")];
    case "cursor-agent":
      return [at(o.projectRoot, ".cursor", "hooks.json"), at(o.home, ".cursor", "hooks.json")];
    case "muse":
      return [
        at(o.projectRoot, ".muse", "hooks.json"),
        at(o.home, ".config", "muse", "settings.json"),
      ];
  }
}

export interface Handler {
  command: string;
  /** Seconds; the harness kills a hook past it. */
  timeout: number;
  /** Fire and forget: the harness does not wait (Muse's `Interrupt` must be declared so). */
  async: boolean;
}

/** Default hook timeout, in seconds, when a handler names none. */
export const DEFAULT_TIMEOUT_S = 60;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function handlerOf(raw: unknown): Handler | null {
  if (!isObj(raw) || typeof raw.command !== "string" || raw.command.trim() === "") return null;
  const t = typeof raw.timeout === "number" && raw.timeout > 0 ? raw.timeout : DEFAULT_TIMEOUT_S;
  return { command: raw.command, timeout: t, async: raw.async === true };
}

/** A group's matcher against a tool name: absent, empty or `*` match all; else a regex (claude's rule). */
export function matcherHits(matcher: unknown, tool: string | null): boolean {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string" || tool === null) return tool === null;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher === tool;
  }
}

/**
 * The handlers one parsed config file runs for `event`. `tool` is the tool name for a tool event
 * (a matcher filters on it); null for the others, where only an unfiltered group runs.
 */
export function handlersFor(
  shape: HookShape,
  doc: unknown,
  event: string,
  tool: string | null,
): Handler[] {
  if (!isObj(doc) || !isObj(doc.hooks)) return [];
  const entries = doc.hooks[event];
  if (!Array.isArray(entries)) return [];
  if (shape === "flat") return entries.map(handlerOf).filter((x): x is Handler => x !== null);
  const out: Handler[] = [];
  for (const g of entries) {
    if (!isObj(g) || !Array.isArray(g.hooks)) continue;
    if (tool !== null && !matcherHits(g.matcher, tool)) continue;
    for (const raw of g.hooks) {
      const h = handlerOf(raw);
      if (h) out.push(h);
    }
  }
  return out;
}

/** What a hook's reply asks for. */
export type Reply =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  /** A tool hook rewrote the command (claude/codex `updatedInput`). */
  | { kind: "rewrite"; command: string }
  /** A tool hook refused the command (cursor `permission: deny`, claude `deny`). */
  | { kind: "deny"; reason: string };

/**
 * A hook's exit code and output, read as the harness reads them. Exit 2 blocks with stderr as the
 * reason (claude, codex, muse). JSON on stdout: `decision: block` (claude, codex, muse), cursor's
 * `followup_message` on its stop, a tool hook's `hookSpecificOutput` (claude, codex) or cursor's
 * `permission`. Anything else allows.
 */
export function readReply(
  h: FakeHarness,
  event: FakeEvent,
  r: { code: number | null; stdout: string; stderr: string },
): Reply {
  if (r.code === 2 && h !== "cursor-agent") {
    const reason = r.stderr.trim();
    return event === "pre_tool" ? { kind: "deny", reason } : { kind: "block", reason };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout.trim() || "null");
  } catch {
    return { kind: "allow" };
  }
  if (!isObj(doc)) return { kind: "allow" };
  if (event === "pre_tool") {
    if (h === "cursor-agent") {
      if (doc.permission === "deny")
        return { kind: "deny", reason: String(doc.agent_message ?? doc.user_message ?? "") };
      return { kind: "allow" };
    }
    const spec = isObj(doc.hookSpecificOutput) ? doc.hookSpecificOutput : null;
    if (spec?.permissionDecision === "deny")
      return { kind: "deny", reason: String(spec.permissionDecisionReason ?? "") };
    const input = spec && isObj(spec.updatedInput) ? spec.updatedInput : null;
    if (input && typeof input.command === "string")
      return { kind: "rewrite", command: input.command };
    return { kind: "allow" };
  }
  if (event === "stop" && h === "cursor-agent") {
    const msg = doc.followup_message;
    return typeof msg === "string" && msg !== ""
      ? { kind: "block", reason: msg }
      : { kind: "allow" };
  }
  if (event === "stop" && doc.decision === "block")
    return { kind: "block", reason: String(doc.reason ?? "") };
  return { kind: "allow" };
}

/** A new session id in the harness's own form: a UUID (claude, cursor-agent), a time-ordered id (codex, muse). */
export function newSessionId(h: FakeHarness, now = Date.now()): string {
  if (h === "claude" || h === "cursor-agent") return randomUUID();
  const t = now.toString(16).padStart(12, "0");
  const r = randomBytes(10).toString("hex");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${r.slice(0, 3)}-${r.slice(3, 7)}-${r.slice(7, 19)}`;
}

/** What a payload is built from: the session and the moment. */
export interface PayloadCtx {
  sessionId: string;
  /** codex and muse: the turn; cursor-agent: the generation. */
  turnId: string;
  cwd: string;
  home: string;
  model: string;
  prompt?: string;
  lastText?: string | null;
  /** The turn was resumed by a Stop block. */
  resumed?: boolean;
  /** session_start: startup | clear | resume | compact. */
  source?: string;
  /** session_end: the reason. */
  reason?: string;
  /** cursor-agent stop: completed | aborted | error. */
  status?: string;
  /** Tool events: the shell command. */
  command?: string;
}

/** A transcript path of the harness's form, under the given home (never read by anything). */
function transcript(h: FakeHarness, c: PayloadCtx): string | null {
  if (h === "claude")
    return join(c.home, ".claude", "projects", c.cwd.replace(/[/.]/g, "-"), `${c.sessionId}.jsonl`);
  if (h === "codex") return join(c.home, ".codex", "sessions", `rollout-${c.sessionId}.jsonl`);
  return null;
}

/**
 * The payload `event` carries on `h`: the U0 keys, synthetic values. cursor-agent's `stop` with a
 * status serves `failed` (error) and `interrupt` (aborted) too.
 */
export function payload(h: FakeHarness, event: FakeEvent, c: PayloadCtx): Record<string, unknown> {
  const name = NATIVE[h][event];
  if (name === null) throw new Error(`${h} fires nothing for ${event}`);
  switch (h) {
    case "claude":
      return claudePayload(name, event, c);
    case "codex":
      return codexPayload(name, event, c);
    case "cursor-agent":
      return cursorPayload(name, event, c);
    case "muse":
      return musePayload(name, event, c);
  }
}

function claudePayload(name: string, event: FakeEvent, c: PayloadCtx): Record<string, unknown> {
  const base = { session_id: c.sessionId, transcript_path: transcript("claude", c), cwd: c.cwd };
  switch (event) {
    case "session_start":
      return { ...base, hook_event_name: name, source: c.source ?? "startup", model: c.model };
    case "prompt":
      return {
        ...base,
        prompt_id: c.turnId,
        permission_mode: "acceptEdits",
        hook_event_name: name,
        prompt: c.prompt ?? "",
      };
    case "stop":
      return {
        ...base,
        prompt_id: c.turnId,
        permission_mode: "acceptEdits",
        effort: { level: "medium" },
        hook_event_name: name,
        stop_hook_active: c.resumed === true,
        last_assistant_message: c.lastText ?? null,
        background_tasks: [],
        session_crons: [],
      };
    case "failed":
      return {
        ...base,
        prompt_id: c.turnId,
        hook_event_name: name,
        error: "overloaded_error",
        error_details: "529 Overloaded",
        last_assistant_message: null,
      };
    case "session_end":
      return { ...base, prompt_id: c.turnId, hook_event_name: name, reason: c.reason ?? "other" };
    case "pre_tool":
      return {
        ...base,
        permission_mode: "acceptEdits",
        hook_event_name: name,
        tool_name: SHELL_TOOL.claude,
        tool_input: { command: c.command ?? "", description: "run a command" },
        tool_use_id: `toolu_${c.turnId.replace(/-/g, "").slice(0, 24)}`,
      };
    case "interrupt":
      throw new Error("claude fires nothing on an interrupt");
  }
}

function codexPayload(name: string, event: FakeEvent, c: PayloadCtx): Record<string, unknown> {
  const t = transcript("codex", c);
  const common = { model: c.model, permission_mode: "default" };
  switch (event) {
    case "session_start":
      return {
        session_id: c.sessionId,
        transcript_path: t,
        cwd: c.cwd,
        hook_event_name: name,
        ...common,
        source: c.source ?? "startup",
      };
    case "prompt":
      return {
        session_id: c.sessionId,
        turn_id: c.turnId,
        transcript_path: t,
        cwd: c.cwd,
        hook_event_name: name,
        ...common,
        prompt: c.prompt ?? "",
      };
    case "stop":
      return {
        session_id: c.sessionId,
        turn_id: c.turnId,
        transcript_path: t,
        cwd: c.cwd,
        hook_event_name: name,
        ...common,
        stop_hook_active: c.resumed === true,
        last_assistant_message: c.lastText ?? null,
      };
    case "interrupt":
      return {
        session_id: c.sessionId,
        turn_id: c.turnId,
        transcript_path: t,
        cwd: c.cwd,
        hook_event_name: name,
        ...common,
      };
    case "session_end":
      return {
        session_id: c.sessionId,
        transcript_path: t,
        cwd: c.cwd,
        hook_event_name: name,
        reason: c.reason ?? "other",
      };
    case "pre_tool":
      return {
        session_id: c.sessionId,
        turn_id: c.turnId,
        transcript_path: t,
        cwd: c.cwd,
        hook_event_name: name,
        ...common,
        tool_name: SHELL_TOOL.codex,
        tool_input: { command: c.command ?? "" },
      };
    case "failed":
      throw new Error("codex turn_failed is not verified");
  }
}

/** A placeholder for the account field cursor-agent sends and nothing may store. */
export const PLACEHOLDER_EMAIL = "user@example.invalid";

function cursorPayload(name: string, event: FakeEvent, c: PayloadCtx): Record<string, unknown> {
  const tail = {
    session_id: c.sessionId,
    hook_event_name: name,
    cursor_version: "0000.00.00-fake",
    workspace_roots: [c.cwd],
    user_email: PLACEHOLDER_EMAIL,
  };
  const head = { conversation_id: c.sessionId, generation_id: c.turnId, model: c.model };
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const tp = join(
    c.home,
    ".cursor",
    "projects",
    "fake",
    "agent-transcripts",
    `${c.sessionId}.jsonl`,
  );
  switch (event) {
    case "session_start":
      return {
        conversation_id: c.sessionId,
        generation_id: c.sessionId,
        model: c.model,
        is_background_agent: false,
        ...tail,
        transcript_path: null,
      };
    case "prompt":
      return { ...head, prompt: c.prompt ?? "", attachments: [], ...tail, transcript_path: null };
    case "stop":
    case "failed":
    case "interrupt": {
      const status =
        c.status ??
        (event === "failed" ? "error" : event === "interrupt" ? "aborted" : "completed");
      return {
        ...head,
        status,
        loop_count: c.resumed === true ? 1 : 0,
        ...(status === "completed" ? usage : {}),
        ...tail,
        transcript_path: tp,
      };
    }
    case "session_end":
      return {
        conversation_id: c.sessionId,
        generation_id: c.sessionId,
        model: c.model,
        reason: c.reason ?? "completed",
        duration_ms: 0,
        is_background_agent: false,
        final_status: "completed",
        ...tail,
        transcript_path: tp,
      };
    case "pre_tool":
      return { ...head, command: c.command ?? "", cwd: c.cwd, ...tail, transcript_path: tp };
  }
}

/** cursor-agent's separate text event: `afterAgentResponse`, which can land after its `stop`. */
export function cursorResponse(c: PayloadCtx): Record<string, unknown> {
  return {
    conversation_id: c.sessionId,
    generation_id: c.turnId,
    model: c.model,
    text: c.lastText ?? "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    session_id: c.sessionId,
    hook_event_name: "afterAgentResponse",
    cursor_version: "0000.00.00-fake",
    workspace_roots: [c.cwd],
    user_email: PLACEHOLDER_EMAIL,
    transcript_path: join(
      c.home,
      ".cursor",
      "projects",
      "fake",
      "agent-transcripts",
      `${c.sessionId}.jsonl`,
    ),
  };
}

function musePayload(name: string, event: FakeEvent, c: PayloadCtx): Record<string, unknown> {
  const tail = {
    cwd: c.cwd,
    transcript_path: null,
    model: c.model,
    permission_mode: "default",
    model_provider: MUSE_PROVIDER,
  };
  switch (event) {
    case "session_start":
      return {
        hook_event_name: name,
        source: c.source ?? "startup",
        session_id: c.sessionId,
        ...tail,
      };
    case "prompt":
      return {
        hook_event_name: name,
        prompt: c.prompt ?? "",
        session_id: c.sessionId,
        turn_id: c.turnId,
        ...tail,
      };
    case "stop":
      return {
        hook_event_name: name,
        stop_hook_active: c.resumed === true,
        last_assistant_message: c.lastText ?? null,
        session_id: c.sessionId,
        turn_id: c.turnId,
        ...tail,
      };
    case "failed":
      return {
        hook_event_name: name,
        error: "overloaded",
        session_id: c.sessionId,
        turn_id: c.turnId,
        ...tail,
      };
    case "interrupt": {
      const { model_provider: _drop, ...rest } = tail;
      return { hook_event_name: name, session_id: c.sessionId, turn_id: c.turnId, ...rest };
    }
    case "session_end":
      return {
        hook_event_name: name,
        reason: c.reason ?? "other",
        session_id: c.sessionId,
        ...tail,
      };
    case "pre_tool":
      return {
        hook_event_name: name,
        tool_name: SHELL_TOOL.muse,
        tool_input: { command: c.command ?? "", description: "run a command", workdir: c.cwd },
        session_id: c.sessionId,
        turn_id: c.turnId,
        ...tail,
      };
  }
}

/**
 * Terminal input the way a harness's line editor reads it, one chunk at a time. Bracketed paste
 * (`ESC [200~ … ESC [201~`) is text, never keys; a lone ESC is the interrupt key; C-u clears the
 * line; CR submits it.
 */
export type Key = { kind: "submit"; text: string } | { kind: "escape" } | { kind: "clear" };

export class LineEditor {
  private buf = "";
  private pasting = false;

  /** The line as typed so far (claude puts an interrupted prompt back here). */
  get line(): string {
    return this.buf;
  }

  set line(v: string) {
    this.buf = v;
  }

  feed(chunk: string): Key[] {
    const out: Key[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (chunk.startsWith("\x1b[200~", i)) {
        this.pasting = true;
        i += 6;
        continue;
      }
      if (chunk.startsWith("\x1b[201~", i)) {
        this.pasting = false;
        i += 6;
        continue;
      }
      const ch = chunk.charAt(i);
      i++;
      if (this.pasting) {
        this.buf += ch === "\r" ? "\n" : ch;
        continue;
      }
      if (ch === "\x1b") {
        // an escape sequence (arrow keys, focus events) is not the Escape key
        if (chunk.charAt(i) === "[" || chunk.charAt(i) === "O") {
          i++;
          while (i < chunk.length && !/[A-Za-z~]/.test(chunk.charAt(i))) i++;
          i++;
          continue;
        }
        out.push({ kind: "escape" });
      } else if (ch === "\x15") {
        this.buf = "";
        out.push({ kind: "clear" });
      } else if (ch === "\r" || ch === "\n") {
        const text = this.buf;
        this.buf = "";
        if (text.trim() !== "") out.push({ kind: "submit", text });
      } else if (ch === "\x7f" || ch === "\b") {
        this.buf = this.buf.slice(0, -1);
      } else if (ch >= " " || ch === "\t") {
        this.buf += ch;
      }
    }
    return out;
  }
}
