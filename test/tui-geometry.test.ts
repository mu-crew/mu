// Pure geometry of the dashboard screen: columns.ts (stable aligned columns),
// frame.tsx (rounded frames) and grid.ts (card columns and row budgets).
// No ink: the modules return plain text.

import { createElement } from "react";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { type ColumnSpec, columnWidths, fitCell, naturalWidths } from "../src/cli/tui/columns.js";
import { borderParts, FRAME_CHROME, Frame } from "../src/cli/tui/frame.js";
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

  it("columns take their natural width, protected ones inside min/max", () => {
    expect(columnWidths(rows, specs)).toEqual([8, 11, 34]);
  });

  it("min floors a column, so widths do not depend on which rows are passed", () => {
    const fixed: ColumnSpec[] = [{ kind: "protect", min: 12 }, { kind: "clip" }];
    expect(columnWidths([["a", "x"]], fixed)[0]).toBe(12);
    expect(columnWidths([], fixed)[0]).toBe(12);
  });

  it("right alignment pads on the left; wide glyphs count 2", () => {
    expect(fitCell("7", 3, "right")).toBe("  7");
    expect(fitCell("日本語", 5)).toBe("日本…");
    expect(stringWidth(fitCell("日本語", 5))).toBe(5);
  });

  it("an escape sequence in a cell never reaches the row", () => {
    expect(fitCell("\u001b[31mred\u001b[0m", 5)).toBe("red  ");
  });
});

/** <Frame> as ink draws it: the lines on a fake terminal. */
async function drawn(
  spec: { width: number; height: number; title: string; subtitle?: string; bottom?: string },
  body: string[],
  columns = 40,
): Promise<string[]> {
  const ui = await renderApp(createElement(Frame, { ...spec, body }), { columns, rows: 10 });
  const lines = ui.screen().split("\n").slice(0, spec.height);
  ui.unmount();
  return lines.map((l) => l.trimEnd());
}

describe("frame", () => {
  it("is exactly width x height, with title and subtitle in the top border", async () => {
    const lines = await drawn({ width: 30, height: 5, title: "Agents", subtitle: "3" }, ["a", "b"]);
    expect(lines).toHaveLength(5);
    expect(widthOf(lines).every((w) => w <= 30)).toBe(true);
    expect(lines[0]?.startsWith("╭─ Agents · 3 ")).toBe(true);
    expect(lines[0]).toHaveLength(30);
    expect(lines[0]?.endsWith("─╮")).toBe(true);
    expect(lines[1]).toBe(`│ a${" ".repeat(25)} │`);
    expect(lines[4]).toBe(`╰${"─".repeat(28)}╯`);
  });

  it("puts the overflow note in the bottom border", async () => {
    const lines = await drawn({ width: 24, height: 3, title: "Open", bottom: "+12 more" }, ["x"]);
    expect(lines[2]).toBe("╰─ +12 more ───────────╯");
  });

  it("cuts body rows by visual width and drops extra rows", async () => {
    const lines = await drawn({ width: 12, height: 4, title: "T" }, [
      "日本語日本語日本語",
      "b",
      "never",
    ]);
    expect(lines).toHaveLength(4);
    expect(widthOf(lines)).toEqual([12, 12, 12, 12]);
    expect(lines[1]).toContain("…");
    expect(lines.join("")).not.toContain("never");
  });

  it("cuts a long label and always keeps a dash and both corners", () => {
    const { head, shown, tail } = borderParts(20, "╭", "╮", "a very long title that cannot fit");
    const line = head + shown + tail;
    expect(stringWidth(line)).toBe(20);
    expect(line.startsWith("╭─ ")).toBe(true);
    expect(line.endsWith("─╮")).toBe(true);
  });

  it("cleans control characters out of titles", () => {
    const { head, shown, tail } = borderParts(20, "╭", "╮", "a\u001b[31mb\n");
    expect((head + shown + tail).includes("\u001b")).toBe(false);
  });

  it("has no frame below its chrome", async () => {
    expect(await drawn({ width: 30, height: 1, title: "T" }, [])).not.toContain("╭");
    expect((await drawn({ width: 3, height: 5, title: "T" }, [])).join("")).not.toContain("╭");
    const two = await drawn({ width: 30, height: FRAME_CHROME, title: "T" }, []);
    expect(two[0]).toMatch(/^╭/);
    expect(two[1]).toMatch(/^╰/);
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
    // Waves sits under the task cards, never with Log.
    const withWaves = ["attention", "agents", "progress", "open", "waves", "log"];
    expect(placeCards(withWaves, 2)).toEqual([
      ["attention", "agents", "log"],
      ["progress", "open", "waves"],
    ]);
    expect(placeCards(withWaves, 3)).toEqual([
      ["attention", "agents"],
      ["progress", "open", "waves"],
      ["log"],
    ]);
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
