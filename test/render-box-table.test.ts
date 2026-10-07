// renderBoxTable replaces cli-table3 for `mu task list` because the
// cli-table3 layout pass is quadratic in rows (f_tasklist_table_render).
// It must stay byte-identical to muTable({ head }).toString().

import tableUtils from "cli-table3/src/utils.js";
import { describe, expect, it, vi } from "vitest";
import { muTable, pc, renderBoxTable } from "../src/output.js";

function viaCliTable3(head: string[], rows: string[][]): string {
  const t = muTable({ head });
  for (const r of rows) t.push(r);
  return t.toString();
}

describe("renderBoxTable", () => {
  it("matches cli-table3 for ANSI, wide, and empty cells", () => {
    const head = ["name", "status", "title", "owner"].map((h) => pc.bold(h));
    const rows = [
      ["a1", pc.cyan("OPEN"), "M6: i3 slice — focus…", pc.dim("—")],
      ["b-long-name", pc.red("CLOSED/wontfix"), "漢字 title", ""],
      ["c", pc.yellow("IN_PROGRESS"), "plain", "worker-1"],
      ["d", "\u001b[32mCLOSED\u001b[39m", "\u001b[1mbold\u001b[22m", "\u001b[2m—\u001b[22m"],
    ];
    expect(renderBoxTable(head, rows)).toBe(viaCliTable3(head, rows));
  });

  it("matches cli-table3 for unbalanced ANSI and zero-width/format characters", () => {
    const head = ["name", "title"];
    const titles = [
      "\u001b[31mred title", // unclosed foreground
      "\u001b[1m\u001b[44mbold on blue", // unclosed bold + background
      "\u001b[0mreset first",
      "\u001b[38;5;196m256 colour",
      "closed early\u001b[39m",
      "soft\u00adhyphen",
      "zero\u200bwidth",
      "zwj\u200dzwnj\u200c",
      "bom\ufeffwj\u2060",
      "rtl\u200fmark\u202e",
      "combining e\u0301",
      "emoji 👍🏽 flag 🇬🇧",
      "tab\there",
      "bell\u0007 osc \u001b]8;;http://x\u0007link\u001b]8;;\u0007",
      "\u001b[2Kerase",
      pc.red("soft\u00adhyphen in red"),
    ];
    const rows = titles.map((t, i) => [`t${i}`, t]);
    expect(renderBoxTable(head, rows)).toBe(viaCliTable3(head, rows));
    for (const r of rows) expect(renderBoxTable(head, [r])).toBe(viaCliTable3(head, [r]));
  });

  it("matches cli-table3 for a header-only table", () => {
    expect(renderBoxTable(["a", "bb"], [])).toBe(viaCliTable3(["a", "bb"], []));
  });

  it("matches cli-table3 for multi-line cells, including SGR open across lines", () => {
    const rows = [
      ["x\ny", "z"],
      ["one", "a\n\nthree lines"],
      [pc.red("r1\nr2"), "\u001b[1mbold\nstill bold"],
      ["crlf\r\nline", "trailing\n"],
      ["漢字\n👍🏽", "tab\there\nzero\u200bwidth"],
    ];
    expect(renderBoxTable(["a", "b"], rows)).toBe(viaCliTable3(["a", "b"], rows));
  });

  it("matches cli-table3 on random non-plain cells", () => {
    const parts = [
      "a",
      "Z9",
      " ",
      "—",
      "…",
      "\n",
      "\r",
      "\t",
      "漢",
      "字",
      "👍🏽",
      "👩\u200d💻",
      "🇬🇧",
      "e\u0301",
      "\u00ad",
      "\u200b",
      "\u200d",
      "\ufeff",
      "\u202e",
      "\u0007",
      "\u001b[31m",
      "\u001b[39m",
      "\u001b[1m",
      "\u001b[22m",
      "\u001b[44m",
      "\u001b[0m",
      "\u001b[38;5;196m",
      "\u001b]8;;http://x\u0007",
      "\u001b]8;;\u0007",
      "\u001b[2K",
    ];
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const cell = () => Array.from({ length: rand(8) }, () => parts[rand(parts.length)]).join("");
    for (let t = 0; t < 300; t++) {
      const head = [cell(), cell(), cell()];
      const rows = Array.from({ length: rand(5) }, () => [cell(), cell(), cell()]);
      expect(renderBoxTable(head, rows)).toBe(viaCliTable3(head, rows));
    }
  });

  it("keeps a large table with one multi-line title on the linear path", () => {
    const head = ["name", "status", "title"].map((h) => pc.bold(h));
    const rows = Array.from({ length: 2000 }, (_, i) => [
      `task_${i}`,
      pc.cyan("OPEN"),
      i === 1000 ? "x\nsecond line" : `title ${i} — plain`,
    ]);
    // cli-table3 measures every cell with strlen; the fast path measures
    // only the non-plain lines (here the two lines of one title).
    const strlen = vi.spyOn(tableUtils, "strlen");
    const start = performance.now();
    const fast = renderBoxTable(head, rows);
    const elapsed = performance.now() - start;
    const calls = strlen.mock.calls.length;
    strlen.mockRestore();
    expect(calls).toBeLessThanOrEqual(2);
    expect(elapsed).toBeLessThan(1000); // cli-table3 takes ~0.5 s+ unloaded
    expect(fast).toBe(viaCliTable3(head, rows));
  });
});
