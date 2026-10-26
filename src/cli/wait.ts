// mu — `mu wait`: the one orchestrator wait, over waitForEvents (src/wait.ts).
//
//   mu wait [<ref>...] [--first | --all] [-w ws] [--until-text re] [--status s]
//           [--stuck-after s] [--on-stall exit|warn] [--wave w] [--blockers-of t]
//           [--timeout s]
//
// A ref is typed: `task:[ws/]id`, `agent:[ws/]name[@runs][#incarnation]`,
// `delegate:<call id>`. No refs: the wait owns what this caller started (the
// agents it spawned and their tasks, its delegate calls). `mu task wait` is
// the same core over `task:` refs (src/cli/tasks/claim.ts).
//
// stdout is ONE JSON envelope for every terminal outcome: an event, a heartbeat
// timeout (ok:true, timedOut), SIGINT/SIGTERM (a final snapshot and a resume
// command), and every error. SIGKILL cannot print and is not promised.
// stderr may carry one heartbeat line a minute. Never ANSI.

import type { Command } from "commander";
import { agentKey } from "../agent-state.js";
import { getAgent } from "../agents.js";
import {
  checkQualifiedPrefix,
  checkWorkstreamName,
  emitJson,
  handle,
  injectedWorkstream,
  JSON_OPT,
  normalizeInheritedWorkstream,
  parseQualifiedRef,
  parseSeconds,
  parseStatusOption,
  resolveWorkstream,
  UsageError,
  WORKSTREAM_OPT,
} from "../cli.js";
import { type Db, tryResolveLiveWorkstreamId } from "../db.js";
import { DelegateNotFoundError, getDelegateCall } from "../delegates.js";
import { reconcile } from "../reconcile.js";
import { TaskNotFoundError } from "../tasks/errors.js";
import { getTask, getTaskOwner } from "../tasks/queries.js";
import { TASK_STATUS_LIST } from "../tasks/status.js";
import { waitSleepOverride } from "../tasks/wait.js";
import { type WaitRef, type WaitResult, type WaitSnapshot, waitForEvents } from "../wait.js";
import { currentCallers } from "../wait-callers.js";
import { ctlAgentHooks } from "../wait-ctl.js";
import { compileTextMatcher } from "../wait-regex.js";
import { CliExitError } from "./handle.js";
import { type WaitConditions, waitData } from "./wait-output.js";

/** Heartbeat to stderr every this many ms while a wait is open. */
const HEARTBEAT_MS = 60_000;
/** The default `--timeout` (the engine's heartbeat cap), in seconds. */
export const WAIT_DEFAULT_TIMEOUT_S = 1500;

/** What a wait verb asks of the core, whatever spelling it came in. */
export interface WaitSpec {
  refs: WaitRef[];
  mode: "first" | "all";
  scope?: string;
  status?: string;
  untilText?: string;
  stuckAfter?: number;
  onStall: "exit" | "warn";
  wave?: string;
  blockersOf?: { workstream: string; id: string };
  /** Seconds, as the caller gave them; absent = the default. */
  timeout?: number;
  /** The words of the verb, for messages. */
  verb: string;
}

// ─── signals: installed before any async setup ─────────────────────

export interface WaitSignals {
  signal: AbortSignal;
  /** `SIGINT` / `SIGTERM` once one arrived. */
  which(): "SIGINT" | "SIGTERM" | undefined;
  dispose(): void;
}

/**
 * Listen for SIGINT and SIGTERM BEFORE the DB is opened or anything is awaited:
 * a signal during setup still ends in an honest snapshot, never a bare kill.
 * The listeners stay until `dispose()` (after the document is out), so a second
 * signal while the result is being written is absorbed, not fatal.
 */
export function installWaitSignals(): WaitSignals {
  const ctl = new AbortController();
  let got: "SIGINT" | "SIGTERM" | undefined;
  const on = (name: "SIGINT" | "SIGTERM") => (): void => {
    got ??= name;
    ctl.abort();
  };
  const onInt = on("SIGINT");
  const onTerm = on("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return {
    signal: ctl.signal,
    which: () => got,
    dispose: () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    },
  };
}

// ─── ref grammar ───────────────────────────────────────────────────

const TYPED_FORMS =
  "task:[<ws>/]<id>, agent:[<ws>/]<name>[@<runs>][#<incarnation>], delegate:<call id>";

/**
 * One typed ref. A bare word is refused (it could be a task or an agent) with the
 * spelling that names it; a typo'd workstream or id is the same error the other
 * verbs give, before anything waits.
 */
export async function parseWaitRef(
  db: Db,
  raw: string,
  scope: string | undefined,
  legacy: { afterRuns?: number; inc?: string } = {},
): Promise<WaitRef> {
  const colon = raw.indexOf(":");
  const kind = colon === -1 ? "" : raw.slice(0, colon);
  if (kind !== "task" && kind !== "agent" && kind !== "delegate") {
    throw new UsageError(
      `ref ${JSON.stringify(raw)} is not typed: use ${TYPED_FORMS}` +
        (raw.includes(":") ? "" : ` (e.g. task:${raw} or agent:${raw})`),
      { showHelp: false },
    );
  }
  let rest = raw.slice(colon + 1);
  if (rest === "")
    throw new UsageError(`ref ${JSON.stringify(raw)} names nothing`, { showHelp: false });
  if (kind === "delegate") {
    const call = getDelegateCall(db, rest);
    if (call === undefined) throw new DelegateNotFoundError(rest);
    return { kind, workstream: call.workstream, id: rest };
  }
  let afterRuns = legacy.afterRuns;
  let incarnation = legacy.inc;
  if (kind === "agent") {
    const hash = rest.indexOf("#");
    if (hash !== -1) {
      incarnation = rest.slice(hash + 1);
      rest = rest.slice(0, hash);
      if (incarnation === "")
        throw new UsageError(`ref ${JSON.stringify(raw)}: empty #incarnation`, { showHelp: false });
    }
    const at = rest.lastIndexOf("@");
    if (at !== -1) {
      const n = rest.slice(at + 1);
      if (!/^\d+$/.test(n)) {
        throw new UsageError(`ref ${JSON.stringify(raw)}: @<runs> must be a whole number`, {
          showHelp: false,
        });
      }
      afterRuns = Number(n);
      rest = rest.slice(0, at);
    }
  }
  const parsed = parseQualifiedRef(rest);
  const workstream =
    parsed.workstream !== undefined
      ? checkQualifiedPrefix(rest, parsed.workstream)
      : await resolveWorkstream(scope);
  if (kind === "task") {
    if (getTask(db, parsed.name, workstream) === undefined) {
      throw new TaskNotFoundError(
        parsed.workstream !== undefined ? rest : parsed.name,
        workstream,
        parsed.name,
      );
    }
    return { kind, workstream, id: parsed.name };
  }
  if (getAgent(db, parsed.name, workstream) === undefined) {
    // The engine raises the typed AgentNotFoundError; say it before any wait starts.
    const { AgentNotFoundError } = await import("../agents/errors.js");
    throw new AgentNotFoundError(parsed.name);
  }
  return {
    kind,
    workstream,
    id: parsed.name,
    ...(afterRuns !== undefined ? { afterRuns } : {}),
    ...(incarnation !== undefined ? { incarnation } : {}),
  };
}

// ─── the run ───────────────────────────────────────────────────────

/** Workstreams with registered agents: the only ones worth a reconcile (no mux touched otherwise). */
function agentWorkstreams(db: Db, among: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const ws of among) {
    const id = tryResolveLiveWorkstreamId(db, ws);
    if (id === null) continue;
    const row = db.prepare("SELECT 1 FROM agents WHERE workstream_id = ? LIMIT 1").get(id);
    if (row !== undefined) out.push(ws);
  }
  return out;
}

/**
 * Prune ghost panes before each poll so a worker that died is seen dead, in every
 * workstream the wait touches (the watched refs', their owners', the scope).
 * Best effort and a no-op without agents: a DB-only wait never needs a mux.
 */
function reconcileHook(
  db: Db,
  spec: WaitSpec,
  refs: () => readonly WaitRef[],
): () => Promise<void> {
  return async () => {
    const among = new Set<string>();
    if (spec.scope !== undefined) among.add(spec.scope);
    for (const r of refs()) {
      among.add(r.workstream);
      if (r.kind === "task") {
        const owner = getTaskOwner(db, r.id, r.workstream);
        if (owner !== undefined) among.add(owner.workstreamName);
      }
    }
    for (const ws of agentWorkstreams(db, among)) {
      try {
        await reconcile(db, { workstream: ws, mode: "full" });
      } catch {
        // A mux hiccup mid-wait: the next poll retries.
      }
    }
  };
}

/** Why the wait ended, in words (the event kind says what; this says which and why). */
function reasonOf(result: WaitResult, signal: string | undefined, open: number): string {
  const e = result.event;
  const snap = result.refs.find(
    (s) =>
      e.ref !== null &&
      s.ref.kind === e.ref.kind &&
      s.ref.workstream === e.ref.workstream &&
      s.ref.id === e.ref.id,
  );
  const who = e.ref === null ? "" : `${e.ref.kind} ${e.ref.workstream}/${e.ref.id}`;
  switch (e.kind) {
    case "closed":
      return `${who} is ${snap?.status ?? "CLOSED"}${snap?.substate !== undefined && snap.substate !== "done" ? `/${snap.substate}` : ""}`;
    case "settled":
      return `${who} finished its run${snap?.runs !== undefined ? ` (run ${snap.runs})` : ""}`;
    case "input":
      return `${who} is blocked on a dialog${snap?.blocked !== undefined ? ` (${snap.blocked.kind})` : ""}; its run is not finished`;
    case "dead":
      return `${who} is gone (its pane died); the work is not done`;
    case "stall":
      return `${who}'s owner needs attention (needs_input past --stuck-after)`;
    case "delegate":
      return `${who} reached ${snap?.status ?? "a final state"}${snap?.verdict ? ` (${snap.verdict})` : ""}`;
    case "interrupted":
      return `${signal ?? "interrupted"}: nothing consumed; ${open} still open`;
    case "heartbeat":
      return result.drained === true
        ? "everything watched is done and was already delivered"
        : `no event before the deadline; ${open} still open`;
    default:
      return e.kind;
  }
}

type Step = { intent: string; command: string };

/** What to do about a task whose owner needs attention: its last answer (pi), then its pane. */
function stuckSteps(snap: WaitSnapshot): Step[] {
  const owner = snap.owner;
  if (owner === null || owner === undefined) return [];
  const ownerWs = snap.ownerWorkstream ?? snap.ref.workstream;
  const out: Step[] = [];
  // A pi owner that settled a run already answered: its final text is one wait away.
  if (snap.ownerRuns !== undefined && snap.ownerRuns >= 1) {
    out.push({
      intent: "Read the worker's last answer (its final text, at once)",
      command: `mu wait agent:${ownerWs}/${owner}@${snap.ownerRuns - 1}`,
    });
  }
  out.push({
    intent: `Read ${owner}'s pane: ${snap.ref.workstream}/${snap.ref.id} is IN_PROGRESS but its owner needs attention`,
    command: `mu agent read ${owner} -w ${ownerWs} --lines 60`,
  });
  return out;
}

/** The few next moves worth printing for an event (the legacy `nextSteps`, until per-verb plans land). */
function nextStepsOf(result: WaitResult, ws: string | undefined): Step[] {
  const e = result.event;
  const out: Step[] = [];
  if (e.ref === null) {
    // A timeout or interrupt: each still-open ref's next look. A stuck one reads the pane,
    // not the task row (the row looks healthy); an open one is a task show.
    for (const s of result.refs) {
      if (s.fired || s.dead || s.ref.kind !== "task") continue;
      if (s.stuck === true) out.push(...stuckSteps(s));
      else
        out.push({
          intent: `Investigate ${s.ref.workstream}/${s.ref.id} (status=${s.status})`,
          command: `mu task show ${s.ref.id} -w ${s.ref.workstream}`,
        });
    }
    return out;
  }
  const snap = result.refs.find(
    (s) =>
      s.ref.kind === e.ref?.kind && s.ref.workstream === e.ref.workstream && s.ref.id === e.ref.id,
  );
  const w = e.ref.workstream;
  if (
    e.kind === "settled" &&
    snap !== undefined &&
    (!snap.lastText || snap.lastError !== undefined)
  ) {
    out.push({ intent: "Read the finished agent", command: `mu agent read ${e.ref.id} -w ${w}` });
  } else if (e.kind === "input") {
    out.push(
      { intent: "Read the dialog pi is waiting on", command: `mu agent read ${e.ref.id} -w ${w}` },
      { intent: "Wait again once it is answered", command: "the `resume` command" },
    );
  } else if (e.kind === "stall" && snap !== undefined) {
    out.push(...stuckSteps(snap));
  } else if (e.kind === "dead") {
    const owner = snap?.owner;
    out.push({
      intent: "See what the dead worker left",
      command:
        e.ref.kind === "task" && owner
          ? `mu agent read ${owner} -w ${snap?.ownerWorkstream ?? w} --lines 60`
          : `mu task show ${e.ref.id} -w ${w}`,
    });
  } else if (e.kind === "delegate") {
    out.push({
      intent: "Read the delegate's answer",
      command: `mu delegates show ${e.ref.id}`,
    });
  } else if (
    e.kind === "closed" &&
    e.ref.kind === "task" &&
    snap?.substate !== undefined &&
    snap.substate !== "done"
  ) {
    // wontfix / duplicate / superseded: nothing to cherry-pick; the notes say what happened instead.
    out.push({
      intent: `Read why ${e.ref.id} closed ${snap.status}/${snap.substate} (no deliverable)`,
      command: `mu task notes ${e.ref.id} -w ${w}`,
    });
  } else if (e.kind === "closed" && ws !== undefined) {
    out.push({ intent: `Pick the next ready task in ${ws}`, command: `mu task next -w ${ws}` });
  }
  return out;
}

/** Run one wait and print its one document. Throws CliExitError(exit) after printing when the exit is not 0. */
export async function runWait(
  db: Db,
  spec: WaitSpec,
  sig: WaitSignals,
  opts: {
    extraNextSteps?: (result: WaitResult) => Promise<{ intent: string; command: string }[]>;
  } = {},
): Promise<void> {
  const callers = currentCallers();
  if (spec.refs.length === 0 && spec.wave === undefined && spec.blockersOf === undefined) {
    if (callers.length === 0) {
      throw new UsageError(
        `${spec.verb}: nothing to wait for. Name refs (${TYPED_FORMS}), or run as a managed agent or a pi session: a wait with no refs owns what that caller started`,
        { showHelp: false },
      );
    }
  }
  if (spec.wave !== undefined && callers.length === 0) {
    throw new UsageError(
      `${spec.verb}: --wave counts delegate calls, which belong to the pi session that issued them; no pi session here (PI_SESSION_ID unset)`,
      { showHelp: false },
    );
  }
  if (spec.untilText !== undefined) {
    try {
      compileTextMatcher(spec.untilText);
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e), {
        showHelp: false,
      });
    }
  }
  const status = spec.status !== undefined ? parseStatusOption(spec.status) : undefined;
  const timeoutS = spec.timeout ?? WAIT_DEFAULT_TIMEOUT_S;
  const conditions: WaitConditions = {
    mode: spec.mode,
    ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(spec.untilText !== undefined ? { untilText: spec.untilText } : {}),
    ...(spec.stuckAfter !== undefined ? { stuckAfter: spec.stuckAfter } : {}),
    ...(spec.onStall !== "exit" ? { onStall: spec.onStall } : {}),
    ...(spec.wave !== undefined ? { wave: spec.wave } : {}),
    ...(spec.blockersOf !== undefined
      ? { blockersOf: `${spec.blockersOf.workstream}/${spec.blockersOf.id}` }
      : {}),
    ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
  };

  let open = 0;
  let last: readonly WaitSnapshot[] = [];
  const warned = new Set<string>();
  const started = Date.now();
  const beat = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    process.stderr.write(
      `mu wait: ${s}s elapsed, ${open} still open (a signal prints the snapshot)\n`,
    );
  }, HEARTBEAT_MS);
  beat.unref();

  let result: WaitResult;
  try {
    result = await waitForEvents(db, spec.refs, {
      callers,
      mode: spec.mode,
      eventScope: "owned",
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(spec.untilText !== undefined ? { until: { text: spec.untilText } } : {}),
      ...(spec.stuckAfter !== undefined ? { stuckAfterMs: spec.stuckAfter * 1000 } : {}),
      onStall: spec.onStall,
      ...(spec.wave !== undefined ? { wave: { name: spec.wave } } : {}),
      ...(spec.blockersOf !== undefined ? { blockersOf: spec.blockersOf } : {}),
      timeoutMs: Math.round(timeoutS * 1000),
      signal: sig.signal,
      ...(waitSleepOverride() !== undefined
        ? { sleep: waitSleepOverride() as (ms: number) => Promise<void> }
        : {}),
      ...ctlAgentHooks(db, { paneText: spec.untilText !== undefined }),
      beforePoll: reconcileHook(db, spec, () =>
        last.length > 0 ? last.map((s) => s.ref) : spec.refs,
      ),
      onPicture: (snaps) => {
        last = snaps;
        open = snaps.filter((s) => !s.fired && !s.dead).length;
        // --on-stall warn: one stderr line per stalled task, then the wait goes on.
        if (spec.onStall !== "warn") return;
        for (const s of snaps) {
          const key = `${s.ref.workstream}/${s.ref.id}`;
          if (s.stuck !== true || warned.has(key)) continue;
          warned.add(key);
          process.stderr.write(
            `mu wait: ${key}: owner ${s.owner ?? "?"} needs attention (${s.stuckWhy ?? "needs_input"} for ${s.stuckSecs ?? 0}s); still waiting (--on-stall warn). Read it: mu agent read ${s.owner ?? "<owner>"} -w ${s.ownerWorkstream ?? s.ref.workstream}\n`,
          );
        }
      },
    });
  } finally {
    clearInterval(beat);
  }

  const signal = sig.which();
  const exit = result.interrupted ? (signal === "SIGTERM" ? 143 : 130) : result.exit;
  const openNow = result.refs.filter((s) => !s.fired && !s.dead).length;
  const extra = opts.extraNextSteps === undefined ? [] : await opts.extraNextSteps(result);
  const nextSteps = [...extra, ...nextStepsOf(result, spec.scope)];
  const short =
    result.timedOut && spec.timeout !== undefined && spec.timeout > 0 && spec.timeout < 300
      ? `--timeout ${spec.timeout} is below the ${WAIT_DEFAULT_TIMEOUT_S}s default: the wait ended at your deadline, not on an event; re-run the resume command`
      : undefined;
  emitJson(
    waitData({
      result,
      exit,
      conditions,
      explicit: spec.refs,
      ...(signal !== undefined ? { signal } : {}),
      reason: reasonOf(result, signal, openNow),
      nextSteps,
      ...(short !== undefined ? { warning: short } : {}),
    }),
  );
  sig.dispose();
  if (exit !== 0) throw new CliExitError(exit);
}

// ─── commander wiring ──────────────────────────────────────────────

interface WaitOpts {
  first?: boolean;
  firstOf?: boolean;
  all?: boolean;
  allOf?: boolean;
  untilIdle?: boolean;
  untilText?: string;
  status?: string;
  stuckAfter?: number;
  onStall?: string;
  wave?: string;
  blockersOf?: string;
  timeout?: number;
  afterRuns?: number;
  inc?: string;
  workstream?: string | string[];
}

/** `--first`/`--first-of` versus `--all`/`--all-of`: one mode, or a usage error (never a silent pick). */
export function waitMode(
  o: Pick<WaitOpts, "first" | "firstOf" | "all" | "allOf"> & { any?: boolean },
): "first" | "all" {
  const first = o.first === true || o.firstOf === true || o.any === true;
  const all = o.all === true || o.allOf === true;
  if (first && all) {
    throw new UsageError("--first and --all are opposites: pass one (first is the default)", {
      showHelp: false,
    });
  }
  return all ? "all" : "first";
}

/** `--on-stall`: exit or warn. steer and release belong to the stall-action units. */
export function parseOnStall(raw: string | undefined): "exit" | "warn" {
  const v = raw ?? "exit";
  if (v === "exit" || v === "warn") return v;
  if (v === "steer" || v === "release") {
    throw new UsageError(
      `--on-stall ${v} is not available in this build (only exit and warn); use exit and handle the stall`,
      { showHelp: false },
    );
  }
  throw new UsageError(`--on-stall: expected 'exit' or 'warn', got ${JSON.stringify(v)}`, {
    showHelp: false,
  });
}

/** `--blockers-of [<ws>/]<task>` as a checked task ref. */
export async function parseBlockersOf(
  db: Db,
  raw: string,
  scope: string | undefined,
): Promise<{ workstream: string; id: string }> {
  const parsed = parseQualifiedRef(raw);
  const workstream =
    parsed.workstream !== undefined
      ? checkQualifiedPrefix(raw, parsed.workstream)
      : await resolveWorkstream(scope);
  if (getTask(db, parsed.name, workstream) === undefined) {
    throw new TaskNotFoundError(
      parsed.workstream !== undefined ? raw : parsed.name,
      workstream,
      parsed.name,
    );
  }
  return { workstream, id: parsed.name };
}

export async function cmdWait(
  db: Db,
  rawRefs: readonly string[],
  o: WaitOpts,
  sig: WaitSignals,
): Promise<void> {
  const mode = waitMode(o);
  if (o.untilIdle === true && o.untilText !== undefined) {
    throw new UsageError("--until-idle and --until-text are two different conditions: pass one", {
      showHelp: false,
    });
  }
  const scope = normalizeInheritedWorkstream(o.workstream);
  if (scope !== undefined) checkWorkstreamName(scope);
  const onStall = parseOnStall(o.onStall);
  const refs: WaitRef[] = [];
  for (const raw of rawRefs) {
    refs.push(await parseWaitRef(db, raw, scope, { afterRuns: o.afterRuns, inc: o.inc }));
  }
  if ((o.afterRuns !== undefined || o.inc !== undefined) && !refs.some((r) => r.kind === "agent")) {
    throw new UsageError("--after-runs / --inc pin an agent ref: name one (agent:<name>)", {
      showHelp: false,
    });
  }
  const spec: WaitSpec = {
    refs,
    mode,
    onStall,
    verb: "mu wait",
    ...(scope !== undefined ? { scope } : {}),
    ...(o.status !== undefined ? { status: o.status } : {}),
    ...(o.untilText !== undefined ? { untilText: o.untilText } : {}),
    ...(o.stuckAfter !== undefined ? { stuckAfter: o.stuckAfter } : {}),
    ...(o.wave !== undefined ? { wave: o.wave } : {}),
    ...(o.blockersOf !== undefined
      ? { blockersOf: await parseBlockersOf(db, o.blockersOf, scope) }
      : {}),
    ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
  };
  await runWait(db, spec, sig);
}

export function wireWaitCommand(program: Command): void {
  program
    .command("wait [refs...]")
    .description(
      [
        "Block until the first event you own, then print ONE JSON result (always JSON; `data.firing`, `data.exit`, `data.snapshots`, `data.resume`).",
        `Refs are typed: ${TYPED_FORMS}. No refs: the wait owns what this caller started (agents it spawned and their tasks, its delegate calls).`,
        "An event is a task closing, an owner dying (exit 6), an agent finishing its run, a dialog or stall needing you (exit 7), a delegate answer, or the heartbeat cap (--timeout, default 1500 s; ok:true with timedOut, exit 0). SIGINT/SIGTERM print the final snapshot and `resume` (exit 130/143); SIGKILL cannot.",
        "Delegate answers (`mu_delegate`) arrive here: your delegate calls end the wait as `delegate` events, and `--wave <name>` waits on a wave and returns `data.tally` (`6/12 CONFIRMED, ...`) instead of N follow-ups.",
        "Read `data.firing.kind` and `data.exit`; to keep waiting run `data.resume`. First event is the default; --all waits for every ref. Parse it: `mu wait task:a task:b | jq -r .data.firing.ref`.",
      ].join(" "),
    )
    .option("--first", "end on the first event (default)")
    .option("--first-of", "alias for --first")
    .option("--all", "end when every named ref is done (an urgent event still ends it early)")
    .option("--all-of", "alias for --all")
    .option("--until-idle", "a run ending is the event (default for agents)")
    .option(
      "--until-text <regex>",
      "a settled run's final text (or a done task's report) must match: bounded regex, at most 200 chars, no backreferences or lookaround. A pi agent's text is its ctl lastText (never its pane); a non-pi pane has no ctl, so its tail is the text (snapshot textSource:pane)",
    )
    .option(
      "--status <status>",
      `a task counts at this status (${TASK_STATUS_LIST}, case-insensitive); default CLOSED`,
    )
    .option(
      "--stuck-after <seconds>",
      "report an owner stalled after this long in needs_input (0 = never; default 120, or 5 for a pi owner read over ctl); the stall is an event with exit 7",
      parseSeconds,
    )
    .option(
      "--on-stall <action>",
      "exit (default): a stall ends the wait; warn: flag it (`stuck` on the snapshot) and keep waiting",
    )
    .option(
      "--wave <name>",
      "wait on this caller's delegate calls of the wave; the result carries `data.tally`",
    )
    .option(
      "--blockers-of <task>",
      "wait on every open transitive blocker of this task, re-read each poll",
    )
    .option(
      "--timeout <seconds>",
      `heartbeat deadline, fractions allowed (default ${WAIT_DEFAULT_TIMEOUT_S}, which is also the cap; 0 = the cap)`,
      parseSeconds,
    )
    .option(
      "--after-runs <n>",
      "agent refs: count runs past N (what `mu agent send --json` printed)",
      (v) => {
        if (!/^\d+$/.test(v))
          throw new UsageError(`--after-runs: expected a whole number, got ${JSON.stringify(v)}`, {
            showHelp: false,
          });
        return Number(v);
      },
    )
    .option("--inc <incarnation>", "agent refs: pin the pi process; another one is refused")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (refs: string[]) {
      const opts = (this as Command).optsWithGlobals() as WaitOpts;
      // Listen before anything is awaited (the DB open included).
      const sig = installWaitSignals();
      const run = handle((db) => cmdWait(db, refs, opts, sig), this as Command);
      return run().finally(() => sig.dispose());
    });
}

// `agentKey` is re-exported for the alias in tasks/claim.ts (one key spelling).
export { agentKey, injectedWorkstream };
