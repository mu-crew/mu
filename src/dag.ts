// mu — task-DAG read + ASCII forest rendering helpers.
//
// Shared by the static `mu task tree` command and the read-only TUI DAG
// popup. Pure rendering lives here so the box-drawing characters and
// diamond-collapse semantics have one implementation.

import pc from "picocolors";
import type { Db } from "./db.js";
import type { TaskStatus } from "./tasks/status.js";
import {
  listTasks,
  type RawTaskRow,
  rowFromDb,
  SELECT_TASK_COLS,
  TASK_FROM_JOIN,
  type TaskRow,
  taskIdFor,
} from "./tasks.js";

// One-line marker appended to a tree node when its subtree was already
// rendered earlier in the forest (DAG diamond collapse). Symbol-only
// + dimmed: the ↻ glyph carries the recurrence semantics, the dim
// keeps it from competing with the task title for the eye.
const RECURRENCE_MARKER = `  ${pc.dim("(↻)")}`;

export interface FullDag {
  /** Root tasks: no incoming `blocks` edge (no blockers). */
  roots: TaskRow[];
  /** Edges map parent task name → child task names (what parent blocks). */
  edges: Map<string, string[]>;
  /** All tasks in the workstream, keyed by operator-facing name. */
  tasks: Map<string, TaskRow>;
}

export type TaskStatusLabelFn = (task: TaskRow) => string;

export interface RenderTreeOptions {
  /** Include the task title after the name + status label. Default: true. */
  includeTitle?: boolean;
}

export interface LoadFullDagOptions {
  /** Optional visible-status filter. Omitted = every task status. */
  statuses?: ReadonlySet<TaskStatus>;
  /** Optional row predicate, applied after `statuses` (e.g. the TUI's
   *  substate toggles). Omitted = keep every row. */
  include?: (task: TaskRow) => boolean;
}

export function loadFullDag(db: Db, workstream: string, opts: LoadFullDagOptions = {}): FullDag {
  const tasks = listTasks(db, workstream).filter(
    (t) =>
      (opts.statuses === undefined || opts.statuses.has(t.status)) &&
      (opts.include === undefined || opts.include(t)),
  );
  const byName = new Map(tasks.map((t) => [t.name, t]));
  const incoming = new Set<string>();
  const edges = new Map<string, string[]>();

  for (const task of tasks) {
    edges.set(task.name, []);
  }

  // Start from task_edges deliberately. With ordinary JOINs plus the
  // same-workstream guard below, SQLite chose tasks(src) × tasks(dst)
  // before probing the edge PK — quadratic in workstream size. CROSS JOIN
  // fixes the loop order at edges → two INTEGER-PK lookups while retaining
  // the guard against malformed cross-workstream rows.
  const rows = db
    .prepare(
      `SELECT src.local_id AS parent, dst.local_id AS child
         FROM task_edges e
   CROSS JOIN tasks src
   CROSS JOIN tasks dst
        WHERE src.id = e.from_task_id
          AND dst.id = e.to_task_id
          AND src.workstream_id = (SELECT id FROM workstreams WHERE name = ?)
          AND dst.workstream_id = src.workstream_id
        ORDER BY src.local_id, dst.local_id`,
    )
    .all(workstream) as { parent: string; child: string }[];

  for (const row of rows) {
    if (!byName.has(row.parent) || !byName.has(row.child)) continue;
    incoming.add(row.child);
    const children = edges.get(row.parent) ?? [];
    children.push(row.child);
    edges.set(row.parent, children);
  }

  const roots = tasks.filter((t) => !incoming.has(t.name));
  return { roots, edges, tasks: byName };
}

/**
 * Render a DAG forest in the same ASCII shape as `mu task tree --down`:
 * each root is printed as a header node, dependents are below it, and
 * DAG diamonds collapse after the first full subtree render with a
 * one-line recurrence marker.
 */
export function renderForest(
  roots: readonly TaskRow[],
  edges: ReadonlyMap<string, readonly string[]>,
  statusFn: TaskStatusLabelFn,
  tasksByName?: ReadonlyMap<string, TaskRow>,
  opts: RenderTreeOptions = {},
): string {
  const byName = new Map(tasksByName ?? roots.map((t) => [t.name, t]));
  const seen = new Set<string>();
  const sections: string[] = [];

  for (const root of roots) {
    if (!byName.has(root.name)) byName.set(root.name, root);
    const lines = [formatTreeNodeLabel(root, statusFn, opts)];
    if (seen.has(root.name)) {
      lines[0] = `${lines[0]}${RECURRENCE_MARKER}`;
    } else {
      seen.add(root.name);
      renderForestChildren(root.name, "", edges, byName, statusFn, seen, lines, opts);
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

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
  /** `tasks.id` (internal: only for a retrieval SQL command, never output as `id`). */
  pk: number;
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
  /** Neighbours of any status the node cap left out (not in `kids` / `closed`): re-rooting here would hit the same cap, so the way back is a read from `capFrom`. */
  capCut: number;
  /** `local_id` of the first neighbour the node cap left out; the capped ones are among this entry's neighbours at or after it ("" when `capCut` is 0). */
  capFrom: string;
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
  /** Walk through CLOSED tasks too (still capped by depth and entries). */
  includeClosed?: boolean;
  /** Levels below a root to list (default and ceiling `FRONTIER_MAX_DEPTH`). */
  maxDepth?: number;
  /** With a `root`: list only its neighbours whose `local_id` is at or after this (the way back from a node-cap cut). */
  childrenFrom?: string;
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
 * per level (never per node), same-workstream edges only. `loadFullDag` stays
 * the whole-workstream SDK read.
 */
export function loadOpenTaskFrontier(
  db: Db,
  workstream: string,
  root?: string,
  direction: FrontierDirection = "dependents",
  opts: OpenTaskFrontierOptions = {},
): OpenTaskFrontier {
  const out: OpenTaskFrontier = { direction, entries: [], rootsCut: 0, againCut: 0 };
  const maxDepth = Math.min(opts.maxDepth ?? FRONTIER_MAX_DEPTH, FRONTIER_MAX_DEPTH);
  const wsRow = db
    .prepare("SELECT id FROM workstreams WHERE name = ? AND torn_down_at IS NULL")
    .get(workstream) as { id: number } | undefined;
  if (wsRow === undefined) return out;
  const wsId = wsRow.id;
  const [from, to] =
    direction === "dependents" ? ["from_task_id", "to_task_id"] : ["to_task_id", "from_task_id"];
  const includeClosed = opts.includeClosed === true;

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
  for (const raw of startRows.slice(0, FRONTIER_MAX_NODES)) {
    nodes.set(raw.id, rowFromDb(raw));
    rootIds.add(raw.id);
    level.push(raw.id);
  }
  const startCut = Math.max(0, startRows.length - FRONTIER_MAX_NODES);

  const children = new Map<number, number[]>();
  const dropped = new Map<number, number>();
  const capDropped = new Map<number, number>();
  const capFrom = new Map<number, string>();
  const closedHidden = new Map<number, number>();
  const expands = (id: number): boolean =>
    includeClosed || rootIds.has(id) || nodes.get(id)?.status !== "CLOSED";

  for (let depth = 0; level.length > 0; depth++) {
    const ids = level.filter(expands);
    if (ids.length === 0) break;
    const marks = ids.map(() => "?").join(", ");
    if (depth >= maxDepth) {
      const counts = db
        .prepare(
          `SELECT e.${from} AS src,
                  SUM(CASE WHEN t.status = 'CLOSED' AND ? = 0 THEN 0 ELSE 1 END) AS open,
                  SUM(CASE WHEN t.status = 'CLOSED' AND ? = 0 THEN 1 ELSE 0 END) AS closed
             FROM task_edges e JOIN tasks t ON t.id = e.${to}
            WHERE e.${from} IN (${marks}) AND t.workstream_id = ? GROUP BY e.${from}`,
        )
        .all(includeClosed ? 1 : 0, includeClosed ? 1 : 0, ...ids, wsId) as {
        src: number;
        open: number;
        closed: number;
      }[];
      for (const c of counts) {
        if (c.open > 0) dropped.set(c.src, (dropped.get(c.src) ?? 0) + c.open);
        if (c.closed > 0) closedHidden.set(c.src, (closedHidden.get(c.src) ?? 0) + c.closed);
      }
      break;
    }
    const skip = depth === 0 && root !== undefined ? opts.childrenFrom : undefined;
    const rows = db
      .prepare(
        `SELECT e.${from} AS src, ${SELECT_TASK_COLS}
           FROM task_edges e
           JOIN tasks t ON t.id = e.${to}
           JOIN workstreams ws ON ws.id = t.workstream_id AND ws.torn_down_at IS NULL
           LEFT JOIN agents ag ON ag.id = t.owner_id
          WHERE e.${from} IN (${marks}) AND t.workstream_id = ?${skip === undefined ? "" : " AND t.local_id >= ?"}
          ORDER BY e.${from}, t.local_id`,
      )
      .all(...ids, wsId, ...(skip === undefined ? [] : [skip])) as (RawTaskRow & { src: number })[];
    const next: number[] = [];
    const closedSeen = new Map<number, number>();
    // Rows come ordered by (parent, local_id). Once the node cap forces a drop, every later row
    // of the level is dropped too (seen or not), so what a parent lost to the cap is exactly its
    // neighbours from `capFrom` on: a read the tree can name as plain SQL.
    let capped = false;
    for (const row of rows) {
      const leaf = row.status === "CLOSED" && !includeClosed;
      if (!capped) {
        if (leaf) {
          const n = closedSeen.get(row.src) ?? 0;
          closedSeen.set(row.src, n + 1);
          if (n >= FRONTIER_CLOSED_PER_NODE) {
            closedHidden.set(row.src, (closedHidden.get(row.src) ?? 0) + 1);
            continue;
          }
        }
        if (!nodes.has(row.id) && nodes.size >= FRONTIER_MAX_NODES) capped = true;
      }
      if (capped) {
        capDropped.set(row.src, (capDropped.get(row.src) ?? 0) + 1);
        if (!capFrom.has(row.src)) capFrom.set(row.src, row.local_id);
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
      pk: id,
      depth,
      parent,
      again: false,
      kids: dropped.get(id) ?? 0,
      closed: closedHidden.get(id) ?? 0,
      capCut: capDropped.get(id) ?? 0,
      capFrom: capFrom.get(id) ?? "",
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
        if (recurrences >= FRONTIER_MAX_NODES) {
          out.againCut++;
          entry.kids++;
        } else {
          recurrences++;
          out.entries.push({
            task: c,
            pk: child,
            depth: depth + 1,
            parent: task.name,
            again: true,
            kids: 0,
            closed: 0,
            capCut: 0,
            capFrom: "",
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

/**
 * ASCII rendering of the open task tree under `root` (bounded: see
 * `loadOpenTaskFrontier`): a node with neighbours left out ends in
 * `(+N)` / `(closed +N)`, a recurrence in the diamond marker.
 */
export function renderTaskTree(
  db: Db,
  workstream: string,
  root: TaskRow,
  direction: FrontierDirection,
  statusFn: TaskStatusLabelFn,
  opts: RenderTreeOptions = {},
): string {
  const { entries } = loadOpenTaskFrontier(db, workstream, root.name, direction);
  return renderFrontierLines(entries, (e) => {
    const marks = [
      e.kids + e.capCut > 0 ? `+${e.kids + e.capCut}` : "",
      e.closed > 0 ? `closed +${e.closed}` : "",
    ].filter(Boolean);
    return `${formatTreeNodeLabel(e.task, statusFn, opts)}${e.again ? RECURRENCE_MARKER : ""}${
      marks.length > 0 ? `  ${pc.dim(`(${marks.join(", ")})`)}` : ""
    }`;
  }).join("\n");
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
function renderForestChildren(
  taskName: string,
  prefix: string,
  edges: ReadonlyMap<string, readonly string[]>,
  byName: Map<string, TaskRow>,
  statusFn: TaskStatusLabelFn,
  seen: Set<string>,
  lines: string[],
  opts: RenderTreeOptions,
): void {
  const children = edges.get(taskName) ?? [];
  for (let i = 0; i < children.length; i++) {
    const childName = children[i];
    if (childName === undefined) continue;
    const isLast = i === children.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    const child = byName.get(childName);

    if (!child) {
      lines.push(`${prefix}${branch}${childName}  (missing!)`);
      continue;
    }

    if (seen.has(childName)) {
      lines.push(
        `${prefix}${branch}${formatTreeNodeLabel(child, statusFn, opts)}${RECURRENCE_MARKER}`,
      );
      continue;
    }

    lines.push(`${prefix}${branch}${formatTreeNodeLabel(child, statusFn, opts)}`);
    seen.add(childName);
    renderForestChildren(childName, childPrefix, edges, byName, statusFn, seen, lines, opts);
  }
}

export function formatTreeNodeLabel(
  t: TaskRow,
  statusFn: TaskStatusLabelFn,
  opts: RenderTreeOptions = {},
): string {
  const base = `${t.name}  ${statusFn(t)}`;
  if (opts.includeTitle === false) return base;
  return `${base}  ${t.title}`;
}
