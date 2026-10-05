// Full task-DAG popup (`g`). Keybind-only; no dashboard card slot.
//
// Read-only forest of the current workstream: every root task (no
// incoming blocks edge) is rendered with the same ASCII tree machinery
// as `mu task tree --down`, separated by blank lines. No card owns this
// popup; it is a dashboard-level graph affordance for large workstreams.

import { Box, Text } from "ink";
import { type ReactElement, useMemo, useRef, useState } from "react";
import { loadFullDag, renderForest } from "../../../dag.js";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import type { TaskStatus } from "../../../tasks/status.js";
import { colorPair } from "../../format.js";
import { contentWidthFromCols, truncateCell } from "../columns.js";
import { dispatchPopupKeyFromInk } from "../keys.js";
import { usePopupInput } from "../popup-input.js";
import { PopupShell } from "../popup-shell.js";
import {
  type FilterState,
  passesFilter,
  StatusFilterStrip,
  useStatusFilter,
} from "../use-status-filter.js";
import { useTerminalSize } from "../use-terminal-size.js";
import { DrillScrollView, useDrillKeymap } from "./drill.js";
import { POPUP_DRILL_CHROME_ROWS, usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  fastTickNonce: number;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  onFilterEditingChange?: (editing: boolean) => void;
  db: Db;
  workstream: string;
}

const DAG_STRIP_ROWS = 1;

interface DagBody {
  body: string;
  roots: string[];
}

export function DagPopup({
  yank,
  onClose,
  db,
  workstream,
  fastTickNonce,
}: PopupProps): ReactElement {
  // DrillScrollView (title + hint) below one StatusFilterStrip row.
  const viewport = usePopupViewport(POPUP_DRILL_CHROME_ROWS + DAG_STRIP_ROWS);
  const statusFilter = useStatusFilter();
  const { statuses, showParked, showNotDone } = statusFilter;
  const { cols } = useTerminalSize();
  const contentWidth = contentWidthFromCols(cols);
  const { body, roots } = useMemo<DagBody>(() => {
    void fastTickNonce;
    return buildDagBody(db, workstream, { statuses, showParked, showNotDone }, contentWidth);
  }, [db, workstream, statuses, showParked, showNotDone, contentWidth, fastTickNonce]);
  const [focusedRoot, setFocusedRoot] = useState<string | null>(() => roots[0] ?? null);
  const lineToRootRef = useRef<readonly string[]>([]);
  const rootsRef = useRef<readonly string[]>([]);
  rootsRef.current = roots;
  const focusedTask = focusedRoot !== null && roots.includes(focusedRoot) ? focusedRoot : roots[0];
  const drill = useDrillKeymap({
    body,
    viewport,
    onClose,
    onYank: () => {
      if (focusedTask === undefined) return;
      return yank(dagYankCommand(focusedTask, workstream));
    },
    onScrollChange: (newTop) =>
      setFocusedRoot(lineToRootRef.current[newTop] ?? rootsRef.current[0] ?? null),
    resetKey: workstream,
  });

  const lineToRoot = useMemo(
    () => rootForBodyLines(drill.wrappedLines, roots),
    [drill.wrappedLines, roots],
  );
  lineToRootRef.current = lineToRoot;

  usePopupInput((input, key) => {
    if (statusFilter.onKey(input, key)) return;
    const action = dispatchPopupKeyFromInk(input, key);
    drill.dispatch(action);
  });

  if (roots.length === 0) {
    return (
      <PopupShell title={`DAG · ${workstream}`}>
        <Box flexDirection="column" flexGrow={1}>
          <StatusFilterStrip
            statuses={statuses}
            showParked={showParked}
            showNotDone={showNotDone}
          />
          <Text dimColor>(no tasks)</Text>
        </Box>
      </PopupShell>
    );
  }

  return (
    <PopupShell title={`DAG · ${workstream}`} hint="y yanks `mu task tree <root-id>`">
      <Box flexDirection="column" flexGrow={1}>
        <StatusFilterStrip statuses={statuses} showParked={showParked} showNotDone={showNotDone} />
        <DrillScrollView
          title="task DAG forest"
          body={body}
          viewport={viewport}
          scrollTop={drill.scrollTop}
          wrappedBody={drill.wrappedBody}
          emptyText="(no tasks)"
          hint="y yanks `mu task tree <root-id>`"
        />
      </Box>
    </PopupShell>
  );
}

export function dagYankCommand(taskId: string, workstream: string): string {
  return `mu task tree ${taskId} -w ${workstream}`;
}

export function buildDagBody(
  db: Db,
  workstream: string,
  filter: ReadonlySet<TaskStatus> | FilterState,
  contentWidth: number = contentWidthFromCols(80),
): DagBody {
  // A bare status set means "no substate toggles" (both slices shown).
  const f: FilterState =
    "statuses" in filter ? filter : { statuses: filter, showParked: true, showNotDone: true };
  const dag = loadFullDag(db, workstream, { include: (t) => passesFilter(t, f) });
  const body = renderForest(dag.roots, dag.edges, (task) => colorPair(task), dag.tasks, {
    includeTitle: false,
  });
  return {
    body: truncateDagBody(body, contentWidth),
    roots: dag.roots.map((t) => t.name),
  };
}

export function truncateDagBody(body: string, contentWidth: number): string {
  const width = Math.max(0, contentWidth - 1);
  return body
    .split("\n")
    .map((line) => truncateCell(line, width))
    .join("\n");
}

function rootForBodyLines(lines: readonly string[], roots: readonly string[]): string[] {
  const rootSet = new Set(roots);
  const out: string[] = [];
  let current = roots[0] ?? "";
  for (const line of lines) {
    const maybeRoot = line.split(/\s+/)[0];
    if (maybeRoot !== undefined && rootSet.has(maybeRoot)) current = maybeRoot;
    out.push(current);
  }
  return out;
}
