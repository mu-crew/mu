// mu — `mu hook`: the hook entries mu installs into a harness's config (spec D7, D13).
//
//   mu hook stop <harness> [--timeout <seconds>] [--json]   (payload on stdin)
//
// A harness runs the entry with its hook payload on stdin. stdout is the
// harness's protocol, not mu's envelope: nothing lets the turn end, and a
// block is `{"decision":"block","reason":…}` (claude, codex) or
// `{"followup_message":…}` (cursor-agent). The verb never fails a turn: it
// exits 0 whatever happens, and a failure only lets the turn end (one line on
// stderr). That includes a malformed entry: claude and codex read exit 2 from
// a Stop hook as "block, and hand stderr to the model", so a bad `--timeout`,
// an unknown option or a missing harness must not reach commander's usage
// error (runCli exits 0 for any `hook` argv, see hookArgv). `--json` prints
// mu's envelope with the decision instead, for a human or a test reading what
// the hook would do. src/hook-stop.ts decides.

import { type Command, CommanderError } from "commander";
import { emitJson, JSON_OPT, parseSeconds } from "../cli.js";
import { openDb } from "../db.js";
import {
  runStopHook,
  STOP_HOOK_TIMEOUT_S,
  type StopDecision,
  stopHookOutput,
} from "../hook-stop.js";
import { importStateIfDue } from "../state-import.js";
import { readStdinRaw } from "./stdin.js";

/** A hook payload larger than this is not a Stop payload: read no further. */
const PAYLOAD_CAP = 4 * 1024 * 1024;

interface HookStopOpts {
  timeout?: string;
  json?: boolean;
}

/** `--timeout` read leniently: a value parseSeconds refuses means the default. */
export function hookTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined) return STOP_HOOK_TIMEOUT_S;
  try {
    return parseSeconds(raw);
  } catch {
    return STOP_HOOK_TIMEOUT_S;
  }
}

/** True when `args` (argv after node and mu) runs a `mu hook` verb. */
export function hookArgv(args: readonly string[]): boolean {
  return args.find((a) => !a.startsWith("-")) === "hook";
}

/**
 * runCli's answer to a parse or action error on a `hook` argv: one line on
 * stderr and exit 0, never commander's exit 2 (a Stop block for claude and
 * codex). Help and --version keep their own exit 0 and print nothing more.
 */
export function hookParseFailure(err: unknown): number {
  if (!(err instanceof CommanderError && err.exitCode === 0)) {
    process.stderr.write(`mu hook: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return 0;
}

/** One Stop, decided; never throws. */
export async function hookStop(
  harness: string | undefined,
  timeoutS: number,
): Promise<StopDecision> {
  if (harness === undefined) return { decision: "allow", why: "no harness named" };
  try {
    const raw = await readStdinRaw(PAYLOAD_CAP);
    let payload: unknown = {};
    try {
      payload = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return { decision: "allow", why: "the hook payload is not JSON" };
    }
    await importStateIfDue();
    const db = openDb();
    try {
      return await runStopHook(db, harness, payload, { timeoutS });
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      decision: "allow",
      why: `failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function wireHookCommand(program: Command): void {
  const hook = program
    .command("hook")
    .description(
      "Hook entries for claude, codex and cursor-agent: each reads the hook payload on stdin and never fails the turn",
    );
  hook
    .command("stop")
    .argument("[harness]", "the harness running the hook: claude, codex or cursor-agent")
    .description(
      "Stop hook for a mu pane agent: an orchestrator keeps driving (it waits as its caller and is blocked with the event), a worker owning a task is told once to close it. stdout is the block answer; empty lets the turn end",
    )
    .option(
      "--timeout <seconds>",
      `the hook entry's own timeout; the wait ends 10 s before it (default ${STOP_HOOK_TIMEOUT_S}, also for a value that is not seconds)`,
    )
    .option(...JSON_OPT)
    // A hook entry from an older or newer mu must still exit 0: tolerate
    // options and arguments this mu does not know.
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async function (this: Command, harness: string | undefined) {
      const o = this.optsWithGlobals() as HookStopOpts;
      const d = await hookStop(harness, hookTimeoutSeconds(o.timeout));
      const output = stopHookOutput(harness ?? "", d);
      if (o.json === true) {
        emitJson({ harness: harness ?? null, ...d, output });
        return;
      }
      if (d.decision === "allow" && /\bfailed\b/.test(d.why)) {
        process.stderr.write(`mu hook stop: ${d.why}\n`);
      }
      if (output !== "") process.stdout.write(`${output}\n`);
    });
}
