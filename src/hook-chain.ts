// mu — which mu agent a harness hook runs for, read from its process chain.
//
// A harness hook (`mu hook stop`) must act only for a pane agent mu started,
// never for a checker or a `claude -p` that agent runs, which inherits the
// agent's env. So the hook reads the process table once and walks its parents
// to the first ancestor with an anchor (src/anchors.ts) whose start time
// matches. The rules mirror murmur's placement (its src/process-chain.ts):
//
// - Harnesses are matched by argv, never by process name: the executable's
//   basename, or under an interpreter (`node`, `bun`) the script it runs, or a
//   package directory in that path. The hook process itself never counts.
// - An adjacent run of one harness, nothing between, is ONE harness: a launcher
//   and the binary it starts (`claude < claude`, `codex < codex.real`).
// - A second, separate harness before the anchor means the hook belongs to a
//   nested agent, and it is refused. So does a harness process in print or
//   exec mode (`claude -p`, `codex exec`; see `oneShot`): U0 recorded claude's
//   `claude -p` behind its tool shell, but codex's `codex exec` and muse's
//   `muse exec` directly under the parent's binary, where adjacency alone
//   would merge them into the parent's run. A mu agent is launched interactive
//   (spec D17). murmur splits a run at the same one-shot member for its own
//   placement; this guard stays mu's, since `mu hook stop` acts on mu's DB
//   whatever murmur is installed.
// - The walk ends at the tmux server (the pid `$TMUX` names, else the first
//   ancestor whose argv is tmux's) or at init.
//
// The env is only a fallback (spec D7), for a pane mu could not anchor (herdr,
// Rex) or an unreadable process table: `MU_MANAGED_AGENT`, `MU_AGENT_NAME`,
// `MU_WORKSTREAM` and an `MU_AGENT_CLI` naming the hook's harness. A nested
// agent inherits all of these but runs a different harness than its parent's
// `MU_AGENT_CLI`, or shows up as a second harness in the chain.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorDir } from "./anchors.js";
import { HARNESS_TABLE, HARNESSES, type Harness } from "./harnesses.js";

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Start time in seconds since the epoch (`ps -o lstart=`); null when unreadable. */
  started: number | null;
  args: string;
}

export type ProcessTable = ReadonlyMap<number, ProcessRow>;

/** `pid ppid <lstart, 24 chars under LC_ALL=C> args`. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** Parse `ps -A -o pid=,ppid=,lstart=,args=`; rows that do not parse are skipped. */
export function parseProcessTable(output: string): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>();
  for (const line of output.split("\n")) {
    const m = PS_LINE.exec(line);
    if (m === null) continue;
    const ms = Date.parse((m[3] ?? "").replace(/\s+/g, " "));
    table.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      started: Number.isFinite(ms) ? Math.floor(ms / 1000) : null,
      args: (m[4] ?? "").trim(),
    });
  }
  return table;
}

let tableForTests: (() => Map<number, ProcessRow> | null) | null = null;

/** Replace the `ps` read (tests: no real process table). null restores it. */
export function setProcessTableReaderForTests(
  read: (() => Map<number, ProcessRow> | null) | null,
): void {
  tableForTests = read;
}

/** One `ps` for the whole table, or null when it cannot be read. */
export function readProcessTable(): Map<number, ProcessRow> | null {
  if (tableForTests !== null) return tableForTests();
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart=,args="], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const table = parseProcessTable(out);
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
}

/** Interpreters whose first non-flag argument is the harness's entry point. */
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno"]);

function executableName(token: string): string {
  return token.slice(token.lastIndexOf("/") + 1).replace(/\.(?:real|js|mjs|cjs)$/, "");
}

/**
 * The harness a process's argv names, or null (murmur's `harnessFromArgv`).
 * Arguments past the executable (or an interpreter's script) are never read:
 * a shell running `claude -p …` is a shell, not a claude.
 */
export function harnessFromArgs(args: string): Harness | null {
  const tokens = args.trim().split(/\s+/);
  const first = tokens[0] ?? "";
  const candidates = [first];
  if (INTERPRETERS.has(executableName(first))) {
    const script = tokens.slice(1).find((t) => !t.startsWith("-"));
    if (script !== undefined) candidates.push(script);
  }
  for (const c of candidates) {
    const name = executableName(c);
    const dirs = c.split("/").slice(0, -1);
    for (const h of HARNESSES) {
      const row = HARNESS_TABLE[h];
      if (row.names.includes(name) || dirs.some((d) => row.packages.includes(d))) return h;
    }
  }
  return null;
}

/**
 * Options of codex and Muse Code that take a value in the next argument, so
 * the value is not read as the subcommand (murmur's `VALUE_OPTIONS`). A value
 * glued on (`-c=x`) is one token and needs no entry.
 */
const VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "-i",
  "--image",
  "--enable",
  "--disable",
  "--add-dir",
  "--local-provider",
  "--remote",
  "--remote-auth-token-env",
]);

/** The subcommands of codex and Muse Code that answer one prompt and exit. */
const ONE_SHOT_SUBCOMMANDS = new Set(["exec", "e", "review"]);

/** The arguments after the executable, or after the script under an interpreter. */
function harnessArguments(tokens: readonly string[]): string[] {
  const rest = tokens.slice(1);
  if (!INTERPRETERS.has(executableName(tokens[0] ?? ""))) return rest;
  const script = rest.findIndex((t) => !t.startsWith("-"));
  return script < 0 ? [] : rest.slice(script + 1);
}

/**
 * True when codex or Muse Code's first argument that is neither an option nor
 * an option's value is a one-shot subcommand. Past `--` every argument is the
 * prompt. After an option this table does not know, a bare argument may be
 * its value, so only a one-shot subcommand word still reads as one.
 */
function oneShotSubcommand(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i] as string;
    if (t === "--") return false;
    if (!t.startsWith("-")) return ONE_SHOT_SUBCOMMANDS.has(t);
    if (VALUE_OPTIONS.has(t)) i += 1;
  }
  return false;
}

/**
 * True when a `harness` process's argv runs it one-shot: `codex exec` (or
 * `e`, or `review`), the same for `muse`, `claude -p`/`--print`,
 * `cursor-agent -p`/`--print`. The rule is murmur's `runMode`, so mu's hook
 * and murmur's placement split the same chains; a prompt that merely holds
 * the word `exec` is no subcommand. pi is never one-shot here.
 */
export function oneShot(harness: Harness, args: string): boolean {
  const rest = harnessArguments(args.trim().split(/\s+/));
  switch (harness) {
    case "codex":
    case "muse":
      return oneShotSubcommand(rest);
    case "claude":
    case "cursor-agent":
      return rest.some((t) => t === "-p" || t === "--print" || t.startsWith("--print="));
    case "pi":
      return false;
  }
}

function isTmuxServer(args: string): boolean {
  const base = executableName(args.trim().split(/\s+/)[0] ?? "");
  return base === "tmux" || base === "tmux:";
}

function tmuxServerPid(tmuxEnv: string | undefined): number | null {
  const pid = Number(tmuxEnv?.split(",")[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The fields of an anchor the hook acts on. */
export interface HookAnchor {
  agent_name: string;
  workstream: string;
  cli: string;
  orchestrator: boolean;
  remote_key: string | null;
}

/** An anchor for `row` whose start time matches, or null. */
export type AnchorReader = (row: ProcessRow) => HookAnchor | null;

/** One second of slack: the wrapper and `ps` may round one `lstart` differently. */
const START_SLACK_S = 1;

/** Parse one anchor file for `row`; null when it does not parse or its start time differs. */
export function parseHookAnchor(raw: string, row: ProcessRow): HookAnchor | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.start_time !== "number" || row.started === null) return null;
  if (Math.abs(r.start_time - row.started) > START_SLACK_S) return null;
  const text = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);
  const agent = text(r.agent_name);
  const ws = text(r.workstream);
  const cli = text(r.cli);
  if (agent === null || ws === null || cli === null) return null;
  return {
    agent_name: agent,
    workstream: ws,
    cli,
    orchestrator: r.orchestrator === true,
    remote_key: text(r.remote_key),
  };
}

/** Anchors from `dir` (default `~/.local/state/mu-next/anchors`, where the wrapper writes). */
export function anchorReader(dir: string = anchorDir()): AnchorReader {
  return (row) => {
    try {
      return parseHookAnchor(readFileSync(join(dir, `${row.pid}.json`), "utf8"), row);
    } catch {
      return null;
    }
  };
}

/** The mu agent a hook acts for. */
export interface HookAgent {
  name: string;
  workstream: string;
  orchestrator: boolean;
  /** Where the identity came from. */
  source: "anchor" | "env";
}

export type HookAgentResult =
  | { ok: true; agent: HookAgent }
  | {
      ok: false;
      reason:
        | "nested" // a second harness between the hook and the agent
        | "other-harness" // the anchor (or MU_AGENT_CLI) names another harness
        | "remote" // a remote worker: no mu DB here (spec D11)
        | "unmanaged"; // no anchor, and no managed env to fall back on
    };

/** Bound on the walk, against a cycle in a table read mid-fork. */
const MAX_DEPTH = 64;

/**
 * The mu agent the hook process `self`, run by `harness`, acts for (spec D7
 * guards). `table` null (unreadable) falls back to the env alone.
 */
export function hookAgent(
  harness: Harness,
  opts: {
    table: ProcessTable | null;
    self?: number;
    anchor?: AnchorReader;
    env?: NodeJS.ProcessEnv;
  },
): HookAgentResult {
  const env = opts.env ?? process.env;
  if (opts.table !== null) {
    const walked = walk(opts.table, opts.self ?? process.pid, opts.anchor ?? anchorReader(), env);
    if (walked.kind === "nested") return { ok: false, reason: "nested" };
    if (walked.kind === "anchor") {
      const a = walked.anchor;
      if (a.remote_key !== null) return { ok: false, reason: "remote" };
      if (a.cli !== harness) return { ok: false, reason: "other-harness" };
      if (walked.first !== null && walked.first !== harness) {
        return { ok: false, reason: "other-harness" };
      }
      return {
        ok: true,
        agent: {
          name: a.agent_name,
          workstream: a.workstream,
          orchestrator: a.orchestrator,
          source: "anchor",
        },
      };
    }
    if (walked.first !== null && walked.first !== harness) {
      return { ok: false, reason: "other-harness" };
    }
  }
  return envAgent(harness, env);
}

function envAgent(harness: Harness, env: NodeJS.ProcessEnv): HookAgentResult {
  if (env.MU_REMOTE === "1" || (env.MU_REMOTE_KEY ?? "") !== "") {
    return { ok: false, reason: "remote" };
  }
  const { MU_MANAGED_AGENT: managed, MU_AGENT_NAME: name, MU_WORKSTREAM: ws } = env;
  if (managed !== "1" || !name || !ws) return { ok: false, reason: "unmanaged" };
  if (env.MU_AGENT_CLI !== harness) return { ok: false, reason: "other-harness" };
  return {
    ok: true,
    agent: { name, workstream: ws, orchestrator: env.MU_ORCHESTRATOR === "1", source: "env" },
  };
}

type Walked =
  | { kind: "anchor"; anchor: HookAnchor; first: Harness | null }
  | { kind: "nested" }
  | { kind: "none"; first: Harness | null };

function walk(
  table: ProcessTable,
  self: number,
  anchorOf: AnchorReader,
  env: NodeJS.ProcessEnv,
): Walked {
  const server = tmuxServerPid(env.TMUX);
  let first: Harness | null = null;
  let run: Harness | null = null;
  let current = table.get(self);
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined; depth += 1) {
    if (server !== null ? current.pid === server : isTmuxServer(current.args)) break;
    if (current.pid !== self) {
      const h = harnessFromArgs(current.args);
      if (h !== null) {
        if (first === null) first = h;
        else if (run !== h) return { kind: "nested" };
        if (oneShot(h, current.args)) return { kind: "nested" };
      }
      run = h;
      const anchor = anchorOf(current);
      if (anchor !== null) return { kind: "anchor", anchor, first };
    }
    if (current.pid <= 1 || current.ppid === current.pid) break;
    current = table.get(current.ppid);
  }
  return { kind: "none", first };
}
