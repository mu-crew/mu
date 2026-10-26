// mu — `mu wait`: the one orchestrator wait, over waitForEvents (src/wait.ts).
//
//   mu wait [<ref>...] [--first | --all] [-w ws] [--until-text re] [--status s]
//           [--stuck-after s] [--on-stall exit|warn|steer|release] [--wave w] [--blockers-of t]
//           [--timeout s]
//
// A ref is typed: `task:[ws/]id`, `agent:[ws/]name[@runs][#incarnation]`,
// `delegate:<call id>`. No refs: the wait owns what this caller started (the
// agents it spawned and their tasks, its delegate calls). `mu task wait` is
// the same core over `task:` refs (src/cli/tasks/claim.ts).
//
// `mu wait --resume <id>` continues a wait from its stored condition set (src/wait-resume.ts):
// every result that leaves something to wait for prints that one short handle, so the resume
// is lossless (no ref, incarnation or caller is dropped) whatever the size of the wait.
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
import type {
  StallActionResult,
  WaitRef,
  WaitResult,
  WaitSnapshot,
  WaitStallContext,
} from "../wait.js";
import { releaseStallHandler, steerStallHandler, waitWithActions } from "../wait-actions.js";
import { currentCallers } from "../wait-callers.js";
import { ctlAgentHooks } from "../wait-ctl.js";
import { compileTextMatcher } from "../wait-regex.js";
import { loadResume, type ResumeSpec, saveResume } from "../wait-resume.js";
import { CliExitError, setNextOutcome } from "./handle.js";
import { owedRefs, resumeCommand, waitData } from "./wait-output.js";

/** Heartbeat to stderr every this many ms while a wait is open. */
const HEARTBEAT_MS = 60_000;
/** The default `--timeout` (the engine's heartbeat cap), in seconds. */
export const WAIT_DEFAULT_TIMEOUT_S = 1500;

/** What a wait verb asks of the core, whatever spelling it came in (the stored shape plus the verb's name). */
export interface WaitSpec extends ResumeSpec {
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
    case "exited":
      return `${who}'s command exited with status ${snap?.exit ?? "?"}${snap?.exit === 0 ? "" : " (the exit of this wait)"}; the pane is kept until \`mu agent close\``;
    case "pane-text":
      return `${who}'s pane printed the awaited text (no control socket: this is pane output, not a finished run)`;
    case "input":
      return `${who} is blocked on a dialog${snap?.blocked !== undefined ? ` (${snap.blocked.kind})` : ""}; its run is not finished`;
    case "dead":
      // A task's owner died before it closed: that work is not done. An agent ref says only that it is gone.
      return e.ref?.kind === "task"
        ? `${who} is gone (its owner's pane died); the work is not done`
        : `${who} is gone (its pane died or it was closed)`;
    case "stall":
      return `${who}'s owner needs attention (needs_input past --stuck-after)${
        result.action === undefined
          ? ""
          : `; --on-stall ${result.action.action}: ${result.action.state}${result.action.reason !== undefined ? ` (${result.action.reason})` : ""}`
      }`;
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

/** What a handled stall did, in one stderr line (a sent nudge continues the wait, so the document may never carry it). */
export function stallActionLine(key: string, owner: string, a: StallActionResult): string {
  const what =
    a.state === "sent"
      ? `sent the reminder to ${owner}`
      : a.state === "released"
        ? `released the task from ${owner}`
        : a.state === "unknown"
          ? `unknown whether the ${a.action} reached ${owner} (not repeated)`
          : a.state === "budget-exhausted"
            ? `${a.action} already used for this owner (not repeated)`
            : `${a.action} refused`;
  const tail = a.disposition === "continue" ? "; still waiting" : "";
  return `mu wait: ${key}: --on-stall ${a.action}: ${what}${a.reason !== undefined && a.state !== "sent" ? ` (${a.reason})` : ""}${tail}\n`;
}

/** `handleStall` for --on-stall steer|release: the merged action, plus the stderr line that names what it did. */
function stallHandler(
  db: Db,
  action: "steer" | "release",
  callers: readonly string[],
): (ctx: WaitStallContext) => Promise<StallActionResult> {
  const run =
    action === "steer" ? steerStallHandler(db, { callers }) : releaseStallHandler(db, { callers });
  return async (ctx) => {
    const res = await run(ctx);
    process.stderr.write(
      stallActionLine(`${ctx.ref.workstream}/${ctx.ref.id}`, ctx.owner.name, res),
    );
    return res;
  };
}

/** Run one wait and print its one document. Throws CliExitError(exit) after printing when the exit is not 0. */
export async function runWait(
  db: Db,
  spec: WaitSpec,
  sig: WaitSignals,
  opts: {
    /** A resume runs for the callers the stored wait ran for, not for whoever types it. */
    callers?: readonly string[];
    /** The producer's receipt (`sent`, `claimed`, `warnings`) when a verb entered the wait: see WaitDataInput.extra. */
    extraData?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const callers = opts.callers !== undefined ? [...opts.callers] : currentCallers();
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
    result = await waitWithActions(db, spec.refs, {
      callers,
      mode: spec.mode,
      eventScope: "owned",
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(spec.untilText !== undefined ? { until: { text: spec.untilText } } : {}),
      ...(spec.stuckAfter !== undefined ? { stuckAfterMs: spec.stuckAfter * 1000 } : {}),
      onStall: spec.onStall,
      ...(spec.onStall === "steer" || spec.onStall === "release"
        ? { handleStall: stallHandler(db, spec.onStall, callers) }
        : {}),
      ...(spec.wave !== undefined ? { wave: { name: spec.wave } } : {}),
      ...(spec.blockersOf !== undefined ? { blockersOf: spec.blockersOf } : {}),
      timeoutMs: Math.round(timeoutS * 1000),
      ...(spec.since !== undefined ? { sinceSeq: spec.since } : {}),
      signal: sig.signal,
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
  // The handle: what is still owed, stored; the printed line stays tiny. With no caller there is
  // nothing to discover, so no owed ref (and no wave or blockers) means nothing to resume.
  const owed = owedRefs(result, spec.mode, spec.refs);
  const resumable =
    owed.length > 0 ||
    callers.length > 0 ||
    spec.wave !== undefined ||
    spec.blockersOf !== undefined;
  const resumeId = resumable
    ? saveResume(db, callers, {
        refs: owed,
        mode: spec.mode,
        onStall: spec.onStall,
        ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(spec.untilText !== undefined ? { untilText: spec.untilText } : {}),
        ...(spec.stuckAfter !== undefined ? { stuckAfter: spec.stuckAfter } : {}),
        ...(spec.wave !== undefined ? { wave: spec.wave } : {}),
        ...(spec.blockersOf !== undefined ? { blockersOf: spec.blockersOf } : {}),
        ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
        ...(result.sinceSeq !== undefined ? { since: result.sinceSeq } : {}),
      })
    : null;
  const resume = resumeId === null ? null : resumeCommand(resumeId, spec.scope);
  // A wait that ended with something still owed: `next` is its stored resume.
  if (resumeId !== null && openNow > 0) {
    setNextOutcome({
      kind: "waited",
      resumeId,
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
    });
  }
  const short =
    result.timedOut && spec.timeout !== undefined && spec.timeout > 0 && spec.timeout < 300
      ? `--timeout ${spec.timeout} is below the ${WAIT_DEFAULT_TIMEOUT_S}s default: the wait ended at your deadline, not on an event; run the resume command`
      : undefined;
  emitJson(
    waitData({
      result,
      exit,
      resume,
      ...(resume === null
        ? {
            resumeWhy:
              "everything named was delivered and no caller owns more: nothing left to wait for",
          }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
      reason: reasonOf(result, signal, openNow),
      ...(short !== undefined ? { warning: short } : {}),
      ...(opts.extraData !== undefined ? { extra: opts.extraData } : {}),
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
  resume?: string;
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

/** `--on-stall`: exit, warn, steer or release. */
export function parseOnStall(raw: string | undefined): "exit" | "warn" | "steer" | "release" {
  const v = raw ?? "exit";
  if (v === "exit" || v === "warn" || v === "steer" || v === "release") return v;
  throw new UsageError(
    `--on-stall: expected 'exit', 'warn', 'steer' or 'release', got ${JSON.stringify(v)}`,
    { showHelp: false },
  );
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
  if (o.resume !== undefined) return cmdWaitResume(db, rawRefs, o, sig);
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

/**
 * `mu wait --resume <id>`: the stored wait, whole. Nothing else may be named (a flag or a
 * ref beside the handle would be a second, silently different wait); the callers are the
 * ones the stored wait ran for. `-w` is a guard: it must name the stored scope.
 */
async function cmdWaitResume(
  db: Db,
  rawRefs: readonly string[],
  o: WaitOpts,
  sig: WaitSignals,
): Promise<void> {
  const id = o.resume ?? "";
  const extras = (
    [
      ["refs", rawRefs.length > 0],
      [
        "--first/--all",
        o.first === true || o.firstOf === true || o.all === true || o.allOf === true,
      ],
      ["--until-idle", o.untilIdle === true],
      ["--until-text", o.untilText !== undefined],
      ["--status", o.status !== undefined],
      ["--stuck-after", o.stuckAfter !== undefined],
      ["--on-stall", o.onStall !== undefined],
      ["--wave", o.wave !== undefined],
      ["--blockers-of", o.blockersOf !== undefined],
      ["--timeout", o.timeout !== undefined],
      ["--after-runs/--inc", o.afterRuns !== undefined || o.inc !== undefined],
    ] as const
  )
    .filter(([, given]) => given)
    .map(([name]) => name);
  if (extras.length > 0) {
    throw new UsageError(
      `--resume ${id} replays the stored wait as it was: do not also pass ${extras.join(", ")} (to change the wait, name the refs again without --resume)`,
      { showHelp: false },
    );
  }
  const stored = loadResume(db, id);
  const scope = normalizeInheritedWorkstream(o.workstream);
  if (scope !== undefined && scope !== stored.spec.scope) {
    throw new UsageError(
      `--resume ${id}: -w ${scope} does not match the stored wait (${stored.spec.scope === undefined ? "no workstream" : `-w ${stored.spec.scope}`})`,
      { showHelp: false },
    );
  }
  await runWait(db, { ...stored.spec, verb: "mu wait --resume" }, sig, { callers: stored.callers });
}

export function wireWaitCommand(program: Command): void {
  program
    .command("wait")
    .argument("[refs...]", `typed: ${TYPED_FORMS}; none = what this caller started`)
    .description(
      "Block until the first event you own, then print ONE JSON result: `data.firing`, `exit` (6 owner died, 7 needs you), `snapshots`, `cursor` (what it consumed), `resume`. --all waits for every ref; --wave returns a `tally`.",
    )
    .option("--first", "end on the first event (default)")
    .option("--first-of", "alias for --first")
    .option("--all", "end when every named ref is done (an urgent event still ends it early)")
    .option("--all-of", "alias for --all")
    .option("--until-idle", "a run ending is the event (default for agents)")
    .option(
      "--until-text <regex>",
      "a settled run's final text (or a done task's report) must match: bounded regex, at most 200 chars, no backreferences or lookaround. A pi agent's text is its ctl lastText (never its pane); a non-pi pane has no ctl and no run to settle: its tail is matched and the wait ends as the distinct `pane-text` event (textSource:pane), never `settled`",
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
      "exit (default): a stall ends the wait; warn: flag it (`stuck` on the snapshot) and keep waiting; steer: send the stalled owner ONE fixed reminder (once per task and owner) and keep waiting; release: free the stalled task for another worker and end the wait (`data.action` says what was done). steer and release act only on workers this caller spawned",
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
    .option(
      "--resume <id>",
      "continue the wait a result's `resume` handle names, with every stored condition (refs with their run baseline and pi incarnation, mode, filters, deadline, callers); only -w may be added (it must match the stored scope)",
    )
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
