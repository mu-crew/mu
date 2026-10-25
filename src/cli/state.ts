// mu — `mu state` (canonical state card).
//
//   mu state                    full card: agents + orphans + tracks +
//                               ready/in-progress/blocked/recent-closed +
//                               recent events. Top-to-bottom,
//                               every section gets its full table. JSON-
//                               first by design (per Ilya's council
//                               critique: state cards as the default
//                               attention surface; SQL/raw verbs as the
//                               escape hatch underneath).
//
// Both render modes load their data via loadWorkstreamSnapshot and
// support variadic `-w X[,Y]...` / `-w X -w Y` and `--all`. N=1 renders
// single-mode (legacy shape); N≥2 stacks per-workstream full cards.
//
// Static snapshots run full reconciliation: reap missing panes. Mid-spawn
// placeholders remain protected by reconcile's pending-pane skip
// (see PENDING_PANE_PREFIX).

import { liveAgentToOutput, workstreamIdOf } from "../agent-output.js";
import type { LiveAgent } from "../agents.js";
import {
  emitJson,
  formatAgentsTable,
  formatTaskListTable,
  formatTracks,
  handle,
  injectedWorkstream,
  JSON_OPT,
  missingWorkstreamError,
  parseLines,
  parseWorkstreamList,
  printLogRow,
  UsageError,
  withRoiAll,
} from "../cli.js";
import { type Db, tryResolveLiveWorkstreamId, WorkstreamNotFoundError } from "../db.js";
import { muTable, pc } from "../output.js";
import {
  listRemoteWorkers,
  loadWorkstreamSnapshot,
  type RemoteWorker,
  type WorkstreamSnapshot,
} from "../state.js";
import { isScratchWorkstream, listWorkstreams } from "../workstream.js";

// ─── Per-workstream loaded data ─────────────────────────────────────

// PerWsData was the previous private shape of loadWorkstreamData.
// Both the type and the loader now live at src/state.ts as the SDK
// seam (WorkstreamSnapshot + loadWorkstreamSnapshot). We keep `PerWsData` as a local alias to
// avoid touching every renderer downstream.
type PerWsData = WorkstreamSnapshot & { remoteWorkers: RemoteWorker[] };

function formatRemoteWorkersTable(rows: readonly RemoteWorker[]): string {
  const table = muTable({
    head: ["task", "host", "path"].map((heading) => pc.bold(heading)),
  });
  for (const row of rows) table.push([row.taskName, row.host, row.path]);
  return table.toString();
}

// ─── Workstream-set resolution ─────────────────────────────────────
//
// Both render modes accept TWO mutually-exclusive shapes (plus
// auto-resolve):
//   -w X         | -w X,Y     | -w X -w Y      explicit set (variadic + parseCsvFlag)
//   --all                                       every workstream on this machine
//   (none)                                      a managed worker's injected workstream,
//                                               else a one-line error: never a guess
//
// N=1 (single -w value, --all on a single-workstream machine, or
// the injected scope) renders single-mode (legacy column shape + flat JSON).
// N≥2 stacks per-workstream cards.

export interface StateOpts {
  // Variadic on every render mode.
  workstream?: string[];
  all?: boolean;
  json?: boolean;
  events?: number; // recent-events cap (default 20)
}

async function resolveWorkstreamSet(db: Db, opts: StateOpts): Promise<string[]> {
  const explicitW = opts.workstream !== undefined && opts.workstream.length > 0;
  const explicitAll = opts.all === true;
  if (explicitAll && explicitW) {
    throw new UsageError("--all and -w/--workstream are mutually exclusive", { showHelp: false });
  }
  if (explicitAll) {
    const all = await listWorkstreams(db);
    return all.map((w) => w.name);
  }
  if (explicitW) {
    // parseWorkstreamList canonicalises repeat / comma / mixed forms into
    // a flat string[]: structurally empty fragments are dropped, blank or
    // padded ones are a usage error (never trimmed into another name).
    const deduped = Array.from(new Set(parseWorkstreamList(opts.workstream ?? [])));
    // Strict validation: every entry must exist. A typo'd name
    // would silently render a half card.
    for (const n of deduped) {
      if (tryResolveLiveWorkstreamId(db, n) === null) throw new WorkstreamNotFoundError(n);
    }
    if (deduped.length > 0) return deduped;
  }
  const injected = injectedWorkstream();
  if (injected !== undefined) return [injected];
  const all = await listWorkstreams(db);
  const first = all[0]?.name;
  throw await missingWorkstreamError({
    orAll: true,
    ...(first ? { extra: `e.g. -w ${first}` } : {}),
  });
}

// ─── JSON shape ─────────────────────────────────────────────────────
//
// Unified single flat shape for `mu state --json`.

function fullJsonShape(db: Db, d: PerWsData): Record<string, unknown> {
  const wsId = workstreamIdOf(db, d.workstreamName);
  return {
    workstreamName: d.workstreamName,
    agents: d.view.agents.map((a) => liveAgentToOutput(a, wsId)),
    orphans: d.view.orphans,
    tracks: d.tracks,
    ready: withRoiAll(d.ready),
    triage: withRoiAll(d.triage),
    inProgress: withRoiAll(d.inProgress),
    blocked: withRoiAll(d.blocked),
    recentClosed: withRoiAll(d.recentClosed),
    remoteWorkers: d.remoteWorkers,
    recent: d.recent,
  };
}

// ─── cmdState — dispatch ────────────────────────────────────────────

export async function cmdState(db: Db, opts: StateOpts): Promise<void> {
  const workstreams = await resolveWorkstreamSet(db, opts);

  // Only `--all` on a machine with no workstreams gets here: every other
  // path either resolved a scope or threw the one-line missing-scope error.
  if (workstreams.length === 0) {
    if (opts.json === true) {
      emitJson({ workstreams: [] });
      return;
    }
    console.log(pc.dim("(no workstreams) try `mu workstream init <name>`"));
    return;
  }

  const eventLimit = opts.events ?? 20;
  const perWs: PerWsData[] = [];
  for (const ws of workstreams) {
    perWs.push({
      ...(await loadWorkstreamSnapshot(db, ws, { eventLimit })),
      remoteWorkers: listRemoteWorkers(db, ws),
    });
  }
  const multi = workstreams.length > 1;

  // ── JSON: full static state shape ──
  if (opts.json === true) {
    if (multi) emitJson({ workstreams: perWs.map((d) => fullJsonShape(db, d)) });
    else {
      const single = perWs[0];
      if (single === undefined) throw new Error("invariant: workstreams non-empty");
      emitJson(fullJsonShape(db, single));
    }
    return;
  }

  // ── Static human render ──
  renderFullMode(perWs);
}

// ─── Render: full mode (default `mu state`) ────────────────────────

/** Past this many tasks, a workstream that is >90% closed gets the one-per-effort hint. */
const BIG_WORKSTREAM_TASKS = 300;

/**
 * Scratch nudge: task-less helpers that sit idle past the threshold
 * (`idle` from `computeAgentIdle`) get a close hint so easy spawning
 * doesn't silently accumulate forgotten panes. Null when none.
 */
export function scratchIdleNudge(workstreamName: string, agents: LiveAgent[]): string | null {
  if (!isScratchWorkstream(workstreamName)) return null;
  const lingering = agents.filter((a) => a.idle === true);
  if (lingering.length === 0) return null;
  const names = lingering.map((a) => a.name).join(", ");
  return `\u26a0 ${lingering.length} idle scratch agent(s): ${names}. Preview closing when done: mu agent close ${lingering[0]?.name ?? "<name>"} -w scratch`;
}

function renderFullMode(perWs: PerWsData[]): void {
  perWs.forEach((d, i) => {
    if (i > 0) console.log("");
    renderFullCard(d);
  });
}

function renderFullCard(d: PerWsData): void {
  const { workstreamName, view, tracks, ready, inProgress, blocked, recentClosed, recent } = d;

  console.log(pc.bold(`State of mu-${workstreamName}`));
  console.log("");
  console.log(pc.bold(`Agents (${view.agents.length} active, ${view.orphans.length} orphan)`));
  console.log(formatAgentsTable(view.agents));
  if (view.orphans.length > 0) {
    for (const orphan of view.orphans) {
      console.log(`  ${pc.yellow("orphan")} ${pc.dim(orphan.paneId)} cli=${orphan.command}`);
    }
  }
  const nudge = scratchIdleNudge(workstreamName, view.agents);
  if (nudge !== null) console.log(pc.yellow(nudge));
  // One workstream per effort: a long-lived catch-all is mostly history.
  const total = d.taskCount;
  const open = ready.length + inProgress.length + blocked.length + d.triage.length;
  if (total >= BIG_WORKSTREAM_TASKS && open * 10 < total) {
    console.log(
      pc.dim(
        `hint: ${total} tasks, ${open} open; start the next effort in a new <project>-<purpose> workstream`,
      ),
    );
  }
  console.log("");
  console.log(pc.bold(`Tracks (${tracks.length})`));
  console.log(formatTracks(tracks));
  console.log("");
  console.log(pc.bold(`Ready (${ready.length})`));
  console.log(ready.length === 0 ? pc.dim("  (none)") : formatTaskListTable(ready));
  console.log("");
  if (d.triage.length > 0) {
    console.log(
      `${pc.bold(`Triage (${d.triage.length})`)} ${pc.dim(`accept: mu task accept <id> -w ${workstreamName} · decline: mu task close <id> --as rejected|duplicate --why ...`)}`,
    );
    console.log(formatTaskListTable(d.triage));
    console.log("");
  }
  console.log(pc.bold(`In progress (${inProgress.length})`));
  console.log(inProgress.length === 0 ? pc.dim("  (none)") : formatTaskListTable(inProgress));
  console.log("");
  console.log(pc.bold(`Blocked (${blocked.length})`));
  console.log(blocked.length === 0 ? pc.dim("  (none)") : formatTaskListTable(blocked));
  console.log("");
  console.log(pc.bold(`Recent closed (${recentClosed.length})`));
  console.log(recentClosed.length === 0 ? pc.dim("  (none)") : formatTaskListTable(recentClosed));
  if (d.remoteWorkers.length > 0) {
    console.log("");
    console.log(pc.bold(`Remote workers (${d.remoteWorkers.length})`));
    console.log(formatRemoteWorkersTable(d.remoteWorkers));
  }
  console.log("");
  console.log(pc.bold(`Recent activity (last ${recent.length} ops)`));
  if (recent.length === 0) {
    console.log(pc.dim("  (none)"));
  } else {
    for (const row of recent) printLogRow(row);
  }
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireStateCommands is called by buildProgram() in src/cli.ts. Wired
// here so every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";

export function wireStateCommands(program: Command): void {
  program
    .command("state")
    .description(
      "Canonical state card: agents + orphans + tracks + ready/in-progress/blocked/recent-closed tasks + remote workers + recent events. The agent/API-facing static state surface. Prints the static card. -w accepts repeat or comma-separate (or both); --all is sugar for every workstream on this machine. N≥2 stacks per-workstream cards.",
    )
    .option(
      "-w, --workstream <names...>",
      "workstream(s) to render (repeat or comma-separate; or both). Required unless --all or run as a spawned worker",
    )
    .option("--all", "include every workstream on this machine")
    .option("--events <n>", "how many recent log entries (ops) to include (default 20)", parseLines)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as StateOpts;
      return handle((db) => cmdState(db, opts), this as Command)();
    });
}
