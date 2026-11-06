// mu — `mu hook stop`: keep-driving and the close nudge for harnesses with a Stop hook.
//
// pi keeps its settle nudge (extension/nudge.ts). claude, codex and
// cursor-agent get the same two behaviours from one Stop hook entry, which
// the harness runs with the hook payload on stdin when a turn ends. Spec
// "Every harness first-class", D7.
//
// - Guards (src/hook-chain.ts): the hook acts only for a pane agent mu started
//   whose harness is the hook's, with no other harness in between, and that is
//   not remote. A `claude -p` a managed agent runs consumes nothing and gets no
//   nudge. Muse Code never gets the entry: its Stop block does not deliver the
//   reason, so a muse hook (and any harness that cannot block) always allows.
// - Orchestrator: a live process already waiting as this caller (a background
//   `mu wait`) lets the turn end; that wait wakes the agent. Otherwise the hook
//   runs a consuming `mu wait --first --timeout <T> --as <caller>`, T 10 s below
//   the hook's own timeout. An event blocks the stop with the wait's result,
//   which the block hands to the model (consumed: no later wait returns it). A
//   timeout with work still owed blocks with "run `mu wait` in the background",
//   at most MU_KEEP_DRIVING_MAX times in a row (default 20): the counter lives
//   in the machine-local `keep_driving` table, per harness session, and a block
//   that delivers events or a turn the user started resets it. Nothing owed:
//   the turn ends.
// - Worker: one that still owns an IN_PROGRESS task is told once per session
//   to close it or park it.
// - Every block records `continued` through `murmur hook mu`: a resumed turn
//   fires no `prompt_submitted`, so murmur would otherwise read it idle.
//
// The hook never fails a turn: every failure allows the stop.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgent } from "./agents.js";
import { writeMuEvent } from "./channels/index.js";
import { parseCloseBlock } from "./close-block.js";
import type { Db } from "./db.js";
import { execFileCapture } from "./exec-file.js";
import { HARNESS_TABLE, type Harness, isHarness } from "./harnesses.js";
import {
  type AnchorReader,
  type HookAgent,
  hookAgent,
  type ProcessTable,
  readProcessTable,
} from "./hook-chain.js";
import { closeNudgeText, keepDrivingRule } from "./nudge-text.js";
import { listTasksByOwner } from "./tasks/queries.js";
import { liveHolder } from "./wait-holders.js";

/** The hook entry's timeout when `--timeout` is not given, in seconds. */
export const STOP_HOOK_TIMEOUT_S = 600;
/** The consuming wait ends this long before the harness would kill the hook. */
export const STOP_WAIT_MARGIN_S = 10;
/** Consecutive empty blocks allowed per session unless MU_KEEP_DRIVING_MAX says otherwise. */
export const KEEP_DRIVING_MAX_DEFAULT = 20;
/** keep_driving rows idle this long go with the next write. */
const KEEP_DRIVING_TTL_MS = 7 * 24 * 3600 * 1000;

/** `MU_KEEP_DRIVING_MAX`: a whole number of consecutive empty blocks (0 = never block on a timeout). */
export function keepDrivingMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MU_KEEP_DRIVING_MAX?.trim() ?? "";
  return /^\d+$/.test(raw) ? Number(raw) : KEEP_DRIVING_MAX_DEFAULT;
}

/** The consuming wait's deadline for a hook entry with `timeoutS`. */
export function stopWaitSeconds(timeoutS: number): number {
  return Math.max(0.1, timeoutS - STOP_WAIT_MARGIN_S);
}

/** What the consuming wait reported. */
export type StopWaitOutcome =
  | { kind: "events"; data: Record<string, unknown> }
  | { kind: "timeout" }
  /** Nothing owed: WaitNothingError, or every watched thing already delivered. */
  | { kind: "nothing" }
  /** Another live process waits as this caller (CallerBusyError). */
  | { kind: "busy" }
  | { kind: "failed"; detail: string };

export type StopDecision =
  | { decision: "allow"; why: string }
  | { decision: "block"; why: "events" | "owed" | "close"; reason: string };

export interface StopHookDeps {
  /** The process table (null: unreadable). */
  table?: () => ProcessTable | null;
  anchor?: AnchorReader;
  /** The hook's own pid, where the walk starts. */
  self?: number;
  env?: NodeJS.ProcessEnv;
  /** True when a live process other than the hook waits as `caller`. */
  holder?: (caller: string) => boolean;
  /** The consuming wait. */
  wait?: (caller: string, timeoutS: number) => Promise<StopWaitOutcome>;
  /** `murmur hook mu --pane <pane>`; true when murmur took the event. */
  writeEvent?: (paneId: string, event: Record<string, unknown>) => Promise<boolean>;
  /** SKILL.md's text, for the keep-driving rule. */
  skillMd?: () => string | undefined;
  now?: () => Date;
}

/** The fields of a Stop payload the hook reads. */
interface StopPayload {
  sessionId: string | null;
  /** True when this turn was resumed by a Stop block; false when the user started it. */
  resumed: boolean | null;
  status: string | null;
  transcriptNull: boolean;
  /** The turn's final message (claude, codex, Muse Code); null when the payload has none. */
  lastText: string | null;
}

function payloadOf(raw: unknown): StopPayload {
  const p = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const sid = typeof p.session_id === "string" && p.session_id !== "" ? p.session_id : null;
  // claude and codex: stop_hook_active; cursor-agent: loop_count (0 for a user's turn).
  const resumed =
    typeof p.stop_hook_active === "boolean"
      ? p.stop_hook_active
      : typeof p.loop_count === "number"
        ? p.loop_count > 0
        : null;
  return {
    sessionId: sid,
    resumed,
    status: typeof p.status === "string" ? p.status : null,
    transcriptNull: "transcript_path" in p && p.transcript_path === null,
    lastText: typeof p.last_assistant_message === "string" ? p.last_assistant_message : null,
  };
}

/** Why this harness's Stop must not be acted on at all, or undefined. */
function skipped(harness: Harness, p: StopPayload): string | undefined {
  // codex's hidden title-generation session fires Stop with no transcript (D6 drop rule).
  if (harness === "codex" && p.transcriptNull) return "codex title-generation session";
  // cursor-agent's aborted or failed stop is not a completed turn: Esc or an error, stop.
  if (harness === "cursor-agent" && p.status !== null && p.status !== "completed") {
    return `turn ${p.status}`;
  }
  return undefined;
}

// ─── keep_driving ──────────────────────────────────────────────────

interface KeepDriving {
  emptyBlocks: number;
  closeNudged: boolean;
}

export function readKeepDriving(db: Db, sessionId: string): KeepDriving {
  const row = db
    .prepare("SELECT empty_blocks, close_nudged FROM keep_driving WHERE session_id = ?")
    .get(sessionId) as { empty_blocks: number; close_nudged: number } | undefined;
  return { emptyBlocks: row?.empty_blocks ?? 0, closeNudged: row?.close_nudged === 1 };
}

function writeKeepDriving(db: Db, sessionId: string, next: KeepDriving, now: Date): void {
  db.transaction(() => {
    db.prepare("DELETE FROM keep_driving WHERE updated_at < ?").run(
      new Date(now.getTime() - KEEP_DRIVING_TTL_MS).toISOString(),
    );
    db.prepare(
      `INSERT INTO keep_driving (session_id, empty_blocks, close_nudged, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET empty_blocks = excluded.empty_blocks,
         close_nudged = excluded.close_nudged, updated_at = excluded.updated_at`,
    ).run(sessionId, next.emptyBlocks, next.closeNudged ? 1 : 0, now.toISOString());
  }).immediate();
}

/** Bookkeeping after a block is decided: `fallback` when it throws, so it never loses the block. */
function bestEffort<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ─── the default deps ──────────────────────────────────────────────

/** Read a wait's one JSON document. */
export function parseStopWait(stdout: string): StopWaitOutcome {
  let doc: { ok?: unknown; error?: unknown; message?: unknown; data?: unknown };
  try {
    doc = JSON.parse(stdout.trim()) as typeof doc;
  } catch {
    return { kind: "failed", detail: stdout.trim().slice(0, 500) || "no output" };
  }
  if (doc.ok === false) {
    if (doc.error === "WaitNothingError") return { kind: "nothing" };
    if (doc.error === "CallerBusyError") return { kind: "busy" };
    return { kind: "failed", detail: `${String(doc.error)}: ${String(doc.message ?? "")}` };
  }
  const data = doc.data;
  if (doc.ok !== true || typeof data !== "object" || data === null) {
    return { kind: "failed", detail: "not a wait result" };
  }
  const d = data as Record<string, unknown>;
  if (d.drained === true) return { kind: "nothing" };
  if (d.interrupted === true) return { kind: "failed", detail: "the wait was interrupted" };
  if (d.timedOut === true) return { kind: "timeout" };
  return { kind: "events", data: d };
}

/** The wait the hook runs: this same mu CLI, as `caller`, one JSON document. */
export function stopWaitArgs(caller: string, timeoutS: number): string[] {
  return [
    "wait",
    "--first",
    "--on-stall",
    "exit",
    "--json",
    "--timeout",
    String(timeoutS),
    "--as",
    caller,
  ];
}

const defaultWait = async (caller: string, timeoutS: number): Promise<StopWaitOutcome> => {
  const cli = process.argv[1];
  if (cli === undefined) return { kind: "failed", detail: "mu's own CLI path is unknown" };
  const r = await execFileCapture(process.execPath, [cli, ...stopWaitArgs(caller, timeoutS)], {
    timeoutMs: Math.round((timeoutS + STOP_WAIT_MARGIN_S) * 1000),
  });
  return parseStopWait(r.stdout);
};

/** SKILL.md beside the package (src/ and dist/ are both one level down). */
function readSkill(): string | undefined {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "mu", "SKILL.md");
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

// ─── the texts ─────────────────────────────────────────────────────

const RULE_FALLBACK =
  "While workers run, keep driving: your turn ends only when everything you own is closed, or only a human can decide.";

export function eventsReason(
  rule: string,
  caller: string,
  waitS: number,
  data: Record<string, unknown>,
): string {
  const needs = Array.isArray(data.humanNeeds) ? data.humanNeeds.length : 0;
  const lead =
    needs > 0
      ? "[mu] A human stop is open (mu human-needed): collect and merge what you already started; start nothing new."
      : `[mu] ${rule}`;
  return [
    lead,
    "",
    `Work you own is still running, so mu's Stop hook ran \`mu ${stopWaitArgs(caller, waitS).join(" ")}\` for you. Its result (consumed: no later wait returns this event again):`,
    JSON.stringify(data),
  ].join("\n");
}

export function owedReason(n: number, max: number): string {
  return `[mu] Workers are still running; run \`mu wait\` in the background, which returns (and wakes you) when one of them needs you, then keep going. (Empty stop block ${n} of ${max} in a row.)`;
}

// ─── the hook ──────────────────────────────────────────────────────

/** The answer to one Stop, as the harness reads it: "" lets the turn end. */
export function stopHookOutput(harness: string, d: StopDecision): string {
  if (d.decision === "allow") return "";
  if (harness === "cursor-agent") return JSON.stringify({ followup_message: d.reason });
  return JSON.stringify({ decision: "block", reason: d.reason });
}

/**
 * Decide one Stop of `harness` from its hook `payload` (parsed JSON). Never
 * throws for a harness, payload or agent it cannot act on: those allow.
 */
export async function runStopHook(
  db: Db,
  harness: string,
  payload: unknown,
  opts: { timeoutS?: number } = {},
  deps: StopHookDeps = {},
): Promise<StopDecision> {
  const env = deps.env ?? process.env;
  if (!isHarness(harness)) return { decision: "allow", why: `not a hook harness: ${harness}` };
  if (harness === "pi") return { decision: "allow", why: "pi keeps its settle nudge" };
  if (!HARNESS_TABLE[harness].canBlockOnStop) {
    return {
      decision: "allow",
      why: `${HARNESS_TABLE[harness].displayName} cannot block a stop with a reason`,
    };
  }
  if (env.MU_NUDGE === "0") return { decision: "allow", why: "MU_NUDGE=0" };
  const p = payloadOf(payload);
  const skip = skipped(harness, p);
  if (skip !== undefined) return { decision: "allow", why: skip };
  const who = hookAgent(harness, {
    table: (deps.table ?? readProcessTable)(),
    ...(deps.self !== undefined ? { self: deps.self } : {}),
    ...(deps.anchor !== undefined ? { anchor: deps.anchor } : {}),
    env,
  });
  if (!who.ok) return { decision: "allow", why: `not a mu pane agent (${who.reason})` };
  const agent = who.agent;
  const now = (deps.now ?? (() => new Date()))();
  const key = p.sessionId ?? `agent:${agent.workstream}/${agent.name}`;
  const state = readKeepDriving(db, key);
  // A turn the user started (not one a block resumed) is a prompt: it resets the cap.
  if (p.resumed === false && state.emptyBlocks > 0) {
    state.emptyBlocks = 0;
    writeKeepDriving(db, key, state, now);
  }
  const decision = agent.orchestrator
    ? await orchestratorStop(
        db,
        agent,
        key,
        state,
        opts.timeoutS ?? STOP_HOOK_TIMEOUT_S,
        deps,
        env,
        now,
      )
    : workerStop(db, agent, key, state, now, p.lastText);
  if (decision.decision === "block") {
    // After a block is decided nothing may turn it into an allow: an `events`
    // block carries an event the wait already consumed.
    try {
      const paneId = bestEffort(
        () => getAgent(db, agent.name, agent.workstream)?.paneId ?? env.TMUX_PANE,
        env.TMUX_PANE,
      );
      if (paneId !== undefined && paneId !== "") {
        await (deps.writeEvent ?? writeMuEvent)(paneId, {
          event: "continued",
          ...(p.sessionId !== null ? { session_id: p.sessionId } : {}),
        });
      }
    } catch {
      // murmur missing or failing: the block still stands.
    }
  }
  return decision;
}

async function orchestratorStop(
  db: Db,
  agent: HookAgent,
  key: string,
  state: KeepDriving,
  timeoutS: number,
  deps: StopHookDeps,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<StopDecision> {
  const caller = `${agent.workstream}/${agent.name}`;
  const holder = deps.holder ?? ((c: string) => liveHolder(c) !== undefined);
  if (holder(caller)) {
    return { decision: "allow", why: `a live wait already holds ${caller}; it wakes the agent` };
  }
  const waitS = stopWaitSeconds(timeoutS);
  const out = await (deps.wait ?? defaultWait)(caller, waitS);
  switch (out.kind) {
    case "nothing":
      return { decision: "allow", why: "nothing owed" };
    case "busy":
      return { decision: "allow", why: `a live wait already holds ${caller}; it wakes the agent` };
    case "failed":
      return { decision: "allow", why: `the wait failed: ${out.detail}` };
    case "events": {
      // The wait already consumed the event: a failed write must not lose it.
      bestEffort(() => writeKeepDriving(db, key, { ...state, emptyBlocks: 0 }, now), undefined);
      const rule =
        bestEffort(() => {
          const md = (deps.skillMd ?? readSkill)();
          return md === undefined ? undefined : keepDrivingRule(md);
        }, undefined) ?? RULE_FALLBACK;
      return {
        decision: "block",
        why: "events",
        reason: eventsReason(rule, caller, waitS, out.data),
      };
    }
    case "timeout": {
      const max = keepDrivingMax(env);
      if (state.emptyBlocks >= max) {
        return {
          decision: "allow",
          why: `${state.emptyBlocks} empty blocks in a row (cap ${max})`,
        };
      }
      const n = state.emptyBlocks + 1;
      writeKeepDriving(db, key, { ...state, emptyBlocks: n }, now);
      return { decision: "block", why: "owed", reason: owedReason(n, max) };
    }
  }
}

function workerStop(
  db: Db,
  agent: HookAgent,
  key: string,
  state: KeepDriving,
  now: Date,
  lastText: string | null = null,
): StopDecision {
  if (agent.workstream === "scratch") return { decision: "allow", why: "a scratch pane" };
  if (state.closeNudged)
    return { decision: "allow", why: "the close nudge already fired this session" };
  // A delegate's call task is closed by its call (finishDelegate), never by the pane.
  const names = listTasksByOwner(db, agent.workstream, agent.name)
    .filter((t) => t.status === "IN_PROGRESS" && t.kind !== "delegate")
    .map((t) => t.name);
  if (names.length === 0) return { decision: "allow", why: "owns no IN_PROGRESS task" };
  // A turn that ends with a valid CLOSE block for an owned task is the worker's report: the
  // orchestrator applies it from the last text (D3). A nudge would start another turn whose
  // text replaces that report, so the orchestrator would never read it.
  const close = lastText === null ? undefined : parseCloseBlock(lastText);
  if (close?.kind === "valid" && names.includes(close.task))
    return { decision: "allow", why: `the turn ends with a CLOSE block for ${close.task}` };
  writeKeepDriving(db, key, { ...state, closeNudged: true }, now);
  return { decision: "block", why: "close", reason: closeNudgeText(agent.workstream, names) };
}
