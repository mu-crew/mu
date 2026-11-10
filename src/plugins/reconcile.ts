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
// `resolveEffect` is every later verb's: claim the row (a live creator or
// resolver refuses), fence on the instance (a changed one refuses,
// `stop-changed`, and nothing is asked or resent), then by method:
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
// A delivery is resent only while no newer delivery to its agent was written
// (the claim reads `seq` against `agents.delivery_seq`). Whatever does not
// resolve stays `unknown` for a human.

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
import type { KeyCaps } from "../host-provider.js";
import { PLUGIN_READ_TIMEOUT_MS, type PluginSession } from "./client.js";
import {
  EffectFencedError,
  EffectOutcomeUnknownError,
  PluginAnswerUnknownError,
  PluginCallError,
} from "./errors.js";
import {
  type Narrowed,
  narrowHostFacts,
  narrowHostLookup,
  narrowJobLookup,
  narrowJobStart,
  narrowMessageCheck,
  narrowNull,
  narrowObject,
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

/** How each method's reply is narrowed, for the first send and any resend. */
const REPLY: Record<string, (x: unknown) => Narrowed<unknown>> = {
  "host.acquire": narrowHostFacts,
  "host.release": narrowNull,
  "job.start": narrowJobStart,
  "job.stop": narrowNull,
};
const replyNarrower = (method: string) => REPLY[method] ?? narrowObject;

export interface EffectCall<T> extends Omit<EffectIntent, "instance" | "pgid" | "pgidStart"> {
  narrow: (x: unknown) => Narrowed<T>;
  /** The subject's own change, in the intent's transaction (given the instance it goes to). */
  alongside?: (instance: string) => void;
  /** The reply, recorded on the subject in the transaction that deletes the row. */
  record?: (result: T) => void;
  /** Nothing happened: recorded with the row's delete. */
  refused?: () => void;
}

/** The creator's path: write ahead, call, record once. Throws the call's typed error. */
export async function runEffect<T>(db: Db, e: EffectCall<T>): Promise<T> {
  const s = await pluginSession(db, e.plugin);
  const instance = s.init.instance;
  writeEffect(
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
  let result: T;
  try {
    result = await s.call(
      e.method,
      e.params,
      { kind: "effect", timeoutMs: effectTimeoutMs(e.method) },
      e.narrow,
    );
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
  | { state: "unknown"; reason: string };

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
): Promise<Resolution | undefined> {
  const claimed = claimEffect(db, key);
  if (claimed === undefined) return undefined;
  const { row, newest } = claimed;
  let out: Resolution;
  try {
    const s = await pluginSession(db, row.plugin);
    if (s.init.instance !== row.instance) {
      throw new EffectFencedError(row.plugin, key, row.instance, s.init.instance);
    }
    out = await byRule(s, row, newest);
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

async function byRule(s: PluginSession, row: EffectRow, newest: boolean): Promise<Resolution> {
  const params = JSON.parse(row.params_json) as Record<string, unknown>;
  const resend = async (): Promise<Resolution> => {
    try {
      const result = await s.call(
        row.method,
        params,
        { kind: "effect", timeoutMs: effectTimeoutMs(row.method) },
        replyNarrower(row.method),
      );
      return { state: "recorded", via: "reply", result };
    } catch (e) {
      if (e instanceof EffectOutcomeUnknownError) return unknown(e.reason);
      throw e;
    }
  };
  const within = (d: { windowMs: number } | undefined): boolean =>
    d !== undefined && Date.now() - row.created_at < d.windowMs;
  const seams = s.init.seams;
  const channel = seams.channel?.caps;
  switch (row.method) {
    case "host.release":
    case "job.stop":
      return resend();
    case "host.acquire":
    case "job.start": {
      const job = row.method === "job.start";
      const caps: KeyCaps | undefined = job ? seams.job?.start : seams.host?.acquire;
      if (caps === undefined) return unknown(`plugin ${row.plugin} no longer declares the seam`);
      if (caps.lookup) {
        return lookup(s, row, params, caps, job && seams.job?.handle === "file");
      }
      if (within(caps.dedupe)) return resend();
      return unknown("no lookup, and the dedupe window has passed");
    }
    case "channel.send":
    case "channel.fresh":
    case "channel.interrupt": {
      if (channel?.receipt === "exact" && row.msg_id !== null) {
        const r = await read(
          s,
          "channel.receipt",
          { target: params.target, msgId: row.msg_id },
          narrowMessageCheck,
        );
        if ("unknown" in r) return unknown(r.unknown);
        if (r.value.state === "accepted")
          return { state: "recorded", via: "receipt", result: r.value };
        return unknown(`receipt: ${r.value.state}`);
      }
      return dedupedDelivery(row, newest, channel?.dedupe?.[deliveryName(row.method)], resend);
    }
    case "channel.abort": {
      const r = await read(s, "channel.readStates", { targets: [params.target] }, narrowObject);
      if ("unknown" in r) return unknown(r.unknown);
      const states = Object.values(r.value) as Array<{ state?: unknown }>;
      if (states.length === 1 && states[0]?.state === "idle") {
        return { state: "recorded", via: "idle", result: r.value };
      }
      return unknown("the agent is not idle");
    }
    case "channel.answer":
    case "channel.command":
      return dedupedDelivery(row, newest, channel?.dedupe?.[deliveryName(row.method)], resend);
    default:
      return unknown(`no rule for ${row.method}`);
  }

  function dedupedDelivery(
    r: EffectRow,
    isNewest: boolean,
    d: { windowMs: number } | undefined,
    again: () => Promise<Resolution>,
  ): Promise<Resolution> | Resolution {
    if (!within(d)) return unknown(`delivery unknown: ${r.method} has no dedupe in its window`);
    if (!isNewest) return unknown("delivery unknown: a newer delivery to the agent was written");
    return again();
  }
}

const deliveryName = (method: string) =>
  method.slice("channel.".length) as "send" | "fresh" | "interrupt" | "answer" | "command";

/** A read: its value, or `unknown` for no answer. */
async function read<T>(
  s: PluginSession,
  method: string,
  params: Record<string, unknown>,
  narrow: (x: unknown) => Narrowed<T>,
): Promise<{ value: T } | { unknown: string }> {
  try {
    return {
      value: await s.call(
        method,
        params,
        { kind: "read", timeoutMs: PLUGIN_READ_TIMEOUT_MS },
        narrow,
      ),
    };
  } catch (e) {
    if (e instanceof PluginAnswerUnknownError) return { unknown: e.reason };
    throw e;
  }
}

/**
 * `lookup(key)`. `found` is the result; `pending` and `unknown` leave the row. `none` proves
 * nothing happened only when the creator and the plugin group the row was sent to are proven
 * gone, and either the lookup was fenced (`fenceKey`) or `inFlightMs` has passed since the
 * intent. A `handle: "file"` kind never acts on `none`: its dispatcher is the view pane.
 */
async function lookup(
  s: PluginSession,
  row: EffectRow,
  params: Record<string, unknown>,
  caps: KeyCaps,
  fileKind: boolean,
): Promise<Resolution> {
  const owners = creatorGone(row) && pluginGroupGone(row);
  const fence = caps.fenceKey && owners && !fileKind;
  const method = row.method === "job.start" ? "job.lookup" : "host.lookup";
  const narrow = row.method === "job.start" ? narrowJobLookup : narrowHostLookup;
  const r = await read(s, method, { target: params.target, key: row.key, fence }, narrow);
  if ("unknown" in r) return unknown(r.unknown);
  const l = r.value;
  if ("found" in l) return { state: "recorded", via: "lookup", result: l.found };
  if ("pending" in l) return unknown("the plugin says it is still in flight");
  if ("unknown" in l) return unknown(l.unknown);
  if (fileKind) return unknown("lookup: none (a file-handle kind's job file decides)");
  const settled =
    fence || (caps.inFlightMs !== undefined && Date.now() - row.created_at >= caps.inFlightMs);
  if (owners && settled) return { state: "none" };
  return unknown("lookup: none, which proves nothing yet (D4 gate)");
}
