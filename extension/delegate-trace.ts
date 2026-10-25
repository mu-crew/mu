/**
 * `MU_DELEGATE_TRACE=1`: the delivery trace of the mu_delegate tool, split
 * from delegate.ts. Off (and free) by default.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultCacheDir } from "../src/state-dir.js";

/** `MU_DELEGATE_TRACE=1` appends one JSON line per delivery step and pi
 *  lifecycle event to `<mu cache dir>/delegate-trace.log`: for finding
 *  where a follow-up got lost. Off (and free) by default. */
export function delegateTraceOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.MU_DELEGATE_TRACE && env.MU_DELEGATE_TRACE !== "0";
}
export function delegateTracePath(): string {
  return join(defaultCacheDir(), "delegate-trace.log");
}
export function trace(event: string, data: Record<string, unknown> = {}): void {
  if (!delegateTraceOn()) return;
  try {
    mkdirSync(defaultCacheDir(), { recursive: true });
    const line = { t: new Date().toISOString(), pid: process.pid, event, ...data };
    appendFileSync(delegateTracePath(), `${JSON.stringify(line)}\n`);
  } catch {
    // tracing must never cost a delegate its answer
  }
}

/** pi events the trace records, with what each says about delivery. */
export const TRACE_EVENTS = [
  "session_start",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_before_tree",
  "session_tree",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_end",
  "message_start",
  "message_end",
] as const;

export function traceFields(
  event: unknown,
  ctx: { isIdle?(): boolean; hasPendingMessages?(): boolean } | undefined,
): Record<string, unknown> {
  const e = (event ?? {}) as Record<string, unknown>;
  const m = e.message as { role?: unknown; customType?: unknown; details?: unknown } | undefined;
  const d = m?.details as { delivery?: unknown; name?: unknown } | undefined;
  const out: Record<string, unknown> = {};
  if (m?.role) out.role = m.role;
  if (m?.customType) out.customType = m.customType;
  if (d?.delivery !== undefined) out.delivery = d.delivery;
  if (d?.name !== undefined) out.name = d.name;
  for (const k of ["aborted", "reason", "willRetry"]) if (e[k] !== undefined) out[k] = e[k];
  try {
    if (ctx?.isIdle) out.idle = ctx.isIdle();
    if (ctx?.hasPendingMessages) out.pendingMsgs = ctx.hasPendingMessages();
  } catch {
    out.ctx = "stale";
  }
  return out;
}
