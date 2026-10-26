/**
 * The extension's side of a durable delegate call: thin wrappers over
 * `mu delegates register | mark | finish | show` (src/cli/delegates.ts).
 * The CLI owns the lifecycle; this only builds argv and reads the envelope,
 * so a shell drives the same states (VISION § 1, rule 2).
 */
import { type MuResult, type MuRunner, parseEnvelope, parseOkEnvelope } from "./mu-run.js";

/** Where a delegate's answer is recorded: a task, resolved by `mu task show`. */
export type RecordTarget = { workstream: string; task: string };

/** The stored spawn request of a call (`delegate_calls.request`). */
export type CallRequest = {
  text: string;
  label?: string;
  cli?: string;
  model?: string;
  cwd?: string;
  workspace?: boolean;
  timeoutS?: number;
  keep?: boolean;
};

/** One call as the extension tracks it: the durable ids and what a start needs. */
export type CallInfo = {
  callId: string;
  caller: string;
  workstream: string;
  /** The delegate task's local id. */
  task: string;
  wave?: string;
  record?: RecordTarget;
  request: CallRequest;
};

export type CallState =
  | "queued"
  | "starting"
  | "running"
  | "recording"
  | "done"
  | "failed"
  | "refused"
  | "cancelled";

/** A `mu delegates` verb that failed: its exit code and the one-line reason. */
export class MuCallError extends Error {
  override readonly name = "MuCallError";
  constructor(
    public readonly verb: string,
    public readonly code: number,
    reason: string,
  ) {
    super(`mu delegates ${verb} failed (exit ${code}): ${reason}`);
  }
}

export type FinishResult = {
  changed: boolean;
  state: CallState;
  recorded: boolean;
  verdict: string | null;
  error?: string;
};

const reason = (r: MuResult): string => {
  const m = parseEnvelope(r.stdout)?.message;
  return (typeof m === "string" ? m : r.stderr || r.stdout).trim();
};

/** The `data` of a success; a failure throws {@link MuCallError}. */
async function call(
  run: MuRunner,
  verb: string,
  args: readonly string[],
  stdin?: string,
): Promise<Record<string, unknown>> {
  const r = await run(["delegates", verb, ...args, "--json"], undefined, stdin);
  // Success is an `ok:true` envelope only: a failure's partial data (or a success
  // whose own data has an `error` field, like a failed record) is not a CLI failure.
  const out = r.code === 0 ? parseOkEnvelope(r.stdout) : undefined;
  if (out === undefined) throw new MuCallError(verb, r.code, reason(r));
  return out;
}

const rowOf = (data: Record<string, unknown>): Record<string, unknown> =>
  (data.call ?? {}) as Record<string, unknown>;

/** The CLI's call row as a {@link CallInfo}. */
export function callInfoOf(row: Record<string, unknown>): CallInfo {
  const rec = row.record as { workstream?: string; task?: string } | null | undefined;
  return {
    callId: String(row.callId),
    caller: String(row.caller),
    workstream: String(row.workstream),
    task: String(row.task),
    ...(typeof row.wave === "string" ? { wave: row.wave } : {}),
    ...(rec?.workstream && rec.task
      ? { record: { workstream: rec.workstream, task: rec.task } }
      : {}),
    request: (row.request ?? { text: "" }) as CallRequest,
  };
}

export function callsApi(run: MuRunner) {
  return {
    /** Create the call (task + brief + row, atomically). `created: false`: this id already existed. */
    async register(
      c: Omit<CallInfo, "task">,
      state: "queued" | "starting" | "refused",
    ): Promise<{ call: CallInfo; state: CallState; created: boolean }> {
      const q = c.request;
      const args = [
        c.callId,
        "--caller",
        c.caller,
        "-w",
        c.workstream,
        "--text",
        "-",
        "--state",
        state,
        ...(q.label ? ["--label", q.label] : []),
        ...(q.cli ? ["--cli", q.cli] : []),
        ...(q.model ? ["--model", q.model] : []),
        ...(q.cwd ? ["--cwd", q.cwd] : []),
        ...(q.workspace === true ? ["--workspace"] : []),
        ...(q.timeoutS !== undefined ? ["--timeout", String(q.timeoutS)] : []),
        ...(q.keep === true ? ["--keep"] : []),
        ...(c.wave ? ["--wave", c.wave] : []),
        ...(c.record ? ["--record", `${c.record.workstream}/${c.record.task}`] : []),
      ];
      const data = await call(run, "register", args, q.text);
      const row = rowOf(data);
      return {
        call: callInfoOf(row),
        state: row.state as CallState,
        created: data.created === true,
      };
    },
    /** One admission step (a compare-and-set on the stored state). */
    async mark(
      callId: string,
      to: "queued" | "starting" | "running" | "refused",
      extra: { agent?: string; error?: string } = {},
    ): Promise<void> {
      await call(run, "mark", [
        callId,
        to,
        ...(extra.agent ? ["--agent", extra.agent] : []),
        ...(extra.error ? ["--error", extra.error] : []),
      ]);
    },
    /** The recorder: verdict note, report and close, in one op group. Idempotent. */
    async finish(
      callId: string,
      o: { outcome: string; text?: string; elapsedMs?: number; author: string; record?: boolean },
    ): Promise<FinishResult> {
      const data = await call(
        run,
        "finish",
        [
          callId,
          "--outcome",
          o.outcome,
          "--author",
          o.author,
          ...(o.elapsedMs !== undefined ? ["--elapsed-ms", String(Math.round(o.elapsedMs))] : []),
          ...(o.record === false ? ["--no-record"] : []),
          ...(o.text?.trim() ? ["--text", "-"] : []),
        ],
        o.text?.trim() ? o.text : undefined,
      );
      return data as unknown as FinishResult;
    },
    async show(
      callId: string,
    ): Promise<{ call: CallInfo; state: CallState; verdict: string | null }> {
      const row = rowOf(await call(run, "show", [callId]));
      return {
        call: callInfoOf(row),
        state: row.state as CallState,
        verdict: typeof row.verdict === "string" ? row.verdict : null,
      };
    },
  };
}
