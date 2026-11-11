// mu — one plugin effect, written ahead and resolved by the rule table
// (plugins spec D4). The journal is src/effects.ts; this file sends.
//
// `runEffect` is the creator's path: the plugin session first (its instance and
// process group go on the row), then the intent with the subject's own change in
// one immediate transaction, then the call with the persisted params. A reply is
// recorded and the row deleted together; an error that says nothing happened
// (`retryable` after its retries, `permanent`, `human`, or never sent) deletes
// the row as a definite outcome; anything else leaves it `unknown`.
//
// `pluginCall` is the one call path of the job adapter and the reconciler:
// the method's reply narrower bound to its request (`replyNarrower`), and the
// instance fence for any call naming a recorded job, host or effect (a
// changed instance refuses before anything is sent).
//
// `resolveEffect` is every later verb's: claim the row (a live creator or
// resolver refuses), then by method, every call fenced on the row's instance
// (`stop-changed`):
//
//   host.release, job.stop      reissue the persisted request (idempotent)
//   host.acquire, job.start     lookup(key) if declared, else a deduped resend
//                               inside its window; `none` counts only under the
//                               gate; a `handle: "file"` kind never acts on it
//   channel.send/fresh/interrupt  receipt(msgId) if `receipt: exact` (only
//                               `accepted` resolves), else a deduped resend
//   channel.abort               readStates: an idle agent means done
//   channel.answer/command      a deduped resend
//
// A delivery (an at-start `job.start` carrying the first prompt included) is
// resent only while no newer delivery to its agent was written (the claim reads
// `seq` against `agents.delivery_seq`). Whatever does not
// resolve stays `unknown` for a human.

import type { MessageCheck } from "../channels/types.js";
import type { Db } from "../db.js";
import {
  claimEffect,
  creatorGone,
  type EffectIntent,
  type EffectRow,
  leaveEffectUnknown,
  pluginGroupGone,
  settleEffect,
  writeEffect,
} from "../effects.js";
import type { Call, KeyCaps } from "../host-provider.js";
import { PLUGIN_READ_TIMEOUT_MS } from "./client.js";
import {
  EffectFencedError,
  EffectOutcomeUnknownError,
  PluginAnswerUnknownError,
  PluginCallError,
} from "./errors.js";
import {
  type MethodReplies,
  narrowWatchEnd,
  type Obj,
  type PluginMethod,
  replyNarrower,
  type SeamName,
  type WatchEnd,
  type WireWatch,
} from "./protocol.js";
import { pluginSession } from "./registry.js";

let timeoutForTests: number | undefined;

/** TEST SEAM: every effect's deadline (a timeout without a 10 s wait). */
export function setEffectTimeoutForTests(ms: number | undefined): void {
  timeoutForTests = ms;
}

/** `host.acquire` takes 10 minutes (D13 Timeouts); every other effect the read bound. */
export function effectTimeoutMs(method: string): number {
  return timeoutForTests ?? (method === "host.acquire" ? 600_000 : PLUGIN_READ_TIMEOUT_MS);
}

/** The instance a call's subject was recorded under, and what to call the refusal. */
export interface Fence {
  instance: string;
  subject: string;
  why?: "stop-changed" | "instance-changed";
}

/** How one call runs: its kind, its fence, the seams it needs, and its bound. */
export interface CallOpts {
  kind: "read" | "effect";
  fence?: Fence;
  needs?: readonly SeamName[];
  /** The call's own budget (a link run's `timeoutMs`), else the method's. */
  timeoutMs?: number;
  /** Add the plugin's grace to the budget (a link run: the plugin answers at its timeout). */
  plusGrace?: boolean;
  /** The caller's `Call` (D6): its deadline caps the budget, its signal cancels. */
  call?: Call;
}

/**
 * The one call path (every plugin call: host, link, job, channel): refuses (`EffectFencedError`)
 * before sending when `fence` names another instance than the plugin's, and narrows the reply
 * against this request.
 */
export async function pluginCall<M extends PluginMethod>(
  db: Db,
  plugin: string,
  method: M,
  params: Obj,
  opts: CallOpts,
): Promise<MethodReplies[M]> {
  const s = await pluginSession(db, plugin, opts.needs);
  const f = opts.fence;
  if (f !== undefined && f.instance !== s.init.instance) {
    throw new EffectFencedError(plugin, f.subject, f.instance, s.init.instance, f.why);
  }
  let timeoutMs =
    (opts.timeoutMs ??
      (opts.kind === "effect" ? effectTimeoutMs(method) : PLUGIN_READ_TIMEOUT_MS)) +
    (opts.plusGrace === true ? s.process.graceMs : 0);
  if (opts.call !== undefined)
    timeoutMs = Math.max(1, Math.min(timeoutMs, opts.call.deadline - Date.now()));
  return s.call(
    method,
    params,
    {
      kind: opts.kind,
      timeoutMs,
      ...(opts.call !== undefined ? { signal: opts.call.signal } : {}),
    },
    replyNarrower(method, params, s.init.seams),
  );
}

/** How a plugin watch ended: its notification, or `gone` (no answer: the plugin stopped, the watch was cancelled, an invalid notification). */
export type WatchOutcome = WatchEnd | { gone: string };

/**
 * `channel.watch` through the one call path, then its one end (D13 Streaming watch). An abort of
 * `signal` sends `$/cancel {watchId}` and ends it `gone`; a watch lives only in this invocation.
 */
export async function pluginWatch(
  db: Db,
  plugin: string,
  params: Obj,
  fence: Fence | undefined,
  signal: AbortSignal,
): Promise<{ start: WireWatch; end: Promise<WatchOutcome> }> {
  const start = await pluginCall(db, plugin, "channel.watch", params, {
    kind: "read",
    ...(fence !== undefined ? { fence } : {}),
    // Not the watch's signal: an abort before the reply would stop the plugin; after it, it cancels the watch.
    needs: ["channel"],
  });
  const proc = (await pluginSession(db, plugin)).process;
  const end = new Promise<WatchOutcome>((resolve) => {
    const cancel = proc.watch(start.watchId, (n) => {
      signal.removeEventListener("abort", onAbort);
      if (n.method === "gone") return resolve({ gone: String(n.params) });
      const r = narrowWatchEnd(n.method, n.params);
      if (r.ok && r.value.watchId === start.watchId) return resolve(r.value);
      proc.poison(`an invalid ${n.method} notification (${r.ok ? "another watch" : r.reason})`);
      resolve({ gone: "an invalid notification" });
    });
    const onAbort = (): void => {
      cancel();
      resolve({ gone: "cancelled" });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { start, end };
}

/** The plugin's grace (D13): a `stopping` link run is waited out for one. */
export async function pluginGraceMs(db: Db, plugin: string): Promise<number> {
  return (await pluginSession(db, plugin)).process.graceMs;
}

export interface EffectCall<M extends PluginMethod>
  extends Omit<EffectIntent, "instance" | "pgid" | "pgidStart" | "method"> {
  method: M;
  /** The instance the subject was recorded under (a stop's job): refused before the intent. */
  fence?: string;
  /** The seams the plugin must declare, refused at load before the intent. */
  needs?: readonly SeamName[];
  /** The caller's deadline and cancel (D6). */
  call?: Call;
  /** The subject's own change, in the intent's transaction (given the instance it goes to); a subject it creates returns its id. */
  alongside?: (instance: string) => unknown;
  /** The reply, recorded on the subject in the transaction that deletes the row. */
  record?: (result: MethodReplies[M]) => void;
  /** Nothing happened: recorded with the row's delete. */
  refused?: () => void;
}

/** The creator's path: write ahead, call, record once. Throws the call's typed error. */
export async function runEffect<M extends PluginMethod>(
  db: Db,
  e: EffectCall<M>,
): Promise<MethodReplies[M]> {
  const s = await pluginSession(db, e.plugin, e.needs);
  const instance = s.init.instance;
  if (e.fence !== undefined && e.fence !== instance) {
    throw new EffectFencedError(e.plugin, e.key, e.fence, instance);
  }
  const row = writeEffect(
    db,
    {
      key: e.key,
      subject: e.subject,
      plugin: e.plugin,
      method: e.method,
      params: e.params,
      instance,
      pgid: s.process.pgid,
      pgidStart: s.process.pgidStart,
    },
    e.alongside === undefined ? undefined : () => e.alongside?.(instance),
  );
  // Every send and retry carries the committed bytes, never the caller's object (which it may
  // still mutate): a resend after a crash then repeats exactly what this call sent.
  const committed = JSON.parse(row.params_json) as Obj;
  let result: MethodReplies[M];
  try {
    result = await pluginCall(db, e.plugin, e.method, committed, {
      kind: "effect",
      fence: { instance, subject: e.key },
      ...(e.call !== undefined ? { call: e.call } : {}),
    });
  } catch (err) {
    if (err instanceof PluginCallError) settleEffect(db, e.key, e.refused);
    else leaveEffectUnknown(db, e.key);
    throw err;
  }
  settleEffect(db, e.key, () => e.record?.(result));
  return result;
}

export type Resolution =
  | { state: "recorded"; via: "reply" | "lookup" | "receipt" | "idle"; result: unknown }
  | { state: "none" }
  /** `receipt`: the channel's answer when it asked one and it did not accept. */
  | { state: "unknown"; reason: string; receipt?: MessageCheck };

export interface ResolveHooks {
  /** The definite result (a reply, a lookup's `found`, an accepted receipt, an idle agent). */
  record?: (r: { via: "reply" | "lookup" | "receipt" | "idle"; result: unknown }) => void;
  /** Proof nothing happened (a gated `none`). */
  none?: () => void;
}

/**
 * Resolve the unresolved effect `key` by the rule table. Undefined when the row is gone
 * (resolved meanwhile). Refuses (`EffectHeldError`) while its creator or resolver lives, and
 * (`EffectFencedError`) when the plugin's instance changed; a resend's typed error propagates
 * with the row left `unknown`.
 */
export async function resolveEffect(
  db: Db,
  key: string,
  hooks: ResolveHooks = {},
  /** The caller's deadline and cancel (D6): every ask and resend of the resolution honours it. */
  call?: Call,
): Promise<Resolution | undefined> {
  const claimed = claimEffect(db, key);
  if (claimed === undefined) return undefined;
  const { row, newest } = claimed;
  let out: Resolution;
  try {
    out = await byRule(db, row, newest, call);
  } catch (err) {
    leaveEffectUnknown(db, key);
    throw err;
  }
  if (out.state === "unknown") {
    leaveEffectUnknown(db, key);
    return out;
  }
  const done =
    out.state === "none"
      ? settleEffect(db, key, hooks.none)
      : settleEffect(db, key, () => hooks.record?.(out as Extract<Resolution, { via: unknown }>));
  return done ? out : { state: "unknown", reason: "the effect changed hands while resolving" };
}

const unknown = (reason: string): Resolution => ({ state: "unknown", reason });

async function byRule(
  db: Db,
  row: EffectRow,
  newest: boolean,
  caller: Call | undefined,
): Promise<Resolution> {
  const params = JSON.parse(row.params_json) as Obj;
  const fence: Fence = { instance: row.instance, subject: row.key };
  const call = <M extends PluginMethod>(method: M, p: Obj, kind: "read" | "effect") =>
    pluginCall(db, row.plugin, method, p, {
      kind,
      fence,
      ...(caller !== undefined ? { call: caller } : {}),
    });
  /** A read: its value, or `unknown` for no answer (an invalid reply included). */
  const read = async <M extends PluginMethod>(
    method: M,
    p: Obj,
  ): Promise<{ value: MethodReplies[M] } | { unknown: string }> => {
    try {
      return { value: await call(method, p, "read") };
    } catch (e) {
      if (e instanceof PluginAnswerUnknownError) return { unknown: e.reason };
      throw e;
    }
  };
  const resend = async (): Promise<Resolution> => {
    try {
      const result = await call(row.method as PluginMethod, params, "effect");
      return { state: "recorded", via: "reply", result };
    } catch (e) {
      if (e instanceof EffectOutcomeUnknownError) return unknown(e.reason);
      throw e;
    }
  };
  const within = (d: { windowMs: number } | undefined): boolean =>
    d !== undefined && Date.now() - row.created_at < d.windowMs;
  const seams = (await pluginSession(db, row.plugin)).init.seams;
  const channel = seams.channel?.caps;
  const m = row.method;
  if (m === "host.release" || m === "job.stop") return resend();
  if (m === "host.acquire" || m === "job.start") {
    const job = m === "job.start";
    const caps: KeyCaps | undefined = job ? seams.job?.start : seams.host?.acquire;
    if (caps === undefined) return unknown(`plugin ${row.plugin} no longer declares the seam`);
    if (!caps.lookup) {
      if (!within(caps.dedupe)) return unknown("no lookup, and the dedupe window has passed");
      // A start carrying the first prompt is the agent's first delivery (seq 1, K8).
      if (!newest)
        return unknown("a newer delivery to the agent was written since its first prompt");
      return resend();
    }
    return lookup(row, caps, job && seams.job?.handle === "file", (fence) =>
      read(job ? "job.lookup" : "host.lookup", { target: params.target, key: row.key, fence }),
    );
  }
  if (m === "channel.abort") {
    const r = await read("channel.readStates", { targets: [params.target] });
    if (!("value" in r)) return unknown(r.unknown);
    // The narrower kept exactly the asked agent's reading.
    const idle = Object.values(r.value)[0]?.state === "idle";
    return idle ? { state: "recorded", via: "idle", result: r.value } : unknown("not idle");
  }
  if (!m.startsWith("channel.")) return unknown(`no rule for ${m}`);
  const receipts = m === "channel.send" || m === "channel.fresh" || m === "channel.interrupt";
  if (receipts && channel?.receipt === "exact" && row.msg_id !== null) {
    const r = await read("channel.receipt", { target: params.target, msgId: row.msg_id });
    if (!("value" in r)) return unknown(r.unknown);
    if (r.value.state === "accepted") return { state: "recorded", via: "receipt", result: r.value };
    return { state: "unknown", reason: `receipt: ${r.value.state}`, receipt: r.value };
  }
  const name = m.slice("channel.".length) as keyof NonNullable<
    NonNullable<typeof channel>["dedupe"]
  >;
  if (!within(channel?.dedupe?.[name])) {
    return unknown(`delivery unknown: ${m} has no dedupe in its window`);
  }
  if (!newest) return unknown("delivery unknown: a newer delivery to the agent was written");
  return resend();
}

/**
 * `lookup(key)`. `found` is the result; `pending` and `unknown` leave the row. `none` proves
 * nothing happened only when the creator and the plugin group the row was sent to are proven
 * gone, and either the lookup was fenced (`fenceKey`) or `inFlightMs` has passed since the
 * intent. A `handle: "file"` kind never acts on `none`: its dispatcher is the view pane.
 */
async function lookup(
  row: EffectRow,
  caps: KeyCaps,
  fileKind: boolean,
  ask: (
    fence: boolean,
  ) => Promise<{ value: MethodReplies["job.lookup" | "host.lookup"] } | { unknown: string }>,
): Promise<Resolution> {
  const owners = creatorGone(row) && pluginGroupGone(row);
  const fence = caps.fenceKey && owners && !fileKind;
  const r = await ask(fence);
  if ("unknown" in r) return unknown(r.unknown);
  const l = r.value;
  // The narrower held a reply kind's found to the whole JobStart (D8 G1a).
  if ("found" in l) return { state: "recorded", via: "lookup", result: l.found };
  if ("pending" in l) return unknown("the plugin says it is still in flight");
  if ("unknown" in l) return unknown(l.unknown);
  if (fileKind) return unknown("lookup: none (a file-handle kind's job file decides)");
  const settled =
    fence || (caps.inFlightMs !== undefined && Date.now() - row.created_at >= caps.inFlightMs);
  if (owners && settled) return { state: "none" };
  return unknown("lookup: none, which proves nothing yet (D4 gate)");
}
