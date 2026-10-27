// mu — `mu delegates`: delegate calls as durable tasks (src/delegates.ts).
//
//   mu delegates [list] [--caller c] [-w ws] [--wave w]   the calls and their states
//   mu delegates show <call-id>                          one call, with its request
//   mu delegates tally -w <ws> --wave <w>                 verdicts grouped per judged task
//   mu delegates register | mark | finish                 the writers the pi extension calls
//   mu delegates reissue <call-id>                        refuses: the tool's job (see cmdDelegatesReissue)
//
// The extension shells out to the writers (VISION § 1: the CLI is the
// product), so a script gets exactly the same lifecycle.

import type { Command } from "commander";
import {
  CliExitError,
  emitJson,
  emitJsonCollection,
  handle,
  JSON_OPT,
  parseNonNegativeInt,
  parsePositiveNumber,
  resolveWorkstream,
  UsageError,
  WORKSTREAM_OPT,
} from "../cli.js";
import type { Db } from "../db.js";
import { type DelegateRunResult, runDelegateProcess } from "../delegate-process.js";
import {
  type DelegateRequest,
  type DelegateRow,
  finishDelegate,
  getDelegateCall,
  listDelegates,
  markDelegate,
  registerDelegateCall,
  verdictTally,
} from "../delegates.js";
import { muTable, pc } from "../output.js";
import { qualifiedRefProblem } from "../workstream-scope.js";
import { readStdinText, STDIN_ARG } from "./stdin.js";

interface WsOpt {
  workstream?: string;
  json?: boolean;
}

/** Reissue is the owning pi session's: only its live runtime drains a queued call. */
const reissueHint = (callId: string): string => `mu_delegate_reissue { call_id: "${callId}" }`;

const callerFromEnv = (): string | undefined => {
  const session = process.env.PI_SESSION_ID;
  return session ? `pi:${session}` : undefined;
};

function renderRows(rows: readonly DelegateRow[]): string {
  const t = muTable({ head: ["CALL", "TASK", "STATE", "WAVE", "AGENT", "JUDGES", "VERDICT"] });
  for (const r of rows)
    t.push([
      r.callId,
      `${r.workstream}/${r.task}`,
      r.state,
      r.wave ?? "",
      r.agent ?? "",
      r.record ? `${r.record.workstream}/${r.record.task}` : "",
      r.verdict ?? "",
    ]);
  return t.toString();
}

export async function cmdDelegatesList(
  db: Db,
  opts: WsOpt & { caller?: string; wave?: string; all?: boolean },
): Promise<void> {
  const caller = opts.caller ?? (opts.all === true ? undefined : callerFromEnv());
  const rows = listDelegates(db, caller, opts.workstream, {
    ...(opts.wave !== undefined ? { wave: opts.wave } : {}),
  });
  if (opts.json) return emitJsonCollection(rows);
  if (rows.length === 0) {
    console.log(
      caller !== undefined && opts.caller === undefined
        ? "no delegate calls of this caller (--all lists every caller's)"
        : "no delegate calls",
    );
    return;
  }
  console.log(renderRows(rows));
  const refused = rows.filter((r) => r.state === "refused");
  if (refused.length > 0)
    console.log(
      pc.yellow(
        `${refused.length} refused past the cap: reissue each once in its pi session, e.g. ${reissueHint(refused[0]?.callId ?? "")}`,
      ),
    );
}

export async function cmdDelegatesShow(db: Db, callId: string, opts: WsOpt): Promise<void> {
  const row = getDelegateCall(db, callId);
  if (!row) throw new UsageError(`no such delegate call: ${callId}`, { showHelp: false });
  if (opts.json) return emitJson({ call: row });
  console.log(renderRows([row]));
  if (row.error) console.log(pc.yellow(`error: ${row.error}`));
  console.log(pc.dim(`brief and report: mu task notes ${row.task} -w ${row.workstream}`));
}

export async function cmdDelegatesTally(db: Db, opts: WsOpt & { wave?: string }): Promise<void> {
  if (opts.wave === undefined) throw new UsageError("tally needs --wave <label>");
  const ws = await resolveWorkstream(opts.workstream);
  const t = verdictTally(db, ws, opts.wave);
  if (opts.json) return emitJson(t);
  const table = muTable({ head: ["FINDING", "CONFIRMED", "REFUTED", "UNVERIFIED", "PENDING"] });
  for (const f of t.findings)
    table.push([
      f.id,
      String(f.confirmed),
      String(f.refuted),
      String(f.unverified),
      String(f.pending),
    ]);
  console.log(table.toString());
  console.log(`queued ${t.queued}, running ${t.running}, refused ${t.refused.length}`);
  if (t.refused.length > 0)
    console.log(
      pc.yellow(`reissue a refused call in its pi session: ${reissueHint(t.refused[0] ?? "")}`),
    );
}

export interface RegisterOpts extends WsOpt {
  caller?: string;
  text?: string;
  label?: string;
  cli?: string;
  model?: string;
  cwd?: string;
  workspace?: boolean;
  timeout?: number;
  keep?: boolean;
  wave?: string;
  record?: string;
  state?: "queued" | "starting" | "refused";
}

export async function cmdDelegatesRegister(
  db: Db,
  callId: string,
  opts: RegisterOpts,
): Promise<void> {
  const ws = await resolveWorkstream(opts.workstream);
  const caller = opts.caller ?? callerFromEnv();
  if (caller === undefined) throw new UsageError("register needs --caller <session>");
  if (opts.text === undefined)
    throw new UsageError("register needs --text <prompt> (or `-` for stdin)");
  const text = opts.text === STDIN_ARG ? await readStdinText("prompt") : opts.text;
  if (text.trim() === "") throw new UsageError("the prompt is empty", { showHelp: false });
  let record: { workstream: string; task: string } | undefined;
  if (opts.record !== undefined) {
    const problem = qualifiedRefProblem(opts.record);
    const slash = opts.record.indexOf("/");
    if (problem !== undefined || slash < 0)
      throw new UsageError(problem ?? `--record needs <workstream>/<task>, got ${opts.record}`, {
        showHelp: false,
      });
    record = { workstream: opts.record.slice(0, slash), task: opts.record.slice(slash + 1) };
  }
  const request: DelegateRequest = {
    text,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.cli !== undefined ? { cli: opts.cli } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.workspace === true ? { workspace: true } : {}),
    ...(opts.timeout !== undefined ? { timeoutS: opts.timeout } : {}),
    ...(opts.keep === true ? { keep: true } : {}),
  };
  const out = registerDelegateCall(db, {
    callId,
    caller,
    workstream: ws,
    request,
    ...(opts.wave !== undefined ? { wave: opts.wave } : {}),
    ...(record ? { record } : {}),
    ...(opts.state !== undefined ? { state: opts.state } : {}),
  });
  if (opts.json) return emitJson(out);
  console.log(
    `${out.created ? "registered" : "already registered"} ${callId} as ${ws}/${out.call.task} (${out.call.state})`,
  );
}

export async function cmdDelegatesMark(
  db: Db,
  callId: string,
  to: string,
  opts: WsOpt & { agent?: string; error?: string },
): Promise<void> {
  if (to !== "queued" && to !== "starting" && to !== "running" && to !== "refused")
    throw new UsageError(`mark takes queued | starting | running | refused, got ${to}`);
  const call = markDelegate(db, callId, to, {
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  });
  if (opts.json) return emitJson({ call });
  console.log(`${callId}: ${call.state}`);
}

export async function cmdDelegatesFinish(
  db: Db,
  callId: string,
  opts: WsOpt & {
    outcome?: string;
    text?: string;
    author?: string;
    elapsedMs?: number;
    record?: boolean;
  },
): Promise<void> {
  if (opts.outcome === undefined)
    throw new UsageError("finish needs --outcome <done|timeout|died|...>");
  if (opts.author === undefined) throw new UsageError("finish needs --author <name>");
  const text = opts.text === STDIN_ARG ? await readStdinText("answer") : opts.text;
  const result = finishDelegate(db, callId, {
    outcome: opts.outcome,
    ...(text !== undefined ? { text } : {}),
    ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
    author: opts.author,
    ...(opts.record === false ? { record: false } : {}),
  });
  if (opts.json) return emitJson(result);
  console.log(
    result.changed
      ? `${callId}: ${result.state}${result.recorded ? ` (verdict on ${result.record?.workstream}/${result.record?.task})` : ""}${result.error ? ` — ${result.error}` : ""}`
      : `${callId}: already ${result.state}; nothing written`,
  );
}

/**
 * Run one call in a child pi with no multiplexer, in the foreground, until it
 * is finished durably (SIGINT/SIGTERM cancel it). Exit 0 only for a recorded
 * answer; a refused, unknown, failed or cancelled call exits 1 and says why.
 * `keep` holds the live child (its stdin is its lifeline) until Ctrl-C.
 */
export async function cmdDelegatesRun(
  db: Db,
  callId: string,
  opts: WsOpt & { keep?: boolean },
): Promise<void> {
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let r: DelegateRunResult;
  try {
    r = await runDelegateProcess(db, callId, {
      signal: ac.signal,
      ...(opts.keep === false ? { keep: false } : {}),
    });
    const { live, ...shown } = r;
    if (opts.json) emitJson(shown);
    else {
      console.log(
        r.ran
          ? `${callId}: ${r.outcome} (${r.state}), task ${r.workstream}/${r.task}, log ${r.logPath}${r.sessionFile ? `, session ${r.sessionFile}` : ""}`
          : `${callId}: already ${r.state}; nothing run`,
      );
      if (r.error) console.log(pc.yellow(r.error));
      if (r.workspace) console.log(`workspace: ${r.workspace}`);
      if (live)
        console.log(pc.dim("keep: holding the child until Ctrl-C (its stdin is its lifeline)"));
    }
    if (live) {
      ac.signal.addEventListener("abort", () => void live.stop(), { once: true });
      await live.exited;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  if (r.ran && r.state !== "done") throw new CliExitError(1);
}

/**
 * Always refuses. A reissued call is `queued`, and nothing drains a durable
 * queued row except the live pi runtime that holds the queue, so a shell
 * reissue would strand it. The tool does the whole move (start or queue).
 */
export async function cmdDelegatesReissue(_db: Db, callId: string, _opts: WsOpt): Promise<void> {
  throw new UsageError(
    `reissue runs inside the pi session that owns the call: use ${reissueHint(callId)} there (a shell would leave it queued with nothing to start it)`,
    { showHelp: false },
  );
}

export function wireDelegatesCommands(program: Command): void {
  const d = program
    .command("delegates")
    .description(
      "Delegate calls as tasks: list (default), show, tally a wave. Each call is a kind=delegate task with a call id and a state (queued starting running recording done failed refused cancelled); reissue with the `mu_delegate_reissue` tool.",
    );
  d.command("list", { isDefault: true })
    .description("List calls: of $PI_SESSION_ID's session (else every caller), or --caller, --all")
    .option("--caller <id>", "calls of this caller (pi:<session>)")
    .option("--all", "every caller")
    .option("--wave <label>", "only this wave")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).optsWithGlobals() as WsOpt & {
        caller?: string;
        wave?: string;
        all?: boolean;
      };
      return handle((db) => cmdDelegatesList(db, opts), this as Command)();
    });
  d.command("show <call-id>")
    .description("One call: state, agent, verdict, error; its brief and report are on the task")
    .option(...JSON_OPT)
    .action(function (callId: string) {
      const opts = (this as Command).optsWithGlobals() as WsOpt;
      return handle((db) => cmdDelegatesShow(db, callId, opts), this as Command)();
    });
  d.command("tally")
    .description(
      "One wave's verdicts grouped per judged task (CONFIRMED/REFUTED/UNVERIFIED; the rest pending), with queued, running and refused counts. One result per call; a refused call is pending until reissued",
    )
    .requiredOption("--wave <label>", "the wave label")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).optsWithGlobals() as WsOpt & { wave?: string };
      return handle((db) => cmdDelegatesTally(db, opts), this as Command)();
    });
  d.command("register <call-id>")
    .description(
      "Create a delegate call: the kind=delegate task, its brief and the call row, in one transaction. The same id with the same request is a no-op; a changed request is refused (exit 4). The record task must exist",
    )
    .option("--caller <id>", "the calling session (default pi:$PI_SESSION_ID)")
    .option("--text <prompt>", "the whole prompt (`-` reads stdin)")
    .option("--label <label>", "names the delegate")
    .option("--cli <key>", "agent cli key")
    .option("--model <id>", "pi --model value")
    .option("--cwd <dir>", "start directory")
    .option("--workspace", "own git worktree")
    .option("--timeout <seconds>", "seconds to wait for the answer", parsePositiveNumber)
    .option("--keep", "keep the pane after it finishes")
    .option("--wave <label>", "group this call with the others of one fan-out")
    .option("--record <ws/task>", "write the verdict onto this task")
    .option("--state <state>", "admission: queued (default) | starting | refused")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (callId: string) {
      const opts = (this as Command).optsWithGlobals() as RegisterOpts;
      return handle((db) => cmdDelegatesRegister(db, callId, opts), this as Command)();
    });
  d.command("mark <call-id> <state>")
    .description(
      "Admission step, as a compare-and-set, for the pi runtime that holds the queue: starting (from queued or refused), queued (from refused: only that runtime drains it), running (from starting), refused (from queued or starting)",
    )
    .option("--agent <name>", "the agent running it (with running)")
    .option("--error <text>", "why (with refused)")
    .option(...JSON_OPT)
    .action(function (callId: string, state: string) {
      const opts = (this as Command).optsWithGlobals() as WsOpt & {
        agent?: string;
        error?: string;
      };
      return handle((db) => cmdDelegatesMark(db, callId, state, opts), this as Command)();
    });
  d.command("finish <call-id>")
    .description(
      "Record the answer: the verdict note on the judged task, then the delegate's report and close, in one op group. A failed record leaves the call failed with the answer kept as its report, never done. A repeat is a no-op",
    )
    .option(
      "--outcome <outcome>",
      "done, or why not: timeout, died, error, empty, blocked, cancelled",
    )
    .option("--text <text>", "the answer, or what is known (`-` reads stdin)")
    .option("--author <name>", "who answered (the delegate's name)")
    .option("--elapsed-ms <n>", "how long it ran", parseNonNegativeInt)
    .option("--no-record", "leave the judged task alone (the call never ran)")
    .option(...JSON_OPT)
    .action(function (callId: string) {
      const opts = (this as Command).optsWithGlobals() as WsOpt & {
        outcome?: string;
        text?: string;
        author?: string;
        elapsedMs?: number;
        record?: boolean;
      };
      return handle((db) => cmdDelegatesFinish(db, callId, opts), this as Command)();
    });
  d.command("run <call-id>")
    .description(
      "Run a queued or starting call in a foreground child `pi --mode rpc`, no mux needed: send once, wait, record verdict, report and close. No pane or agent row. SIGINT cancels; an unknown delivery is never resent.",
    )
    .option("--no-keep", "stop the child after the answer even when the call asked for keep")
    .option(...JSON_OPT)
    .action(function (callId: string) {
      const opts = (this as Command).optsWithGlobals() as WsOpt & { keep?: boolean };
      return handle((db) => cmdDelegatesRun(db, callId, opts), this as Command)();
    });
  d.command("reissue <call-id>")
    .description(
      "Refuses: reissue a refused call with the `mu_delegate_reissue` tool in its pi session (only that runtime can start or drain it)",
    )
    .option(...JSON_OPT)
    .action(function (callId: string) {
      const opts = (this as Command).optsWithGlobals() as WsOpt;
      return handle((db) => cmdDelegatesReissue(db, callId, opts), this as Command)();
    });
}
