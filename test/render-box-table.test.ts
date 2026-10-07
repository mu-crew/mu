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

  it("matches cli-table3 for a header-only table", () => {
    expect(renderBoxTable(["a", "bb"], [])).toBe(viaCliTable3(["a", "bb"], []));
  });

  it("falls back to cli-table3 for multi-line cells", () => {
    const rows = [["x\ny", "z"]];
    expect(renderBoxTable(["a", "b"], rows)).toBe(viaCliTable3(["a", "b"], rows));
  });
});
