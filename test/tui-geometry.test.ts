// Pure geometry of the dashboard screen: columns.ts (stable aligned columns),
// frame.tsx (rounded frames) and grid.ts (card columns and row budgets).
// No ink: the modules return plain text.

import { createElement } from "react";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import {
  type ColumnSpec,
  columnWidths,
  fitCell,
  GUTTER,
  naturalWidths,
  renderRow,
} from "../src/cli/tui/columns.js";
import { borderLine, FRAME_CHROME, Frame, frameLines } from "../src/cli/tui/frame.js";
import {
  allocateRowBudgets,
  type CardSpec,
  columnCount,
  fitColumn,
  gridWidths,
  placeCards,
} from "../src/cli/tui/grid.js";
import { renderApp } from "./_ink-render.js";

const widthOf = (lines: readonly string[]): number[] => lines.map((l) => stringWidth(l));

describe("columns", () => {
  const specs: ColumnSpec[] = [{ kind: "protect", max: 8 }, { kind: "protect" }, { kind: "clip" }];
  const rows = [
    ["t001", "OPEN", "short"],
    ["a_much_longer_task_id", "IN_PROGRESS", "a title that is rather long indeed"],
  ];

  it("naturalWidths counts visual width and strips control characters", () => {
    expect(naturalWidths([["日本", "a\u001b[31mb"]], 2)).toEqual([4, 2]);
    expect(naturalWidths([], 2)).toEqual([0, 0]);
  });

  it("protected columns keep their natural width (inside min/max); clip takes the rest", () => {
    const w = columnWidths(rows, specs, 50);
    expect(w[0]).toBe(8); // capped
    expect(w[1]).toBe(11);
    expect(w[2]).toBe(50 - 8 - 11 - 2 * GUTTER);
  });

  it("a clip column that fits is left at its natural width", () => {
    const w = columnWidths(rows, specs, 200);
    expect(w[2]).toBe(34);
  });

  it("without a total the widths are natural", () => {
    expect(columnWidths(rows, specs)).toEqual([8, 11, 34]);
  });

  it("min floors a column, so widths do not depend on which rows are passed", () => {
    const fixed: ColumnSpec[] = [{ kind: "protect", min: 12 }, { kind: "clip" }];
    expect(columnWidths([["a", "x"]], fixed, 40)[0]).toBe(12);
    expect(columnWidths([], fixed, 40)[0]).toBe(12);
  });

  it("clip columns collapse when the protected ones alone overflow", () => {
    expect(columnWidths(rows, specs, 15)).toEqual([8, 11, 0]);
  });

  it("several clip columns share the rest; the last takes the rounding", () => {
    const two: ColumnSpec[] = [{ kind: "clip" }, { kind: "clip" }];
    const w = columnWidths([["x".repeat(40), "y".repeat(40)]], two, 31);
    expect(w).toEqual([14, 15]);
  });

  it("a row is the same width every time, whatever the content", () => {
    const w = columnWidths(rows, specs, 50);
    const lines = rows.map((r) => renderRow(r, w, specs, 50));
    expect(widthOf(lines)).toEqual([50, 50]);
    // The second column starts at the same x on every row.
    const col2 = (line: string): number =>
      line.indexOf("OPEN") >= 0 ? line.indexOf("OPEN") : line.indexOf("IN_PROGRESS");
    expect(col2(lines[0] ?? "")).toBe(col2(lines[1] ?? ""));
  });

  it("only the clip column is cut, and it ends in …", () => {
    const w = columnWidths(rows, specs, 40);
    const line = renderRow(rows[1] ?? [], w, specs, 40);
    expect(line.endsWith("…")).toBe(true);
    expect(line).toContain("IN_PROGRESS");
    expect(stringWidth(line)).toBe(40);
  });

  it("zero-width columns vanish with their gutter; total cuts a row that still overflows", () => {
    const w = columnWidths(rows, specs, 15);
    const line = renderRow(rows[0] ?? [], w, specs, 15);
    expect(stringWidth(line)).toBe(15);
    expect(line.startsWith("t001")).toBe(true);
  });

  it("right alignment pads on the left; wide glyphs count 2", () => {
    expect(fitCell("7", 3, "right")).toBe("  7");
    expect(fitCell("日本語", 5)).toBe("日本…");
    expect(stringWidth(fitCell("日本語", 5))).toBe(5);
  });

  it("an escape sequence in a cell never reaches the row", () => {
    const line = renderRow(["\u001b[31mred\u001b[0m"], [5], [{ kind: "protect" }]);
    expect(line).toBe("red  ");
  });
});

describe("frame", () => {
  it("is exactly width x height, with title and subtitle in the top border", () => {
    const lines = frameLines({ width: 30, height: 5, title: "Agents", subtitle: "3" }, ["a", "b"]);
    expect(lines).toHaveLength(5);
    expect(widthOf(lines)).toEqual([30, 30, 30, 30, 30]);
    expect(lines[0]?.startsWith("╭─ Agents · 3 ")).toBe(true);
    expect(lines[0]?.endsWith("─╮")).toBe(true);
    expect(lines[1]).toBe(`│ a${" ".repeat(25)} │`);
    expect(lines[3]).toBe(`│ ${" ".repeat(26)} │`);
    expect(lines[4]).toBe(`╰${"─".repeat(28)}╯`);
  });

  it("puts the overflow note in the bottom border", () => {
    const lines = frameLines({ width: 24, height: 3, title: "Open", bottom: "+12 more" }, ["x"]);
    expect(lines[2]).toBe("╰─ +12 more ───────────╯");
    expect(stringWidth(lines[2] ?? "")).toBe(24);
  });

  it("cuts body rows by visual width and drops extra rows", () => {
    const lines = frameLines({ width: 12, height: 4, title: "T" }, [
      "日本語日本語日本語",
      "b",
      "never",
    ]);
    expect(lines).toHaveLength(4);
    expect(widthOf(lines)).toEqual([12, 12, 12, 12]);
    expect(lines[1]).toContain("…");
  });

  it("cuts a long label and always keeps a dash and both corners", () => {
    const line = borderLine(20, "╭", "╮", "a very long title that cannot fit");
    expect(stringWidth(line)).toBe(20);
    expect(line.startsWith("╭─ ")).toBe(true);
    expect(line.endsWith("─╮")).toBe(true);
  });

  it("cleans control characters out of titles", () => {
    expect(borderLine(20, "╭", "╮", "a\u001b[31mb\n").includes("\u001b")).toBe(false);
  });

  it("<Frame> renders through ink to the same lines", async () => {
    const spec = { width: 30, height: 5, title: "Agents", subtitle: "3", bottom: "+2 more" };
    const body = ["worker-1  busy", "日本語日本語日本語日本語日本語日本語日本語"];
    const ui = await renderApp(createElement(Frame, { ...spec, body }), { columns: 40, rows: 10 });
    const got = ui.screen().split("\n").slice(0, 5);
    expect(got.map((l) => l.trimEnd())).toEqual(frameLines(spec, body).map((l) => l.trimEnd()));
    ui.unmount();
  });

  it("has no frame below its chrome", () => {
    expect(frameLines({ width: 30, height: 1, title: "T" }, [])).toEqual([]);
    expect(frameLines({ width: 3, height: 5, title: "T" }, [])).toEqual([]);
    expect(frameLines({ width: 30, height: FRAME_CHROME, title: "T" }, [])).toHaveLength(2);
  });
});

describe("grid: columns by width", () => {
  it.each([
    [80, 1],
    [100, 1],
    [119, 1],
    [120, 2],
    [179, 2],
    [180, 3],
    [240, 3],
    [300, 3],
  ] as const)("%i cols -> %i columns", (cols, n) => {
    expect(columnCount(cols)).toBe(n);
  });

  it.each([
    [100, 1],
    [120, 2],
    [180, 3],
    [240, 3],
    [121, 2],
    [200, 3],
  ])("widths at %i cols x %i fill the screen exactly with a one-col gap", (total, n) => {
    const w = gridWidths(total, n);
    expect(w).toHaveLength(n);
    expect(w.reduce((a, b) => a + b, 0) + (n - 1)).toBe(total);
    expect(Math.max(...w) - Math.min(...w)).toBeLessThanOrEqual(1);
  });

  it("places cards by a fixed table; unknown ids go last; empty columns drop", () => {
    const ids = ["attention", "agents", "progress", "open", "log"];
    expect(placeCards(ids, 1)).toEqual([ids]);
    expect(placeCards(ids, 2)).toEqual([
      ["attention", "agents", "log"],
      ["progress", "open"],
    ]);
    expect(placeCards(ids, 3)).toEqual([["attention", "agents"], ["progress", "open"], ["log"]]);
    expect(placeCards(["agents", "mystery"], 3)).toEqual([["agents"], ["mystery"]]);
    expect(placeCards(["log"], 3)).toEqual([["log"]]);
  });

  it("placement does not depend on the data", () => {
    expect(placeCards(["agents", "open"], 2)).toEqual(placeCards(["agents", "open"], 2));
  });
});

describe("grid: row budgets", () => {
  const card = (id: string, min: number, max: number, count: number): CardSpec => ({
    id,
    min,
    max,
    count,
  });
  const total = (m: Map<string, number>, n: number): number =>
    [...m.values()].reduce((a, b) => a + b, 0) + n * FRAME_CHROME;

  it("short lists get their data, not padded", () => {
    const m = allocateRowBudgets(40, [card("a", 2, 10, 3), card("b", 2, 10, 0)]);
    expect(m.get("a")).toBe(3);
    expect(m.get("b")).toBe(2); // min
  });

  it("a column with hidden data fills its height, past max if it must", () => {
    for (const rows of [30, 40, 50]) {
      const cards = [card("a", 2, 6, 100), card("b", 2, 6, 100), card("c", 2, 6, 100)];
      const m = allocateRowBudgets(rows, cards);
      expect(total(m, 3)).toBe(rows);
    }
    const m = allocateRowBudgets(50, [card("a", 2, 6, 100)]);
    expect(m.get("a")).toBe(48);
  });

  it("spare rows go to the cards that hide data, in proportion; a fitting card gets none", () => {
    const m = allocateRowBudgets(40, [
      card("fits", 2, 4, 4),
      card("big", 2, 4, 30),
      card("huge", 2, 4, 90),
    ]);
    expect(m.get("fits")).toBe(4);
    expect(m.get("huge") ?? 0).toBeGreaterThan(m.get("big") ?? 0);
    expect(total(m, 3)).toBe(40);
  });

  it("under contention max stops one noisy card crowding the others", () => {
    const m = allocateRowBudgets(20, [
      card("noisy", 2, 6, 500),
      card("b", 2, 6, 8),
      card("c", 2, 6, 8),
    ]);
    expect(total(m, 3)).toBeLessThanOrEqual(20);
    expect(m.get("b")).toBeGreaterThanOrEqual(2);
    expect(m.get("c")).toBeGreaterThanOrEqual(2);
  });

  it("never exceeds the budget when the data fits within it", () => {
    for (const rows of [30, 40, 50]) {
      const m = allocateRowBudgets(rows, [
        card("a", 3, 12, 5),
        card("b", 3, 12, 40),
        card("c", 3, 12, 2),
      ]);
      expect(total(m, 3)).toBeLessThanOrEqual(rows);
    }
  });

  it("when the minimums do not fit it returns them", () => {
    const m = allocateRowBudgets(8, [card("a", 3, 6, 9), card("b", 3, 6, 9)]);
    expect([m.get("a"), m.get("b")]).toEqual([3, 3]);
  });

  it("is deterministic and empty for no cards", () => {
    expect(allocateRowBudgets(30, []).size).toBe(0);
    const cards = [card("a", 2, 5, 9), card("b", 2, 5, 9), card("c", 2, 5, 9)];
    expect([...allocateRowBudgets(31, cards)]).toEqual([...allocateRowBudgets(31, cards)]);
  });

  it.each([30, 40, 50])(
    "fitColumn at %i rows: height never passes the column, data columns fill it",
    (rows) => {
      const cards = [card("a", 3, 10, 50), card("b", 3, 10, 50), card("c", 3, 10, 50)];
      const placed = fitColumn(rows, cards);
      const h = placed.reduce((n, p) => n + p.height, 0);
      expect(h).toBe(rows);
      for (const p of placed) expect(p.hidden).toBe(50 - p.rows);
    },
  );

  it("fitColumn clips top-down and drops cards that no longer have a body row", () => {
    const cards = [card("a", 3, 10, 50), card("b", 3, 10, 50), card("c", 3, 10, 50)];
    const placed = fitColumn(9, cards);
    expect(placed.reduce((n, p) => n + p.height, 0)).toBeLessThanOrEqual(9);
    expect(placed[0]?.id).toBe("a");
    expect(placed.every((p) => p.rows > 0)).toBe(true);
  });

  it("fitColumn on a column too short for any frame shows nothing", () => {
    expect(fitColumn(1, [card("a", 3, 10, 5)])).toEqual([]);
  });

  it("fitColumn reports hidden rows for the +N more note", () => {
    const [a] = fitColumn(10, [card("a", 2, 4, 20)]);
    expect(a).toEqual({ id: "a", height: 10, rows: 8, hidden: 12 });
  });
});
