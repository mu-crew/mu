// mu — what murmur reports for one hook-harness pane (spec D3, D4).
//
// `murmur pane <pane> --json` drains the pane's inbox into murmur's store
// first, so its `run_count` is never a cached view: the `hooks` channel's
// send gate, its ack and its dialog answer read it here. A pane murmur does
// not answer for (murmur absent, or older than `murmur pane`) reads
// `undefined`: unknown, never idle.

import { execFileCapture } from "../exec-file.js";
import { sleep } from "../tmux.js";

/** One pane as murmur reports it after a drain. */
export interface HooksPane {
  /**
   * murmur's rendered word for the pane: `working`, `idle`, `idle?` (an
   * interrupt mu sent that no harness event has confirmed), `blocked`, `done`,
   * `error`, `crashed`. null: murmur knows nothing about the pane. Picked by
   * attention priority (an old `error` outranks a running turn), so it is for
   * messages only: the gates read `activity` and `attention`.
   */
  state: string | null;
  /** The agent row's activity (`running`, `stopped`); null: no agent row. */
  activity: string | null;
  /** The attention kinds the pane carries (`blocked`, `error`, `done`, `crashed`). */
  attention: string[];
  /** The harness session the counts belong to; null: no agent row. */
  sessionId: string | null;
  /** Prompts submitted in this session; null: no agent row. */
  runCount: number | null;
  /** When the pane's agent row last changed (epoch ms); null: no agent row. */
  updatedAt: number | null;
  /** The pending dialog's message (the tool name), when the pane is blocked. */
  blocked: string | null;
  /** The `error` attention's message (a failed turn), when the pane carries one. */
  error: string | null;
  /**
   * When that `error` was first raised (epoch ms, murmur's `requested_at`).
   * murmur keeps an attention through later turns and keeps its first time on
   * a repeat, so an error older than `updatedAt` was not raised by the row's
   * last event. null: no error, or a murmur that does not report the time.
   */
  errorAt: number | null;
  /**
   * The last settled turn's assistant text (`turn_stopped`, head-capped at 64
   * KB by murmur); null: none in this session. A turn that ended without text
   * (an interrupt, a failure) leaves the previous turn's text here.
   */
  lastText: string | null;
  /** False after an interrupt mu wrote that no harness event has confirmed (`idle?`). */
  confirmed: boolean;
}

export type MurmurPaneRunner = (paneId: string) => Promise<string | null>;

let runnerForTests: MurmurPaneRunner | null = null;

const defaultRunner: MurmurPaneRunner = async (paneId) => {
  // mu's own tmux server: the private test socket when one is set, else the
  // server murmur finds from `$TMUX` or the default one, as mu's tmux calls do.
  const socket = process.env.MU_TMUX_SOCKET;
  const route = socket !== undefined && socket.length > 0 ? ["-L", socket] : [];
  try {
    const r = await execFileCapture("murmur", ["pane", paneId, "--json", ...route], {
      timeoutMs: 5_000,
    });
    return r.exitCode === 0 ? r.stdout : null;
  } catch {
    return null;
  }
};

/** Replace `murmur pane` (tests: a fake harness's inbox). null restores the real one. */
export function setMurmurPaneRunnerForTests(run: MurmurPaneRunner | null): void {
  runnerForTests = run;
}

/** Write one of mu's own events into the pane's inbox; true when murmur took it. */
export type MurmurHookRunner = (paneId: string, event: Record<string, unknown>) => Promise<boolean>;

let hookRunnerForTests: MurmurHookRunner | null = null;

const defaultHookRunner: MurmurHookRunner = async (paneId, event) => {
  const socket = process.env.MU_TMUX_SOCKET;
  const route = socket !== undefined && socket.length > 0 ? ["-L", socket] : [];
  try {
    const r = await execFileCapture("murmur", ["hook", "mu", "--pane", paneId, ...route], {
      timeoutMs: 5_000,
      input: JSON.stringify(event),
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
};

/** Replace `murmur hook mu` (tests: a fake harness's inbox). null restores the real one. */
export function setMurmurHookRunnerForTests(run: MurmurHookRunner | null): void {
  hookRunnerForTests = run;
}

/**
 * Record mu's own vocabulary event for a pane through `murmur hook mu --pane`
 * (spec D3). Best effort: false when murmur is absent or refused it.
 */
export async function writeMuEvent(
  paneId: string,
  event: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await (hookRunnerForTests ?? defaultHookRunner)(paneId, event);
  } catch {
    return false;
  }
}

/** Acknowledge every attention request on a pane (`murmur clear --pane`); true when murmur ran. */
export type MurmurClearRunner = (paneId: string) => Promise<boolean>;

let clearRunnerForTests: MurmurClearRunner | null = null;

const defaultClearRunner: MurmurClearRunner = async (paneId) => {
  // `murmur clear` takes no socket: it finds the server from `$TMUX`, else the default one.
  try {
    const r = await execFileCapture("murmur", ["clear", "--pane", paneId], { timeoutMs: 5_000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
};

/** Replace `murmur clear` (tests: a fake harness's attention). null restores the real one. */
export function setMurmurClearRunnerForTests(run: MurmurClearRunner | null): void {
  clearRunnerForTests = run;
}

/**
 * Acknowledge the pane's attention through `murmur clear --pane` (the focus
 * hook's own write: attention only, never activity, counts or session).
 * murmur reports nothing back, so a caller that needs it gone reads the pane
 * after. Best effort: false when murmur is absent or failed.
 */
export async function clearPaneAttention(paneId: string): Promise<boolean> {
  try {
    return await (clearRunnerForTests ?? defaultClearRunner)(paneId);
  } catch {
    return false;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse `murmur pane --json`; undefined when it is not a pane report. */
export function parseHooksPane(stdout: string): HooksPane | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null || !("state" in doc)) return undefined;
  const d = doc as { state: unknown; agent?: unknown; attention?: unknown };
  const agent =
    typeof d.agent === "object" && d.agent !== null ? (d.agent as Record<string, unknown>) : null;
  const attention = (Array.isArray(d.attention) ? d.attention : []).filter(
    (a): a is { kind: string; message?: unknown; requested_at?: unknown } =>
      typeof a === "object" && a !== null && typeof (a as { kind?: unknown }).kind === "string",
  );
  const blocked = attention.find((a) => a.kind === "blocked");
  const error = attention.find((a) => a.kind === "error");
  return {
    state: str(d.state),
    // A row without an activity word is still a row: unknown activity, never "no row".
    activity: agent === null ? null : (str(agent.activity) ?? ""),
    attention: attention.map((a) => a.kind),
    sessionId: str(agent?.session_id),
    runCount: num(agent?.run_count),
    updatedAt: num(agent?.updated_at),
    blocked: blocked === undefined ? null : (str(blocked.message) ?? ""),
    error: error === undefined ? null : (str(error.message) ?? ""),
    errorAt: error === undefined ? null : num(error.requested_at),
    lastText: str(agent?.last_text),
    confirmed: agent?.confirmed !== false && d.state !== "idle?",
  };
}

/** Drain and read one pane; undefined when murmur does not answer. */
export async function readHooksPane(paneId: string): Promise<HooksPane | undefined> {
  let stdout: string | null;
  try {
    stdout = await (runnerForTests ?? defaultRunner)(paneId);
  } catch {
    stdout = null;
  }
  return stdout === null ? undefined : parseHooksPane(stdout);
}

/** A non-negative integer env value in ms, else `fallback`. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

/** How long a paste (or a dialog answer) waits for its hook event: `MU_SEND_ACK_MS`, default 10 s. */
export function sendAckMs(): number {
  return envMs("MU_SEND_ACK_MS", 10_000);
}

/** A `running` pane with no event for this long reads unknown: `MU_STALE_MS`, default 10 min. */
export function staleMs(): number {
  return envMs("MU_STALE_MS", 600_000);
}

/** What the send gate decided. */
export type SendGate =
  | { ok: true }
  | { ok: false; state: "blocked" | "running" | "unknown"; reason: string };

/**
 * The `hooks` send gate (spec D4), on murmur's structured fields rather than
 * its rendered word: `blocked` attention is answered, never pasted into,
 * whatever else the pane carries; a `running` agent, and a running one with no
 * event for `stale` ms, read as refusals `--force` overrides; so does a pane
 * murmur cannot report, one with no agent row (its harness has not claimed it,
 * or has ended its session), and `crashed` (the harness is gone, and a paste
 * would reach whatever runs in the pane now). A stopped agent is sendable,
 * whether it reads `idle`, `idle?`, `done` or `error`.
 */
export function sendGate(pane: HooksPane | undefined, now: number, stale: number): SendGate {
  if (pane === undefined) {
    return { ok: false, state: "unknown", reason: "murmur pane did not answer" };
  }
  if (pane.state === null) {
    return { ok: false, state: "unknown", reason: "murmur has no row for the pane" };
  }
  if (pane.blocked !== null) {
    return { ok: false, state: "blocked", reason: pane.blocked || "a permission dialog" };
  }
  if (pane.attention.includes("crashed")) {
    return { ok: false, state: "unknown", reason: "its harness crashed" };
  }
  switch (pane.activity) {
    case null:
      return { ok: false, state: "unknown", reason: "murmur has no harness row for the pane" };
    case "running":
      if (pane.updatedAt !== null && now - pane.updatedAt > stale) {
        const s = Math.round((now - pane.updatedAt) / 1000);
        return { ok: false, state: "unknown", reason: `running, with no event for ${s}s` };
      }
      return { ok: false, state: "running", reason: "murmur reads it running" };
    case "stopped":
      return { ok: true };
    default:
      return {
        ok: false,
        state: "unknown",
        reason: `unrecognised murmur activity ${pane.activity || "(none)"}`,
      };
  }
}

/**
 * True when `after` shows a run that `before` did not: the run count rose in
 * the same session, or another session has started one. With no baseline (the
 * gate's read failed) nothing confirms: an old row's count is no evidence. When
 * murmur reported the pane with no agent row, only a first run (`run_count`
 * 1) confirms.
 */
export function runStarted(before: HooksPane | undefined, after: HooksPane | undefined): boolean {
  if (before === undefined) return false;
  if (after === undefined || after.runCount === null || after.runCount < 1) return false;
  if (before.runCount === null) return after.runCount === 1;
  if (after.sessionId !== before.sessionId) return true;
  return after.runCount > before.runCount;
}

/** True when `after` carries an event `before` had not: a newer update, or a changed state. */
export function eventArrived(before: HooksPane | undefined, after: HooksPane | undefined): boolean {
  if (after === undefined) return false;
  if (before === undefined) return after.state !== null;
  if (
    after.state !== before.state ||
    after.activity !== before.activity ||
    after.blocked !== before.blocked ||
    after.sessionId !== before.sessionId ||
    after.runCount !== before.runCount
  ) {
    return true;
  }
  return (
    after.updatedAt !== null && (before.updatedAt === null || after.updatedAt > before.updatedAt)
  );
}

/** Poll cadence of an ack. Each poll is one `murmur pane` process. */
const ACK_POLL_MS = 250;

/**
 * Read the pane until `done` holds, within `ms`: the pane that satisfied it,
 * or undefined. Bounded by both the clock and the poll count, so a test's
 * no-op sleep ends it too. Never resends anything.
 */
export async function pollPane(
  paneId: string,
  ms: number,
  done: (pane: HooksPane | undefined) => boolean,
): Promise<HooksPane | undefined> {
  const deadline = Date.now() + ms;
  const polls = Math.ceil(ms / ACK_POLL_MS) + 1;
  for (let i = 0; i < polls; i++) {
    if (i > 0) await sleep(ACK_POLL_MS);
    const pane = await readHooksPane(paneId);
    if (done(pane)) return pane;
    if (Date.now() >= deadline) break;
  }
  return undefined;
}

/**
 * Turns settled in the pane's session. `run_count` counts submitted prompts,
 * so a running (or blocked) pane's current turn has not settled yet; pi's
 * `runs`, which the wait baselines mirror, counts settled runs. undefined: no
 * agent row.
 */
export function settledRuns(pane: HooksPane): number | undefined {
  if (pane.runCount === null || pane.activity === null) return undefined;
  return pane.activity === "running" ? Math.max(0, pane.runCount - 1) : pane.runCount;
}

/**
 * True when `after` shows a fresh session that `before` did not: another
 * session id, or the same one started over from run 0 (murmur resets
 * `run_count` on every `session_start` that is not a resume). With no
 * baseline nothing confirms.
 */
export function freshStarted(before: HooksPane | undefined, after: HooksPane | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  if (after.activity === null || after.sessionId === null) return false;
  if (before.sessionId === null) return after.runCount === 0;
  if (after.sessionId !== before.sessionId) return true;
  return after.runCount === 0 && (before.runCount ?? 0) > 0;
}

/**
 * True when `after` shows a run in a session other than `before`'s: what
 * confirms a fresh session's first prompt on a harness whose new session
 * reports itself only on that prompt (codex, muse).
 */
export function runInNewSession(
  before: HooksPane | undefined,
  after: HooksPane | undefined,
): boolean {
  if (before === undefined || after === undefined || after.sessionId === null) return false;
  if (after.runCount === null || after.runCount < 1) return false;
  return after.sessionId !== before.sessionId;
}
