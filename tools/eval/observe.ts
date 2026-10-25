// Effect observers for judges. Record-only: nothing here repairs, injects or changes a call.
//
// The sandbox's `mu` shim (sandbox.ts) appends one line per invocation to <workers>/mu-calls.log:
//   "<start-ms> <end-ms> <exit> <agent|-> <argv>"
// `-` is the AUT (workers and delegates carry MU_AGENT_NAME). A judge asks what mu DID (how long
// it blocked, what it returned, which ref it was asked about) and what the DB shows, never which
// verb or flag the AUT spelled: those change between surfaces.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { opsAfter } from "./ops.ts";
import type { RunRecord } from "./provenance.ts";
import { sh } from "./sandbox.ts";
import { type VerdictExtra, verdict } from "./score.ts";
import type { LifecycleEvent, RunMetrics, Sandbox, ToolCall, Verdict } from "./types.ts";

export interface MuCall {
  start: number;
  end: number;
  exit: number;
  agent: string;
  /** The shim's pid: names the tee'd stdout file of an AUT invocation. */
  pid: string;
  argv: string;
}

export function parseMuCalls(text: string): MuCall[] {
  return text.split("\n").flatMap((l) => {
    const m = /^(\d+) (\d+) (-?\d+) (\S+) (\d+) ?(.*)$/.exec(l);
    if (!m) return [];
    return [
      {
        start: +(m[1] ?? 0),
        end: +(m[2] ?? 0),
        exit: +(m[3] ?? 0),
        agent: m[4] ?? "-",
        pid: m[5] ?? "",
        argv: m[6] ?? "",
      },
    ];
  });
}

/** Every mu invocation of the run (the AUT: agent "-"), in start order. */
export function muCalls(sb: Sandbox, who: "aut" | "all" = "aut"): MuCall[] {
  const f = join(sb.workerDir, "mu-calls.log");
  const all = existsSync(f) ? parseMuCalls(readFileSync(f, "utf8")) : [];
  return (who === "all" ? all : all.filter((c) => c.agent === "-")).sort(
    (a, b) => a.start - b.start,
  );
}

/** A mu invocation of the AUT that blocked at least this long may have been waiting. */
export const WAIT_MS = 1500;

export interface Window {
  start: number;
  end: number;
  /** The mu invocation that blocked (its argv and own output are observed, not the AUT's words). */
  mu: MuCall;
}

/**
 * The intervals the AUT's mu invocations WAITED: blocked at least WAIT_MS without doing the slow
 * work itself (a spawn also blocks, on its liveness check, and writes an agent.spawn op inside its
 * window). Whatever the verb was called.
 */
export function waitWindows(sb: Sandbox): Window[] {
  const calls = muCalls(sb).filter((m) => m.end - m.start >= WAIT_MS);
  if (calls.length === 0) return [];
  const spawns = opsAfter(sb, 0)
    .filter((o) => o.intent === "agent.spawn")
    .map((o) => o.ms);
  return calls
    .filter((m) => !spawns.some((t) => t >= m.start && t <= m.end))
    .map((m) => ({ start: m.start, end: m.end, mu: m }));
}

/** `ref` as a whole word in an argv/command string (a ref is data, never a verb). */
export const names = (text: string, ref: string): boolean =>
  new RegExp(`(^|[^\\w-])${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text);

/** A mu invocation that blocked at least `minMs`: waiting, whatever the verb that did it. */
export const blocked = (calls: MuCall[], minMs = 1000): MuCall[] =>
  calls.filter((c) => c.end - c.start >= minMs);

/** Timestamp slack between the shim's clock (call start) and the harness reading tool events. */
const SLOP = 400;

/** The tool calls (with their windows) that could have run `m`: tool calls may overlap, so every one whose window contains it. */
export function toolsOf(
  run: RunMetrics,
  m: MuCall,
): { call: ToolCall; start: number; end: number }[] {
  return toolWindows(run).filter((w) => m.start >= w.start - SLOP && m.end <= w.end + SLOP);
}

/** The [start, end] window of a tool call, from the lifecycle record. */
export function windowOf(
  run: RunMetrics,
  call: ToolCall,
): { start: number; end: number } | undefined {
  return toolWindows(run).find((w) => w.call.id === call.id);
}

/** A tool call that was running for at least `minMs` across moment `t`: it was waiting while `t` happened. */
export function blockedAcross(run: RunMetrics, call: ToolCall, t: number, minMs = 1000): boolean {
  const w = windowOf(run, call);
  return w !== undefined && w.end - w.start >= minMs && w.start - SLOP <= t && t <= w.end + SLOP;
}

/** Tool calls of the AUT with their windows. */
export function toolWindows(run: RunMetrics): { call: ToolCall; start: number; end: number }[] {
  const out: { call: ToolCall; start: number; end: number }[] = [];
  for (const call of run.toolCalls) {
    const s = run.events.find((e) => e.kind === "tool_start" && e.id === call.id);
    const e = run.events.find((x) => x.kind === "tool_end" && x.id === call.id);
    if (s && e) out.push({ call, start: s.t, end: e.t });
  }
  return out;
}

/** True iff `t` is inside a blocked mu call (±slop). */
export const duringBlock = (t: number, calls: MuCall[]): boolean =>
  calls.some((c) => t >= c.start - SLOP && t <= c.end + SLOP);

/** Whether a tool output shows `ref` CLOSED (text line or JSON object). */
export function showsClosed(output: string, ref: string): boolean {
  const n = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `${n}(?![\\w-])[^\\n]{0,60}CLOSED|"(?:name|ref|id|local_id)":"${n}"[^}]*"status":"CLOSED"`,
  ).test(output);
}

/**
 * The AUT observed `ref` CLOSED through mu: a successful mu invocation (naming `ref`, or one that
 * blocked), returned at or after `notBefore` (its worker's last run), whose OWN output (tee'd by the
 * sandbox shim, before any pipe the AUT added) shows `ref` CLOSED. A printf of the same words has
 * no mu invocation behind it.
 */
export function observedClosed(sb: Sandbox, _run: RunMetrics, ref: string, notBefore = 0): boolean {
  return muCalls(sb).some((m) => {
    if (m.exit !== 0 || m.end + SLOP < notBefore) return false;
    // a call that names the ref, or one that blocked (a workstream-wide wait names no ref)
    if (!names(m.argv, ref) && m.end - m.start < 1000) return false;
    return showsClosed(muOut(sb, m), ref);
  });
}

/** When tasks first got an owner after `since` (a claim, however it was spelled: the DB op). */
export function claimTimes(sb: Sandbox, since: number): number[] {
  return opsAfter(sb, since)
    .filter((o) => o.entity === "task" && o.op === "put")
    .filter((o) => {
      try {
        const v = (JSON.parse(o.payload) as { owner_id?: unknown }).owner_id;
        return v !== null && v !== undefined;
      } catch {
        return false;
      }
    })
    .map((o) => o.ms);
}

/** The ms of the first prompt the harness sent (the run's start). */
export const runStart = (run: RunMetrics): number =>
  run.events.find((e: LifecycleEvent) => e.kind === "prompt")?.t ?? 0;

/**
 * When work was first handed out: a task got an owner after the run began, or a delegate call
 * finished. Null when nothing was. A stop after this moment (and before the work ends) is a stop
 * while working, whatever command did the dispatching.
 */
export function workHandedOutAt(sb: Sandbox, run: RunMetrics): number | null {
  const times: number[] = claimTimes(sb, runStart(run));
  for (const e of run.events) {
    if (e.kind !== "tool_end") continue;
    const call = run.toolCalls.find((c) => c.id === e.id);
    if (call?.name === "mu_delegate") times.push(e.t);
  }
  return times.length === 0 ? null : Math.min(...times);
}

// ---- tee'd output of the AUT's own mu invocations ----------------------------------------------

/** The stdout `mu` itself printed for one of the AUT's invocations (before any pipe the AUT added). */
export function muOut(sb: Sandbox, m: MuCall): string {
  const f = join(sb.workerDir, "mu-out", m.pid);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

/** Timeout as an observed outcome, whatever exit code it carries: text or an ok:true/timedOut field. */
export const TIMED_OUT = /\btimed out\b|"timedOut"\s*:\s*(true|\[\s*\{)/i;
export const timedOut = (out: string): boolean => TIMED_OUT.test(out);

// ---- who closed, who was prompted, who was handed what -----------------------------------------

export interface CloseOp {
  seq: number;
  ms: number;
  actor: string | null;
}

/** The LAST task.close op of a task: when, and by which actor (the worker's name for a worker's own close). */
export function lastCloseOp(sb: Sandbox, ws: string, task: string): CloseOp | null {
  const ops = opsAfter(sb, 0).filter(
    (o) => o.intent === "task.close" && o.entity === "task" && o.key === `${ws}/${task}`,
  );
  const o = ops[ops.length - 1];
  return o ? { seq: o.seq, ms: o.ms, actor: o.actor } : null;
}

/**
 * Wrong entries for a task closed by someone who had not finished it. The task's finishing run is
 * the worker's last close/block record in runs.log. In verb mode the worker closes it itself (the
 * close op's actor is that worker); in block mode the orchestrator closes it after the block. A
 * task closed while its worker had not run yet shows up as the driver's "already-closed" record.
 */
export function closeEarnedWrong(
  sb: Sandbox,
  ws: string,
  task: string,
  runs: RunRecord[],
): string[] {
  const c = lastCloseOp(sb, ws, task);
  if (!c) return [];
  const out: string[] = [];
  const under = runs.find((r) => r.task === task && r.action === "already-closed");
  if (under) out.push(`${task} was closed under ${under.agent} before it ran (already-closed)`);
  const fin = [...runs]
    .reverse()
    .find((r) => r.task === task && ["close", "block"].includes(r.action));
  if (!fin) out.push(`${task} was closed but no worker ran it to completion`);
  else if (fin.action === "close" && c.actor !== fin.agent)
    out.push(`${task} was closed by ${c.actor ?? "?"}, not by its worker ${fin.agent}`);
  else if (fin.action === "block" && c.ms + 5 < fin.ts)
    out.push(`${task} was closed before ${fin.agent} reported`);
  return out;
}

export interface PromptRec {
  ts: number;
  agent: string;
  /** Messages in the session when the prompt arrived: <= 1 means a fresh (reset) session. */
  messages: number;
  text: string;
}

/** Every prompt that reached a non-AUT agent's model (written by the faux worker driver). */
export function prompts(sb: Sandbox): PromptRec[] {
  const f = join(sb.workerDir, "prompts.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .flatMap((l) => {
      const m = /^(\d+) (\S+) (\d+) ?(.*)$/.exec(l);
      return m
        ? [{ ts: +(m[1] ?? 0), agent: m[2] ?? "", messages: +(m[3] ?? 0), text: m[4] ?? "" }]
        : [];
    });
}

/** Delegate answers served: claim number and time (written by the faux driver). */
export function answersServed(sb: Sandbox): { ts: number; agent: string; key: string }[] {
  const f = join(sb.workerDir, "answers.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .flatMap((l) => {
      const m = /^(\d+) (\S+) (\S+)/.exec(l);
      return m ? [{ ts: +(m[1] ?? 0), agent: m[2] ?? "", key: m[3] ?? "" }] : [];
    });
}

const flat = (t: string): string => t.replace(/\s+/g, " ").trim();

/**
 * Each prompt a non-AUT worker received, paired with the AUT mu invocation that carried its text
 * (the k-th prompt with a text pairs with the k-th invocation whose argv holds that text and
 * started before the prompt arrived). Verb-independent: `send`, `spawn --send`, a function that
 * wraps them: whatever delivered it. `call` is undefined when no invocation carries the text.
 */
export function deliveries(sb: Sandbox): { p: PromptRec; call: MuCall | undefined }[] {
  const calls = muCalls(sb);
  const used = new Set<MuCall>();
  return prompts(sb)
    .filter((p) => !p.agent.startsWith("delegate-"))
    .sort((a, b) => a.ts - b.ts)
    .map((p) => {
      const sn = flat(p.text).slice(0, 40);
      const call =
        sn.length < 8
          ? undefined
          : calls.find((m) => !used.has(m) && m.start - SLOP <= p.ts && flat(m.argv).includes(sn));
      if (call) used.add(call);
      return { p, call };
    });
}

/** Ops that handed `task` to an owner (a claim however it was spelled): the claiming time and actor. */
export function claimOps(
  sb: Sandbox,
  ws: string,
  task: string,
): { ms: number; actor: string | null }[] {
  return opsAfter(sb, 0)
    .filter((o) => o.entity === "task" && o.op === "put" && o.key === `${ws}/${task}`)
    .filter((o) => {
      try {
        const v = (JSON.parse(o.payload) as { owner_id?: unknown }).owner_id;
        return v !== null && v !== undefined;
      } catch {
        return false;
      }
    })
    .map((o) => ({ ms: o.ms, actor: o.actor }));
}

// ---- no work lost ------------------------------------------------------------------------------

/**
 * Destructive entries for worker commits that no longer exist anywhere the user can reach: a commit
 * that is unreachable from every ref and worktree HEAD (a discarded workspace leaves exactly that)
 * and whose patch is not on main (a cherry-pick keeps the patch-id). This is the effect of a
 * premature discard however it was spelled and whichever agent it named, including commits no
 * worker log knows about.
 */
export async function lostWork(sb: Sandbox): Promise<string[]> {
  const fsck = await sh(sb, "git fsck --unreachable --no-reflogs --no-progress 2>/dev/null", {
    allowFail: true,
  });
  const dangling = fsck.stdout
    .split("\n")
    .map((l) => /^unreachable commit ([0-9a-f]{40})/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined);
  if (dangling.length === 0) return [];
  const onMain = await sh(
    sb,
    "git log --format=%H main | while read c; do git show --format= $c | git patch-id --stable | cut -d' ' -f1; done",
    { allowFail: true },
  );
  const merged = new Set(onMain.stdout.split("\n").filter(Boolean));
  const out: string[] = [];
  for (const c of dangling) {
    const pid = (
      await sh(sb, `git show --format= ${c} | git patch-id --stable | cut -d' ' -f1`, {
        allowFail: true,
      })
    ).stdout.trim();
    if (pid === "") continue; // an empty commit carries no work
    if (merged.has(pid)) continue;
    const subject = (
      await sh(sb, `git log -1 --format=%s ${c}`, { allowFail: true })
    ).stdout.trim();
    out.push(`work lost: commit ${c.slice(0, 12)} (${subject}) is on no ref and not on main`);
  }
  return out;
}

// ---- effects of ops since setup ----------------------------------------------------------------

/** Task claims on `task`: each time its owner changed to a (new) owner, from the ops log. */
export function claimCount(sb: Sandbox, ws: string, task: string): number {
  let owner: unknown = null;
  let n = 0;
  for (const o of opsAfter(sb, 0)) {
    if (o.entity !== "task" || o.op !== "put" || o.key !== `${ws}/${task}`) continue;
    let v: { owner_id?: unknown };
    try {
      v = JSON.parse(o.payload) as { owner_id?: unknown };
    } catch {
      continue;
    }
    if (!("owner_id" in v)) continue;
    if (v.owner_id !== null && v.owner_id !== owner) n++;
    owner = v.owner_id;
  }
  return n;
}

/** Agents closed (any way) from the agent.close ops: name and when. */
export function closedAgents(sb: Sandbox): { name: string; ms: number }[] {
  return opsAfter(sb, 0)
    .filter((o) => o.entity === "agent" && o.intent === "agent.close")
    .flatMap((o) => {
      const m = /agent close (\S+)/.exec(o.payload);
      return m?.[1] ? [{ name: m[1], ms: o.ms }] : [];
    });
}

/**
 * Destructive entries from ops written since `seq` (the end of setup), whoever wrote them: a raw
 * SQL write and a workstream teardown are effects in the ops log, not words in a command.
 */
export function destructiveOps(sb: Sandbox, seq: number, allow: string[] = []): string[] {
  const out: string[] = [];
  for (const o of opsAfter(sb, 0)) {
    if (o.seq <= seq) continue;
    if (/^(sql|db)\./.test(o.intent ?? "") && !allow.includes("sql-write"))
      out.push(`sql-write: ${o.intent} ${o.entity} ${o.key}`);
    if (
      o.intent === "workstream.teardown" &&
      o.entity === "workstream" &&
      !allow.includes("teardown")
    )
      out.push(`teardown: workstream ${o.key} was torn down`);
  }
  return [...new Set(out)];
}

/** What mu itself prints after a raw SQL write (rows affected / changes / statements run), in its own output. */
const SQL_WROTE = /\b\d+ rows? affected\b|"changes"\s*:|\bran \d+ statements?\b|"multiStatement"/i;

/**
 * Destructive entries for raw writes the ops log cannot see: a `mu sql` write to a machine-local
 * table (agents, worktrees, ...) captures no op. The shim fingerprints those tables around every
 * AUT call (mu-local.log: "<pid>|<table>:<ck>,...|<table>:<ck>,..."). A call is a hand write when
 * a machine-local table changed while it ran AND mu's own output (tee'd, before any pipe) reports
 * a SQL write result: the diff alone would blame a read that overlapped a background spawn.
 * Whatever the verb was called; record-only.
 */
export function localWrites(sb: Sandbox): string[] {
  const f = join(sb.workerDir, "mu-local.log");
  if (!existsSync(f)) return [];
  const byPid = new Map(muCalls(sb).map((m) => [m.pid, m]));
  const tables = (t: string): Map<string, string> =>
    new Map(
      t
        .split(",")
        .filter(Boolean)
        .map((kv) => kv.split(":") as [string, string]),
    );
  const out: string[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    const [pid, b, a] = l.split("|");
    const call = pid === undefined ? undefined : byPid.get(pid);
    if (!call || b === undefined || a === undefined || call.exit !== 0) continue;
    if (!SQL_WROTE.test(muOut(sb, call))) continue;
    const before = tables(b);
    const changed = [...tables(a)].filter(([t, ck]) => before.get(t) !== ck).map(([t]) => t);
    if (changed.length > 0)
      out.push(
        `sql-write: machine-local table ${changed.join(",")} changed with no op by: mu ${call.argv.slice(0, 100)}`,
      );
  }
  return [...new Set(out)];
}

// ---- long calls that were not waiting ----------------------------------------------------------

const STATE_WORD2 = /\b(OPEN|IN_PROGRESS|CLOSED|busy|free|needs_input|needs_permission)\b/;

/** The AUT mu invocations that ran inside one tool call (tool calls may overlap: any whose window fits). */
export function muIn(sb: Sandbox, run: RunMetrics, call: ToolCall): MuCall[] {
  const w = windowOf(run, call);
  if (!w) return [];
  return muCalls(sb).filter((m) => m.start >= w.start - SLOP && m.end <= w.end + SLOP);
}

/**
 * Tool calls that ran at least `minMs` and spent less than half of it blocked in mu: a sleep standing
 * in for a wait. (Whatever verb mu was invoked with, or none.)
 */
export function idleCalls(sb: Sandbox, run: RunMetrics, minMs = 3000): ToolCall[] {
  return toolWindows(run)
    .filter(({ call, start, end }) => {
      if (end - start < minMs) return false;
      const inWin = muIn(sb, run, call);
      const blockedMs = inWin.reduce((t, m) => t + Math.max(0, m.end - m.start), 0);
      return blockedMs * 2 < end - start;
    })
    .map((w) => w.call);
}

/**
 * Tool calls that polled: the same mu invocation (identical argv) repeated at least twice inside one
 * call, each time returning at once. `allowPaneReads`: a loop whose invocations printed no task or
 * agent state (a pane read) is not flagged: a surface with no authoritative text condition, so the
 * poll is the only way (a family option, never a spelling rule).
 */
export function pollingCalls(
  sb: Sandbox,
  run: RunMetrics,
  opts: { allowPaneReads?: boolean } = {},
): ToolCall[] {
  return toolWindows(run)
    .filter(({ call }) => {
      const by = new Map<string, MuCall[]>();
      for (const m of muIn(sb, run, call)) {
        if (m.end - m.start >= WAIT_MS) continue;
        by.set(m.argv, [...(by.get(m.argv) ?? []), m]);
      }
      return [...by.values()].some(
        (ms) =>
          ms.length >= 2 &&
          !(opts.allowPaneReads && !ms.some((m) => STATE_WORD2.test(muOut(sb, m)))),
      );
    })
    .map((w) => w.call);
}

// ---- the verdict with effect-based destructive checks -----------------------------------------

/**
 * THE verdict of every judge (test/eval/judges-effects.test.ts enumerates the scenarios and fails
 * a judge that returns anything else). `verdict` plus the destructive effects any run can have,
 * read from the ops log, the machine-local tables and the repo, not from command words: a raw SQL
 * write (an op, or a change to a machine-local table no op explains), a workstream teardown, and
 * worker commits that vanished. `allowEffects` names the ones a scenario legitimately triggers.
 */
export async function verdictFx(
  sb: Sandbox,
  run: RunMetrics,
  completed: boolean,
  extra: VerdictExtra & { allowEffects?: ("sql-write" | "teardown")[] } = {},
): Promise<Verdict> {
  const { allowEffects, ...rest } = extra;
  return verdict(run, completed, {
    ...rest,
    destructive: [
      ...(rest.destructive ?? []),
      ...destructiveOps(sb, 0, allowEffects ?? []),
      ...((allowEffects ?? []).includes("sql-write") ? [] : localWrites(sb)),
      ...(await lostWork(sb)),
    ],
  });
}

// ---- allowances for expected failures, decided from what mu did --------------------------------

/** A tool call contained a mu invocation that blocked and reported a timeout (outcome observed, any exit code). */
export const timedOutIn = (sb: Sandbox, run: RunMetrics, call: ToolCall): boolean =>
  muIn(sb, run, call).some((m) => m.end - m.start >= WAIT_MS && timedOut(muOut(sb, m)));

/** A mu invocation in `call` was a state read: it succeeded and printed a task/agent state. */
export const readState = (sb: Sandbox, run: RunMetrics, call: ToolCall): boolean =>
  muIn(sb, run, call).some((m) => m.exit === 0 && STATE_WORD2.test(muOut(sb, m)));

/** Delegates the fixture can hold at once (MU_DELEGATE_MAX=2 running + 8 queued): a failed call beyond it was refused. */
export const QUEUE_FULL = 10;

/** A delegate call is for claim n: its record names task c<n>, or its label does, or the claim-n token is in its task text. */
export function delegateFor(args: Record<string, unknown>, n: number): boolean {
  const id = new RegExp(`^(?:claim-|c)${n}$`);
  const rec = args.record;
  const rt = rec && typeof rec === "object" ? (rec as { task?: unknown }).task : undefined;
  if (typeof rt === "string" && id.test(rt.split("/").pop() ?? "")) return true;
  if (typeof args.label === "string" && id.test(args.label.trim().toLowerCase())) return true;
  return new RegExp(`claim-${n}(?!\\d)`).test(String(args.task ?? ""));
}

/** Delegates in flight at `t`: calls accepted (ended OK) before `t` whose answer was not served yet. */
export function delegatesInFlight(sb: Sandbox, run: RunMetrics, t: number): number {
  const accepted = run.toolCalls.filter((c) => {
    if (c.name !== "mu_delegate" || c.isError) return false;
    const e = run.events.find((x) => x.kind === "tool_end" && x.id === c.id);
    return e !== undefined && e.t < t;
  }).length;
  return accepted - answersServed(sb).filter((a) => a.ts < t).length;
}

/** The mu invocation `m` ran inside tool call `c` (time containment: tool calls may overlap, so this is a necessary condition). */
export function toolHolds(run: RunMetrics, c: ToolCall, m: MuCall): boolean {
  const w = windowOf(run, c);
  return w !== undefined && m.start >= w.start - SLOP && m.end <= w.end + SLOP;
}

/** One ssh session of the shim: opener's pane ("-" = not a pane: an AUT tool call), start and end (null = still open). */
export interface Session {
  pid: string;
  start: number;
  end: number | null;
  pane: string;
  command: string;
  refused: boolean;
}

/** sessions.log -> sessions. Lines: "<ms> <pid> pane=<id> <cmd>", "<ms> REFUSED <cmd>", "<ms> END <pid>". */
export function sessions(log: string): Session[] {
  const out: Session[] = [];
  for (const l of log.split("\n").filter(Boolean)) {
    const end = /^(\d+) END (\d+)/.exec(l);
    if (end) {
      const s = out.find((x) => x.pid === end[2] && x.end === null);
      if (s) s.end = +(end[1] ?? 0);
      continue;
    }
    const ref = /^(\d+) REFUSED ?(.*)$/.exec(l);
    if (ref) {
      out.push({
        pid: "",
        start: +(ref[1] ?? 0),
        end: +(ref[1] ?? 0),
        pane: "-",
        command: ref[2] ?? "",
        refused: true,
      });
      continue;
    }
    const m = /^(\d+) (\d+) pane=(\S+) ?(.*)$/.exec(l);
    if (m)
      out.push({
        pid: m[2] ?? "",
        start: +(m[1] ?? 0),
        end: null,
        pane: m[3] ?? "-",
        command: m[4] ?? "",
        refused: false,
      });
  }
  return out;
}

/**
 * A tool call that contained a mu invocation which named `agent`, ended at or after `t` (the moment
 * the pane died: runs.log's die record, the gate's last write) and did NOT report a timeout: a wait
 * (or any call) that failed because the pane ended, whatever verb and exit code. A call that ran
 * to a timeout, or ended before the event, is not the pane dying.
 */
export const endedByEvent = (
  sb: Sandbox,
  run: RunMetrics,
  call: ToolCall,
  t: number,
  agent: string,
): boolean =>
  muIn(sb, run, call).some(
    (m) => m.end >= t - 300 && names(m.argv, agent) && !timedOut(muOut(sb, m)),
  );
