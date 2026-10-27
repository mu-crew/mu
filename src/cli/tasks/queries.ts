// mu — `mu task` query verbs (read-only; no DB writes).
//
// list, next, owned-by.
// Plus the `mu me tasks` / `mu me next` agent-self subcommands (also
// read-only; they query against `resolveSelf(db)` instead of -w —
// wired in src/cli/agents.ts via `wireSelfCommands`).
//
// Extracted from src/cli/tasks.ts as part of refactor_split_large_src_files.
//
// Output is the mu-next record form (src/cli/tasks/records.ts): one task per
// line or one JSON item with SQL column names, every result capped on its final
// bytes, a cut naming the exact `--from` command that resumes.
//
// Removed in audit_cleanups_post_schema_v5_wave: `task blocked`,
// `task goals`, `task search`, `task ready` (the latter merged into
// `task next -n 0`, which now means "all ready, unlimited"). The
// underlying SDK helpers `listBlocked` and `listGoals` survive —
// `mu state` consumes `listBlocked`. The audit's SQL recipes for
// the removed verbs live in docs/guide/sql.md "Run common queries".

import { AgentNotFoundError } from "../../agents.js";
import {
  byRoiDesc,
  checkQualifiedPrefix,
  emitJson,
  parseQualifiedRef,
  parseSortOption,
  parseStatusesOption,
  parseSubstatesOption,
  relTimeBasisForSort,
  resolveExistingWorkstream,
  resolveSelf,
  sortTasks,
  type TaskSortKey,
  UsageError,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { say } from "../../messages.js";
import { pc } from "../../output.js";
import { taskRevisions } from "../../revision.js";
import { shellWord } from "../../shell-quote.js";
import {
  agentIdByRef,
  listReady,
  listTasks,
  listTasksByOwner,
  listTasksByOwnerCrossWorkstream,
  type TaskRow,
} from "../../tasks.js";
import { resolveMeAgent } from "../me-identity.js";
import { type TaskPageOut, taskPage } from "./records.js";

/** Print a page: the JSON document, or the record lines. */
function emitPage(out: TaskPageOut, json: boolean): void {
  if (json) {
    emitJson(out.data);
    return;
  }
  console.log(out.lines.join("\n"));
}

/** Flags that re-select the same rows, for the `next=` command of a cut. */
type Flags = readonly (string | undefined)[];
const command = (parts: readonly string[], flags: Flags, tail: readonly string[]): string =>
  [...parts, ...flags.filter((f): f is string => f !== undefined), ...tail].join(" ");

/** The one way back from a cut: the same read, `--all` (uncapped), `--json` as given. */
const allTail = (opts: { json?: boolean }): string[] => [
  ...(opts.json === true ? ["--json"] : []),
  "--all",
];

const wsFlag = (ws: string): string => `-w ${shellWord(ws)}`;

export async function cmdMyTasks(
  db: Db,
  opts: { json?: boolean; includeClosed?: boolean; all?: boolean } = {},
): Promise<void> {
  const self = resolveMeAgent(db);
  // Scope by self.workstream so a same-named worker in another
  // workstream can't pollute this list.
  const tasks = listTasksByOwner(db, self.workstreamName, self.name, {
    includeClosed: opts.includeClosed ?? false,
  });
  if (tasks.length === 0 && !opts.json) {
    console.log(pc.dim(`(${self.name} owns no tasks)`));
    return;
  }
  emitPage(
    taskPage(tasks, {
      all: opts.all === true,
      json: opts.json === true,
      next: command(
        ["mu", "me", "tasks"],
        [opts.includeClosed ? "--include-closed" : undefined],
        allTail(opts),
      ),
    }),
    opts.json === true,
  );
}

export async function cmdMyNext(
  db: Db,
  opts: { lines?: number; json?: boolean; all?: boolean },
): Promise<void> {
  const self = resolveMeAgent(db);
  const k = opts.lines ?? 1;
  const sorted = listReady(db, self.workstreamName).sort(byRoiDesc);
  const tasks = k === 0 ? sorted : sorted.slice(0, k);
  if (tasks.length === 0 && !opts.json) {
    console.log(pc.dim(`(no ready tasks in ${self.workstreamName})`));
    return;
  }
  emitPage(
    taskPage(tasks, {
      all: opts.all === true,
      json: opts.json === true,
      next: command(["mu", "me", "next", "-n", String(k)], [], allTail(opts)),
    }),
    opts.json === true,
  );
}

/** The agent an `--owner` / `--mine` filter names, as its real id (never matched by bare name). */
function ownerFilter(
  db: Db,
  ws: string,
  opts: { owner?: string; mine?: boolean },
): { id: number; flag: string } | undefined {
  if (opts.owner !== undefined && opts.mine === true) {
    throw new UsageError(say("task.list_owner_mine"));
  }
  if (opts.mine === true) {
    const self = resolveSelf(db);
    const id = agentIdByRef(db, self.workstreamName, self.name);
    if (id === null) throw new AgentNotFoundError(self.name, self.workstreamName);
    return { id, flag: `--owner ${shellWord(`${self.workstreamName}/${self.name}`)}` };
  }
  if (opts.owner === undefined) return undefined;
  const ref = parseQualifiedRef(opts.owner);
  const agentWs =
    ref.workstream === undefined ? ws : checkQualifiedPrefix(opts.owner, ref.workstream);
  const id = agentIdByRef(db, agentWs, ref.name);
  if (id === null) throw new AgentNotFoundError(ref.name, agentWs);
  return { id, flag: `--owner ${shellWord(`${agentWs}/${ref.name}`)}` };
}

export async function cmdTaskList(
  db: Db,
  opts: {
    workstream?: string;
    json?: boolean;
    status?: string[];
    substate?: string[];
    sort?: string;
    all?: boolean;
    owner?: string;
    mine?: boolean;
  },
): Promise<void> {
  const workstream = await resolveExistingWorkstream(db, opts.workstream);
  const listOpts: Parameters<typeof listTasks>[2] = {};
  // --status accepts repeat OR comma-separate OR mix; parseStatusesOption
  // handles parseCsvFlag + per-element validate + dedup. Returns
  // undefined for no filter (matches today's no-flag shape).
  const statuses = parseStatusesOption(opts.status);
  if (statuses !== undefined) {
    listOpts.status = statuses;
  }
  const substates = parseSubstatesOption(opts.substate);
  if (substates !== undefined) listOpts.substate = substates;
  const owner = ownerFilter(db, workstream, opts);
  if (owner !== undefined) listOpts.ownerId = owner.id;
  // `--all` is the uncapped read: every task, whole (a list is every status already).
  // Default sort for `mu task list` is `id` (preserves prior
  // behaviour: SQL ORDER BY local_id). The other read verbs default
  // to `roi` because their primary use is "what should I do next".
  const sortKey: TaskSortKey = opts.sort === undefined ? "id" : parseSortOption(opts.sort);
  const tasks = sortTasks(listTasks(db, workstream, listOpts), sortKey);
  const flags: Flags = [
    statuses === undefined ? undefined : `--status ${statuses.join(",")}`,
    substates === undefined ? undefined : `--substate ${substates.join(",")}`,
    opts.sort === undefined ? undefined : `--sort ${opts.sort}`,
    owner?.flag,
  ];
  const head = ["mu", "task", "list", wsFlag(workstream)];
  if (tasks.length === 0 && opts.json !== true) {
    console.log(pc.dim("(no tasks)"));
    return;
  }
  emitPage(
    taskPage(tasks, {
      all: opts.all === true,
      json: opts.json === true,
      next: command(head, flags, allTail(opts)),
      basis: relTimeBasisForSort(sortKey),
      // `revision` is what `--if <rev>` on the guarded verbs repeats.
      ...(opts.json === true ? { revisions: taskRevisions(db, workstream) } : {}),
    }),
    opts.json === true,
  );
}

// ROI = impact / effort_days. Higher first. Tasks with effortDays=0
// (would divide by zero) sort to the top by treating their ROI as Infinity.
//
// `-n 0` means "unlimited" — the merged-in `task ready` semantics
// from audit_merge_task_ready_into_next. Default K=1 keeps the
// historical "what should I do right now?" shape.
export async function cmdTaskNext(
  db: Db,
  opts: {
    workstream?: string;
    lines?: number;
    json?: boolean;
    sort?: string;
    all?: boolean;
  },
): Promise<void> {
  const workstream = await resolveExistingWorkstream(db, opts.workstream);
  const k = opts.lines ?? 1;
  const sortKey: TaskSortKey = opts.sort === undefined ? "roi" : parseSortOption(opts.sort);
  const sorted = sortTasks(listReady(db, workstream), sortKey);
  const tasks = k === 0 ? sorted : sorted.slice(0, k);
  if (tasks.length === 0 && opts.json !== true) {
    const parked = listTasks(db, workstream, { substate: "parked" }).length;
    const triage = listTasks(db, workstream, { substate: "triage" }).length;
    if (parked === 0 && triage === 0) {
      console.log(pc.dim("(no ready tasks)"));
      return;
    }
    const held = [parked > 0 ? `${parked} parked` : "", triage > 0 ? `${triage} in triage` : ""]
      .filter(Boolean)
      .join(", ");
    const which = [triage > 0 ? "triage" : "", parked > 0 ? "parked" : ""]
      .filter(Boolean)
      .join(",");
    console.log(
      pc.dim(`(no ready tasks; ${held}: mu task list --substate ${which} -w ${workstream})`),
    );
    return;
  }
  const flags: Flags = [
    "-n",
    String(k),
    opts.sort === undefined ? undefined : `--sort ${opts.sort}`,
  ];
  emitPage(
    taskPage(tasks, {
      all: opts.all === true,
      json: opts.json === true,
      next: command(["mu", "task", "next", wsFlag(workstream)], flags, allTail(opts)),
    }),
    opts.json === true,
  );
}

export async function cmdTaskOwnedBy(
  db: Db,
  agent: string,
  opts: {
    json?: boolean;
    includeClosed?: boolean;
    workstream?: string;
    all?: boolean;
    full?: boolean;
  } = {},
): Promise<void> {
  // Default behaviour: scope to the resolved workstream (so the common
  // case 'mu task owned-by worker-1' returns only this workstream's
  // worker-1, not every workstream's). --all explicitly opts into the
  // cross-workstream view via listTasksByOwnerCrossWorkstream.
  const includeClosed = opts.includeClosed ?? false;
  const ws = opts.all ? undefined : await resolveExistingWorkstream(db, opts.workstream);
  const tasks: TaskRow[] =
    ws === undefined
      ? listTasksByOwnerCrossWorkstream(db, agent, { includeClosed })
      : listTasksByOwner(db, ws, agent, { includeClosed });
  if (tasks.length === 0 && opts.json !== true) {
    console.log(pc.dim(`(no tasks owned by ${agent})`));
    return;
  }
  const flags: Flags = [
    ws === undefined ? "--all" : undefined,
    includeClosed ? "--include-closed" : undefined,
  ];
  // Surface the workstream column when we're showing cross-workstream
  // results (--all); for the scoped (default) case the column would
  // be redundant.
  emitPage(
    taskPage(tasks, {
      all: opts.full === true,
      json: opts.json === true,
      withWorkstream: ws === undefined,
      next: command(
        ["mu", "task", "owned-by", shellWord(agent), ...(ws === undefined ? [] : [wsFlag(ws)])],
        flags,
        [...(opts.json === true ? ["--json"] : []), "--full"],
      ),
    }),
    opts.json === true,
  );
}
