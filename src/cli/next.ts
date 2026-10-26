// mu — `mu next`: the executor's verb (src/next.ts).
//
//   mu next [--dry] [--hold] [--cap N] [--timeout s] [--on-stall exit|warn|steer|release] [-w ws]
//
// stdout is ONE JSON envelope for every outcome, success or interrupted, bounded
// to 4 KB (`moves` are cut on a record boundary with `movesCut`, never the
// summary). SIGINT/SIGTERM are installed before the DB opens: the pass stops
// between effects (one in flight finishes, it is journaled), the one document
// says `interrupted`, exit 130/143. Exit: 0 done, cap reached or timed out; 1 a
// spawn failed unsent; 6 a worker died with nothing more to do (`--hold`); 7 a
// stall, a dialog, or this caller's human need; 130/143 a signal. Never ANSI.

import type { Command } from "commander";
import { spawnerFromEnv } from "../agents/spawn.js";
import {
  emitJson,
  handle,
  JSON_OPT,
  normalizeInheritedWorkstream,
  parsePositiveInt,
  parseSeconds,
  resolveWorkstream,
  WORKSTREAM_OPT,
} from "../cli.js";
import type { Db } from "../db.js";
import { type ExecuteNextOptions, executeNext, type NextMove, type NextResult } from "../next.js";
import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../output-contract.js";
import { CliExitError } from "./handle.js";
import { installWaitSignals, parseOnStall, type WaitSignals } from "./wait.js";

interface NextOpts {
  dry?: boolean;
  hold?: boolean;
  cap?: number;
  workers?: number;
  timeout?: number;
  onStall?: string;
  workstream?: string | string[];
}

const REASON_CHARS = 200;

/** One move as a flat record: the reason clipped, empty fields gone. */
function moveRecord(m: NextMove): Record<string, unknown> {
  const out: Record<string, unknown> = { ...m };
  if (typeof m.reason === "string" && m.reason.length > REASON_CHARS) {
    out.reason = `${m.reason.slice(0, REASON_CHARS)}…`;
  }
  return out;
}

/** The result document, bounded to RESULT_BYTES on its FINAL bytes. The summary is never cut; moves are, from the end. */
export function nextData(r: NextResult, exit: number, signal?: string): Record<string, unknown> {
  const head = {
    workstream: r.workstream,
    dry: r.dry,
    cap: r.cap,
    used: r.used,
    exit,
    ...(r.stopped !== undefined ? { stopped: r.stopped } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(r.held !== undefined ? { held: r.held } : {}),
    ...(r.inFlight !== undefined ? { inFlight: r.inFlight } : {}),
    ...(r.human_needed !== undefined
      ? {
          human_needed: r.human_needed.map((n) => ({
            ...n,
            reason: n.reason.slice(0, REASON_CHARS),
          })),
        }
      : {}),
  };
  const records = r.moves.map((m) => JSON.stringify(moveRecord(m)));
  const build = (kept: number): Record<string, unknown> => ({
    ...head,
    moves: records.slice(0, kept).map((x) => JSON.parse(x) as unknown),
    ...(kept < records.length
      ? { movesCut: records.length - kept, retrieve: "mu task show <id> -w <ws>; mu next --dry" }
      : {}),
  });
  const fits = (d: Record<string, unknown>): boolean =>
    Buffer.byteLength(encodeEnvelope(okEnvelope(d))) <= RESULT_BYTES;
  let kept = records.length;
  while (kept > 0 && !fits(build(kept))) kept--;
  return build(kept);
}

/** The exit code of a finished invocation. */
export function nextExit(r: NextResult, signal: "SIGINT" | "SIGTERM" | undefined): number {
  if (r.stopped === "interrupted") return signal === "SIGTERM" ? 143 : 130;
  if (r.stopped === "human") return 7;
  if (r.stopped === "failed") return 1;
  return r.held?.exit ?? 0;
}

export async function cmdNext(db: Db, o: NextOpts, sig: WaitSignals): Promise<void> {
  const scope = normalizeInheritedWorkstream(o.workstream);
  const workstream = await resolveWorkstream(scope);
  const opts: ExecuteNextOptions = {
    workstream,
    caller: spawnerFromEnv() ?? "",
    signal: sig.signal,
    ...(o.dry === true ? { dry: true } : {}),
    ...(o.hold === true ? { hold: true } : {}),
    ...(o.cap !== undefined ? { cap: o.cap } : {}),
    ...(o.workers !== undefined ? { workers: o.workers } : {}),
    ...(o.timeout !== undefined ? { timeoutMs: Math.round(o.timeout * 1000) } : {}),
    onStall: parseOnStall(o.onStall),
  };
  const result = await executeNext(db, opts);
  const which = sig.which();
  const exit = nextExit(result, which);
  emitJson(nextData(result, exit, which));
  sig.dispose();
  if (exit !== 0) throw new CliExitError(exit);
}

export function wireNextCommand(program: Command): void {
  program
    .command("next")
    .description(
      [
        "Do the judgement-free moves for tasks authorised HERE (`mu task auto`): retry dead and API-errored workers, resume stored attempts, spawn+claim+brief ready ones. Prints ONE JSON result (`data.moves`, `data.used`, `data.stopped`, `data.exit`).",
        "Never grants permission, accepts, merges or tears down. A dead local worker is reaped (its task reopens and is retried as a new attempt); a LIVE worker whose run ended in an API error is sent its brief again IN PLACE (same pane, never duplicated); a remote worker's tree is never touched (`attention`). Every retry costs one run of the task's ceiling; an `attention` move needs you.",
        "--dry plans with zero writes (no pane, socket or receipt read). --cap bounds effects (default 5, max 100; replays, probes, retries and reaps count). --hold then waits (bounded by --timeout, default 1500 s) for the first event on its workers: a death or API error is recovered and the wait goes on, anything else (a worker finishing, a stall, a dialog) returns it. SIGINT/SIGTERM stop between effects and print the one result.",
      ].join(" "),
    )
    .option("--dry", "plan only: zero writes, no mux, no ctl")
    .option(
      "--hold",
      "after the pass, wait for the first event on the in-flight workers (recovering deaths and API errors)",
    )
    .option(
      "--cap <n>",
      "effects this invocation may perform (default 5, max 100)",
      parsePositiveInt,
    )
    .option(
      "--workers <n>",
      "worker ceiling: no new pane while n workers are working (an IN_PROGRESS task or an attempt in flight); a worker whose task is CLOSED is free. Default: none",
      parsePositiveInt,
    )
    .option(
      "--timeout <seconds>",
      "--hold deadline, fractions allowed (default and cap 1500; 0 = the cap)",
      parseSeconds,
    )
    .option(
      "--on-stall <action>",
      "--hold: exit (default) ends on a stalled worker; warn; steer sends it ONE reminder; release frees its task",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).optsWithGlobals() as NextOpts;
      const sig = installWaitSignals();
      const run = handle((db) => cmdNext(db, opts, sig), this as Command);
      return run().finally(() => sig.dispose());
    });
}

export type { NextResult };
