// Judge-side queries over RunMetrics.events (the harness's timestamped lifecycle record) and the
// family rule for guarantees only a candidate can give. Pure: no I/O. The observer only records;
// nothing here repairs or injects anything.
//
//  - A *stop* is an agent_end that happens while work the AUT owns is still open (the run ended
//    and a human prod or a late follow-up had to resume it).
//  - A *wait window* is the tool_start..tool_end interval of a `mu wait` call.
//  - A *native* guarantee (mid-wait delivery, a direct-call snapshot, one wait verb for every ref)
//    cannot be had on 3.x: on the 3x family a miss is a note "N/A baseline 3.x", on next a wrong
//    entry. A 3x golden may show the best manual workaround; it never claims the guarantee.
import { sandboxFamily } from "./fixtures.ts";
import type { LifecycleEvent, RunMetrics, Sandbox, ToolCall } from "./types.ts";

/** `mu wait`, `mu task wait`, `mu agent wait` as a command word (not inside a quoted note). */
export const WAIT_CALL = /(^|[\s;&|(`$])mu\s+(?:(?:task|agent)\s+)?wait\b/;

export function commandOf(call: ToolCall): string {
  return call.name === "bash" && typeof call.args.command === "string" ? call.args.command : "";
}

/** A wait command word; single-quoted text (a note's prose) is not a command. */
export const isWaitCall = (call: ToolCall): boolean =>
  WAIT_CALL.test(commandOf(call).replace(/'[^']*'/g, "''"));

export interface Window {
  call: ToolCall;
  start: number;
  end: number;
}

/** The interval each tool call (matching `pick`) ran, from tool_start/tool_end events. */
export function windows(run: RunMetrics, pick: (c: ToolCall) => boolean): Window[] {
  const out: Window[] = [];
  for (const call of run.toolCalls) {
    if (!pick(call)) continue;
    const start = run.events.find((e) => e.kind === "tool_start" && e.id === call.id);
    const end = run.events.find((e) => e.kind === "tool_end" && e.id === call.id);
    if (start && end) out.push({ call, start: start.t, end: end.t });
  }
  return out;
}

export const waitWindows = (run: RunMetrics): Window[] => windows(run, isWaitCall);

/**
 * agent_end events that ended the run while work was open: after `after` and before `doneAt`, and
 * not the last one when work never finished.
 */
export function stops(run: RunMetrics, doneAt: number, after = -Infinity): LifecycleEvent[] {
  const ends = run.events.filter((e) => e.kind === "agent_end");
  const open = Number.isFinite(doneAt) ? ends : ends.slice(0, -1);
  return open.filter((e) => e.t > after && e.t < doneAt);
}

/** A dispatch command: `agent send`, or `agent spawn ... --send`. */
const DISPATCH = /\bagent\s+send\b|\bagent\s+spawn\b[^;&|]*--send\b/;

/** The first moment work was handed out: a mu_delegate, `agent send` or `spawn --send` call finished. Null when none. */
export function firstDispatch(run: RunMetrics): number | null {
  for (const e of run.events) {
    if (e.kind !== "tool_end") continue;
    const call = run.toolCalls.find((c) => c.id === e.id);
    if (call && (call.name === "mu_delegate" || DISPATCH.test(commandOf(call)))) return e.t;
  }
  return null;
}

/**
 * Turn ends between the first dispatch (any kind) and `doneAt`. No dispatch at all means no
 * window: nothing was running yet.
 */
export function stopsWhileWorking(run: RunMetrics, doneAt: number): LifecycleEvent[] {
  const from = firstDispatch(run);
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

/**
 * A successful wait call that names `ref` and whose own output shows it CLOSED, returning at or
 * after `notBefore` (e.g. its worker's last run). The result is read from that call, not claimed.
 */
export function waitedClosed(run: RunMetrics, ref: string, notBefore = 0): boolean {
  const name = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return waitWindows(run).some(({ call, end }) => {
    if (call.isError || (call.exitCode ?? 0) !== 0 || end < notBefore) return false;
    const args = commandOf(call)
      .replace(/'[^']*'/g, "''")
      .replace(/^[\s\S]*?\bmu\s+(?:(?:task|agent)\s+)?wait\b/, "");
    return (
      new RegExp(`(^|[\\s;&|])${name}(?![\\w-])`).test(args) &&
      new RegExp(`${name}(?![\\w-])[^\\n]{0,60}CLOSED|"name":"${name}"[^}]*"status":"CLOSED"`).test(
        call.output,
      )
    );
  });
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
