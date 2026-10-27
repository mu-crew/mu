// mu — `computeNext`: the ONE rule set behind every `next` (slice A of v_hints).
//
// A result's `next` (src/output-contract.ts `NextPlan`) is computed here, over
// current state plus what the verb that just ran did (`NextOutcome`), and
// nowhere else. The dashboard asks the same function with no outcome.
//
// Contract (docs/mu-next/README.md "Next contract"):
//   - READ-ONLY. It reads SQLite (and, through `expectsCtl`, whether a control
//     socket file exists). It never waits, registers, reaps, ingests, spawns or
//     runs what it suggests; it never consumes a cursor.
//   - Only state-advancing moves that are already authorised: the exact wait a
//     send owes, the stored resume of a wait, the apply of a preview (fenced
//     with `--if <rev>`), the brief a `claim --for` owes, `mu next` over tasks
//     the orchestrator authorised HERE, and the bare wait over refs the
//     callers already own. Reads (show/notes/list/read/log/check-by-guess) are
//     never suggested. Usually the plan is null.
//   - A move mu cannot fill is omitted: no `<…>`, `...`, `a|b`, no guessed flag
//     (`agent check` has no `--inc`, so an unknown delivery is suggested only
//     while the registry row the send went to is still the one registered).
//   - Never a resend. A refused delegate call is reissued by the pi tool
//     `mu_delegate_reissue`, not a shell, so it is never in `next`.
//   - Executable as printed: every command is an argv rendered word by word
//     with `shellWord` (POSIX single quotes). Safe moves rank before
//     destructive ones; a destructive move without `--if` is refused here.
//   - `seq` is never truncated: `capPlan` drops a too-big seq whole, and cuts
//     an `alt` from its tail.

import { expectsCtl } from "./agents/transport.js";
import { getAgent } from "./agents.js";
import { pendingAttempts } from "./auto-attempt.js";
import type { Db } from "./db.js";
import { openHumanNeeds } from "./human-needed.js";
import type { NextPlan } from "./output-contract.js";
import { shellWord } from "./shell-quote.js";
import { authorisedReady } from "./task-auto.js";
import { readWaitRegistration } from "./wait-registration.js";
import { isScratchWorkstream } from "./workstream.js";

/** An agent as a hint names it: its workstream and name. */
export interface NextAgent {
  workstream: string;
  name: string;
}

/** What the verb that just ran did, as far as a follow-up depends on it. */
export type NextOutcome =
  /** A delivered send (also `spawn --send`/`--task`, `--fresh`, `--interrupt`): the baseline the SEND measured. */
  | { kind: "sent"; agent: NextAgent; runs?: number; incarnation?: string }
  /** A send written but unconfirmed: `msgId` and the registry id (`AgentRow.incarnation`) it went to. */
  | { kind: "send-unknown"; agent: NextAgent; msgId: string; agentId: number }
  /** A remote command gate spawned: its wait returns the command's exit. */
  | { kind: "gate-spawned"; agent: NextAgent }
  /** `task claim --for`: the owner still has to be sent the task. `muxCanSend: false` (tmux):
   *  a non-pi owner cannot be sent anything, so no send is offered. */
  | {
      kind: "claimed-for";
      task: { workstream: string; id: string };
      owner: NextAgent;
      muxCanSend?: boolean;
    }
  /** A destructive preview: `apply` is the verb's argv (from `mu`), `revision` its fence. */
  | { kind: "preview"; apply: readonly string[]; revision: number }
  /** A wait ended with something still owed: its stored handle. */
  | { kind: "waited"; resumeId: string | null; scope?: string };

export interface NextContext {
  /** `currentCallers()`: the managed `<ws>/<agent>` and `pi:<session>`. Empty = no owned work. */
  callers: readonly string[];
  /** The resolved scope of the call, when it has one. */
  workstream?: string;
  outcome?: NextOutcome;
  /**
   * Whether the verb that just ran registered owed work (`armWait`). The CLI passes it, so
   * the bare wait follows only a command that created something to wait for; a read or an
   * unrelated write is not followed by it. Absent (the dashboard, no verb): any owed ref counts.
   */
  armed?: boolean;
}

/** One move: the argv as typed (`mu` first). Destructive moves must carry `--if`. */
export interface HintMove {
  argv: readonly string[];
  destructive?: boolean;
}

/** A destructive move without its revision fence. */
export class UnguardedMoveError extends Error {
  override readonly name = "UnguardedMoveError";
}

/** The `next` byte budget, a share of the 4 KB result (`RESULT_BYTES`). */
export const NEXT_BYTES = 1024;

/** The most alternatives one plan offers. */
export const MAX_ALTERNATIVES = 3;

/** The prompt that hands a claimed task to its owner. Message text (v_hint_messages owns the wording). */
export function dispatchPrompt(task: { workstream: string; id: string }): string {
  return `Claim done: work on ${task.id}. Read: mu task notes ${task.id} -w ${task.workstream}`;
}

/** `agent:<ws>/<name>[@<runs>][#<incarnation>]`: the typed ref a wait takes. */
export function agentRefOf(
  agent: { name: string; workstreamName: string },
  runs?: number,
  incarnation?: string,
): string {
  return `agent:${agent.workstreamName}/${agent.name}${runs === undefined ? "" : `@${runs}`}${incarnation === undefined ? "" : `#${incarnation}`}`;
}

/** The one resume of a stored wait handle (`mu wait --resume <id>`), as argv. */
export function resumeArgv(id: string, scope?: string): string[] {
  return ["mu", "wait", "--resume", id, ...(scope === undefined ? [] : ["-w", scope])];
}

/** One command line, each word POSIX-quoted only when it needs it. */
export function renderArgv(argv: readonly string[]): string {
  if (argv[0] !== "mu") throw new Error(`a next move starts with mu (got ${argv[0] ?? "nothing"})`);
  return argv.map(shellWord).join(" ");
}

/**
 * The plan for `moves` in order: safe moves first (stable), duplicates dropped, at most
 * MAX_ALTERNATIVES for `alt`. A `seq` is kept whole. null for no moves.
 */
export function renderPlan(mode: "seq" | "alt", moves: readonly HintMove[]): NextPlan {
  for (const m of moves) {
    if (m.destructive === true && !m.argv.includes("--if")) {
      throw new UnguardedMoveError(`destructive move without --if: ${m.argv.join(" ")}`);
    }
  }
  const ordered = mode === "seq" ? moves : [...moves].sort((a, b) => rank(a) - rank(b));
  const commands = [...new Set(ordered.map((m) => renderArgv(m.argv)))];
  const kept = mode === "alt" ? commands.slice(0, MAX_ALTERNATIVES) : commands;
  return kept.length === 0 ? null : { mode, commands: kept };
}

const rank = (m: HintMove): number => (m.destructive === true ? 1 : 0);

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Fit a plan into `bytes` (its JSON encoding). A `seq` that does not fit is dropped WHOLE
 * (never a partial sequence); an `alt` loses alternatives from its tail. `cut` counts the
 * commands left out.
 */
export function capPlan(plan: NextPlan, bytes = NEXT_BYTES): { next: NextPlan; cut: number } {
  if (plan === null || utf8(JSON.stringify(plan)) <= bytes) return { next: plan, cut: 0 };
  if (plan.mode === "seq") return { next: null, cut: plan.commands.length };
  const commands = [...plan.commands];
  while (commands.length > 0 && utf8(JSON.stringify({ mode: "alt", commands })) > bytes) {
    commands.pop();
  }
  const cut = plan.commands.length - commands.length;
  return { next: commands.length === 0 ? null : { mode: "alt", commands }, cut };
}

/** The follow-up of what the verb did: at most one move, none when mu cannot fill it. */
function outcomeMove(db: Db, o: NextOutcome): HintMove | undefined {
  switch (o.kind) {
    case "sent":
      if (o.runs === undefined) return undefined; // a mux send or a slash command started no fenced run
      return {
        argv: ["mu", "wait", agentRefOf(agentLike(o.agent), o.runs, o.incarnation)],
      };
    case "send-unknown": {
      // The receipt route, never a resend. `agent check` probes the name's CURRENT socket and has
      // no incarnation flag, so it is offered only while the row the send went to is still there.
      const row = getAgent(db, o.agent.name, o.agent.workstream);
      if (row === undefined || row.incarnation !== o.agentId) return undefined;
      return {
        argv: ["mu", "agent", "check", o.agent.name, o.msgId, "-w", o.agent.workstream, "--json"],
      };
    }
    case "gate-spawned":
      return { argv: ["mu", "wait", agentRefOf(agentLike(o.agent))] };
    case "claimed-for": {
      const owner = getAgent(db, o.owner.name, o.owner.workstream);
      if (owner === undefined) return undefined;
      const ctl = expectsCtl(owner);
      if (!ctl && o.muxCanSend === false) return undefined;
      const fresh = ctl ? ["--fresh"] : [];
      return {
        argv: [
          "mu",
          "agent",
          "send",
          owner.name,
          ...fresh,
          dispatchPrompt(o.task),
          "-w",
          owner.workstreamName,
        ],
      };
    }
    case "preview":
      return { argv: [...o.apply, "--if", String(o.revision)], destructive: true };
    case "waited":
      if (o.resumeId === null) return undefined;
      return { argv: resumeArgv(o.resumeId, o.scope) };
  }
}

const agentLike = (a: NextAgent) => ({ name: a.name, workstreamName: a.workstream });

/** Authorised work this machine's executor would act on now (stored attempts or ready auto tasks). */
function executorMove(db: Db, ws: string): HintMove | undefined {
  if (isScratchWorkstream(ws)) return undefined;
  if (pendingAttempts(db, ws).length === 0 && authorisedReady(db, ws).length === 0) {
    return undefined;
  }
  return { argv: ["mu", "next", "-w", ws] };
}

/** The callers own registered refs (in `ws` when scoped): the bare wait picks them up. */
function ownedWaitMove(db: Db, callers: readonly string[], ws?: string): HintMove | undefined {
  const owes = callers.some((c) =>
    (readWaitRegistration(db, c)?.refs ?? []).some((r) => ws === undefined || r.workstream === ws),
  );
  if (!owes) return undefined;
  return { argv: ws === undefined ? ["mu", "wait"] : ["mu", "wait", "-w", ws] };
}

/** A course check is due after this many CLOSED/done work tasks since the last one... */
export const COURSE_CHECK_CLOSED = 10;
/** ...or this long since it (with at least one closed since). Constants: no flag, no env. */
export const COURSE_CHECK_AGE_MS = 24 * 3600_000;

/**
 * The course-correct trigger (skills/mu/recipes/course-correct.md), read from
 * state, never remembered: since the newest note of `ws` starting `COURSE CHECK` (none: the
 * workstream's creation), count the CLOSED/done work tasks by their close note's time (a later
 * note does not move it). One line when due, else undefined.
 * Read-only; one query.
 */
export function courseCheckHint(db: Db, ws: string, now = Date.now()): string | undefined {
  const row = db
    .prepare(
      `WITH w AS (SELECT id, created_at FROM workstreams WHERE name = ? AND torn_down_at IS NULL),
            a AS (SELECT COALESCE(
              (SELECT MAX(n.created_at) FROM task_notes n JOIN tasks t ON t.id = n.task_id
                WHERE t.workstream_id = w.id AND n.content LIKE 'COURSE CHECK%'),
              w.created_at) AS since, w.id AS wid FROM w)
       SELECT a.since AS since,
              (SELECT COUNT(*) FROM tasks t WHERE t.workstream_id = a.wid AND t.status = 'CLOSED'
                  AND t.substate = 'done' AND t.kind = 'work' AND (SELECT MAX(c.created_at)
                    FROM task_notes c WHERE c.task_id = t.id AND c.kind = 'close') > a.since) AS closed
         FROM a`,
    )
    .get(ws) as { since: string; closed: number } | undefined;
  if (row === undefined || row.closed === 0) return undefined;
  const old = now - Date.parse(row.since) >= COURSE_CHECK_AGE_MS;
  if (row.closed < COURSE_CHECK_CLOSED && !old) return undefined;
  return `course check due: ${row.closed} closed since ${row.since.slice(0, 16)}Z (recipes/course-correct.md)`;
}

/**
 * The `next` of a result: the outcome's own follow-up first, then (unless a caller has an
 * open human need, which stops everything it would start) `mu next` over authorised work and
 * the bare wait over owned refs (only after a verb that armed one), as alternatives. A preview's apply ranks last. Read-only.
 */
export function computeNext(db: Db, ctx: NextContext): NextPlan {
  const moves: HintMove[] = [];
  const own = ctx.outcome === undefined ? undefined : outcomeMove(db, ctx.outcome);
  if (own !== undefined) moves.push(own);
  const stopped = ctx.callers.some((c) => openHumanNeeds(db, c).length > 0);
  if (!stopped && ctx.outcome?.kind !== "preview") {
    const exec = ctx.workstream === undefined ? undefined : executorMove(db, ctx.workstream);
    if (exec !== undefined) moves.push(exec);
    // The bare wait is redundant beside a more exact wait.
    if (ctx.armed !== false && (own === undefined || own.argv[1] !== "wait")) {
      const wait = ownedWaitMove(db, ctx.callers, ctx.workstream);
      if (wait !== undefined) moves.push(wait);
    }
  }
  return capPlan(renderPlan("alt", moves)).next;
}

/**
 * The one-line notices of a result, beside its `next` (they are not commands): today only
 * `courseCheckHint` for the call's workstream. The output finalisation (`mu state`, `mu wait`)
 * prints them; empty when nothing is due. Read-only.
 */
export function computeNotices(db: Db, ctx: NextContext, now = Date.now()): string[] {
  const hint =
    ctx.workstream === undefined || isScratchWorkstream(ctx.workstream)
      ? undefined
      : courseCheckHint(db, ctx.workstream, now);
  return hint === undefined ? [] : [hint];
}
