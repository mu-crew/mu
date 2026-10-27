// mu — `mu task tree` verb (record / JSON dependency listing).
//
// Lists the OPEN blocker subtree (default) or dependent subtree (--down)
// of a task from loadOpenTaskFrontier (src/dag.ts): open tasks expand, CLOSED
// ones are leaves, depth and node counts are capped. One record per entry in
// preorder (the shared task record plus `depth=`, `parent=`, and `kids=` /
// `closed=` / `capped=` counts of what hangs below and is not listed), or one
// JSON item per entry. Diamonds list once plus an `again` record at every
// later sighting; the same rule stops a cycle, which sync can create
// (`mu doctor` reports those).
//
// ONE way back from any cut (a page that does not fit 4 KB, a depth or node
// cap, collapsed CLOSED neighbours, a clipped title): the same command with
// `--all`, which walks everything (CLOSED included) and prints it whole.
// The footer `more=N next=<that command>` is reserved before the page shrinks.

import { assertTaskInWorkstream, emitJson, resolveEntityRef } from "../../cli.js";
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
  footerLine,
  jsonDocument,
  linesBytes,
  pageRecords,
  type RecordPage,
  taskItemCut,
  taskRecordCut,
} from "./records.js";

interface TreeOpts {
  /** Show dependents (what this task blocks) instead of blockers. */
  down?: boolean;
  json?: boolean;
  workstream?: string;
  /** The uncapped read: CLOSED walked too, every level and task, no paging. */
  all?: boolean;
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
  const json = opts.json === true;
  const whole = opts.all === true;
  const direction: FrontierDirection = down ? "dependents" : "blockers";
  const { entries, againCut } = loadOpenTaskFrontier(db, ws, rootId, direction, {
    uncapped: whole,
  });
  const allCmd = `mu task tree ${shellWord(rootId)} -w ${shellWord(ws)}${down ? " --down" : ""}${json ? " --json" : ""} --all`;

  const counts = (e: FrontierEntry): [string, number][] =>
    (
      [
        ["kids", e.kids],
        ["closed", e.closed],
        ["capped", e.capCut],
      ] as [string, number][]
    ).filter(([, n]) => n > 0);
  const fields = (e: FrontierEntry): string[] => [
    `depth=${e.depth}`,
    ...(e.parent === null ? [] : [`parent=${escapeRecordText(e.parent)}`]),
    ...(e.again ? ["again=1"] : []),
    ...counts(e).map(([k, n]) => `${k}=${n}`),
  ];
  const render = (page: RecordPage<FrontierEntry>) => {
    let cut = 0;
    // Not listed: entries past the page, and what a cap or the CLOSED collapse left under any entry.
    const more = page.more + entries.reduce((n, e) => n + e.kids + e.closed + e.capCut, 0);
    const lines: string[] = [];
    const items: Record<string, unknown>[] = [];
    for (const e of page.shown) {
      if (json) {
        const one = taskItemCut(e.task, { whole });
        cut += one.cut;
        items.push({
          ...one.item,
          depth: e.depth,
          parent: e.parent,
          ...(e.again ? { again: true } : {}),
          ...Object.fromEntries(counts(e)),
        });
      } else {
        const one = taskRecordCut(e.task, { whole, extra: fields(e) });
        cut += one.cut;
        lines.push(one.line);
      }
    }
    const foot = footerLine({ more, cut }, allCmd);
    if (json) {
      return {
        lines,
        data: {
          direction,
          workstream: ws,
          root: rootId,
          ...(whole ? {} : { max_depth: FRONTIER_MAX_DEPTH }),
          ...(againCut > 0 ? { again_cut: againCut } : {}),
          items,
          count: items.length,
          more,
          ...(cut > 0 ? { cut } : {}),
          ...(foot === null ? {} : { retrieve: allCmd }),
        },
      };
    }
    const header = [
      "tree",
      escapeRecordText(rootId),
      direction,
      `entries=${entries.length}${whole ? "" : ` max_depth=${FRONTIER_MAX_DEPTH}`}`,
      down ? "hint=omit --down for blockers" : "hint=--down for dependents",
    ].join("\t");
    return { lines: [header, ...lines, ...(foot === null ? [] : [foot])], data: undefined };
  };
  const page: RecordPage<FrontierEntry> = whole
    ? { shown: entries, more: 0 }
    : pageRecords(entries, (p) => {
        const r = render(p);
        return json ? Buffer.byteLength(jsonDocument(r.data)) + 1 : linesBytes(r.lines);
      });
  const out = render(page);
  if (json) emitJson(out.data);
  else console.log(out.lines.join("\n"));
}
