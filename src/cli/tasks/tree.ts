// mu — `mu task tree` verb (record / JSON dependency listing).
//
// Lists the OPEN blocker subtree (default) or dependent subtree (--down)
// of a task from loadOpenTaskFrontier (src/dag.ts): open tasks expand, CLOSED
// ones are leaves (--all walks them too), depth and node counts are capped.
// One record per entry in preorder (the shared task record, plus `depth=` and
// `parent=`), or one JSON item per entry. Diamonds list once plus an `again`
// record at every later sighting; the same rule stops a cycle, which sync can
// create (`mu doctor` reports those).
//
// Every cut names its way back:
//   - a node with tasks left under it: `kids=N under=<tree of that node>`;
//   - a node whose neighbours the 2000-task cap left out: `capped=K capped_next=<SQL read of
//     exactly those>` (re-rooting at the node would load the same 2000 again);
//   - a page that does not fit 4 KB: `more=N next=<same tree> --from <entry>`, cut on a
//     subtree boundary (whole subtrees, in preorder; `parent=` ties a later page back).
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import { assertTaskInWorkstream, resolveEntityRef } from "../../cli.js";
import {
  FRONTIER_MAX_DEPTH,
  type FrontierDirection,
  type FrontierEntry,
  loadOpenTaskFrontier,
} from "../../dag.js";
import type { Db } from "../../db.js";
import { shellWord } from "../../shell-quote.js";
import { getTask, TaskNotFoundError } from "../../tasks.js";
import {
  escapeRecordText,
  fromOffset,
  jsonDocument,
  linesBytes,
  moreLine,
  pageRecords,
  type RecordPage,
  sqlCommand,
  taskItem,
  taskRecord,
} from "./records.js";

interface TreeOpts {
  /** Show dependents (what this task blocks) instead of blockers. */
  down?: boolean;
  json?: boolean;
  workstream?: string;
  /** Walk CLOSED tasks too. */
  all?: boolean;
  /** 1-based entry to start at. */
  from?: number;
}

interface Omission {
  key: "under" | "capped";
  counts: (readonly [string, number])[];
  next: string;
}

/** `task_edges` columns (from, to) of a walk direction: dependents follow from→to. */
const edgeColumns = (direction: FrontierDirection): [string, string] =>
  direction === "dependents" ? ["from_task_id", "to_task_id"] : ["to_task_id", "from_task_id"];

/**
 * The page of `entries` from 1-based `from` that fits `size`, ending on a subtree
 * boundary: the next entry is no deeper than the first one of the page, or (when
 * one subtree fills the whole budget) than the shallowest level that has a
 * boundary within it. A page always makes progress.
 */
function treePage(
  entries: readonly FrontierEntry[],
  from: number,
  size: (page: RecordPage<FrontierEntry>) => number,
  nextFor: (from: number) => string,
): RecordPage<FrontierEntry> {
  const fit = pageRecords(entries, from, size, nextFor);
  if (fit.more === 0) return fit;
  const start = from - 1;
  let end = start + fit.shown.length;
  const first = entries[start]?.depth ?? 0;
  search: for (let d = first; d <= FRONTIER_MAX_DEPTH + 1; d++) {
    for (let e = start + fit.shown.length; e > start; e--) {
      if ((entries[e]?.depth ?? 0) <= d) {
        end = e;
        break search;
      }
    }
  }
  const left = entries.length - end;
  return { shown: entries.slice(start, end), more: left, next: left > 0 ? nextFor(end + 1) : null };
}

export async function cmdTaskTree(db: Db, rawId: string, opts: TreeOpts): Promise<void> {
  // resolveEntityRef parses `<workstream>/<name>` if present, else uses
  // opts.workstream. Returns the resolved (name, workstream) pair so we
  // never re-resolve downstream — the workstream is mandatory on every
  // SDK call that resolves an entity by name.
  const { name: rootId, workstream: ws } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, rootId, ws);
  const root = getTask(db, rootId, ws);
  if (!root) throw new TaskNotFoundError(rootId, ws);
  const down = opts.down ?? false;
  const direction: FrontierDirection = down ? "dependents" : "blockers";
  const includeClosed = opts.all === true;
  const { entries, againCut } = loadOpenTaskFrontier(db, ws, rootId, direction, { includeClosed });
  const [fromCol, toCol] = edgeColumns(direction);
  const treeCmd = (id: string, extra = ""): string =>
    `mu task tree ${shellWord(id)} -w ${shellWord(ws)}${down ? " --down" : ""}${extra}`;
  const nextFor = (k: number): string =>
    `${treeCmd(rootId)}${includeClosed ? " --all" : ""} --from ${k}`;

  /** The exact read of the neighbours the 2000-task cap left out (re-rooting would load the same 2000 again). */
  const cappedCommand = (e: FrontierEntry): string =>
    sqlCommand(
      `SELECT t.local_id, t.status FROM task_edges e JOIN tasks t ON t.id = e.${toCol} WHERE e.${fromCol} = ${e.pk} AND t.workstream_id = ${e.task.workstreamId} AND t.local_id >= '${e.capFrom}' ORDER BY t.local_id`,
    );
  /** What is left under an entry, one omission per command: `under` (another tree read) and `capped` (SQL). */
  const omissions = (e: FrontierEntry): Omission[] => {
    const out: Omission[] = [];
    if (e.kids > 0 || e.closed > 0) {
      out.push({
        key: "under",
        counts: [
          ...(e.kids > 0 ? [["kids", e.kids] as const] : []),
          ...(e.closed > 0 ? [["closed", e.closed] as const] : []),
        ],
        // `--all` reaches the closed ones too.
        next: treeCmd(e.task.name, e.closed > 0 && !includeClosed ? " --all" : ""),
      });
    }
    if (e.capCut > 0) {
      out.push({ key: "capped", counts: [["capped", e.capCut]], next: cappedCommand(e) });
    }
    return out;
  };
  const fields = (e: FrontierEntry): string[] => [
    `depth=${e.depth}`,
    ...(e.parent === null ? [] : [`parent=${escapeRecordText(e.parent)}`]),
    ...(e.again ? ["again=1"] : []),
  ];
  /** The record of an entry, then one `more` record per omission under it. */
  const linesOfEntry = (e: FrontierEntry): string[] => [
    taskRecord(e.task, { extra: fields(e) }),
    ...omissions(e).map(
      (o) =>
        `more\t${escapeRecordText(e.task.name)}\t${o.counts.map(([k, n]) => `${k}=${n}`).join(" ")}\tnext=${o.next}`,
    ),
  ];

  const from = fromOffset(opts.from);
  if (opts.json) {
    const itemOf = (e: FrontierEntry) => ({
      ...taskItem(e.task),
      depth: e.depth,
      parent: e.parent,
      ...(e.again ? { again: true } : {}),
      ...Object.fromEntries(
        omissions(e).flatMap((o) => [
          ...o.counts.map(([k, n]) => [k, n]),
          [`${o.key}_retrieve`, o.next],
        ]),
      ),
    });
    const dataOf = (page: RecordPage<FrontierEntry>) => ({
      direction,
      workstream: ws,
      root: rootId,
      max_depth: FRONTIER_MAX_DEPTH,
      ...(againCut > 0 ? { again_cut: againCut } : {}),
      items: page.shown.map(itemOf),
      count: page.shown.length,
      more: page.more,
      ...(page.next === null ? {} : { retrieve: page.next }),
    });
    const page = treePage(
      entries,
      from,
      (p) => Buffer.byteLength(jsonDocument(dataOf(p))) + 1,
      nextFor,
    );
    console.log(jsonDocument(dataOf(page)));
    return;
  }

  const header = [
    "tree",
    escapeRecordText(rootId),
    direction,
    `entries=${entries.length} max_depth=${FRONTIER_MAX_DEPTH}${againCut > 0 ? ` again_cut=${againCut}` : ""}`,
    down ? "hint=omit --down for blockers" : "hint=--down for dependents",
  ].join("\t");
  const linesOf = (page: RecordPage<FrontierEntry>): string[] => {
    const lines = [header, ...page.shown.flatMap(linesOfEntry)];
    const foot = moreLine(page);
    if (foot !== null) lines.push(foot);
    return lines;
  };
  const page = treePage(entries, from, (p) => linesBytes(linesOf(p)), nextFor);
  console.log(linesOf(page).join("\n"));
}
