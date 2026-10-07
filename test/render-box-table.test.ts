// renderBoxTable replaces cli-table3 for `mu task list` because the
// cli-table3 layout pass is quadratic in rows (f_tasklist_table_render).
// It must stay byte-identical to muTable({ head }).toString().

import { describe, expect, it } from "vitest";
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

  it("falls back to cli-table3 for multi-line cells", () => {
    const rows = [["x\ny", "z"]];
    expect(renderBoxTable(["a", "b"], rows)).toBe(viaCliTable3(["a", "b"], rows));
  });
});
