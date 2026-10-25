// mu — `mu task tree` verb (ASCII / JSON dependency rendering).
//
// Renders the OPEN blocker subtree (default) or dependent subtree (--down)
// of a task from loadOpenTaskFrontier (src/dag.ts): open tasks expand, CLOSED
// ones are leaves (--all walks them too), depth and node counts are capped, and
// a node with more under it says how many and the exact `tree <node>` command.
// Diamonds list once plus a one-line "↻" recurrence at every later sighting; the
// same rule stops a cycle, which sync can create (`mu doctor` reports those).
// The result is paged by `--from <entry>` so no tree is cut silently.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import { assertTaskInWorkstream, resolveEntityRef } from "../../cli.js";
import {
  FRONTIER_MAX_DEPTH,
  type FrontierEntry,
  loadOpenTaskFrontier,
  renderFrontierLines,
} from "../../dag.js";
import type { Db } from "../../db.js";
import { pc } from "../../output.js";
import { shellWord } from "../../shell-quote.js";
import { formatPair } from "../../tasks/status.js";
import { getTask, TaskNotFoundError } from "../../tasks.js";
import {
  clipEscaped,
  escapeRecordText,
  fromOffset,
  jsonDocument,
  linesBytes,
  moreLine,
  pageRecords,
  RECORD_CHARS,
  taskItem,
  titleCommand,
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
  const direction = down ? "dependents" : "blockers";
  const frontier = loadOpenTaskFrontier(db, ws, rootId, direction, {
    includeClosed: opts.all === true,
  });
  const entries = frontier.entries;
  const flags = `${down ? " --down" : ""}${opts.all === true ? " --all" : ""}`;
  const treeCmd = (id: string, extra = ""): string =>
    `mu task tree ${shellWord(id)} -w ${shellWord(ws)}${down ? " --down" : ""}${extra}`;
  const nextFor = (k: number): string =>
    `${treeCmd(rootId)}${opts.all === true ? " --all" : ""} --from ${k}`;
  void flags;

  // What an entry says is left under it, each with the command that reaches it.
  const marks = (e: FrontierEntry): string[] => {
    const out: string[] = [];
    if (e.kids > 0) out.push(`+${e.kids} next=${treeCmd(e.task.name)}`);
    if (e.closed > 0) out.push(`closed+${e.closed} next=${treeCmd(e.task.name, " --all")}`);
    return out;
  };
  const omissions = [
    ...(frontier.rootsCut > 0 ? [`cut=${frontier.rootsCut}`] : []),
    ...(frontier.againCut > 0 ? [`again_cut=${frontier.againCut}`] : []),
  ];

  const from = fromOffset(opts.from);
  if (opts.json) {
    const itemOf = (e: FrontierEntry) => ({
      ...taskItem(e.task),
      depth: e.depth,
      parent: e.parent,
      ...(e.again ? { again: true } : {}),
      ...(e.kids > 0 ? { kids: e.kids, kids_retrieve: treeCmd(e.task.name) } : {}),
      ...(e.closed > 0
        ? { closed: e.closed, closed_retrieve: treeCmd(e.task.name, " --all") }
        : {}),
    });
    const dataOf = (page: { shown: FrontierEntry[]; more: number; next: string | null }) => ({
      direction,
      workstream: ws,
      root: rootId,
      max_depth: FRONTIER_MAX_DEPTH,
      items: page.shown.map(itemOf),
      count: page.shown.length,
      more: page.more,
      ...(page.next === null ? {} : { retrieve: page.next }),
    });
    const page = pageRecords(
      entries,
      from,
      (p) => Buffer.byteLength(jsonDocument(dataOf(p))) + 1,
      nextFor,
    );
    console.log(jsonDocument(dataOf(page)));
    return;
  }

  // Branch drawing needs every entry's neighbours, so draw the whole list and page the lines.
  const labels = new Map<FrontierEntry, string>();
  const label = (e: FrontierEntry): string => {
    const cached = labels.get(e);
    if (cached !== undefined) return cached;
    const tail = [e.again ? "↻" : "", ...marks(e)].filter(Boolean).join(" ");
    const base = `${e.task.name}  ${formatPair(e.task)}`;
    const suffix = tail === "" ? "" : `  (${tail})`;
    // Room: the record cap less the branch drawing (4 chars a level), the fixed parts and,
    // for a clipped title, the `cut=N next=<command>` tail (N has at most as many digits as the title has characters).
    const full = escapeRecordText(e.task.title);
    const retrieve = titleCommand(e.task);
    const fixed = 4 * e.depth + [...base].length + [...suffix].length + 4;
    let text: string;
    if ([...full].length + fixed <= RECORD_CHARS) {
      text = `${escapeRecordText(base)}  ${full}${suffix}`;
    } else {
      const tailLen = `  cut=  next=${retrieve}`.length + String([...e.task.title].length).length;
      const title = clipEscaped(e.task.title, Math.max(0, RECORD_CHARS - fixed - tailLen - 1));
      text = `${escapeRecordText(base)}  ${title.text}…  cut=${title.cut}  next=${retrieve}${suffix}`;
    }
    labels.set(e, text);
    return text;
  };
  const drawn = renderFrontierLines(entries, label);
  const swap = down ? "omit --down for blockers" : "--down for dependents";
  const header = `tree ${rootId} ${direction} (${swap}) entries=${entries.length}${omissions.length > 0 ? ` ${omissions.join(" ")}` : ""}`;
  const page = pageRecords(
    drawn,
    from,
    (p) =>
      linesBytes([header, ...p.shown, ...(moreLine(p) === null ? [] : [moreLine(p) as string])]),
    nextFor,
  );
  console.log(pc.dim(header));
  const foot = moreLine(page);
  console.log([...page.shown, ...(foot === null ? [] : [foot])].join("\n"));
}
