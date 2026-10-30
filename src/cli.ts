// mu — command-line interface.
//
// One namespace/command per verb group (see `mu --help` for the current
// list), each registered via commander as a thin wrapper around the
// corresponding programmatic function in src/. The real work happens in
// agents.ts, tasks.ts, db.ts, mux.ts; this file is just
// argument parsing, output formatting, and error-to-exit-code
// translation.
//
// Layout: cli.ts is the wiring root. Pure rendering helpers live in
// `src/cli/format.ts`; typed-error → exit-code mapping + the `handle`
// wrapper live in `src/cli/handle.ts`. cli.ts re-exports their public
// surface so existing tests + cli/* importers don't need to change
// import paths. The exit-code catalogue is documented at the top of
// `src/cli/handle.ts`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";

import { AgentNotInWorkstreamError, type AgentRow, getAgent, getAgentByPane } from "./agents.js";
import { wireAgentCommands, wireSelfCommands } from "./cli/agents.js";
import { openDashboardOrHelp } from "./cli/dashboard-launch.js";
import { wireDbCommands } from "./cli/db.js";
import { wireDbQueryCommand } from "./cli/db-query.js";
import { wireDelegatesCommands } from "./cli/delegates.js";
import { wireDoctorCommand } from "./cli/doctor.js";
import {
  emitParseError,
  finalNext,
  findCommandForArgv,
  fitNext,
  NameAmbiguousError,
  setNextScope,
  UsageError,
} from "./cli/handle.js";
import { wireHostCommands } from "./cli/host.js";
import { wireHumanNeededCommand } from "./cli/human-needed.js";
import { wireLogCommand } from "./cli/log.js";
import { wireNextCommand } from "./cli/next.js";
import { wirePiCommand } from "./cli/pi.js";
import { wireRebuildCommand } from "./cli/rebuild.js";
import { wireStateCommands } from "./cli/state.js";
import { wireSyncCommand } from "./cli/sync.js";
import { wireTaskCommands } from "./cli/tasks.js";
import { wireWaitCommand } from "./cli/wait.js";
import { wireWorkstreamCommands } from "./cli/workstream.js";
import { type Db, tryResolveLiveWorkstreamId, WorkstreamNotFoundError } from "./db.js";
import { editDistance } from "./edit-distance.js";
import { encodeEnvelope, okEnvelope, safeJsonLine } from "./output-contract.js";
import { isTaskSortKey, TASK_SORT_KEYS, type TaskSortKey } from "./tasks/sort.js";
import { TASK_SUBSTATES, type TaskSubstate } from "./tasks/status.js";
import {
  isTaskStatus,
  TASK_STATUS_LIST,
  TaskNotInWorkstreamError,
  type TaskStatus,
} from "./tasks.js";
import {
  isScratchWorkstream,
  isValidWorkstreamName,
  resolveMuxSessionWorkstreamName,
} from "./workstream.js";
import {
  parseWorkstreamFragments,
  qualifiedRefProblem,
  workstreamNameProblem,
} from "./workstream-scope.js";

// ─── Re-exports for downstream cli/* modules ──────────────────────────
//
// Pure rendering helpers and the typed-error catalogue live in
// `src/cli/format.ts` and `src/cli/handle.ts`; cli/* modules import
// them through `cli.ts` for ergonomic single-import lines.

export {
  colorPair,
  formatAgentsTable,
  IDLE_GLYPH,
  relTime,
  statusIcon,
  truncate,
  truncateFront,
} from "./cli/format.js";
export {
  CliExitError,
  classifyError,
  handle,
  NameAmbiguousError,
  UsageError,
} from "./cli/handle.js";
export {
  byRoiDesc,
  isTaskSortKey,
  relTimeBasisForSort,
  sortTasks,
  TASK_SORT_KEYS,
  type TaskSortKey,
} from "./tasks/sort.js";

// ─── Workstream resolution ─────────────────────────────────────────────

/**
 * The workstream a mu-spawned worker was injected with, or undefined.
 * Spawn sets `MU_MANAGED_AGENT=1` and `MU_WORKSTREAM` together; the gate
 * keeps a stale `$MU_WORKSTREAM` in a user shell from routing anything.
 */
export function injectedWorkstream(): string | undefined {
  if (process.env.MU_MANAGED_AGENT !== "1") return undefined;
  const ws = process.env.MU_WORKSTREAM;
  if (ws === undefined || ws === "") return undefined;
  return checkWorkstreamName(ws, "$MU_WORKSTREAM");
}

/** The managed worker this process runs as (spawn-injected), or undefined. */
export function injectedIdentity(): { name: string; workstream: string } | undefined {
  const workstream = injectedWorkstream();
  const name = process.env.MU_AGENT_NAME;
  if (workstream === undefined || name === undefined || name === "") return undefined;
  return { name, workstream };
}

/**
 * Validate ONE workstream name from `-w`: exactly what the caller typed,
 * or a UsageError. Empty, blank or padded values are rejected rather than
 * trimmed, because trimming turns a quoting accident into a different,
 * valid workstream (`-w ' auth'` would read `auth`).
 */
export function checkWorkstreamName(value: string, flag = "-w/--workstream"): string {
  const problem = workstreamNameProblem(value, flag);
  if (problem !== undefined) throw new UsageError(problem, { showHelp: false });
  return value;
}

/**
 * Parse repeated / comma-separated `-w` values into names. Like
 * parseCsvFlag, a structurally empty fragment (`"a,"`) is a comma
 * artifact and is dropped; unlike it, a fragment is never trimmed:
 * padded or blank ones, and a lone empty value, are usage errors.
 */
export function parseWorkstreamList(values: readonly string[], flag = "-w/--workstream"): string[] {
  const parsed = parseWorkstreamFragments(values, flag);
  if ("problem" in parsed) throw new UsageError(parsed.problem, { showHelp: false });
  return parsed.names;
}

/**
 * The one-line "no scope" error. The session name is only a SUGGESTION,
 * read best-effort here on the error path; nothing ever routes by it.
 * `extra` carries verb-specific hints (a candidate qualified ref, `--all`).
 */
export async function missingWorkstreamError(
  opts: { extra?: string; orAll?: boolean } = {},
): Promise<UsageError> {
  const parts: string[] = [];
  const session = await resolveMuxSessionWorkstreamName();
  if (session !== null) parts.push(`tmux session mu-${session}: -w ${session}`);
  if (opts.extra !== undefined) parts.push(opts.extra);
  const tail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return new UsageError(`no workstream: pass -w <name>${opts.orAll ? " or --all" : ""}${tail}`, {
    showHelp: false,
  });
}

/**
 * Resolve the workstream a verb acts on. Scope is explicit or injected:
 *   1. `-w <name>` (validated, never trimmed)
 *   2. the injected `$MU_WORKSTREAM` of a managed worker (`MU_MANAGED_AGENT=1`)
 * Anything else is a one-line UsageError. `$MU_SESSION` and the mux
 * session name never route a verb: a silent misroute is worse than a
 * cheap error.
 */
export async function resolveWorkstream(explicit?: string): Promise<string> {
  const ws = explicit !== undefined ? checkWorkstreamName(explicit) : injectedWorkstream();
  if (ws === undefined) throw await missingWorkstreamError();
  setNextScope(ws);
  return ws;
}

/** The live workstreams whose name is near `name`, closest first (at most three). */
function nearWorkstreams(db: Db, name: string): string[] {
  const rows = db.prepare("SELECT name FROM workstreams WHERE torn_down_at IS NULL").all() as {
    name: string;
  }[];
  return rows
    .map((r) => ({ name: r.name, d: editDistance(r.name, name) }))
    .filter((r) => r.d <= Math.max(2, Math.floor(name.length / 3)) || r.name.includes(name))
    .sort((a, b) => a.d - b.d || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((r) => r.name);
}

/** Throw `WorkstreamNotFoundError` (exit 3) unless the workstream `name` is live; the reserved
 *  `scratch` always passes (its first `task add` / `agent spawn` creates it). The one existence
 *  check of every verb that reads or writes inside a workstream. A torn-down name throws
 *  `WorkstreamTornDownError`. */
export function requireLiveWorkstream(db: Db, name: string): void {
  if (isScratchWorkstream(name) || tryResolveLiveWorkstreamId(db, name) !== null) return;
  throw new WorkstreamNotFoundError(name, {
    near: nearWorkstreams(db, name),
    init: isValidWorkstreamName(name),
  });
}

/** `resolveWorkstream`, then the existence check: a typo'd `-w` is exit 3, never an empty
 *  success or a silently created workstream. */
export async function resolveExistingWorkstream(db: Db, explicit?: string): Promise<string> {
  const ws = await resolveWorkstream(explicit);
  requireLiveWorkstream(db, ws);
  return ws;
}

// ─── Qualified entity refs (cross-workstream verb args) ────────────────
//
// Every verb that takes an entity name (mu task show <id>, mu agent
// send <name>, mu agent close <agent>) accepts EITHER:
//   - bare `<name>`           → resolves via current workstream context
//   - qualified `<ws>/<name>` → resolves directly, no -w needed
// Implemented as a parse-at-CLI-entry helper so the SDK signatures
// stay workstream-explicit (no entity ref shape leaks below cli.ts).

export interface ParsedRef {
  /** Workstream prefix when the input was `<ws>/<name>`; undefined for
   *  bare names. */
  workstream?: string;
  /** The bare name (everything after the first '/' if qualified, else
   *  the whole input). */
  name: string;
}

/** Split `<ws>/<name>` on the FIRST '/'. Bare input → workstream=undefined.
 *  Names today are restricted to [a-z0-9_-] (slugify / agent name validator)
 *  so '/' is unambiguous: no entity name can contain it. */
export function parseQualifiedRef(raw: string): ParsedRef {
  const slash = raw.indexOf("/");
  if (slash === -1) return { name: raw };
  return { workstream: raw.slice(0, slash), name: raw.slice(slash + 1) };
}

/** The `<ws>` of a qualified ref goes through the same validator as `-w`:
 *  ` own/t` or `/t` is an error, never trimmed into `own`. */
export function checkQualifiedPrefix(raw: string, workstream: string): string {
  const problem = qualifiedRefProblem(raw) ?? workstreamNameProblem(workstream);
  if (problem !== undefined) throw new UsageError(problem, { showHelp: false });
  return workstream;
}

/** Sync glue: parse a qualified ref and (if qualified) push the
 *  workstream onto opts.workstream. Throws UsageError when the caller
 *  passed BOTH `--workstream A` AND `B/<name>` and they disagree.
 *  Returns the bare name for downstream use. Mutates opts. */
export function applyQualifiedRef(raw: string, opts: { workstream?: string }): string {
  const parsed = parseQualifiedRef(raw);
  if (opts.workstream !== undefined) checkWorkstreamName(opts.workstream);
  if (parsed.workstream === undefined) return raw;
  checkQualifiedPrefix(raw, parsed.workstream);
  if (opts.workstream !== undefined && opts.workstream !== parsed.workstream) {
    throw new UsageError(
      `qualified ref ${JSON.stringify(raw)} (workstream=${JSON.stringify(parsed.workstream)}) conflicts with --workstream ${JSON.stringify(opts.workstream)}`,
      { showHelp: false },
    );
  }
  opts.workstream = parsed.workstream;
  return parsed.name;
}

/** Per-entity table+key+error mapping for findEntityWorkstreams /
 *  resolveEntityRef. Centralised so adding a new entity is one row. */
const ENTITY_TABLES = {
  task: { table: "tasks", keyCol: "local_id" },
  agent: { table: "agents", keyCol: "name" },
} as const;

export type EntityKind = keyof typeof ENTITY_TABLES;

/** List the workstream names where `entity` exists. Used for ambiguity
 *  detection when the bare-name caller has no resolved -w context. */
export function findEntityWorkstreams(db: Db, kind: EntityKind, name: string): string[] {
  const { table, keyCol } = ENTITY_TABLES[kind];
  const rows = db
    .prepare(
      `SELECT ws.name AS workstream FROM ${table} t
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE t.${keyCol} = ?
        ORDER BY ws.name`,
    )
    .all(name) as { workstream: string }[];
  return rows.map((r) => r.workstream);
}

/**
 * One-stop ref resolver for verbs taking an entity name + optional -w.
 *
 * Pipeline:
 *   1. Parse `<ws>/<name>` (qualified form) — sets opts.workstream
 *      from the prefix and returns the bare name.
 *   2. Resolve the workstream: -w, else the injected worker scope
 *      (the ladder in resolveWorkstream). An invalid -w is an error,
 *      never a reason to guess.
 *   3. When no scope exists and the bare name lives in ≥2 workstreams:
 *      throw NameAmbiguousError listing the candidates. Otherwise throw
 *      the one-line missing-scope error, naming the qualified ref when
 *      exactly one workstream has the name. Nothing is routed by a guess.
 *
 * Returns `{ name, workstream }`. The verb then uses `name` for the
 * entity lookup and `workstream` for downstream SDK calls; opts.workstream
 * is mutated to match (so existing helpers like assertTaskInWorkstream
 * still work as the second-line check).
 */
export async function resolveEntityRef(
  db: Db,
  raw: string,
  opts: { workstream?: string },
  kind: EntityKind,
): Promise<{ name: string; workstream: string }> {
  const name = applyQualifiedRef(raw, opts);
  if (opts.workstream !== undefined || injectedWorkstream() !== undefined) {
    return { name, workstream: await resolveExistingWorkstream(db, opts.workstream) };
  }
  const matches = findEntityWorkstreams(db, kind, name);
  if (matches.length >= 2) throw new NameAmbiguousError(name, matches, kind);
  const only = matches[0];
  throw await missingWorkstreamError(only !== undefined ? { extra: `${only}/${name}?` } : {});
}

/** Standard --status validation: case-insensitive, returns the
 *  canonical TaskStatus or throws UsageError naming every legal
 *  value. Centralised so adding a status updates every CLI surface
 *  at once (the OPEN | IN_PROGRESS | CLOSED list used to drift
 *  across `mu task list --status`, `mu task wait --status`, the
 *  --help text, and error messages). Source list lives in
 *  src/tasks.ts as TASK_STATUS_LIST. */
export function parseStatusOption(raw: string, flag = "--status"): TaskStatus {
  const upper = raw.toUpperCase();
  if (!isTaskStatus(upper)) {
    throw new UsageError(`${flag} must be one of ${TASK_STATUS_LIST} (got ${JSON.stringify(raw)})`);
  }
  return upper;
}

/** Multi-status flag parser for the `--status <s...>` shape used by
 *  `mu task list / task next / approve list` (per
 *  task_list_multi_status_union). Composes parseCsvFlag (repeat OR
 *  comma-separated OR mix) with per-element parseStatusOption
 *  validation, then dedups case-insensitively (parseStatusOption
 *  upper-cases). Returns `undefined` when the flag is absent or
 *  resolves to an empty array — semantically "no filter", matching
 *  today's no-`--status` shape. Throws UsageError naming the offending
 *  element on the first invalid value (so the operator sees which one
 *  failed, not just "some value was wrong"). */
export function parseStatusesOption(
  values: readonly string[] | undefined,
  flag = "--status",
): TaskStatus[] | undefined {
  const fragments = parseCsvFlag(values, flag);
  if (fragments.length === 0) return undefined;
  const seen = new Set<TaskStatus>();
  const out: TaskStatus[] = [];
  for (const raw of fragments) {
    const status = parseStatusOption(raw, flag);
    if (seen.has(status)) continue;
    seen.add(status);
    out.push(status);
  }
  return out;
}

/** Every substate across all statuses, in canonical order. */
const ALL_SUBSTATES: readonly TaskSubstate[] = [...new Set(Object.values(TASK_SUBSTATES).flat())];

/** `--substate <s...>` parser: same repeat/comma shape as
 *  parseStatusesOption, validated against every status's substates
 *  (case-insensitive, deduped). undefined = no filter. */
export function parseSubstatesOption(
  values: readonly string[] | undefined,
  flag = "--substate",
): TaskSubstate[] | undefined {
  const fragments = parseCsvFlag(values, flag);
  if (fragments.length === 0) return undefined;
  const out = new Set<TaskSubstate>();
  for (const raw of fragments) {
    const lower = raw.toLowerCase();
    const match = ALL_SUBSTATES.find((s) => s === lower);
    if (match === undefined) {
      throw new UsageError(
        `${flag} must be one of ${ALL_SUBSTATES.join(" | ")} (got ${JSON.stringify(raw)})`,
      );
    }
    out.add(match);
  }
  return [...out];
}

// ─── Self-resolution (injected identity → AgentRow) ────────────────────

/**
 * Resolve "the agent running this process". A mu-spawned worker carries
 * its identity in the env (`MU_AGENT_NAME` + `MU_WORKSTREAM`, injected at
 * spawn), and that is authoritative: the row is looked up by name in that
 * workstream, never guessed from a pane. A managed identity with no row
 * is an error. Only a process with no injected identity falls back to
 * `$TMUX_PANE` (a hand-registered agent, or an adopted pane). Returns null
 * when neither identifies a managed agent.
 */
export function resolveSelfOptional(db: Db): AgentRow | null {
  const injected = injectedIdentity();
  if (injected !== undefined) {
    const row = getAgent(db, injected.name, injected.workstream);
    if (row === undefined) {
      throw new UsageError(
        `injected identity ${injected.workstream}/${injected.name} has no agent row (closed or torn down). Use \`mu agent list -w ${injected.workstream}\`.`,
        { showHelp: false },
      );
    }
    return row;
  }
  const paneId = process.env.TMUX_PANE;
  if (!paneId) return null;
  return getAgentByPane(db, paneId) ?? null;
}

/**
 * Strict variant of `resolveSelfOptional`: throws UsageError when the
 * process is neither a managed worker nor in a managed pane. Used by
 * `mu me` / `mu me tasks` / `mu me next`. Lives in cli.ts so cli/agents.ts
 * and cli/tasks.ts can both import it without a lateral cli/* dependency.
 */
export function resolveSelf(db: Db): AgentRow {
  const agent = resolveSelfOptional(db);
  if (agent) return agent;
  const paneId = process.env.TMUX_PANE;
  throw new UsageError(
    paneId
      ? `pane ${paneId} is not a managed agent. Use \`mu agent list\` to see managed panes, or \`mu agent spawn\` to register a new one.`
      : "not a managed agent: this verb needs the identity spawn injects (MU_AGENT_NAME, MU_WORKSTREAM) or a managed tmux pane",
    { showHelp: false },
  );
}

// ─── Shared SDK-CLI bridge helpers (used by cli/*.ts) ──────────────
//
// These were extracted from inline-with-task-verbs in cli.ts; the
// task verbs moved to src/cli/tasks.ts but the helpers stay here so
// every cli/*.ts module can import them from one canonical location.

export function parseSortOption(raw: string, flag = "--sort"): TaskSortKey {
  if (!isTaskSortKey(raw)) {
    throw new UsageError(
      `${flag} must be one of ${TASK_SORT_KEYS.join(" | ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

// ─── Workstream-scope assertions ──────────────────────────────────────

/**
 * Generic workstream-scope assertion. The two typed wrappers
 * (`assertAgentInWorkstream`, `assertTaskInWorkstream`) share this
 * shape: SELECT the `workstream` column from `<table>` WHERE
 * `<keyCol>` = key, and if the row exists with a non-matching
 * workstream throw a typed `*NotInWorkstreamError`. No-op when
 * `expectedWs` is undefined or the row doesn't exist (downstream
 * handlers raise the matching `*NotFoundError`).
 *
 * Doing the lookup directly via raw SQL (rather than through the
 * typed `getAgent` / `getTask`) keeps the helper decoupled from
 * each row's full schema — it only ever needs the one column. The
 * typed errors are constructed by `errFactory` so each caller keeps
 * its specific error class and exit-code mapping.
 */
export function assertEntityInWorkstream<E extends Error>(
  db: Db,
  table: string,
  keyCol: string,
  keyVal: string,
  expectedWs: string | undefined,
  errFactory: (keyVal: string, expectedWs: string, actualWs: string | null) => E,
): void {
  if (!expectedWs) return;
  // v5: per-scope unique TEXT names mean a bare
  // `WHERE keyCol = ? LIMIT 1` could pick the wrong workstream's row
  // and falsely raise NotInWorkstreamError when the expected workstream
  // ALSO has a row of this name.
  // Fast path: if a row exists in the expected workstream, we're done.
  const inScope = db
    .prepare(
      `SELECT 1 AS hit FROM ${table} t
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE t.${keyCol} = ? AND ws.name = ?
        LIMIT 1`,
    )
    .get(keyVal, expectedWs) as { hit: number } | undefined;
  if (inScope) return;
  // Slow path: name doesn't exist in expected ws — check whether it
  // exists anywhere else so we can raise the typed mismatch error
  // (rather than letting downstream raise the generic NotFoundError).
  // Pick any other workstream's row deterministically.
  const elsewhere = db
    .prepare(
      `SELECT ws.name AS workstream FROM ${table} t
         LEFT JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE t.${keyCol} = ?
        ORDER BY ws.name
        LIMIT 1`,
    )
    .get(keyVal) as { workstream: string | null } | undefined;
  if (elsewhere) {
    throw errFactory(keyVal, expectedWs, elsewhere.workstream);
  }
}

/**
 * Sister of `assertTaskInWorkstream` for verbs that target an agent
 * by name. Agent names are per-workstream unique
 * (`UNIQUE(workstream_id, name)` in src/db.ts), so the same name can
 * exist in multiple workstreams; `-w` is the scope check that turns a
 * wrong-target verb into a clear `AgentNotInWorkstreamError` (exit 4)
 * instead of silently operating on a same-named agent in another
 * workstream. No-op when `workstream` is undefined or the agent
 * doesn't exist (downstream handler raises `AgentNotFoundError`).
 */
export function assertAgentInWorkstream(
  db: Db,
  agentName: string,
  workstream: string | undefined,
): void {
  // agents.workstream is NOT NULL in the schema, so `actual` is
  // never null in practice; the `?? "—"` is defence-in-depth for the
  // typed-error contract (which expects a non-null actual).
  assertEntityInWorkstream(
    db,
    "agents",
    "name",
    agentName,
    workstream,
    (n, exp, actual) => new AgentNotInWorkstreamError(n, exp, actual ?? "—"),
  );
}

/**
 * Sister of `assertAgentInWorkstream` for verbs that target a single
 * task by ID. Task ids are unique per workstream, so a bare id under the
 * wrong `-w` is a different (or no) task: this raises a clear
 * `TaskNotInWorkstreamError` naming the real workstream. `resolveEntityRef`
 * has already validated and existence-checked `-w`. No-op when `workstream` is undefined or the task
 * doesn't exist (downstream handler raises `TaskNotFoundError`).
 */
export function assertTaskInWorkstream(
  db: Db,
  taskId: string,
  workstream: string | undefined,
): void {
  // tasks.workstream is NOT NULL in the schema; see assertAgentInWorkstream.
  assertEntityInWorkstream(
    db,
    "tasks",
    "local_id",
    taskId,
    workstream,
    (id, exp, actual) => new TaskNotInWorkstreamError(id, exp, actual ?? "—"),
  );
}

// ─── Numeric arg parsers ─────────────────────────────────────────────
//
// All strict: the whole string must be the number. parseInt/parseFloat
// kept a numeric prefix ("5.9abc" -> 5, "2x" -> 2) and parseFloat let
// "1e999" through as Infinity, which JSON serialises as null.

const NON_NEGATIVE_INT_RE = /^\s*\d+\s*$/;

export function parsePositiveNumber(value: string): number {
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(`expected a positive number, got ${JSON.stringify(value)}`);
  }
  return n;
}

/** Like parsePositiveNumber, but 0 is allowed (`--older-than 0`: everything). */
export function parseNonNegativeNumber(value: string): number {
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError(`expected a non-negative number, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Parses a duration in seconds for --timeout / --stuck-after: any
// non-negative finite number, fractions included. Strict on purpose:
// parseInt read "0.5" as 0 (wait forever) and "10m" as 10, so a
// suffix or other trailing text is an error, not a prefix to keep.
export function parseSeconds(value: string): number {
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError(
      `expected a non-negative number of seconds, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

export function parseImpact(value: string): number {
  const n = NON_NEGATIVE_INT_RE.test(value) ? Number(value) : Number.NaN;
  if (Number.isNaN(n) || n < 1 || n > 100) {
    throw new InvalidArgumentError(`expected 1..100, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Parses a non-negative integer (0 is valid): line counts, --limit,
// and --since, which uses 0 as the "replay everything" cursor.
export function parseNonNegativeInt(value: string): number {
  const n = NON_NEGATIVE_INT_RE.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(`expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

/** A whole number >= 1: run ceilings (`task auto --max`). */
export function parsePositiveInt(value: string): number {
  const n = NON_NEGATIVE_INT_RE.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new InvalidArgumentError(`expected an integer >= 1, got ${JSON.stringify(value)}`);
  }
  return n;
}

/** Line counts (-n/--lines/--events): same rule as parseNonNegativeInt. */
export const parseLines = parseNonNegativeInt;

// ─── Program definition ───────────────────────────────────────────────
//
// See the `wire*Commands` calls below for the full namespace/utility
// list (`workstream`, `agent`, `task`, `log`, `state`,
// `sql`, `sync`, `rebuild`, `db`, `doctor`, plus the bare `mu`
// TTY-aware default) rather than a count here, which drifts.
//
// Every flag is declared on the subcommand that consumes it. The one
// exception is the root `-w`: a preAction hook (forwardRootWorkstream)
// writes it into the verb's own `-w`, so `mu -w ws <verb>` and
// `mu --workstream=ws <verb>` scope exactly like `mu <verb> -w ws`.
// Verbs therefore read `this.opts()` and still see a root `-w`; without
// the hook, teardown and state silently fell back to $MU_SESSION. The
// optsWithGlobals() verbs also see the root array and funnel it through
// normalizeInheritedWorkstream.
//
// Bare `mu` takes only the root `-w` / `--json` flags and prints help.

// Reusable workstream flag declaration. Each subcommand that needs it
// gets its own copy via `.option(...WORKSTREAM_OPT)` so there is no
// cross-command leakage.
export const WORKSTREAM_OPT = [
  "-w, --workstream <name>",
  "workstream (required; a qualified <ws>/<name> ref carries its own; a spawned worker defaults to its own)",
] as const;

// Reusable --json flag for every read verb. Output shape is documented
// per-verb but follows a consistent pattern: collections → the
// `{items, count}` envelope (emitJsonCollection), so an empty one prints
// `{"items":[],"count":0}`; single entities → JSON objects (every
// "single" verb errors on a miss rather than printing `null`). Pretty-printing is OFF; one
// document per line so output is grep/jq friendly.
export const JSON_OPT = ["--json", "emit machine-readable JSON instead of a table"] as const;

/**
 * Canonical multi-value-flag parser. Every commander variadic flag
 * (`--foo <vals...>`) in mu is post-processed through this helper so
 * the operator can use repeated-flag form, comma-separated form, or
 * any mix:
 *
 *   --foo a --foo b --foo c   → ["a", "b", "c"]
 *   --foo a,b,c               → ["a", "b", "c"]
 *   --foo a,b --foo c         → ["a", "b", "c"]
 *
 * Whitespace inside fragments is trimmed. Two kinds of "empty" get
 * DIFFERENT treatment, and the distinction is the whole point (see
 * docs/reference/naming.md § Empty and blank list fragments):
 *
 *   EMPTY  (`""` before trimming) — DROPPED. This is either a
 *          structural comma artifact (`"a,b,"`, `"a,,b"`) or the
 *          deliberate clear-everything sentinel that
 *          `mu task reparent --blocked-by ''` documents. Both are
 *          things an operator means.
 *   BLANK  (non-empty before trimming, empty after — i.e. entirely
 *          whitespace, `" "` / `"\t"`) — a UsageError (exit 2). An
 *          operator never means "filter by the space character";
 *          it is a typo or a quoting accident, and silently dropping
 *          it produced a silent wrong answer:
 *          `--status "OPEN, "`
 *          quietly widened to no-filter-at-all, and `--status " "`
 *          returned every task as though no filter were given.
 *
 * Trim-then-drop-empty conflated the two. Deciding it HERE rather
 * than per-call-site is deliberate: a per-call-site answer is exactly
 * how the flag-vs-positional inconsistency arose.
 *
 * Idempotent: the helper is safe to apply twice (its output never
 * contains a blank fragment, so a second pass cannot throw).
 *
 * Convention codified by cli_audit_plurality_uniformity (v0.3). See
 * docs/guide/sql.md "Pass list flags".
 */
export function parseCsvFlag(
  values: readonly string[] | undefined,
  flag = "a list flag",
): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const value of values) {
    for (const fragment of value.split(",")) {
      // Empty BEFORE trimming: comma artifact or clear-all sentinel.
      if (fragment.length === 0) continue;
      const trimmed = fragment.trim();
      // Non-empty before, empty after: entirely whitespace.
      if (trimmed.length === 0) {
        throw new UsageError(
          `${flag} got a blank (whitespace-only) value ${JSON.stringify(fragment)}. Remove it, or pass an empty string ('') if you meant "none".`,
        );
      }
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Normalize an `optsWithGlobals()` workstream value into a single name.
 *
 * Subcommands that call `optsWithGlobals()` inherit the ROOT
 * `-w, --workstream <names>` flag, which COLLECTS into an array — so a
 * root-position invocation like `mu -w foo task owned-by worker-1`
 * yields `["foo"]` (an array), not `"foo"`. The subcommand's own
 * `WORKSTREAM_OPT` is single-value (`<name>`) and yields a string.
 * `optsWithGlobals()` can hand either shape to a single-workstream
 * verb, so callers MUST funnel the merged value through this helper:
 * it accepts string | string[] | undefined, reuses parseCsvFlag's
 * canonicalisation (repeat / comma / mixed forms), returns the single
 * name (or undefined when none was passed), and throws UsageError when
 * more than one workstream is supplied to a verb that scopes to one.
 *
 * Guards finding_optswithglobals_can_pass_root: without this, an array
 * leaks unchanged through resolveWorkstream into DB calls, producing
 * confusing substrate errors instead of the documented scoping.
 */
export function normalizeInheritedWorkstream(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const names = parseWorkstreamList(typeof value === "string" ? [value] : value);
  if (names.length === 0) return undefined;
  if (names.length > 1) {
    throw new UsageError(
      `-w/--workstream takes a single workstream here (got ${names.length}: ${names.join(", ")})`,
      { showHelp: false },
    );
  }
  return names[0];
}

/** The one JSON document of a successful `--json` invocation: the payload in
 *  a `{ok:true,data,next}` envelope (src/output-contract.ts), one line. `next`
 *  is the one finalisation (`finalNext`, src/cli/handle.ts), fitted to what the
 *  result budget leaves. An explicit success envelope passes through, never
 *  `data.ok`. Exported so cli/*.ts modules share one formatter. */
export function emitJson(value: unknown): void {
  const env = okEnvelope(value);
  const base = encodeEnvelope(env);
  if (env.next !== null || value === env) {
    console.log(base);
    return;
  }
  console.log(encodeEnvelope({ ...env, next: fitNext(finalNext(), Buffer.byteLength(base)) }));
}

/** One raw JSON line, NOT enveloped: the NDJSON stream rows of `mu log --tail`
 *  (a stream is not a document, and its rows keep the stored op shape). */
export function emitJsonRow(value: unknown): void {
  console.log(safeJsonLine(JSON.stringify(value)));
}

/** Wrap a collection in mu's canonical `{items, count}` payload (the `data` of the envelope).
 *  Every collection-read verb (list,
 *  next, owned-by, notes, search, orphans, commits, ...) emits this
 *  shape so a future sibling field (`baseRef`, `totalAcrossPages`,
 *  ...) can be added without breaking every caller. Pre-1.0
 *  breaking versus the pre-audit bare-array shape.
 *
 *  Carve-out: `mu sql` pages its rows as `{items, count, more, retrieve?}` (src/cli/db-query.ts;
 *  row shape is per-query, not part of the typed contract).
 *  `mu log --tail --json` keeps NDJSON (one object per line) since
 *  it's a stream, not a collection. */
export function emitJsonCollection<T>(items: readonly T[]): void {
  emitJson({ items, count: items.length });
}

/**
 * Read the package version from the shipped package.json. Works for
 * both source mode (src/cli.ts → ../package.json) and bundled mode
 * (dist/cli.js → ../package.json), since both layouts have package.json
 * exactly one directory up. Avoids hand-bumping a string literal in
 * code on every release.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("mu")
    .description(
      "Persistent crew of AI agents in tmux or herdr panes coordinated through a built-in task DAG.",
    )
    .version(readPackageVersion())
    .helpOption("-h, --help")
    // .showHelpAfterError() is not used:
    // emitError() in handle.ts now owns help-on-error emission for both
    // commander mistakes and handler-thrown UsageErrors. Without this
    // removal, commander would print its own "\n<help>" appendix to
    // stderr before throwing CommanderError, leaving us with a duplicate
    // help dump (commander's then ours). We suppress commander's stderr
    // entirely in applyExitOverride below; this comment is the load-
    // bearing explanation of why we don't reach for showHelpAfterError().
    // Sort most Commands lists (NOT the Options list) alphabetically.
    // Commander v14 inherits configureHelp via copyInheritedSettings()
    // when subcommands are created with .command(), but we also walk the
    // tree below for certainty — future subcommand groups added via
    // .addCommand() do not inherit.
    .configureHelp({ sortSubcommands: true })
    // Without this, `mu task list --json` would bind --json to the
    // program (where we declare it for the bare `mu --json` help path)
    // instead of the `list` subcommand. With it,
    // options before a subcommand bind to the program; options after
    // bind to the subcommand. Subcommands inherit it automatically.
    .enablePositionalOptions()
    // Default action when no subcommand is given: print help (TTY or not).
    //
    // NOT variadic (`<names...>`): a variadic root flag swallowed the
    // verb too, so `mu -w ws task list` parsed as workstreams
    // ["ws","task","list"] and printed root help with exit 0.
    .option(
      "-w, --workstream <names>",
      "workstream(s) to render (repeat or comma-separate; or both). Before a verb, it is that verb's -w",
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option(...JSON_OPT)
    .hook("preAction", (root, leaf) => {
      forwardRootJson(root, leaf);
      forwardRootWorkstream(root, leaf);
    })
    .action(openDashboardOrHelp(program));

  wireWorkstreamCommands(program);
  wireAgentCommands(program);
  wireSelfCommands(program);
  wireTaskCommands(program);
  wireWaitCommand(program);
  wireNextCommand(program);
  wireLogCommand(program);
  wireStateCommands(program);
  wireSyncCommand(program);
  wireHostCommands(program);
  wireHumanNeededCommand(program);
  wireDelegatesCommands(program);
  wireRebuildCommand(program);
  wireDbCommands(program);
  wireDbQueryCommand(program);
  wireDoctorCommand(program);
  wirePiCommand(program);
  applyAlphabeticalHelpSort(program);
  // Every node in the command tree
  // must call exitOverride() so commander throws CommanderError
  // instead of calling process.exit() itself. Lets the parseAsync()
  // catch route every operator-error through emitError() with the
  // failing subcommand's --help (human) or `usage` JSON (--json).
  applyExitOverride(program);
  return program;
}

/** preAction hook: hand a root-position `--json` to the verb's own `--json`,
 *  so `mu --json task list` prints the same envelope as `mu task list --json`.
 *  Without it enablePositionalOptions binds the flag to the root and the
 *  success path prints a human table (errors read argv, so they already
 *  honoured it). Help and `--version` stay raw text: they are not verbs. */
function forwardRootJson(root: Command, leaf: Command): void {
  if (leaf === root || root.opts().json !== true) return;
  if (leaf.options.some((o) => o.attributeName() === "json")) {
    leaf.setOptionValueWithSource("json", true, "cli");
  }
}

/** preAction hook: hand a root-position `-w` to the verb's own `-w`, so
 *  `mu -w ws task list` means `mu task list -w ws`. Fails loud (exit 2)
 *  rather than silently ignoring the flag when the verb takes no `-w`,
 *  or when `-w` is given on both sides of the verb. */
function forwardRootWorkstream(root: Command, leaf: Command): void {
  if (leaf === root) return;
  const names = root.opts().workstream as string[] | undefined;
  if (names === undefined) return;
  // One line, no help dump: the message already names the fix.
  const usage = (message: string): never => {
    throw new UsageError(message, { showHelp: false });
  };
  const opt = leaf.options.find((o) => o.attributeName() === "workstream");
  if (opt === undefined) {
    usage(`\`${leaf.name()}\` takes no -w/--workstream; drop the root -w`);
    return;
  }
  if (leaf.getOptionValue("workstream") !== undefined) {
    usage("-w/--workstream given both before and after the verb; pass it once");
    return;
  }
  // optsWithGlobals() lets the root's value overwrite the leaf's, so the root
  // must end up holding exactly what the leaf holds: a string for a
  // single-workstream verb, never the root's raw array.
  const settle = (value: string | string[]): void => {
    leaf.setOptionValueWithSource("workstream", value, "cli");
    root.setOptionValueWithSource("workstream", value, "cli");
  };
  if (opt.variadic) {
    settle(names);
    return;
  }
  const parsed = parseWorkstreamList(names);
  if (parsed.length > 1) {
    usage(
      `-w/--workstream takes a single workstream here (got ${parsed.length}: ${parsed.join(", ")})`,
    );
    return;
  }
  if (parsed[0] !== undefined) settle(parsed[0]);
}

// Recursively set sortSubcommands on every command in the tree. Belt
// and braces over the root .configureHelp() call: guarantees the sort
// holds regardless of how a subcommand was attached (.command() vs
// .addCommand()) and regardless of inheritance behaviour across
// commander versions. Preserves any other help-configuration keys
// already set on a subcommand.
function applyAlphabeticalHelpSort(cmd: Command): void {
  cmd.configureHelp({ ...cmd.configureHelp(), sortSubcommands: true });
  for (const sub of cmd.commands) {
    applyAlphabeticalHelpSort(sub);
  }
}

/** Recursively call exitOverride() on every command in the tree.
 *  Without this, commander writes its error to stderr and calls
 *  process.exit() inline — we never see the error and our emitError()
 *  contract (--help on usage errors, --json envelopes, exit-2
 *  uniformity) doesn't apply.
 *
 *  We ALSO swallow commander's writeErr so commander never prints the
 *  unformatted "error: ..." / help combo before our handler runs. The
 *  captured text is discarded; emitError() re-emits message + help in
 *  mu's format. Help displays via --help still flow through writeOut
 *  (commander.helpDisplayed code, which classifyCommanderError maps to
 *  exit 0 with no further output). */
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({
    writeOut: (s) => process.stdout.write(s),
    writeErr: () => {
      // Swallow commander's pre-throw stderr; emitError re-emits.
    },
  });
  for (const sub of cmd.commands) {
    applyExitOverride(sub);
  }
}

// ─── Entry point ───────────────────────────────────────────────────────

/** Bare verb-namespace invocations (`mu agent`, `mu task`, …)
 *  used to print nothing and exit 0 because commander, given a parent
 *  with subcommands and no .action(), produces an empty render. We
 *  fix this BEFORE parseAsync rather than via .action() on each
 *  namespace because attaching .action() makes commander treat
 *  `mu task bogus` as a positional arg to `task` instead of routing
 *  it to the "unknown subcommand" lane (which other tests + emitError
 *  depend on). Surfaced by `bare_verb_namespaces_mu_workspace_task` (when `workspace` was a namespace).
 *
 *  Triggers when:
 *    - argv after the program name is exactly one token
 *    - that token names a top-level subcommand of `mu`
 *    - that subcommand itself has its own subcommands (i.e. it's a
 *      namespace, not a leaf verb); `me` is the exception: bare, it runs
 *      `state --me`
 *  In that case we append `--help` so commander routes through its
 *  help printer. Bare `mu` is unaffected because
 *  the slice has length 0.
 */
export function injectBareNamespaceHelp(
  program: Command,
  argv: readonly string[],
): readonly string[] {
  // argv is the full process.argv shape: [node, mu, ...userArgs].
  if (argv.length !== 3) return argv;
  const token = argv[2];
  if (token === undefined || token.startsWith("-")) return argv;
  const sub = program.commands.find((c) => c.name() === token || c.aliases().includes(token));
  if (!sub) return argv;
  if (sub.commands.length === 0) return argv;
  // `mu me` has subcommands AND its own action (`state --me`): bare, it runs.
  if (sub.name() === "me") return argv;
  return [...argv, "--help"];
}

/** Parse and run one `mu` invocation. Called by the bin bootstrap
 *  (src/main.ts) after it enables the compile cache; tests use
 *  buildProgram() directly. */
export async function runCli(rawArgv: readonly string[]): Promise<void> {
  const program = buildProgram();
  const argv = injectBareNamespaceHelp(program, rawArgv);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    // CommanderError (parse-time) lands here because every command in
    // the tree had .exitOverride() applied. Locate the deepest matching
    // subcommand from argv so emitError can render its --help (human)
    // or `usage` JSON (--json).
    const failingCmd = findCommandForArgv(program, argv.slice(2));
    const exitCode = emitParseError(err, failingCmd);
    process.exit(exitCode);
  }
}
