// formatTaskListTable sizes the title so each row fits the terminal. The
// status cell renders the (status, substate) pair, e.g. "CLOSED/wontfix",
// so the budget must measure that text, not the bare status.

import { stripVTControlCharacters as plain } from "node:util";
import { describe, expect, it } from "vitest";
import { formatTaskListTable } from "../src/cli/format.js";
import type { TaskRow } from "../src/tasks.js";

function task(over: Partial<TaskRow>): TaskRow {
  return {
    name: "a1",
    workstreamName: "demo",
    title: "x".repeat(200),
    status: "OPEN",
    substate: "todo",
    impact: 50,
    effortDays: 1,
    ownerName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("formatTaskListTable width", () => {
  it("rows with a long status/substate pair still fit the terminal", () => {
    const original = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
    try {
      const out = formatTaskListTable([
        task({ name: "a1", status: "CLOSED", substate: "wontfix" }),
        task({ name: "a2" }),
      ]);
      const widths = plain(out)
        .split("\n")
        .map((l) => l.length);
      expect(Math.max(...widths)).toBeLessThanOrEqual(100);
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: original, configurable: true });
    }
  });
});
