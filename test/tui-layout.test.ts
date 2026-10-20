import { describe, expect, it } from "vitest";
import {
  allocateRowBudgets,
  arrangeColumns,
  type CardId,
  type ColumnAssignment,
  columnRowBudgets,
  columnWidths,
  cullCardsForRows,
  dashboardColumnCount,
  layoutColumns,
} from "../src/cli/tui/layout.js";

const ALL: CardId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function ids(cols: number, visible: CardId[] = ALL): CardId[][] {
  return layoutColumns(cols, visible).map((c) => c.cards);
}

describe("dashboard responsive layout", () => {
  it("Cols=70: 1 column, all cards sorted slot ASC with slot 0 trailing", () => {
    expect(dashboardColumnCount(70)).toBe(1);
    expect(ids(70)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 0]]);
  });

  it("Cols=140: 2 columns, streams split as column trailers for 5/5 balance", () => {
    expect(dashboardColumnCount(140)).toBe(2);
    expect(ids(140)).toEqual([
      [1, 2, 5, 9, 4],
      [3, 6, 7, 8, 0],
    ]);
  });

  it("Cols=140: slot 0 off keeps Activity log as the left-column trailer", () => {
    expect(ids(140, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9, 4],
      [3, 6, 7, 8],
    ]);
  });

  it("Cols=140: slot 4 off keeps Commits as the right-column trailer", () => {
    expect(ids(140, [0, 1, 2, 3, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8, 0],
    ]);
  });

  it("Cols=140: both stream cards off leaves small-pair left and task-list right", () => {
    expect(ids(140, [1, 2, 3, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8],
    ]);
  });

  it("Cols=140: only slot 3 visible returns a single non-empty column", () => {
    expect(ids(140, [3])).toEqual([[3]]);
  });

  it("Cols=200: 3 columns keep groups, sorted with slot 0 last", () => {
    expect(dashboardColumnCount(200)).toBe(3);
    expect(ids(200)).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8],
      [4, 0],
    ]);
  });

  it("Cols=260: 4 columns split small pairs, task-list, and stream sorted with slot 0 last", () => {
    expect(dashboardColumnCount(260)).toBe(4);
    expect(ids(260)).toEqual([
      [1, 2],
      [5, 9],
      [3, 6, 7, 8],
      [4, 0],
    ]);
  });

  it("Cols=140: slot 0 alone in the stream group goes to the right column", () => {
    expect(ids(140, [0, 1, 2, 3, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8, 0],
    ]);
  });

  it("Cols=140: slot 4 alone in the stream group goes to the left column", () => {
    expect(ids(140, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9, 4],
      [3, 6, 7, 8],
    ]);
  });

  it("toggling cards off repacks without blank columns", () => {
    expect(ids(200, [1, 2, 3, 5, 7])).toEqual([
      [1, 2, 5],
      [3, 7],
    ]);
    expect(ids(140, [1, 2, 3, 5, 7])).toEqual([
      [1, 2, 5],
      [3, 7],
    ]);
  });

  it("computes gap-aware integer column widths", () => {
    expect(columnWidths(140, 2).map((c) => c.width)).toEqual([70, 69]);
    expect(columnWidths(200, 3).map((c) => c.width)).toEqual([66, 66, 66]);
    expect(columnWidths(0, 0)).toEqual([]);
  });
});

describe("dashboard low-row card culler", () => {
  it("keeps all cards when their minimum stacks fit", () => {
    expect(cullCardsForRows(ALL, 80)).toEqual({ cards: ALL, hidden: [] });
  });

  it("keeps every card at 30 rows once chrome shrank to its true 2-row cost", () => {
    // pack_dashboard_cards_tighter lowered CARD_CHROME_ROWS from 4 to
    // 2 (the actual TitledBox top+bottom border cost). At 30 rows the
    // tallest min-stack column is now 25 rows so nothing needs culling.
    expect(cullCardsForRows(ALL, 30)).toEqual({ cards: ALL, hidden: [] });
  });

  it("culls aggressively at 10 rows and keeps only the highest-priority cards", () => {
    // Same chrome=2 retune: cull stops once 4 cards' min-stack fits in
    // 10 rows (one column = (2+2)+(3+2) = 9 ≤ 10) instead of needing
    // to drop down to a 2-card stack like the chrome=4 era.
    expect(cullCardsForRows(ALL, 10)).toEqual({
      cards: [0, 1, 3, 4],
      hidden: [9, 8, 5, 2, 7, 6],
    });
  });

  it("keeps the highest-priority visible card even below its minimum stack", () => {
    expect(cullCardsForRows(ALL, 4)).toEqual({
      cards: [3],
      hidden: [9, 8, 5, 2, 7, 6, 4, 0, 1],
    });
  });

  it("returns empty arrays when every card is toggled off", () => {
    expect(cullCardsForRows([], 10)).toEqual({ cards: [], hidden: [] });
  });

  it("does not resurrect cards that were explicitly toggled off", () => {
    expect(cullCardsForRows([1, 3], 80)).toEqual({ cards: [1, 3], hidden: [] });
  });
});

describe("dashboard row-budget allocator", () => {
  it("returns natural rows when there is no contention", () => {
    const budgets = allocateRowBudgets(80, [
      { id: 1, dataCount: 1 },
      { id: 3, dataCount: 4 },
      { id: 4, dataCount: 2 },
    ]);
    expect(budgets[1]).toBe(2); // min guarantee beats dataCount=1
    expect(budgets[3]).toBe(4);
    expect(budgets[4]).toBe(3); // min guarantee beats dataCount=2
  });

  it("a huge card takes every spare row past maxRows while siblings keep min guarantees", () => {
    const budgets = allocateRowBudgets(80, [
      { id: 3, dataCount: 100 }, // Ready maxRows=15
      { id: 1, dataCount: 1 },
      { id: 2, dataCount: 1 },
      { id: 9, dataCount: 0 },
    ]);
    expect([budgets[1], budgets[2], budgets[9]]).toEqual([2, 2, 2]);
    // 80 rows - 8 chrome - 6 sibling rows: the column is full.
    expect(budgets[3]).toBe(66);
  });

  it("fills the column when one list overflows its cap (Ready=40 at 80 rows)", () => {
    const budgets = allocateRowBudgets(80, [
      { id: 3, dataCount: 40 },
      { id: 6, dataCount: 2 },
    ]);
    expect(budgets[3]).toBe(40);
    expect(budgets[6]).toBe(3);
  });

  it("spare rows go to overflowing cards in proportion to the rows they hide", () => {
    // body = 50 - 6 chrome = 44. First pass: Ready 15, In-progress 12,
    // Agents 2 (29). Spare 15 split by hidden rows 45 : 18 → 10.7 : 4.3.
    const budgets = allocateRowBudgets(50, [
      { id: 3, dataCount: 60 },
      { id: 6, dataCount: 30 },
      { id: 1, dataCount: 1 },
    ]);
    expect([budgets[3], budgets[6], budgets[1]]).toEqual([26, 16, 2]);
  });

  it("leaves blank space when no card hides rows", () => {
    const budgets = allocateRowBudgets(80, [
      { id: 3, dataCount: 4 },
      { id: 6, dataCount: 0 },
    ]);
    expect([budgets[3], budgets[6]]).toEqual([4, 3]);
  });

  it("uses largest-remainder leftover distribution after min rows", () => {
    const budgets = allocateRowBudgets(23, [
      { id: 3, dataCount: 9 },
      { id: 6, dataCount: 5 },
      { id: 7, dataCount: 5 },
    ]);
    // bodyAvailable = 23 - chrome(6) = 17. Min total = 9. The 8-row
    // weighted remainder is 3.78 / 2.10 / 2.10, so Ready wins the
    // largest-remainder row after floors of (3, 2, 2). chrome=2 here
    // mirrors what chrome=4 + availableRows=29 used to exercise.
    expect([budgets[3], budgets[6], budgets[7]]).toEqual([7, 5, 5]);
  });

  it("empty-data cards still get their min row count", () => {
    const budgets = allocateRowBudgets(16, [
      { id: 1, dataCount: 0 },
      { id: 2, dataCount: 0 },
    ]);
    expect(budgets[1]).toBe(2);
    expect(budgets[2]).toBe(2);
  });
});

const HEIGHT_OF = (lanes: ColumnAssignment[]): CardId[][] => lanes.map((a) => a.cards);

function hiddenRows(rows: number, lanes: CardId[][], counts: Partial<Record<CardId, number>>) {
  const count = (id: CardId) => counts[id] ?? 0;
  return lanes.reduce<number>((sum, lane) => {
    const budgets = columnRowBudgets(rows, lane, count);
    return sum + lane.reduce<number>((s, id) => s + Math.max(0, count(id) - budgets[id]), 0);
  }, 0);
}

describe("dashboard card-to-column search", () => {
  it("keeps the default layout when nothing overflows", () => {
    const initial = layoutColumns(260, ALL);
    const result = arrangeColumns({ initial, availableRows: 60, dataCountFn: () => 3 });
    expect(HEIGHT_OF(result.assignments)).toEqual(HEIGHT_OF(initial));
    expect(result.hiddenRows).toBe(0);
  });

  it("moves cards off a crowded column into one with room", () => {
    // 4 columns at 30 rows: the task-list column holds four long lists
    // while the small-pair columns sit near-empty.
    const counts: Partial<Record<CardId, number>> = { 3: 20, 6: 20, 7: 20, 8: 20 };
    const initial = layoutColumns(260, ALL);
    const before = hiddenRows(30, HEIGHT_OF(initial), counts);
    const result = arrangeColumns({
      initial,
      availableRows: 30,
      dataCountFn: (id) => counts[id] ?? 0,
    });
    expect(result.hiddenRows).toBeLessThan(before);
    expect(result.hiddenRows).toBe(hiddenRows(30, HEIGHT_OF(result.assignments), counts));
    // Slot order inside every column, Commits last, no empty column.
    for (const lane of HEIGHT_OF(result.assignments)) {
      expect(lane.length).toBeGreaterThan(0);
      const keys = lane.map((id) => (id === 0 ? 10 : id));
      expect(keys).toEqual([...keys].sort((a, b) => a - b));
    }
    expect(HEIGHT_OF(result.assignments).flat().sort()).toEqual([...ALL].sort());
  });

  it("finds the optimum on a small fixture", () => {
    // Two columns of 20 rows. Default: [1, 2] | [3, 6]. Ready and
    // In-progress both hold 14 rows; split them one per column and
    // nothing hides.
    const counts: Partial<Record<CardId, number>> = { 3: 14, 6: 14, 1: 1, 2: 1 };
    const initial: ColumnAssignment[] = [{ cards: [1, 2] }, { cards: [3, 6] }];
    const result = arrangeColumns({
      initial,
      availableRows: 20,
      dataCountFn: (id) => counts[id] ?? 0,
    });
    expect(result.hiddenRows).toBe(0);
    expect(HEIGHT_OF(result.assignments)).toEqual([
      [1, 6],
      [2, 3],
    ]);
  });

  it("is deterministic and leaves no improving single move or swap", () => {
    const counts: Partial<Record<CardId, number>> = { 0: 25, 3: 40, 4: 30, 6: 9, 7: 18, 8: 5 };
    const input = {
      initial: layoutColumns(200, ALL),
      availableRows: 40,
      dataCountFn: (id: CardId) => counts[id] ?? 0,
    };
    const a = arrangeColumns(input);
    const b = arrangeColumns(input);
    expect(a).toEqual(b);
    // No single move or swap from the result hides fewer rows.
    const lanes = HEIGHT_OF(a.assignments);
    const slot = (id: CardId) => (id === 0 ? 10 : id);
    const sorted = (lane: CardId[]) => [...lane].sort((x, y) => slot(x) - slot(y));
    for (let from = 0; from < lanes.length; from++) {
      for (let to = 0; to < lanes.length; to++) {
        if (from === to) continue;
        for (const x of lanes[from] ?? []) {
          if ((lanes[from]?.length ?? 0) > 1) {
            const moved = lanes.map((l) => [...l]);
            moved[from] = (lanes[from] ?? []).filter((id) => id !== x);
            moved[to] = sorted([...(lanes[to] ?? []), x]);
            expect(hiddenRows(40, moved, counts)).toBeGreaterThanOrEqual(a.hiddenRows);
          }
          for (const y of lanes[to] ?? []) {
            const swapped = lanes.map((l) => [...l]);
            swapped[from] = sorted([...(lanes[from] ?? []).filter((id) => id !== x), y]);
            swapped[to] = sorted([...(lanes[to] ?? []).filter((id) => id !== y), x]);
            expect(hiddenRows(40, swapped, counts)).toBeGreaterThanOrEqual(a.hiddenRows);
          }
        }
      }
    }
  });

  it("keeps the previous assignment when counts move by one (no jitter)", () => {
    const counts: Partial<Record<CardId, number>> = { 3: 20, 6: 20, 7: 20, 8: 20 };
    const initial = layoutColumns(260, ALL);
    const first = arrangeColumns({
      initial,
      availableRows: 30,
      dataCountFn: (id) => counts[id] ?? 0,
    });
    for (const delta of [-1, 1]) {
      for (const id of [3, 6, 7, 8, 1, 4] as CardId[]) {
        const next = { ...counts, [id]: (counts[id] ?? 0) + delta };
        const result = arrangeColumns({
          initial,
          availableRows: 30,
          dataCountFn: (card) => Math.max(0, next[card] ?? 0),
          previous: first.assignments,
        });
        expect(HEIGHT_OF(result.assignments)).toEqual(HEIGHT_OF(first.assignments));
      }
    }
  });

  it("drops the previous assignment once the new one hides enough fewer rows", () => {
    const initial = layoutColumns(260, ALL);
    const previous = initial;
    const counts: Partial<Record<CardId, number>> = { 3: 20, 6: 20, 7: 20, 8: 20 };
    const result = arrangeColumns({
      initial,
      availableRows: 30,
      dataCountFn: (id) => counts[id] ?? 0,
      previous,
    });
    expect(HEIGHT_OF(result.assignments)).not.toEqual(HEIGHT_OF(initial));
  });

  it("retains a previous layout only when no single move or swap saves more than the hysteresis", () => {
    // 140 cols, 15 rows: the culled card set. The previous layout came
    // from arrangeColumns itself; the default-start descent lands in a
    // different local optimum than one swap away from previous.
    const rows = 15;
    const visible = cullCardsForRows([0, 1, 2, 4, 6, 7, 8, 9], rows).cards;
    const initial = layoutColumns(140, visible);
    const old: Partial<Record<CardId, number>> = { 0: 5, 1: 13, 2: 11, 4: 73, 6: 0, 7: 4 };
    const counts: Partial<Record<CardId, number>> = { 0: 3, 1: 0, 2: 0, 4: 68, 6: 0, 7: 0 };
    const previous = arrangeColumns({
      initial,
      availableRows: rows,
      dataCountFn: (id) => old[id] ?? 0,
    }).assignments;
    const result = arrangeColumns({
      initial,
      availableRows: rows,
      dataCountFn: (id) => counts[id] ?? 0,
      previous,
    });
    const minGain = Math.max(3, Math.ceil(result.hiddenRows * 0.1));
    const lanes = HEIGHT_OF(result.assignments);
    const slot = (id: CardId) => (id === 0 ? 10 : id);
    const sorted = (lane: CardId[]) => [...lane].sort((x, y) => slot(x) - slot(y));
    for (let from = 0; from < lanes.length; from++) {
      for (let to = 0; to < lanes.length; to++) {
        if (from === to) continue;
        for (const x of lanes[from] ?? []) {
          if ((lanes[from] ?? []).length > 1) {
            const moved = lanes.map((l) => [...l]);
            moved[from] = (lanes[from] ?? []).filter((id) => id !== x);
            moved[to] = sorted([...(lanes[to] ?? []), x]);
            expect(result.hiddenRows - hiddenRows(rows, moved, counts)).toBeLessThan(minGain);
          }
          for (const y of lanes[to] ?? []) {
            const swapped = lanes.map((l) => [...l]);
            swapped[from] = sorted([...(lanes[from] ?? []).filter((id) => id !== x), y]);
            swapped[to] = sorted([...(lanes[to] ?? []).filter((id) => id !== y), x]);
            expect(result.hiddenRows - hiddenRows(rows, swapped, counts)).toBeLessThan(minGain);
          }
        }
      }
    }
  });

  it("ignores a previous assignment over a different card set", () => {
    const initial = layoutColumns(260, ALL);
    const counts: Partial<Record<CardId, number>> = { 3: 20, 6: 20, 7: 20, 8: 20 };
    const withoutPrev = arrangeColumns({
      initial,
      availableRows: 30,
      dataCountFn: (id) => counts[id] ?? 0,
    });
    const stale = arrangeColumns({
      initial,
      availableRows: 30,
      dataCountFn: (id) => counts[id] ?? 0,
      previous: [{ cards: [1, 2] }, { cards: [5] }, { cards: [3, 6, 7, 8] }, { cards: [4, 0] }],
    });
    expect(stale).toEqual(withoutPrev);
  });

  it("stays cheap: 10 cards in 4 columns under a few ms per call", () => {
    const counts: Partial<Record<CardId, number>> = {
      0: 25,
      1: 12,
      2: 9,
      3: 80,
      4: 200,
      5: 11,
      6: 30,
      7: 40,
      8: 5,
      9: 7,
    };
    const initial = layoutColumns(260, ALL);
    const runs = 50;
    const start = performance.now();
    for (let i = 0; i < runs; i++) {
      arrangeColumns({ initial, availableRows: 40, dataCountFn: (id) => counts[id] ?? 0 });
    }
    const perCall = (performance.now() - start) / runs;
    // Budget is ~2ms; allow headroom for loaded CI machines.
    expect(perCall).toBeLessThan(20);
  });
});
