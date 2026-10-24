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

/** agent_end events that ended the run while work was open: before `doneAt`, and not the last one when work never finished. */
export function stops(run: RunMetrics, doneAt: number): LifecycleEvent[] {
  const ends = run.events.filter((e) => e.kind === "agent_end");
  const open = Number.isFinite(doneAt) ? ends : ends.slice(0, -1);
  return open.filter((e) => e.t < doneAt);
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
}

/**
 * A guarantee only a candidate surface gives. Met: a note. Missed: on 3.x a note "N/A baseline"
 * (data, never a pass claim), on next a wrong entry.
 */
export function native(sb: Sandbox, label: string, ok: boolean, detail: string): NativeResult {
  if (ok) return { wrong: [], notes: [`native ok: ${label} (${detail})`] };
  if (sandboxFamily(sb) === "3x")
    return { wrong: [], notes: [`N/A baseline 3.x: ${label} (${detail})`] };
  return { wrong: [`${label}: ${detail}`], notes: [] };
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
