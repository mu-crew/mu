// Shared task-status toggle filter for TUI task-list surfaces.
//
// Used by the DAG and all-tasks popups. o/i/c toggle a status; p and w
// toggle two substate slices (OPEN/parked, CLOSED-but-not-done).
// Default is everything visible; state is deliberately local to
// the popup instance and resets on unmount (no persistence / no config).
//
// Per ROADMAP pledge: ink/react imports are confined to src/cli/tui/*.

import { Box, Text } from "ink";
import { type ReactElement, useCallback, useState } from "react";
import { GLYPH } from "../../glyphs.js";
import { TASK_STATUSES, type TaskPair, type TaskStatus } from "../../tasks/status.js";
import { colorStatus } from "../format.js";
import type { KeyFlags } from "./keys.js";

export const STATUS_BY_KEY: Readonly<Record<string, TaskStatus>> = {
  o: "OPEN",
  i: "IN_PROGRESS",
  c: "CLOSED",
};

const STATUS_LABELS: Readonly<Record<TaskStatus, { key: string; rest: string }>> = {
  OPEN: { key: "O", rest: "pen" },
  IN_PROGRESS: { key: "I", rest: "n_progress" },
  CLOSED: { key: "C", rest: "losed" },
};

export function toggleStatusSet(
  statuses: ReadonlySet<TaskStatus>,
  status: TaskStatus,
): Set<TaskStatus> {
  const next = new Set(statuses);
  if (next.has(status)) {
    next.delete(status);
  } else {
    next.add(status);
  }
  return next;
}

export function statusForToggleKey(input: string, key: KeyFlags): TaskStatus | undefined {
  if (key.ctrl === true || key.meta === true) return undefined;
  return STATUS_BY_KEY[input.toLowerCase()];
}

/** The two substate slices with their own toggle: `p` OPEN/parked,
 *  `w` CLOSED rows whose substate is not done (rejected, wontfix, ...). */
export type SubstateToggle = "parked" | "notDone";

const SUBSTATE_BY_KEY: Readonly<Record<string, SubstateToggle>> = { p: "parked", w: "notDone" };

export function substateToggleForKey(input: string, key: KeyFlags): SubstateToggle | undefined {
  if (key.ctrl === true || key.meta === true) return undefined;
  return SUBSTATE_BY_KEY[input.toLowerCase()];
}

export interface FilterState {
  statuses: ReadonlySet<TaskStatus>;
  showParked: boolean;
  showNotDone: boolean;
}

/** True when a task survives every toggle: its status is enabled and
 *  neither substate slice it belongs to is hidden. */
export function passesFilter(t: TaskPair, f: FilterState): boolean {
  if (!f.statuses.has(t.status)) return false;
  if (!f.showParked && t.status === "OPEN" && t.substate === "parked") return false;
  if (!f.showNotDone && t.status === "CLOSED" && t.substate !== "done") return false;
  return true;
}

export interface StatusFilter extends FilterState {
  statuses: Set<TaskStatus>;
  toggle: (s: TaskStatus) => void;
  /** Returns true when an o/i/c/p/w toggle key was consumed. */
  onKey: (input: string, key: KeyFlags) => boolean;
}

export function useStatusFilter(): StatusFilter {
  const [statuses, setStatuses] = useState<Set<TaskStatus>>(() => new Set(TASK_STATUSES));
  const [showParked, setShowParked] = useState(true);
  const [showNotDone, setShowNotDone] = useState(true);

  const toggle = useCallback((status: TaskStatus) => {
    setStatuses((prev) => toggleStatusSet(prev, status));
  }, []);

  const onKey = useCallback(
    (input: string, key: KeyFlags): boolean => {
      const status = statusForToggleKey(input, key);
      if (status !== undefined) {
        toggle(status);
        return true;
      }
      const sub = substateToggleForKey(input, key);
      if (sub === "parked") setShowParked((v) => !v);
      else if (sub === "notDone") setShowNotDone((v) => !v);
      return sub !== undefined;
    },
    [toggle],
  );

  return { statuses, showParked, showNotDone, toggle, onKey };
}

const SUBSTATE_LABELS: ReadonlyArray<{
  id: SubstateToggle;
  key: string;
  rest: string;
  color: "gray" | "red";
}> = [
  { id: "parked", key: "P", rest: "arked", color: "gray" },
  // Covers every non-done close (rejected, wontfix, duplicate, superseded).
  { id: "notDone", key: "W", rest: "on't do", color: "red" },
];

export function StatusFilterStrip({
  statuses,
  showParked = true,
  showNotDone = true,
}: {
  statuses: ReadonlySet<TaskStatus>;
  showParked?: boolean;
  showNotDone?: boolean;
}): ReactElement {
  const substateOn: Record<SubstateToggle, boolean> = {
    parked: showParked,
    notDone: showNotDone,
  };
  return (
    <Box>
      <Text dimColor>filters: </Text>
      {TASK_STATUSES.map((status, i) => {
        const label = STATUS_LABELS[status];
        const enabled = statuses.has(status);
        return (
          <Text key={status}>
            {i > 0 ? "  " : ""}
            <Text>{"["}</Text>
            <Text>{colorStatus(status).replace(status, label.key)}</Text>
            <Text>{"]"}</Text>
            <Text>{label.rest}</Text>
            <Text> </Text>
            <Text color={enabled ? "green" : "gray"}>{enabled ? GLYPH.on : GLYPH.off}</Text>
          </Text>
        );
      })}
      {SUBSTATE_LABELS.map((label, i) => {
        const enabled = substateOn[label.id];
        return (
          <Text key={label.id}>
            {i === 0 ? "   " : "  "}
            <Text>{"["}</Text>
            <Text color={label.color}>{label.key}</Text>
            <Text>{"]"}</Text>
            <Text>{label.rest}</Text>
            <Text> </Text>
            <Text color={enabled ? "green" : "gray"}>{enabled ? GLYPH.on : GLYPH.off}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
