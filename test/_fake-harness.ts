// A fake hook harness for the `hooks` channel (spec D3, D4, U8).
//
// It writes murmur inbox events for its pane as files (`<inbox>/<pane>/<seq>.json`,
// murmur's event field names), and its `murmur pane` runner drains them in
// name order into a pane report shaped like `murmur pane <pane> --json`,
// deleting each applied file, as murmur's drain does. It also answers the
// tmux calls mu makes to its pane: `send-keys C-u` clears its input box,
// `set-buffer` / `paste-buffer` type into it, and `Enter` submits it, which
// fires `prompt_submitted` like a real harness's UserPromptSubmit hook
// (unless `acks` is off). Keys typed while a permission dialog is open fire
// the next event (unless `answers` is off). Escape on a running turn does what
// `onEscape` says: the harness's own `interrupted` (codex, muse,
// cursor-agent), nothing (claude: the turn stops silently), or nothing because
// it only closed an overlay (the turn runs on). Submitting `freshCommand`
// starts a new session as `freshMode` says: at once (claude's `/clear`:
// `session_end` clear, then `session_start` clear), on the next prompt (codex,
// muse), or never (a harness that refused it); it fires no `prompt_submitted`.
//
// Its report follows murmur's model, not one word per event: attention
// (`blocked`, `error`, `done`, `crashed`) persists until an event clears it and
// outranks activity in the rendered `state`, so a running agent after a failed
// turn still reads `error`, and a pane whose session ended reads its attention
// with no agent row. A `turn_stopped` that names its `generation_id` sets the
// text it carries, or none, and a later one for that ended generation only
// fills the text in (cursor-agent's text after its stop). tmux argv words are
// read back as tmux reads them (a final `;` is a separator).
//
// Install `fake.pane` with setMurmurPaneRunnerForTests (and `fake.hook` with
// setMurmurHookRunnerForTests) and route the tmux executor through `fake.tmux`
// first.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MurmurHookRunner, MurmurPaneRunner } from "../src/channels/hooks-pane.js";

interface PaneState {
  /** The agent row's activity; null: no agent row (no session, or one that ended). */
  activity: "running" | "stopped" | null;
  /** Pending attention, kind to message. Persists until an event clears it, as murmur's does. */
  attention: Map<string, string>;
  sessionId: string | null;
  runCount: number;
  updatedAt: number;
  confirmed: boolean;
  failed: boolean;
  lastText: string | null;
  /** The last ended turn's `generation_id` (cursor-agent, muse name their turns); null: none. */
  generation: string | null;
}

/** murmur's ATTENTION_PRIORITY: the first kind present is the rendered word, ahead of activity. */
const ATTENTION_PRIORITY = ["crashed", "error", "blocked", "done"];

/**
 * What tmux makes of one argv word (see tmuxWord): a final `\;` loses its
 * backslash, and a bare final `;` is a command separator, dropped.
 */
const fromTmuxWord = (w: string): string =>
  w.endsWith("\\;") ? `${w.slice(0, -2)};` : w.endsWith(";") ? w.slice(0, -1) : w;

export interface FakeHarness {
  readonly paneId: string;
  /** The inbox directory of this pane. */
  readonly inbox: string;
  /** A submitted paste fires `prompt_submitted`. Default true. */
  acks: boolean;
  /** Keys typed into an open dialog fire `answeredWith`. Default true. */
  answers: boolean;
  /** The event an answered dialog fires. Default `turn_stopped`. */
  answeredWith: string;
  /** What Escape on a running turn does. Default `event`. */
  onEscape: "event" | "silent" | "overlay";
  /** The harness's fresh command. Default `/new`. */
  freshCommand: string;
  /** When the fresh command's new session reports itself. Default `immediate`. */
  freshMode: "immediate" | "first-prompt" | "ignored";
  /** The session new events belong to (a fresh command moves it). */
  readonly session: string;
  /** Every tmux argv mu sent to this pane (and its paste buffers), in order. */
  readonly calls: string[][];
  /** Every text submitted with Enter, in order. */
  readonly submitted: string[];
  /** What sits in the input box now. */
  input: string;
  /** Write one event file. `now` defaults to Date.now(). */
  emit(event: string, fields?: Record<string, unknown>): void;
  /** The fake `murmur pane`: drains this pane's inbox and reports it. */
  pane: MurmurPaneRunner;
  /** The fake `murmur hook mu --pane`: writes mu's event into this pane's inbox. */
  hook: MurmurHookRunner;
  /** Every event mu wrote through `hook`, in order. */
  readonly muEvents: Record<string, unknown>[];
  /** The `@murmur_pane_state` word the drain published (empty: none). */
  option(): string;
  /** Answer a tmux call that targets this pane or its buffers; undefined: not ours. */
  tmux(args: readonly string[]): { stdout: string; stderr: string; exitCode: number } | undefined;
  /** Number of event files not yet drained. */
  pending(): number;
}

const OK = { stdout: "", stderr: "", exitCode: 0 };

export function fakeHarness(root: string, paneId: string, sessionId: string): FakeHarness {
  const inbox = join(root, "inbox", paneId.replace("%", "p"));
  mkdirSync(inbox, { recursive: true });
  let seq = 0;
  let current = sessionId;
  let sessions = 1;
  /** A fresh command a first-prompt harness has taken: the session its next prompt starts. */
  let pendingSession: string | null = null;
  const st: PaneState = {
    activity: null,
    attention: new Map(),
    sessionId: null,
    runCount: 0,
    updatedAt: 0,
    confirmed: true,
    failed: false,
    lastText: null,
    generation: null,
  };
  let claimed = false;
  const buffers = new Map<string, string>();

  /** murmur's vocabulary, as its store applies it (stepTurn, for a mu-managed agent). */
  const apply = (e: Record<string, unknown>): void => {
    const event = String(e.event);
    const sid = typeof e.session_id === "string" ? e.session_id : null;
    const now = typeof e.now === "number" ? e.now : Date.now();
    if (st.sessionId !== null && sid !== st.sessionId && event !== "session_start") return;
    if (event === "session_start" && e.source === "compact") return;
    const generation = typeof e.generation_id === "string" ? e.generation_id : null;
    // As murmur: a named turn that already ended takes only its late text (cursor-agent's
    // `afterAgentResponse` after its `stop`).
    if (event === "turn_stopped" && generation !== null && generation === st.generation) {
      if (typeof e.text === "string") st.lastText = e.text;
      st.updatedAt = now;
      return;
    }
    st.updatedAt = now;
    claimed = true;
    // Every event but a new dialog clears `blocked`; nothing but an abort clears `error`.
    if (event !== "permission_requested") st.attention.delete("blocked");
    st.confirmed = true;
    switch (event) {
      case "session_start":
        if (e.source !== "resume" || st.sessionId === null) {
          st.sessionId = sid;
          st.runCount = 0;
          st.lastText = null;
          st.failed = false;
          st.generation = null;
        }
        st.activity = "stopped";
        break;
      case "prompt_submitted":
        st.activity = "running";
        st.runCount += 1;
        st.attention.delete("done");
        break;
      case "continued":
        st.activity = "running";
        break;
      case "permission_requested":
        st.attention.set("blocked", typeof e.message === "string" ? e.message : "");
        break;
      case "interrupted":
        st.activity = "stopped";
        st.confirmed = e.by !== "mu";
        if (st.failed) st.attention.delete("error");
        break;
      case "turn_stopped":
        // A mu-managed agent's settle raises no `done`.
        st.activity = "stopped";
        st.failed = false;
        // As murmur: a turn that names no text keeps the previous one, unless it names
        // its generation, whose text may still be on its way.
        if (generation !== null) {
          st.lastText = typeof e.text === "string" ? e.text : null;
          st.generation = generation;
        } else if (typeof e.text === "string") st.lastText = e.text;
        break;
      case "turn_failed":
        st.activity = "stopped";
        st.failed = true;
        st.attention.set("error", typeof e.message === "string" ? e.message : "");
        break;
      case "session_end":
        // Not `/clear`: the agent row goes, its attention stays.
        if (e.reason !== "clear") {
          st.activity = null;
          st.sessionId = null;
        }
        break;
      case "crashed":
        st.attention.set("crashed", "");
        break;
    }
  };

  const drain = (): void => {
    for (const name of readdirSync(inbox).sort()) {
      const file = join(inbox, name);
      apply(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
      rmSync(file);
    }
  };

  /** murmur's renderState then tmuxAgentState, and `idle?` for an unconfirmed idle. */
  const rendered = (): string | null => {
    if (!claimed) return null;
    const kind = ATTENTION_PRIORITY.find((k) => st.attention.has(k));
    if (kind !== undefined) return kind;
    if (st.activity === null) return null;
    if (st.activity === "running") return "working";
    return st.confirmed ? "idle" : "idle?";
  };

  const fake: FakeHarness = {
    paneId,
    inbox,
    acks: true,
    answers: true,
    answeredWith: "turn_stopped",
    onEscape: "event",
    freshCommand: "/new",
    freshMode: "immediate",
    get session() {
      return current;
    },
    calls: [],
    submitted: [],
    muEvents: [],
    input: "",
    emit(event, fields = {}) {
      seq += 1;
      const body = { v: 1, event, session_id: current, now: Date.now(), ...fields };
      writeFileSync(
        join(inbox, `${String(seq).padStart(12, "0")}-${process.pid}.json`),
        JSON.stringify(body),
      );
    },
    pane: async (pane) => {
      if (pane !== paneId) return JSON.stringify({ pane, state: null, agent: null, attention: [] });
      drain();
      return JSON.stringify({
        pane,
        server: { kind: "default" },
        state: rendered(),
        agent:
          st.activity === null
            ? null
            : {
                cli: "fake",
                activity: st.activity,
                source: "inbox",
                harness: "fake",
                session_id: st.sessionId,
                run_count: st.runCount,
                last_text: st.lastText,
                confirmed: st.confirmed,
                updated_at: st.updatedAt,
              },
        attention: [...st.attention].map(([kind, message]) => ({
          kind,
          message,
          source: "hook",
          driver: "orchestrated",
        })),
      });
    },
    hook: async (pane, event) => {
      if (pane !== paneId) return false;
      fake.muEvents.push({ ...event });
      const { event: name, ...fields } = event;
      // `murmur hook mu` stamps who wrote it: mu's `interrupted` is unconfirmed.
      fake.emit(String(name), { ...fields, by: "mu" });
      return true;
    },
    option: () => {
      drain();
      const word = rendered();
      return word === null ? "" : word === "idle?" ? "idle" : word;
    },
    tmux(args) {
      const [verb] = args;
      const target = args[args.indexOf("-t") + 1];
      if (verb === "set-buffer") {
        const name = args[args.indexOf("-b") + 1] ?? "";
        if (!name.startsWith("mu-paste-")) return undefined;
        const data = fromTmuxWord(args[args.indexOf("--") + 1] ?? "");
        fake.calls.push([...args]);
        if (data === "") return { stdout: "", stderr: "no data specified", exitCode: 1 };
        buffers.set(name, (args.includes("-a") ? (buffers.get(name) ?? "") : "") + data);
        return OK;
      }
      if (verb === "delete-buffer") {
        buffers.delete(args[args.indexOf("-b") + 1] ?? "");
        return OK;
      }
      if (target !== paneId || (verb !== "send-keys" && verb !== "paste-buffer")) return undefined;
      fake.calls.push([...args]);
      if (verb === "paste-buffer") {
        const name = args[args.indexOf("-b") + 1] ?? "";
        fake.input += buffers.get(name) ?? "";
        if (args.includes("-d")) buffers.delete(name);
        return OK;
      }
      const keys = args
        .slice(args.indexOf("-t") + 2)
        .filter((k) => k !== "--" && k !== "-l")
        .map(fromTmuxWord)
        .filter((k) => k !== "");
      const literal = args.includes("-l");
      drain();
      for (const key of keys) {
        if (st.attention.has("blocked")) {
          // Any key answers the open dialog; the harness moves on.
          if (fake.answers) fake.emit(fake.answeredWith, { text: "answered" });
        } else if (!literal && key === "C-u") fake.input = "";
        else if (!literal && key === "Escape") {
          if (st.activity === "running" && fake.onEscape === "event") fake.emit("interrupted");
        } else if (!literal && key === "Enter") {
          const text = fake.input;
          fake.submitted.push(text);
          fake.input = "";
          if (text === fake.freshCommand) {
            sessions += 1;
            const next = `${sessionId}-${sessions}`;
            if (fake.freshMode === "immediate") {
              fake.emit("session_end", { reason: "clear" });
              current = next;
              fake.emit("session_start", { source: "clear" });
            } else if (fake.freshMode === "first-prompt") pendingSession = next;
          } else if (fake.acks) {
            if (pendingSession !== null) {
              current = pendingSession;
              pendingSession = null;
              fake.emit("session_start", { source: "startup" });
            }
            fake.emit("prompt_submitted");
          }
        } else fake.input += key;
      }
      return OK;
    },
    pending: () => readdirSync(inbox).length,
  };
  return fake;
}
