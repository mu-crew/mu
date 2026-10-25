// Judge-side queries over RunMetrics.events (the harness's timestamped lifecycle record) and the
// family rule for guarantees only a candidate can give. Pure: no I/O. The observer only records;
// nothing here repairs or injects anything.
//
//  - A *stop* is an agent_end that happens while work the AUT owns is still open (the run ended
//    and a human prod or a late follow-up had to resume it).
//  - A *wait window* is the interval a mu invocation of the AUT BLOCKED (observed by the sandbox's
//    mu shim, observe.ts): waiting is what a call did, never what it was spelled.
//  - A *native* guarantee (mid-wait delivery, a direct-call snapshot, one wait verb for every ref)
//    cannot be had on 3.x: on the 3x family a miss is a note "N/A baseline 3.x", on next a wrong
//    entry. A 3x golden may show the best manual workaround; it never claims the guarantee.
import { sandboxFamily } from "./fixtures.ts";
import {
  muOut,
  toolWindows,
  WAIT_MS,
  type Window,
  waitWindows,
  workHandedOutAt,
} from "./observe.ts";
import type { LifecycleEvent, RunMetrics, Sandbox, ToolCall } from "./types.ts";

export function commandOf(call: ToolCall): string {
  return call.name === "bash" && typeof call.args.command === "string" ? call.args.command : "";
}

export { WAIT_MS, type Window, waitWindows };

/** The output mu itself printed in each wait window. */
export const waitOutputs = (sb: Sandbox): string[] => waitWindows(sb).map((w) => muOut(sb, w.mu));

/** The [start,end] of every tool call (from the lifecycle record). */
export { toolWindows };

/**
 * agent_end events that ended the run while work was open: after `after` and before `doneAt`, and
 * not the last one when work never finished.
 */
export function stops(run: RunMetrics, doneAt: number, after = -Infinity): LifecycleEvent[] {
  const ends = run.events.filter((e) => e.kind === "agent_end");
  const open = Number.isFinite(doneAt) ? ends : ends.slice(0, -1);
  return open.filter((e) => e.t > after && e.t < doneAt);
}

/**
 * Turn ends between the moment work was first handed out (a task got an owner, or a delegate was
 * issued: the DB and tool record, however the AUT spelled it) and `doneAt`. No hand-out means no
 * window: nothing was running yet.
 */
export function stopsWhileWorking(sb: Sandbox, run: RunMetrics, doneAt: number): LifecycleEvent[] {
  const from = workHandedOutAt(sb, run);
  return from === null ? [] : stops(run, doneAt, from);
}

/** Custom-message deliveries (mu-delegate) whose text satisfies `re`. */
export function deliveries(run: RunMetrics, re: RegExp = /./): LifecycleEvent[] {
  return run.events.filter((e) => e.kind === "delegate_msg" && re.test(e.text ?? ""));
}

/** True iff `t` lies inside one of the windows. */
export const inside = (t: number, ws: Window[]): boolean =>
  ws.some((w) => t >= w.start && t <= w.end);

/** The ms of the first lifecycle event of `kind` (after `after`), or null. */
export function firstEvent(
  run: RunMetrics,
  kind: LifecycleEvent["kind"],
  after = -Infinity,
): LifecycleEvent | null {
  return run.events.find((e) => e.kind === kind && e.t > after) ?? null;
}

export interface NativeResult {
  wrong: string[];
  notes: string[];
  /** Missed on the baseline: carried to Verdict.na (report, matrix and check show it). */
  na: string[];
}

/**
 * A guarantee only a candidate surface gives. Met: a note. Missed: on 3.x an N/A entry (data,
 * never a pass claim; verdict() turns it into a note and the report shows it), on next a wrong entry.
 */
export function native(sb: Sandbox, label: string, ok: boolean, detail: string): NativeResult {
  if (ok) return { wrong: [], notes: [`native ok: ${label} (${detail})`], na: [] };
  if (sandboxFamily(sb) === "3x") return { wrong: [], notes: [], na: [`${label} (${detail})`] };
  return { wrong: [`${label}: ${detail}`], notes: [], na: [] };
}

/** Task states in a wait snapshot: every object naming a task (name/id/local_id/task) with a string status. */
export function snapshotStates(snap: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const o = v as Record<string, unknown>;
    const id = [o.name, o.id, o.local_id, o.task].find((x) => typeof x === "string");
    if (typeof id === "string" && typeof o.status === "string") out.set(id, o.status);
    Object.values(o).forEach(walk);
  };
  walk(snap);
  return out;
}

/** The wrong entry for a run that needed a prod: "never stop" means prods == 0. */
export const prodWrong = (run: RunMetrics): string[] =>
  run.prods > 0 ? [`the orchestrator needed ${run.prods} prod(s) to carry on`] : [];

/** Last JSON object in a tool output (stdout may carry other lines), or null. */
export function lastJson(output: string): Record<string, unknown> | null {
  const starts: number[] = [];
  for (let i = output.indexOf("{"); i >= 0; i = output.indexOf("{", i + 1)) starts.push(i);
  for (const s of starts) {
    try {
      const v: unknown = JSON.parse(output.slice(s).trim());
      if (typeof v === "object" && v !== null && !Array.isArray(v))
        return v as Record<string, unknown>;
    } catch {
      // not a JSON tail from here
    }
  }
  return null;
}
