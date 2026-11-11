// mu — `mu wait --text`: the wait result as plain lines, no JSON filter needed.
//
// runWait (src/cli/wait.ts) builds the same WaitDataInput the JSON result
// (src/cli/wait-output.ts) is built from; shownReports reads the reports, waitText is pure.
//
// Shape: line 1 is `event: <kind> on <ref> | resume: <command>`. Everything else the result
// knows (exit and reason, each consumed ref's state, a task's or delegate's report, warnings,
// notices, owed news) sits between it and the `---` line. Below `---` is only the firing
// agent's last words, as `mu agent read --text` prints them.

import type { Db } from "../db.js";
import { listNotes } from "../tasks/queries.js";
import type { WaitSnapshot } from "../wait-types.js";
import { refString, tallySummary, type WaitDataInput } from "./wait-output.js";

/** A report note's content, keyed by `refString` of the task or delegate ref it answers. */
export type ReportsByRef = ReadonlyMap<string, string>;

/** The refs this result consumed or fired on, firing ref first: the ones the text shows. */
export function shownSnapshots(input: WaitDataInput): WaitSnapshot[] {
  const { result } = input;
  const firing = result.event.ref === null ? null : refString(result.event.ref);
  const keys = new Set([
    ...result.delivered.map(refString),
    ...(result.events ?? []).flatMap((e) => (e.ref === null ? [] : [refString(e.ref)])),
    ...(firing === null ? [] : [firing]),
  ]);
  const shown = result.refs.filter((s) => keys.has(refString(s.ref)));
  return [
    ...shown.filter((s) => refString(s.ref) === firing),
    ...shown.filter((s) => refString(s.ref) !== firing),
  ];
}

/**
 * The latest report note (what `mu task notes --report` prints) of each shown task, and of each
 * shown delegate's own task (its answer).
 */
export function shownReports(db: Db, input: WaitDataInput): ReportsByRef {
  const out = new Map<string, string>();
  for (const s of shownSnapshots(input)) {
    const task =
      s.ref.kind === "task" ? s.ref.id : s.ref.kind === "delegate" ? s.callTask : undefined;
    if (task === undefined) continue;
    const report = listNotes(db, task, s.ref.workstream)
      .reverse()
      .find((n) => n.kind === "report");
    if (report !== undefined) out.set(refString(s.ref), report.content);
  }
  return out;
}

function stateLine(s: WaitSnapshot): string {
  const bits = [`${refString(s.ref)}: ${s.status ?? "gone"}`];
  if (s.substate !== undefined && s.substate !== null && s.substate !== "") {
    bits[0] += `/${s.substate}`;
  }
  if (s.dead) bits.push("dead");
  if (s.ref.kind === "agent" && s.runs !== undefined) bits.push(`run ${s.runs}`);
  if (s.owed === true) bits.push("owed");
  if (s.verdict !== undefined && s.verdict !== null) bits.push(`verdict ${s.verdict}`);
  if (s.owner !== undefined && s.owner !== null) bits.push(`owner ${s.owner}`);
  if (s.stuck === true) bits.push(`stuck (${s.stuckWhy ?? "needs_input"} ${s.stuckSecs ?? 0}s)`);
  if (s.exit !== undefined) bits.push(`exit ${s.exit}`);
  if (s.lastError !== undefined && s.lastError !== "") bits.push(`error: ${s.lastError}`);
  return bits.join(", ");
}

/** Indented, so no report line can read as the `---` separator. */
const indent = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

export function waitText(input: WaitDataInput, reports: ReportsByRef): string {
  const { result } = input;
  const firing = result.event.ref === null ? null : refString(result.event.ref);
  const resume = input.resume === null ? "no resume" : `${input.resume} --text`;
  const out = [`event: ${result.event.kind} on ${firing ?? "none"} | resume: ${resume}`];
  if (result.events !== undefined && result.events.length > 1) {
    out.push(
      `events: ${result.events.map((e) => `${e.kind} ${e.ref === null ? "none" : refString(e.ref)}`).join(", ")}`,
    );
  }
  const why = input.reason === undefined ? "" : ` (${input.reason})`;
  out.push(`exit: ${input.exit}${why}`);
  if (result.timedOut) out.push("timed out: nothing consumed; run the resume");
  const shown = shownSnapshots(input);
  for (const s of shown) {
    out.push(stateLine(s));
    if (s.ref.kind === "agent") continue;
    const report = reports.get(refString(s.ref));
    if (report !== undefined) out.push(`report of ${refString(s.ref)}:`, indent(report));
    else if (s.fired) out.push(`report of ${refString(s.ref)}: none filed`);
  }
  // The rest, one line each: what is still open, and what an earlier wait consumed.
  const keys = new Set(shown.map((s) => refString(s.ref)));
  for (const s of result.refs) if (!keys.has(refString(s.ref))) out.push(stateLine(s));
  const open = result.refs.filter((s) => !s.fired && !s.dead).length;
  if (open > 0) out.push(`open: ${open}`);
  if (result.owed !== undefined && result.owed > 0) out.push(`owed: ${result.owed}`);
  if (result.tally !== undefined) out.push(`tally: ${tallySummary(result.tally)}`);
  if (result.action !== undefined) {
    const a = result.action;
    out.push(
      `action: --on-stall ${a.action} ${a.state}${a.reason !== undefined ? ` (${a.reason})` : ""}`,
    );
  }
  for (const n of result.humanNeeds) out.push(`human needed: ${n.workstream}/${n.id}: ${n.reason}`);
  if (input.warning !== undefined) out.push(`warning: ${input.warning}`);
  for (const n of input.notices ?? []) out.push(`notice: ${n}`);
  out.push("---");
  // Below the line: only agents' words. A task or delegate answers with its report, above.
  const words = shown.filter((s) => s.ref.kind === "agent" && (s.lastText ?? "").trim() !== "");
  const first = words[0];
  if (first === undefined || refString(first.ref) !== firing) {
    out.push(
      firing !== null && result.event.ref?.kind !== "agent"
        ? `no final text: ${firing} is a ${result.event.ref?.kind} ref; its report is above`
        : "no final text",
    );
  }
  words.forEach((s, i) => {
    if (i > 0 || refString(s.ref) !== firing) out.push(`--- ${refString(s.ref)}`);
    out.push((s.lastText ?? "").trim());
  });
  return out.join("\n");
}
