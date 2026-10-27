// The dashboard palette (theme.ts): roles map to the 3.x colours, rows carry
// them per column, NO_COLOR drops colour but keeps bold/dim/inverse, and the
// styled line always reads as the plain one.

import chalk from "chalk";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../src/cli/tui/frame.js";
import { attentionStrip, NO_FILTER, tabRows } from "../src/cli/tui/rows.js";
import { fitLine, lineText } from "../src/cli/tui/text.js";
import { agentStateRole, statusRole, style } from "../src/cli/tui/theme.js";
import type { DashboardSnapshot } from "../src/dashboard-data.js";
import { withEnv } from "./_env.js";
import { renderApp } from "./_ink-render.js";

const empty = (over: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
  caller: null,
  caller_scope: "none",
  workstreams: [],
  tasks: [],
  edges: [],
  frontier: [],
  agents: [],
  log: [],
  next: null,
  next_source: "unavailable",
  human_needs: [],
  delegates: [],
  attention: [],
  ...over,
});

const task = (id: string, status: string, substate: string) => ({
  key: `w/${id}`,
  workstream: "w",
  id,
  title: `title ${id}`,
  status,
  substate,
  impact: 50,
  effort_days: 1,
  owner: null,
  owner_id: null,
  owner_workstream: null,
  kind: "work",
  wave: null,
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-01 00:00:00",
  activity_seq: 0,
});

describe("roles", () => {
  it("task status as 3.x inkColorForPair", () => {
    expect(style(statusRole("OPEN", "todo")).color).toBe("cyan");
    expect(style(statusRole("OPEN", "parked")).color).toBe("gray");
    expect(style(statusRole("OPEN", "triage")).color).toBe("gray");
    expect(style(statusRole("IN_PROGRESS", "doing")).color).toBe("yellow");
    expect(style(statusRole("CLOSED", "done")).color).toBe("green");
    expect(style(statusRole("CLOSED", "wontfix")).color).toBe("red");
  });

  it("agent state as 3.x STATUS_COLORS", () => {
    expect(style(agentStateRole("busy")).color).toBe("cyan");
    expect(style(agentStateRole("needs_permission")).color).toBe("magenta");
    expect(style(agentStateRole("needs_input"))).toEqual({ dimColor: true });
    expect(style(agentStateRole(null))).toEqual({ dimColor: true });
  });

  it("NO_COLOR drops colour, keeps bold and dim", async () => {
    await withEnv("NO_COLOR", "1", async () => {
      expect(style("title")).toEqual({ bold: true });
      expect(style("bad")).toEqual({});
      expect(style("muted")).toEqual({ dimColor: true });
    });
    expect(style("title")).toEqual({ color: "cyan", bold: true });
  });
});

describe("styled rows", () => {
  it("a task row: id bold, status in its colour, owner dim, title plain; text is the line's", () => {
    const snap = empty({ tasks: [task("t1", "CLOSED", "wontfix")] });
    const [r] = tabRows("tasks", snap, "w", { ...NO_FILTER, status: "all" }, 0);
    expect(r?.line.find((s) => s.text.startsWith("t1"))?.role).toBe("id");
    expect(r?.line.find((s) => s.text.startsWith("CLOSED/wontfix"))?.role).toBe("undone");
    expect(r?.line.at(-1)).toEqual({ text: "title t1" });
    expect(lineText(r?.line ?? [])).toBe(r?.text);
  });

  it("a log row: the verb cyan, operator prose (no intent) plain", () => {
    const item = (seq: number, rendered: string, intent: string | null) => ({
      seq,
      scope: "w",
      created_at: "2026-01-01T10:00:00",
      rendered,
      intent,
      actor: "a",
    });
    const snap = empty({
      log: [
        item(1, "task close t1 done", "task.close"),
        item(2, "task close by hand", null),
      ] as never,
    });
    const [a, b] = tabRows("log", snap, "w", NO_FILTER, 0);
    expect(a?.line.find((s) => s.role === "verb")?.text).toBe("task close");
    expect(b?.line.some((s) => s.role === "verb")).toBe(false);
  });

  it("an agent row: a dead agent's state red, a stalled tool yellow (from the attention list)", () => {
    const agent = {
      key: "w/a",
      name: "a",
      workstream: "w",
      state: "unknown",
      tasks: [],
      task: null,
      tool: { name: "bash", since: 0, elapsed_ms: 1 },
    };
    const att = (kind: "dead" | "stalled") => ({
      key: `${kind}:w/a`,
      workstream: "w",
      kind,
      text: "a",
      target: "w/a",
    });
    const snap = empty({ agents: [agent] as never, attention: [att("dead"), att("stalled")] });
    const [r] = tabRows("agents", snap, "w", NO_FILTER, 0);
    expect(r?.line.find((s) => s.text.startsWith("unknown"))?.role).toBe("bad");
    expect(r?.line.find((s) => s.text.startsWith("bash"))?.role).toBe("warn");
  });

  it("the strip: all quiet green; items yellow, dead red", () => {
    expect(attentionStrip([], null)).toEqual([{ text: "✓ all quiet", role: "good" }]);
    const line = attentionStrip(
      [
        { key: "d", workstream: "w", kind: "dead", text: "a dead", target: null },
        { key: "p", workstream: "w", kind: "permission", text: "b permission", target: null },
      ],
      "w",
    );
    expect(lineText(line)).toBe("⚠ 2 need you: a dead · b permission");
    expect(line.find((s) => s.text === "a dead")?.role).toBe("bad");
    expect(line.find((s) => s.text === "b permission")?.role).toBe("warn");
  });

  it("fitLine cuts by visual width across runs, keeping each run's role", () => {
    const cut = fitLine(
      [
        { text: "ab", role: "id" },
        { text: "日本語", role: "bad" },
      ],
      5,
    );
    expect(lineText(cut)).toBe("ab日…");
    expect(cut.map((s) => s.role)).toEqual(["id", "bad", undefined]); // the pad after the "…"
    expect(lineText(fitLine([{ text: "a\u001b[31mb" }], 4))).toBe("ab  ");
  });
});

const ESC = "\u001b";
const sgr = (...codes: number[]): string => codes.map((c) => `${ESC}[${c}m`).join("");

describe("<Frame> through ink, colour on", () => {
  // Vitest has no TTY, so ink's chalk is at level 0: raise it to see the SGR codes.
  let level: typeof chalk.level;
  beforeEach(() => {
    level = chalk.level;
    chalk.level = 1;
  });
  afterEach(() => {
    chalk.level = level;
  });
  const spec = {
    width: 30,
    height: 4,
    title: "Agents",
    subtitle: "2",
    bottom: "+1 more",
    body: [[{ text: "dead", role: "bad" as const }], [{ text: "sel", role: "bad" as const }]],
    selected: 1,
  };

  it("border gray, title bold cyan, count dim, a row in its role, the cursor solid inverse", async () => {
    const ui = await renderApp(createElement(Frame, spec), { columns: 40, rows: 6 });
    const s = ui.screen();
    expect(s).toContain(`${sgr(90)}╭─ `); // gray border
    expect([`${sgr(1, 36)}Agents`, `${sgr(36, 1)}Agents`].some((t) => s.includes(t))).toBe(true); // bold cyan title
    expect(s).toContain(`${sgr(2)}2`); // dim count
    expect(s).toContain(`${sgr(31)}dead`); // red row
    expect(s).toContain(`${sgr(7)}sel${" ".repeat(23)}${sgr(27)}`); // inverse, no colour inside
    ui.unmount();
  });

  it("NO_COLOR: no colour codes at all, bold, dim and inverse stay", async () => {
    await withEnv("NO_COLOR", "1", async () => {
      const ui = await renderApp(createElement(Frame, spec), { columns: 40, rows: 6 });
      const s = ui.screen();
      const colours = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];
      expect(colours.filter((c) => s.includes(sgr(c)))).toEqual([]);
      expect(s).toContain(`${sgr(1)}Agents`);
      expect(s).toContain(sgr(7));
      ui.unmount();
    });
  });
});
