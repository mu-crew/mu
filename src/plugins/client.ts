// mu — a started plugin: the handshake, the load rules and one call
// (spec 2026-11-09-mu-plugins.md, D13, D14).
//
// The plugin gets mu's environment minus every local-only mu variable
// (`LOCAL_ONLY_ENV`, which covers MU_DB_PATH, MU_STATE_DIR and MU_SYNC_DIR):
// it reaches nothing of mu's but its own stdin, and every call's `target`
// carries all the identity it needs. A plugin only reports facts: mu records
// them; the plugin never writes mu's DB, state or log.
//
// Errors by `data.kind`: `retryable` is retried, at most three times, with the
// same params under a fresh id and deadline; `permanent` and `human` throw
// `PluginCallError`; `unknown-outcome` throws `EffectOutcomeUnknownError` for
// an effect and `PluginAnswerUnknownError` for a read. No answer (a deadline,
// a cancel, the plugin gone, an invalid message) is the same unknown, unless
// the request never went out.

import { LOCAL_ONLY_ENV } from "../remote-agent.js";
import {
  EffectOutcomeUnknownError,
  PluginAnswerUnknownError,
  PluginCallError,
  PluginRefusedError,
} from "./errors.js";
import {
  muTerminating,
  PluginProcess,
  RpcFailure,
  RpcUnanswered,
  terminatingReason,
} from "./process.js";
import {
  type InitializeResult,
  loadRefusals,
  type Narrowed,
  narrowInitializeResult,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  type SeamName,
} from "./protocol.js";

/** Reads (the handshake, status, lookups) take 10 s (D13 Timeouts). */
export const PLUGIN_READ_TIMEOUT_MS = 10_000;

/** A `retryable` error is retried at most this many times. */
export const PLUGIN_RETRIES = 3;

/** mu's major version, as the handshake names it. */
const MU_VERSION = "5";

/** The environment a plugin starts with: mu's, minus the local-only mu variables. */
export function pluginEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of LOCAL_ONLY_ENV) delete out[k];
  return out;
}

export interface CallOptions {
  /** `effect`: it may change something outside mu (D4); `read`: it changes nothing. */
  kind: "read" | "effect";
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One started, handshaken plugin. */
export interface PluginSession {
  readonly name: string;
  readonly init: InitializeResult;
  readonly process: PluginProcess;
  /** `params` exactly as persisted (D4): the envelope id and `deadline` are fresh per send. */
  call<T>(
    method: string,
    params: Record<string, unknown>,
    opts: CallOptions,
    narrow: (x: unknown) => Narrowed<T>,
  ): Promise<T>;
  shutdown(): Promise<void>;
}

/**
 * Start `argv`, run the handshake, apply the load rules. A refusal reaps the process and
 * throws `PluginRefusedError` (exit 4).
 */
export async function startPlugin(
  name: string,
  argv: readonly string[],
  opts: { needs?: readonly SeamName[]; graceMs?: number } = {},
): Promise<PluginSession> {
  let proc: PluginProcess;
  try {
    proc = await PluginProcess.start(argv, pluginEnv(), opts.graceMs);
  } catch (e) {
    // mu is terminating: nothing new starts (process.ts, the latch).
    if (e instanceof RpcUnanswered)
      throw new PluginCallError(name, "start", "permanent", e.message);
    throw new PluginRefusedError(name, [`it did not start: ${(e as Error).message}`]);
  }
  let init: InitializeResult;
  try {
    const raw = await proc.request(
      "initialize",
      { protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX }, mu: MU_VERSION },
      { timeoutMs: PLUGIN_READ_TIMEOUT_MS },
    );
    const r = narrowInitializeResult(raw);
    if (!r.ok) throw new PluginRefusedError(name, [`its handshake is invalid: ${r.reason}`]);
    const refusals = loadRefusals(r.value, { name, ...(opts.needs ? { needs: opts.needs } : {}) });
    if (refusals.length > 0) throw new PluginRefusedError(name, refusals);
    init = r.value;
    // Stopped during the handshake (a signal, its leader's exit): no session.
    if (!proc.ready()) throw new RpcUnanswered(proc.broken ?? "the plugin stopped", true);
  } catch (e) {
    await proc.shutdown();
    if (e instanceof PluginRefusedError) throw e;
    const latched = muTerminating();
    if (latched !== undefined) {
      throw new PluginCallError(name, "initialize", "permanent", terminatingReason(latched));
    }
    const why = e instanceof RpcFailure ? `${e.kind}: ${e.message}` : (e as Error).message;
    const stderr = proc.stderrLine();
    throw new PluginRefusedError(name, [
      `its handshake failed: ${why}${stderr !== "" && !why.includes(stderr) ? ` (stderr: ${stderr})` : ""}`,
    ]);
  }
  return session(name, init, proc);
}

function session(name: string, init: InitializeResult, proc: PluginProcess): PluginSession {
  return {
    name,
    init,
    process: proc,
    shutdown: () => proc.shutdown(),
    async call(method, params, opts, narrow) {
      const unknown = (reason: string): Error =>
        opts.kind === "effect"
          ? new EffectOutcomeUnknownError(name, method, reason)
          : new PluginAnswerUnknownError(name, method, reason);
      for (let attempt = 0; ; attempt++) {
        let raw: unknown;
        try {
          raw = await proc.request(
            method,
            { ...params, deadline: Date.now() + opts.timeoutMs },
            { timeoutMs: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) },
          );
        } catch (e) {
          if (e instanceof RpcFailure) {
            if (e.kind === "unknown-outcome") throw unknown(e.message);
            if (e.kind === "retryable" && attempt < PLUGIN_RETRIES) continue;
            throw new PluginCallError(name, method, e.kind, e.message, e.remedy);
          }
          if (e instanceof RpcUnanswered) {
            if (!e.sent) throw new PluginCallError(name, method, "permanent", e.message);
            throw unknown(e.message);
          }
          throw e;
        }
        const r = narrow(raw);
        if (r.ok) return r.value;
        proc.poison(`an invalid ${method} result (${r.reason})`);
        throw unknown(`an invalid result: ${r.reason}`);
      }
    },
  };
}
