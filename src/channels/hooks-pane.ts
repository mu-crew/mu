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
    (a): a is { kind: string; message?: unknown } =>
      typeof a === "object" && a !== null && typeof (a as { kind?: unknown }).kind === "string",
  );
  const blocked = attention.find((a) => a.kind === "blocked");
  return {
    state: str(d.state),
    // A row without an activity word is still a row: unknown activity, never "no row".
    activity: agent === null ? null : (str(agent.activity) ?? ""),
    attention: attention.map((a) => a.kind),
    sessionId: str(agent?.session_id),
    runCount: num(agent?.run_count),
    updatedAt: num(agent?.updated_at),
    blocked: blocked === undefined ? null : (str(blocked.message) ?? ""),
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
