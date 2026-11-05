// mu — the `hooks` channel's remote path: a hook harness worker on a host
// (spec D11).
//
// A claude, codex, cursor-agent or muse worker spawned with `--host` runs on
// the remote node behind the local pane (an ssh, or a lease carrier). Its
// hooks there find its remote key (`<origin host>/<pane key>`, in its anchor
// and its env) and write to murmur's remote area on that node, never its
// inbox: the remote node's store, `murmur status` and snapshot never hold the
// worker, so the origin stays the one writer of the pane's row.
//
// mu reads that area on demand: one exec of the host profile's `exec`
// template runs `murmur pane --remote <key> --json` on the node, which applies
// the waiting events to the key's state, deletes them and prints the state
// with the events it applied. mu relays each of those events, in order, into
// the local pane's inbox with `murmur hook mu --pane` (harness and agent
// named, since no harness runs in the local pane), so the local drain, its
// pane options and `murmur pane <pane>` see the worker as they see a local
// one. Every other `hooks` read stays local. A read whose events never reached
// the pane (the exec timed out after the node applied them, a relay refused)
// is not lost for good: each read that succeeds compares the local pane with
// the node's snapshot and writes the events that bring it back in line.
//
// Each read also keeps a small record of which run set the node's text, so
// collect applies a CLOSE block only from the turn that wrote it, never from
// an earlier turn's text that murmur kept when a later turn ended without one.
//
// A read costs one exec (several serialized ssh round trips on a lease host),
// so only a wait, a collect and a send gate read; an ack poll never does. A
// read passes the host's channel admission like every remote command: at
// `--max-sessions 1` the worker's own pane holds the only channel and the read
// is refused (the send gate then reads `unknown`). Reads of one key are
// serialized by a local lock, so two mu processes never relay one key's events
// out of order; murmur's own per-key lock makes each event applied, and
// relayed, once.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../db.js";
import { locksDir, withFileLock } from "../file-lock.js";
import { HOST_COMMAND_TIMEOUT_MS, runHostTemplate } from "../hosts.js";
import { localPaneAlive } from "../remote-agent.js";
import { shellQuote } from "../shell-quote.js";
import { type HooksPane, readHooksPane, writeMuEvent } from "./hooks-pane.js";
import type { RemoteReader, RemoteReadResult, RemoteSnapshot } from "./types.js";

/** The line the remote script prints before murmur's JSON (a login shell may print noise first). */
const PANE_MARK = "MU_REMOTE_PANE";
/** The line saying whether mu's own event (`write`) was recorded on the node. */
const WRITE_MARK = "MU_REMOTE_WRITE";

/** How long a read waits for another mu process's read of the same key. */
const LOCK_WAIT_MS = 60_000;

/** The worker a reader serves: its row's identity and pane, plus its host and remote key. */
export interface RemoteHooksAgent {
  name: string;
  workstreamName: string;
  paneId: string;
  /** The harness, as the relay names it to murmur (the local pane runs none). */
  harness: string;
  host: string;
  key: string;
}

/**
 * The remote script one read runs (the exec template's `{cmd}`): optionally
 * record mu's own event (`murmur hook mu --remote`, payload on stdin), then
 * print the key's state with the events applied (`murmur pane --remote
 * --json`). The exit status is the read's.
 */
export function remotePaneScript(key: string, write?: Record<string, unknown>): string {
  const lines = [`k=${shellQuote(key)}`];
  if (write !== undefined) {
    lines.push(
      `if printf '%s' ${shellQuote(JSON.stringify(write))} | murmur hook mu --remote "$k" >/dev/null; then w=ok; else w=failed; fi`,
      `printf '${WRITE_MARK} %s\\n' "$w"`,
    );
  }
  lines.push(`printf '${PANE_MARK}\\n'`, `exec murmur pane --remote "$k" --json`);
  return `sh -c ${shellQuote(lines.join("\n"))}`;
}

type Doc = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isDoc = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

/** What one read printed: whether mu's event was written, and murmur's report. */
export interface RemoteOutput {
  written: "ok" | "failed" | null;
  report: Doc;
  events: Doc[];
}

/** Parse a read's stdout for `key`; the reason as a string when it holds no report of that key. */
export function parseRemoteOutput(stdout: string, key: string): RemoteOutput | string {
  const lines = stdout.split("\n");
  const mark = lines.map((l) => l.trim()).lastIndexOf(PANE_MARK);
  if (mark < 0) return "the host printed no murmur report";
  let written: RemoteOutput["written"] = null;
  for (const l of lines.slice(0, mark)) {
    const m = new RegExp(`^${WRITE_MARK} (ok|failed)$`).exec(l.trim());
    if (m?.[1] === "ok" || m?.[1] === "failed") written = m[1];
  }
  let doc: unknown;
  try {
    doc = JSON.parse(lines.slice(mark + 1).join("\n"));
  } catch {
    return "murmur pane --remote printed no JSON (murmur older than the remote area?)";
  }
  if (!isDoc(doc) || doc.remote !== key || !Array.isArray(doc.events)) {
    return "murmur pane --remote printed another key's report, or none";
  }
  return { written, report: doc, events: doc.events.filter(isDoc) };
}

/** The report as the channel reads it. `textTied`: see textTurnAfter. */
export function remoteSnapshot(out: RemoteOutput, textTied = false): RemoteSnapshot {
  const { report } = out;
  const agent = isDoc(report.agent) ? report.agent : null;
  const state = str(report.state);
  const entries = (Array.isArray(report.attention) ? report.attention : []).filter(isDoc);
  const message = (kind: string): string | null => {
    const entry = entries.find((a) => a.kind === kind);
    return entry === undefined ? null : (str(entry.message) ?? "");
  };
  return {
    state,
    harness: str(agent?.harness),
    sessionId: str(agent?.session_id),
    runCount: num(agent?.run_count),
    activity: agent === null ? null : (str(agent.activity) ?? ""),
    lastText: str(agent?.last_text),
    confirmed: agent?.confirmed !== false && state !== "idle?",
    claimed: agent !== null && agent.claimed !== false,
    attention: entries.map((a) => str(a.kind)).filter((k): k is string => k !== null),
    blocked: message("blocked"),
    error: message("error"),
    textTied,
    events: out.events.length,
    harnessEvents: out.events.filter((e) => e.by !== "mu").length,
  };
}

/**
 * What mu has seen set a key's text, kept across reads (one small file per
 * key, beside its read lock): the session and run count the last read left,
 * the last ended turn that named its generation (cursor-agent, muse) and the
 * run it ended in, and the run whose `turn_stopped` carried the text murmur
 * holds now. null: unknown.
 */
export interface TextTurn {
  session: string | null;
  runs: number | null;
  generation: string | null;
  generationRuns: number | null;
  textRuns: number | null;
}

/** A session_start that starts the turns, and the text, over (not a resume or a compact). */
const resets = (e: Doc | undefined): boolean =>
  e?.event === "session_start" && e.source !== "resume" && e.source !== "compact";

/**
 * The text record after one read's applied events, from the one before it.
 * murmur says nothing about which turn wrote `last_text` (it keeps the
 * previous text when a turn ends without one), but every event it applies
 * passes through one read, in order, so mu counts the runs itself: from the
 * last session reset in the batch (run 0), else from the run count the last
 * read left. A `turn_stopped` with text sets the text in its run; one for a
 * generation that already ended (cursor-agent's text after its `stop`, even
 * during the next turn) sets it in the run that generation ended. A count that
 * does not end at the snapshot's (a read whose events never reached mu, a
 * claim murmur reset unseen) ties nothing until the text changes again.
 */
export function textTurnAfter(
  prev: TextTurn | undefined,
  events: readonly Doc[],
  snap: Pick<RemoteSnapshot, "sessionId" | "runCount">,
): TextTurn {
  const unknown: TextTurn = {
    session: snap.sessionId,
    runs: snap.runCount,
    generation: null,
    generationRuns: null,
    textRuns: null,
  };
  if (snap.runCount === null) return unknown;
  let start = events.length - 1;
  while (start >= 0 && !resets(events[start])) start -= 1;
  const batch = events.slice(start + 1);
  const carried = start < 0 && prev !== undefined && prev.session === snap.sessionId;
  // From the last reset the turns and the text start over; without one, from what the last read left.
  let state: TextTurn =
    start >= 0
      ? { ...unknown, session: str(events[start]?.session_id) ?? snap.sessionId }
      : carried
        ? { ...prev }
        : unknown;
  let runs =
    start >= 0
      ? 0
      : carried && prev.runs !== null
        ? prev.runs
        : snap.runCount - batch.filter((e) => e.event === "prompt_submitted").length;
  for (const e of batch) {
    const generation = str(e.generation_id);
    const text = str(e.text);
    switch (e.event) {
      case "session_start":
        // A resume keeps the turns and the text; it may name the session afresh.
        state.session = str(e.session_id) ?? state.session;
        break;
      case "prompt_submitted":
        runs += 1;
        break;
      case "turn_stopped":
        if (generation !== null && generation === state.generation) {
          if (text !== null) state.textRuns = state.generationRuns;
        } else {
          if (generation !== null) {
            state = { ...state, generation, generationRuns: runs, textRuns: null };
          }
          if (text !== null) state.textRuns = runs;
        }
        break;
      case "interrupted":
      case "turn_failed":
        if (generation !== null && generation !== state.generation) {
          state = { ...state, generation, generationRuns: runs };
        }
        break;
    }
  }
  return runs === snap.runCount && state.session === snap.sessionId ? { ...state, runs } : unknown;
}

/** True when the snapshot's text is its last ended turn's own, by the record. */
export function textTied(turn: TextTurn, snap: RemoteSnapshot): boolean {
  return (
    snap.activity === "stopped" &&
    snap.lastText !== null &&
    snap.sessionId !== null &&
    turn.session === snap.sessionId &&
    turn.textRuns === snap.runCount
  );
}

function readTextTurn(path: string): TextTurn | undefined {
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isDoc(doc)) return undefined;
    return {
      session: str(doc.session),
      runs: num(doc.runs),
      generation: str(doc.generation),
      generationRuns: num(doc.generationRuns),
      textRuns: num(doc.textRuns),
    };
  } catch {
    return undefined;
  }
}

/** Best effort: a record that cannot be written ties nothing on the next read. */
function writeTextTurn(path: string, turn: TextTurn): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(turn));
    renameSync(`${path}.tmp`, path);
  } catch {
    rmSync(path, { force: true });
  }
}

/**
 * The events that bring the local pane back in line with its node's snapshot,
 * oldest first; none when they agree. A read whose relay was lost part way
 * (an exec that timed out after murmur applied its events, a relay murmur
 * refused) leaves the local pane behind its node, and no later read relays
 * those events again: without this, a lost `turn_stopped` would leave the
 * pane running for good. The local pane's session and run count are replayed
 * (a `session_start`, one `prompt_submitted` per missing run), then the way
 * the turn stands: ended (mu's `interrupted` for an interrupt no harness
 * confirmed, a `turn_failed` for a new error, else a `turn_stopped` with the
 * node's text), running again, or a dialog open. A corrected text is never
 * tied to its turn by more than ownText's rules: a text the local pane already
 * held reads as an earlier turn's. A released key, an unknown activity word,
 * or a pane murmur does not answer for is left alone.
 */
export function reconcileEvents(local: HooksPane | undefined, snap: RemoteSnapshot): Doc[] {
  if (local === undefined || local.activity === "") return [];
  if (!snap.claimed || snap.sessionId === null || snap.runCount === null) return [];
  if (snap.activity !== "running" && snap.activity !== "stopped") return [];
  const out: Doc[] = [];
  const session = snap.sessionId;
  const add = (event: string, fields: Doc = {}): void => {
    out.push({ event, session_id: session, ...fields });
  };
  let runs = local.runCount ?? 0;
  let activity = local.activity;
  let text = local.lastText;
  let blocked = local.blocked !== null;
  if (
    activity === null ||
    local.sessionId !== session ||
    local.runCount === null ||
    local.runCount > snap.runCount
  ) {
    add("session_start", { source: "startup" });
    runs = 0;
    activity = "stopped";
    text = null;
    blocked = false;
  }
  for (; runs < snap.runCount; runs += 1) {
    add("prompt_submitted");
    activity = "running";
    blocked = false;
  }
  const withText = snap.lastText !== null ? { text: snap.lastText } : {};
  if (snap.activity === "stopped" && activity !== "stopped") {
    if (!snap.confirmed) add("interrupted");
    else if (snap.error !== null && local.error === null)
      add("turn_failed", { message: snap.error });
    else add("turn_stopped", withText);
    blocked = false;
  } else if (snap.activity === "running" && activity !== "running") {
    add("continued");
    blocked = false;
  } else if (snap.activity === "stopped" && snap.lastText !== null && snap.lastText !== text) {
    add("turn_stopped", withText);
    blocked = false;
  }
  if (snap.activity === "running" && snap.blocked !== null && !blocked) {
    add("permission_requested", { message: snap.blocked });
  } else if (snap.activity === "running" && snap.blocked === null && blocked) {
    add("continued");
  }
  return out;
}

/** The event fields murmur's `hook mu` takes, as one applied remote event carried them. */
const RELAYED_FIELDS = ["session_id", "source", "reason", "message", "text", "generation_id"];

/**
 * One applied remote event as `murmur hook mu --pane` takes it: the
 * vocabulary's fields, the harness (the local pane runs none, so murmur needs
 * it named), and the worker's identity as mu knows it. undefined: not an event.
 */
export function relayPayload(event: Doc, agent: RemoteHooksAgent): Doc | undefined {
  const name = str(event.event);
  if (name === null) return undefined;
  const harness = str(event.harness) ?? agent.harness;
  const out: Doc = { event: name, harness };
  for (const field of RELAYED_FIELDS) {
    const v = str(event[field]);
    if (v !== null) out[field] = v;
  }
  out.agent = {
    agent_name: agent.name,
    workstream: agent.workstreamName,
    role: "worker",
    cli: harness,
    driver: "orchestrated",
  };
  return out;
}

/**
 * A file of one key's on this machine (beside the DB, as collect's lock): the
 * lock that serializes its reads (`lock`), and its text record (`turn`).
 */
function keyPath(db: Db, key: string, kind: "lock" | "turn"): string {
  const base = db.memory || db.name === "" ? locksDir() : join(dirname(db.name), "locks");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(base, kind === "lock" ? `remote-read-${hash}.lock` : `remote-turn-${hash}.json`);
}

const firstLine = (s: string): string =>
  s
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

/**
 * One read of `agent`'s node, with its events relayed into the local pane's
 * inbox, then the pane brought in line with the node's snapshot
 * (reconcileEvents). Never throws. Events the node applied that never reached
 * the pane (a relay that failed part way, an exec that timed out after the
 * node applied them) are not relayed again; the next read that succeeds
 * corrects the pane from its snapshot instead.
 */
export async function readRemoteHooks(
  db: Db,
  agent: RemoteHooksAgent,
  write?: Record<string, unknown>,
): Promise<RemoteReadResult> {
  const fail = (reason: string): RemoteReadResult => ({ ok: false, reason });
  return withFileLock(
    keyPath(db, agent.key, "lock"),
    `remote read ${agent.key}`,
    async (): Promise<RemoteReadResult> => {
      let run: Awaited<ReturnType<typeof runHostTemplate>>;
      try {
        run = await runHostTemplate(
          db,
          agent.host,
          "exec",
          `read:${agent.workstreamName}/${agent.name}`,
          { cmd: remotePaneScript(agent.key, write), cwd: "." },
          { paneAlive: localPaneAlive, timeoutMs: HOST_COMMAND_TIMEOUT_MS },
        );
      } catch (e) {
        return fail(`host ${agent.host}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (run.exitCode === null) {
        return fail(`host ${agent.host} timed out after ${HOST_COMMAND_TIMEOUT_MS}ms`);
      }
      if (run.exitCode !== 0) {
        const why = firstLine(run.stderr) || firstLine(run.stdout);
        return fail(
          `murmur pane --remote on ${agent.host} exited ${run.exitCode}${why === "" ? "" : `: ${why}`}`,
        );
      }
      const out = parseRemoteOutput(run.stdout, agent.key);
      if (typeof out === "string") return fail(`host ${agent.host}: ${out}`);
      // The text record counts the node's events, relayed or not: they were applied.
      const turnPath = keyPath(db, agent.key, "turn");
      const plain = remoteSnapshot(out);
      const turn = textTurnAfter(readTextTurn(turnPath), out.events, plain);
      writeTextTurn(turnPath, turn);
      const snapshot = { ...plain, textTied: textTied(turn, plain) };
      let relayed = 0;
      for (const event of out.events) {
        const payload = relayPayload(event, agent);
        if (payload === undefined) continue;
        if (!(await writeMuEvent(agent.paneId, payload))) {
          return fail(
            `murmur hook mu --pane ${agent.paneId} refused a relayed event: ${relayed} of ${out.events.length} relayed (the next read brings the pane back in line)`,
          );
        }
        relayed += 1;
      }
      // What an earlier read lost on the way (applied on the node, never relayed): corrected here.
      const local = await readHooksPane(agent.paneId);
      for (const fix of reconcileEvents(local, snapshot)) {
        const payload = relayPayload({ ...fix, harness: snapshot.harness }, agent);
        if (payload === undefined) continue;
        if (!(await writeMuEvent(agent.paneId, payload))) {
          return fail(
            `murmur hook mu --pane ${agent.paneId} refused a correction: the pane is out of line with its node (${snapshot.state ?? "no state"})`,
          );
        }
      }
      if (write !== undefined && out.written !== "ok") {
        return fail(`murmur hook mu --remote on ${agent.host} did not record mu's event`);
      }
      return { ok: true, snapshot };
    },
    {
      strict: true,
      acquireTimeoutMs: LOCK_WAIT_MS,
      onUnavailable: () => fail("another mu process is reading this worker's node"),
    },
  );
}

/**
 * The reader `channelTarget` attaches to a remote `hooks` row. A successful
 * read is remembered, so a verb that reads twice in a row (the interrupt's
 * gate, then its send's) can reuse it within `maxAgeMs`; a `write` always
 * reads afresh.
 */
export function remoteReader(db: Db, agent: RemoteHooksAgent): RemoteReader {
  let lastOk: { at: number; result: RemoteReadResult } | undefined;
  return {
    host: agent.host,
    key: agent.key,
    read: async (opts = {}) => {
      const maxAge = opts.maxAgeMs ?? 0;
      if (opts.write === undefined && lastOk !== undefined && Date.now() - lastOk.at < maxAge) {
        return lastOk.result;
      }
      const result = await readRemoteHooks(db, agent, opts.write);
      if (result.ok) lastOk = { at: Date.now(), result };
      return result;
    },
  };
}
