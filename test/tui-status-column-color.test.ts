import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inkColorForPair } from "../src/cli/format.js";
import { ReadyCard } from "../src/cli/tui/cards/ready.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { TaskRow } from "../src/tasks.js";
import { findListRowByCell } from "./_jsx-find.js";

const EMPTY_SNAPSHOT: WorkstreamSnapshot = {
  workstreamName: "demo",
  view: {
    agents: [],
    orphans: [],
    report: { prunedGhosts: 0, orphans: [], mode: "report-only" },
  },
  tracks: [],
  ready: [],
  inProgress: [],
  blocked: [],
  recentClosed: [],
  parkedCount: 0,
  allTasks: [],
  workspaces: [],
  workspaceOrphans: [],
  recent: [],
  recentCommits: [],
  commitsBackend: null,
  doctor: null,
};

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    name: "task_01",
    workstreamName: "demo",
    title: "Task 01",
    status: "OPEN",
    substate: "todo",
    impact: 80,
    effortDays: 1,
    ownerName: null,
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

function expectStatusColor(
  node: unknown,
  status: string,
  columnIndex: number,
  color: string,
): void {
  const row = findListRowByCell(node, status);
  expect(row, `row containing status ${status}`).toBeDefined();
  expect(row?.colors?.[columnIndex]?.color).toBe(color);
  expect(row?.colors?.[columnIndex]?.dimColor).toBeUndefined();
}

describe("TUI status column colours", () => {
  it("Ready card colours OPEN status cyan", () => {
    const snapshot = { ...EMPTY_SNAPSHOT, ready: [task({ name: "ready_x", status: "OPEN" })] };

    expectStatusColor(ReadyCard({ snapshot }), "OPEN", 1, "cyan");
  });

  it.each([
    ["src/cli/tui/popups/ready.tsx", 1],
    ["src/cli/tui/popups/inprogress.tsx", 2],
    ["src/cli/tui/popups/blocked.tsx", 2],
    ["src/cli/tui/popups/recent.tsx", 2],
  ] as const)("%s derives row colours from inkColorForPair(t)", (path, statusColumn) => {
    const src = readFileSync(path, "utf-8");
    expect(src).toContain("{ color: inkColorForPair(t) }, // status");
    expect(src).not.toContain("{ dimColor: true }, // status");
    expect(statusColumn).toBeGreaterThan(0);
  });

  it("all-tasks popup derives row colours from inkColorForPair with blocked override", () => {
    const src = readFileSync("src/cli/tui/popups/all-tasks.tsx", "utf-8");
    // Blocked tasks get yellow; non-blocked use inkColorForPair
    expect(src).toContain('isBlocked ? "yellow" : inkColorForPair(t)');
  });

  it.each([
    ["OPEN", "todo", "cyan"],
    ["OPEN", "parked", "gray"],
    ["IN_PROGRESS", "active", "yellow"],
    ["CLOSED", "done", "green"],
    ["CLOSED", "wontfix", "red"],
    ["CLOSED", "duplicate", "red"],
    ["CLOSED", "superseded", "red"],
  ] as const)("inkColorForPair(%s/%s) is %s", (status, substate, color) => {
    expect(inkColorForPair({ status, substate })).toBe(color);
  });
});
