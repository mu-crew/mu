// mu — bounded open-task frontier read and its ASCII branch drawing, shared
// by `mu task tree` and the dashboard.

import type { Db } from "./db.js";
import {
  type RawTaskRow,
  rowFromDb,
  SELECT_TASK_COLS,
  TASK_FROM_JOIN,
  type TaskRow,
  taskIdFor,
} from "./tasks.js";

/** Deepest level of a frontier read; a node past it keeps a `kids` count. */
export const FRONTIER_MAX_DEPTH = 12;
/** Most distinct tasks one frontier read lists (recurrences are capped at the same number). */
export const FRONTIER_MAX_NODES = 2000;
/** CLOSED neighbours listed under one node; the rest collapse into its `closed` count. */
export const FRONTIER_CLOSED_PER_NODE = 3;

export type FrontierDirection = "blockers" | "dependents";

/** One line of the open task tree, in preorder. */
export interface FrontierEntry {
  task: TaskRow;
  /** 0 for a root. */
  depth: number;
  /** `local_id` of the entry it is listed under; null for a root. */
  parent: string | null;
  /** Already listed above (a diamond, or a cycle sync made): not expanded again. */
  again: boolean;
  /** Neighbours (in the read direction) that are not CLOSED and are not listed under this entry. */
  kids: number;
  /** CLOSED neighbours collapsed into this count instead of listed. */
  closed: number;
  /** Neighbours of any status the node cap left out (not in `kids` / `closed`). */
  capCut: number;
}

export interface OpenTaskFrontier {
  direction: FrontierDirection;
  entries: FrontierEntry[];
  /** Start tasks left out by the node cap (only without a `root`). */
  rootsCut: number;
  /** Recurrence lines (diamonds) left out by the cap; every such task is listed elsewhere. */
  againCut: number;
}

export interface OpenTaskFrontierOptions {
  /** Walk through CLOSED tasks too (still capped by depth and entries unless `uncapped`). */
  includeClosed?: boolean;
  /** No cap at all: CLOSED tasks walked, every level, every task, every recurrence (`task tree --all`). */
  uncapped?: boolean;
  /** Levels below a root to list (default and ceiling `FRONTIER_MAX_DEPTH`). */
  maxDepth?: number;
}

/**
 * The open part of the DAG, bounded: from `root` (always expanded, even when
 * CLOSED) or, without one, from every non-CLOSED task that has no non-CLOSED
 * predecessor; `direction` is the way to walk (dependents = what a task
 * blocks). A non-CLOSED task expands; a CLOSED one is a leaf, and only the
 * first `FRONTIER_CLOSED_PER_NODE` of a node's CLOSED neighbours are listed
 * (the rest are counted), so one umbrella with 870 closed children costs a
 * few lines. Depth is capped at `FRONTIER_MAX_DEPTH` and entries at
 * `FRONTIER_MAX_NODES`; what a cap leaves out is counted in `kids`. Diamonds
 * and cycles list a task once and mark later sightings `again`. One SQL read
 * per level (never per node), same-workstream edges only.
 */
export function loadOpenTaskFrontier(
  db: Db,
  workstream: string,
  root?: string,
  direction: FrontierDirection = "dependents",
  opts: OpenTaskFrontierOptions = {},
): OpenTaskFrontier {
  const out: OpenTaskFrontier = { direction, entries: [], rootsCut: 0, againCut: 0 };
  const uncapped = opts.uncapped === true;
  const maxDepth = uncapped
    ? Number.POSITIVE_INFINITY
    : Math.min(opts.maxDepth ?? FRONTIER_MAX_DEPTH, FRONTIER_MAX_DEPTH);
  const maxNodes = uncapped ? Number.POSITIVE_INFINITY : FRONTIER_MAX_NODES;
  const closedPerNode = uncapped ? Number.POSITIVE_INFINITY : FRONTIER_CLOSED_PER_NODE;
  const wsRow = db
    .prepare("SELECT id FROM workstreams WHERE name = ? AND torn_down_at IS NULL")
    .get(workstream) as { id: number } | undefined;
  if (wsRow === undefined) return out;
  const wsId = wsRow.id;
  const [from, to] =
    direction === "dependents" ? ["from_task_id", "to_task_id"] : ["to_task_id", "from_task_id"];
  const includeClosed = opts.includeClosed === true || uncapped;

  const nodes = new Map<number, TaskRow>();
  const rootIds = new Set<number>();
  let level: number[] = [];
  const startRows: RawTaskRow[] = [];
  if (root !== undefined) {
    const id = taskIdFor(db, root, workstream);
    if (id === null) return out;
    startRows.push(
      db
        .prepare(`SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE t.id = ?`)
        .get(id) as RawTaskRow,
    );
  } else {
    // Open tasks nothing open blocks (dependents) / that block nothing open (blockers).
    startRows.push(
      ...(db
        .prepare(
          `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN}
            WHERE t.workstream_id = ? AND t.status <> 'CLOSED'
              AND NOT EXISTS (SELECT 1 FROM task_edges e JOIN tasks p ON p.id = e.${from}
                               WHERE e.${to} = t.id AND p.status <> 'CLOSED'
                                 AND p.workstream_id = t.workstream_id)
            ORDER BY t.local_id`,
        )
        .all(wsId) as RawTaskRow[]),
    );
  }
  for (const raw of startRows.slice(0, maxNodes)) {
    nodes.set(raw.id, rowFromDb(raw));
    rootIds.add(raw.id);
    level.push(raw.id);
  }
  const startCut = Math.max(0, startRows.length - maxNodes);

  const children = new Map<number, number[]>();
  const dropped = new Map<number, number>();
  const capDropped = new Map<number, number>();
  const closedHidden = new Map<number, number>();
  const expands = (id: number): boolean =>
    includeClosed || rootIds.has(id) || nodes.get(id)?.status !== "CLOSED";

  for (let depth = 0; level.length > 0; depth++) {
    const ids = level.filter(expands);
    if (ids.length === 0) break;
    if (depth >= maxDepth) {
      const counts: { src: number; open: number; closed: number }[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        counts.push(
          ...(db
            .prepare(
              `SELECT e.${from} AS src,
                      SUM(CASE WHEN t.status = 'CLOSED' AND ? = 0 THEN 0 ELSE 1 END) AS open,
                      SUM(CASE WHEN t.status = 'CLOSED' AND ? = 0 THEN 1 ELSE 0 END) AS closed
                 FROM task_edges e JOIN tasks t ON t.id = e.${to}
                WHERE e.${from} IN (${chunk.map(() => "?").join(", ")}) AND t.workstream_id = ? GROUP BY e.${from}`,
            )
            .all(includeClosed ? 1 : 0, includeClosed ? 1 : 0, ...chunk, wsId) as {
            src: number;
            open: number;
            closed: number;
          }[]),
        );
      }
      for (const c of counts) {
        if (c.open > 0) dropped.set(c.src, (dropped.get(c.src) ?? 0) + c.open);
        if (c.closed > 0) closedHidden.set(c.src, (closedHidden.get(c.src) ?? 0) + c.closed);
      }
      break;
    }
    // Chunked: an uncapped level can hold more ids than SQLite takes as variables.
    const rows: (RawTaskRow & { src: number })[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      rows.push(
        ...(db
          .prepare(
            `SELECT e.${from} AS src, ${SELECT_TASK_COLS}
               FROM task_edges e
               JOIN tasks t ON t.id = e.${to}
               JOIN workstreams ws ON ws.id = t.workstream_id AND ws.torn_down_at IS NULL
               LEFT JOIN agents ag ON ag.id = t.owner_id
              WHERE e.${from} IN (${chunk.map(() => "?").join(", ")}) AND t.workstream_id = ?
              ORDER BY e.${from}, t.local_id`,
          )
          .all(...chunk, wsId) as (RawTaskRow & { src: number })[]),
      );
    }
    const next: number[] = [];
    const closedSeen = new Map<number, number>();
    // Rows come ordered by (parent, local_id). Once the node cap forces a drop, every later row
    // of the level is dropped too (seen or not).
    let capped = false;
    for (const row of rows) {
      const leaf = row.status === "CLOSED" && !includeClosed;
      if (!capped) {
        if (leaf) {
          const n = closedSeen.get(row.src) ?? 0;
          closedSeen.set(row.src, n + 1);
          if (n >= closedPerNode) {
            closedHidden.set(row.src, (closedHidden.get(row.src) ?? 0) + 1);
            continue;
          }
        }
        if (!nodes.has(row.id) && nodes.size >= maxNodes) capped = true;
      }
      if (capped) {
        capDropped.set(row.src, (capDropped.get(row.src) ?? 0) + 1);
        continue;
      }
      if (!nodes.has(row.id)) {
        nodes.set(row.id, rowFromDb(row));
        next.push(row.id);
      }
      const kids = children.get(row.src) ?? [];
      kids.push(row.id);
      children.set(row.src, kids);
    }
    level = next;
  }

  // Preorder over what was loaded; the entry cap counts recurrences too.
  const listed = new Set<number>();
  let recurrences = 0;
  const walk = (id: number, parent: string | null, depth: number): void => {
    const task = nodes.get(id);
    if (task === undefined) return;
    const entry: FrontierEntry = {
      task,
      depth,
      parent,
      again: false,
      kids: dropped.get(id) ?? 0,
      closed: closedHidden.get(id) ?? 0,
      capCut: capDropped.get(id) ?? 0,
    };
    out.entries.push(entry);
    listed.add(id);
    const kids = children.get(id) ?? [];
    if (depth >= maxDepth) {
      // The level cap holds for the walk too: a shared DAG loads nodes at a shallow
      // level that the walk first meets deep. What is not listed under this entry is counted.
      for (const child of kids) {
        if (nodes.get(child)?.status === "CLOSED" && !includeClosed) entry.closed++;
        else entry.kids++;
      }
      return;
    }
    for (const child of kids) {
      const c = nodes.get(child);
      if (c === undefined) continue;
      if (listed.has(child)) {
        if (recurrences >= maxNodes) {
          out.againCut++;
          entry.kids++;
        } else {
          recurrences++;
          out.entries.push({
            task: c,
            depth: depth + 1,
            parent: task.name,
            again: true,
            kids: 0,
            closed: 0,
            capCut: 0,
          });
        }
        continue;
      }
      walk(child, task.name, depth + 1);
    }
  };
  for (const id of [...rootIds].sort((a, b) =>
    (nodes.get(a)?.name ?? "").localeCompare(nodes.get(b)?.name ?? ""),
  )) {
    if (listed.has(id)) continue;
    walk(id, null, 0);
  }
  out.rootsCut = startCut;
  return out;
}

/** One ASCII tree line per frontier entry: the branch drawing, then `label(entry)`. */
export function renderFrontierLines(
  entries: readonly FrontierEntry[],
  label: (entry: FrontierEntry) => string,
): string[] {
  const lines: string[] = [];
  const open: boolean[] = [];
  entries.forEach((e, i) => {
    if (e.depth === 0) {
      lines.push(label(e));
      return;
    }
    // Is there a later sibling (same depth, before the depth drops below it)?
    let last = true;
    for (let j = i + 1; j < entries.length; j++) {
      const d = entries[j]?.depth ?? 0;
      if (d < e.depth) break;
      if (d === e.depth) {
        last = false;
        break;
      }
    }
    open[e.depth] = !last;
    let prefix = "";
    for (let d = 1; d < e.depth; d++) prefix += open[d] ? "│   " : "    ";
    lines.push(`${prefix}${last ? "└── " : "├── "}${label(e)}`);
  });
  return lines;
}
