// The first screen: Overview cards, the attention strip, framed full-height tabs,
// and the footer pinned to the last row at any size.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/cli/tui/app.js";
import { createRuntime, type DashboardRuntime } from "../src/cli/tui/runtime.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { renderApp } from "./_ink-render.js";

describe("dashboard screen", () => {
  let tmp: string;
  let db: Db;
  let rt: DashboardRuntime;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-dash-over-"));
    db = openDb({ path: join(tmp, "a.db") });
    delete process.env.MU_SYNC_DIR;
    ensureWorkstream(db, "beta");
    for (let i = 0; i < 30; i++)
      addTask(db, {
        workstream: "beta",
        localId: `t${i}`,
        title: `task ${i}`,
        impact: 10 + i,
        effortDays: 1,
      });
    addTask(db, {
      workstream: "beta",
      localId: "decide",
      title: "decide the fx policy",
      impact: 50,
      effortDays: 1,
      kind: "human",
    });
  });
  afterEach(async () => {
    await rt?.close();
    db.close();
    rmFixtureDir(tmp);
  });

  const open = (columns: number, rows: number, tab?: "tasks") => {
    rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: db, caller: null });
    return renderApp(
      createElement(App, {
        runtime: rt,
        pollMs: null,
        initialWorkstream: "beta",
        ...(tab ? { initialTab: tab } : {}),
        now: () => 0,
      }),
      { columns, rows },
    );
  };

  it("Overview is the first screen: cards, ROI order, and the whole screen is used", async () => {
    for (const [columns, rows] of [
      [200, 50],
      [120, 40],
      [80, 24],
    ] as const) {
      const ui = await open(columns, rows);
      await ui.until((s) => s.includes("Attention") && s.includes("Open"));
      const lines = ui.screen().split("\n");
      const at = `${columns}x${rows}`;
      expect(lines, at).toHaveLength(rows);
      expect(lines[1], at).toContain("Overview");
      expect(lines[2], at).toMatch(/^⚠ 1 need you: human: decide/); // the strip, under the tabs
      expect(lines.at(-1), at).toContain("q quit"); // footer pinned to the last row
      expect(lines.join("\n"), at).toContain("human: decide the fx policy");
      expect(lines.join("\n"), at).toContain("t29"); // highest ROI first in Open
      for (const l of lines) expect(stringWidth(l), at).toBeLessThanOrEqual(columns);
      ui.unmount();
    }
  });

  it("a wide screen puts the cards in columns; a narrow one stacks them", async () => {
    const wide = await open(200, 50);
    await wide.until((s) => s.includes("Open"));
    const row = wide
      .screen()
      .split("\n")
      .find((l) => l.includes("Attention"));
    expect(row).toContain("In progress"); // side by side
    wide.unmount();
    const narrow = await open(80, 24);
    await narrow.until((s) => s.includes("Attention"));
    expect(
      narrow
        .screen()
        .split("\n")
        .find((l) => l.includes("Attention")),
    ).not.toContain("Agents");
    narrow.unmount();
  });

  it("a drill keeps the attention strip under its title", async () => {
    const ui = await open(100, 30);
    await ui.until((s) => s.includes("Attention"));
    await ui.press("\r"); // Enter on the attention item: the human task's notes
    await ui.until((s) => s.includes("Notes  "));
    const lines = ui.screen().split("\n");
    expect(lines[0]).toContain("Notes  ");
    expect(lines[1]).toMatch(/^⚠ 1 need you: human: decide/);
    expect(lines).toHaveLength(30);
    expect(lines.at(-1)).toContain("Esc back");
    ui.unmount();
  });

  it("the attention strip stays on the other tabs; a framed tab fills the screen", async () => {
    const ui = await open(100, 30);
    await ui.until((s) => s.includes("Attention"));
    await ui.press("\u001b[C"); // right: Tasks
    await ui.until((s) => s.includes("╭─ Tasks"));
    const lines = ui.screen().split("\n");
    expect(lines).toHaveLength(30);
    expect(lines[2]).toContain("⚠ 1 need you: human: decide the fx policy");
    expect(lines.at(-1)).toContain("q quit");
    expect(lines.at(-2)).toContain("next"); // Next above the pinned footer
    expect(lines.some((l) => l.startsWith("╰─ ") && /\d+\/\d+/.test(l))).toBe(true);
    ui.unmount();
  });

  it("Enter on an attention item opens that task's notes", async () => {
    const ui = await open(120, 40);
    await ui.until((s) => s.includes("> human: decide"));
    await ui.press("\r");
    await ui.until((s) => s.includes("decide the fx policy") && !s.includes("Attention"));
    ui.unmount();
  });
});
