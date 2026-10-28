// The dashboard's four tabs (S2): the pure model (rows.ts, text.ts) and the Ink
// view over a real snapshot. Fixture DBs, a fake terminal, no timers.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { App, layout } from "../src/cli/tui/app.js";
import { overviewCards } from "../src/cli/tui/overview.js";
import {
  cursorIndex,
  moveCursor,
  NO_FILTER,
  nextLine,
  nextSortLabel,
  pickWorkstream,
  scopeKey,
  tabRows,
} from "../src/cli/tui/rows.js";
import { createRuntime, type DashboardRuntime } from "../src/cli/tui/runtime.js";
import { cell, clean, lineText, scrollTop } from "../src/cli/tui/text.js";
import { type DashboardSnapshot, formatElapsed } from "../src/dashboard-data.js";
import { type Db, openDb } from "../src/db.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
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
  waves: [],
  attention: [],
  ...over,
});

describe("text", () => {
  it("clean strips escapes and control characters", () => {
    expect(clean("a\u001b[31mred\u001b[0m\tb\nc\u001b]0;title\u0007d")).toBe("ared b cd");
  });

  it("cell pads and cuts by VISUAL width (wide glyphs count 2)", () => {
    expect(cell("ab", 5)).toBe("ab   ");
    expect(cell("日本語x", 6)).toBe("日本… ");
    expect(cell("abcdef", 4)).toBe("abc…");
    expect(cell("x", 0)).toBe("");
  });

  it("scrollTop moves the least that shows the cursor and never past the end", () => {
    expect(scrollTop(0, 3, 10, 5)).toBe(0);
    expect(scrollTop(0, 7, 10, 5)).toBe(3);
    expect(scrollTop(5, 2, 10, 5)).toBe(2);
    expect(scrollTop(9, 9, 10, 5)).toBe(5);
    expect(scrollTop(3, 0, 2, 5)).toBe(0);
  });
});

describe("model", () => {
  it("starts on the hint when live, else the MOST ACTIVE workstream (not the first)", () => {
    const ws = [
      { name: "alpha", scratch: false, latest_seq: 3 },
      { name: "scratch", scratch: true, latest_seq: 90 },
      { name: "zed", scratch: false, latest_seq: 40 },
    ];
    expect(pickWorkstream(ws, "zed")).toBe("zed");
    expect(pickWorkstream(ws, "gone")).toBe("scratch");
    expect(pickWorkstream(ws)).toBe("scratch");
    expect(pickWorkstream([])).toBeNull();
  });

  it("Next: unavailable is never 'no authorised work'; only a computed null is", () => {
    expect(nextLine(empty())).toBe("next: unavailable");
    expect(nextLine(empty({ next_source: "computed" }))).toBe("next: no authorised work");
    expect(
      nextLine(
        empty({ next_source: "computed", next: { mode: "seq", commands: ["mu a", "mu b"] } }),
      ),
    ).toBe("next (seq): mu a ; mu b");
  });

  it("filters are scoped per tab and workstream", () => {
    expect(scopeKey("tasks", "a")).not.toBe(scopeKey("tasks", "b"));
    expect(scopeKey("tasks", "a")).not.toBe(scopeKey("dag", "a"));
    expect(scopeKey("agents", "a")).not.toBe(scopeKey("agents", "b"));
    expect(scopeKey("log", "a")).not.toBe(scopeKey("log", "b"));
  });

  it("an agent whose tool is not reported shows '?', not 'none'; a reported one shows elapsed", () => {
    const base = { key: "w/a", workstream: "w", state: "idle", tasks: [], task: null } as never;
    const snap = empty({
      agents: [
        base,
        { ...(base as object), key: "w/b", tool: { name: "bash", since: 0, elapsed_ms: 65_000 } },
        { ...(base as object), key: "w/c", tool: null },
      ] as never,
    });
    const [a, b, c] = tabRows("agents", snap, "w", NO_FILTER, 0);
    expect(a?.text).toContain("tool ?");
    expect(c?.text).toContain("tool -"); // reported none: not unknown
    expect(b?.text).toContain("bash 1m05s");
    expect(formatElapsed(3_700_000)).toBe("1h01m");
  });

  it("Agents: bare names for the selected workstream, @host only on a remote agent", () => {
    const a = { workstream: "w", state: "busy", tool: null } as const;
    const snap = empty({
      agents: [
        { ...a, key: "w/local", name: "local", host: null, tasks: [], task: "w/t1" },
        { ...a, key: "w/far", name: "far", host: "dev", tasks: [], task: "other/t2" },
        { ...a, key: "o/x", workstream: "o", name: "x", host: null, tasks: [], task: null },
      ] as never,
    });
    const [l, f, ...rest] = tabRows("agents", snap, "w", NO_FILTER, 0);
    expect(l?.text).toMatch(/^local\s+local\s+busy\s+t1\s+tool -$/);
    expect(l?.text).not.toContain("@");
    expect(f?.text).toMatch(/^far\s+dev\s+busy\s+other\/t2/);
    expect(rest).toEqual([]);
  });

  it("the cursor follows its key when rows reorder, and clamps", () => {
    const rows = ["a", "b", "c"].map((key) => ({ key, text: key, line: [{ text: key }] }));
    expect(cursorIndex(rows, "c", "tasks")).toBe(2);
    expect(cursorIndex([...rows].reverse(), "c", "tasks")).toBe(0);
    expect(cursorIndex(rows, "gone", "tasks")).toBe(0);
    expect(cursorIndex(rows, null, "log")).toBe(2);
    expect(moveCursor(rows, "b", "tasks", 9)).toBe("c");
    expect(moveCursor([], null, "tasks", 1)).toBeNull();
  });

  it("DAG: the frontier cuts are always rows, even under a text filter that matches nothing", () => {
    const snap = empty({
      edges: [
        {
          key: "w/a",
          workstream: "w",
          id: "a",
          title: "A",
          status: "OPEN",
          substate: "todo",
          depth: 0,
          parent: null,
          again: false,
          kids: 0,
          closed: 2,
          cap_cut: 1,
        },
      ],
      frontier: [{ workstream: "w", roots_cut: 4, again_cut: 1 }],
    });
    const all = tabRows("dag", snap, "w", NO_FILTER, 0).map((r) => r.text);
    expect(all[0]).toMatch(/^a {2}OPEN {13} {2}A {2}\(2 closed, 1 cut by cap\)$/);
    expect(all.slice(1)).toEqual([
      "… 4 open start tasks left out by the node cap",
      "… 1 repeat line left out by the node cap",
    ]);
    const hidden = tabRows("dag", snap, "w", { ...NO_FILTER, text: "zzz" }, 0);
    // The entry's own line is filtered out; its per-entry cap cut is still said.
    expect(hidden.map((r) => r.text)).toEqual([
      "… 1 open task under a left out by the node cap",
      "… 4 open start tasks left out by the node cap",
      "… 1 repeat line left out by the node cap",
    ]);
    expect(hidden.every((r) => r.key.startsWith("cut:"))).toBe(true);
    // A matching filter shows the entry (with its cut in the line) and no duplicate notice.
    const shown = tabRows("dag", snap, "w", { ...NO_FILTER, text: "a" }, 0);
    expect(shown.filter((r) => r.text.includes("under a"))).toEqual([]);
  });

  it("layout: the workstream and tab rows always stay, then one data row, then the rest", () => {
    const l = (n: number) => {
      const { shown, height } = layout(n);
      return { shown: [...shown], height };
    };
    expect(l(0)).toEqual({ shown: [], height: 0 });
    expect(l(2)).toEqual({ shown: [], height: 0 });
    expect(l(3)).toEqual({ shown: [], height: 1 });
    expect(l(4)).toEqual({ shown: ["footer"], height: 1 });
    expect(l(5)).toEqual({ shown: ["footer", "strip"], height: 1 });
    expect(l(6)).toEqual({ shown: ["footer", "strip", "filter"], height: 1 });
    expect(l(7)).toEqual({ shown: ["footer", "strip", "filter", "next"], height: 1 });
    expect(l(50)).toEqual({ shown: ["footer", "strip", "filter", "next"], height: 44 });
  });
});

describe("tabs (Ink over a real snapshot)", () => {
  let tmp: string;
  let db: Db;
  let rt: DashboardRuntime;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-dash-tabs-"));
    db = openDb({ path: join(tmp, "a.db") });
    delete process.env.MU_SYNC_DIR;
  });
  afterEach(async () => {
    await rt?.close();
    db.close();
    rmFixtureDir(tmp);
  });

  const add = (ws: string, id: string, title = id): void => {
    ensureWorkstream(db, ws);
    addTask(db, { workstream: ws, localId: id, title, impact: 50, effortDays: 1 });
  };
  const open = (size = { columns: 80, rows: 20 }, initial?: string) => {
    rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: db, caller: null });
    return renderApp(
      createElement(App, {
        runtime: rt,
        initialTab: "tasks",
        pollMs: null,
        initialWorkstream: initial,
        now: () => 0,
      }),
      size,
    );
  };

  it("starts on the most active workstream, marks scratch, shows tasks newest-activity first", async () => {
    add("alpha", "old");
    add("scratch", "s1");
    add("beta", "first");
    add("beta", "second");
    const ui = await open();
    await ui.until((s) => s.includes("second"));
    const s = ui.screen();
    expect(s).toContain("[beta]");
    expect(s).toContain("scratch*");
    expect(s.indexOf("second")).toBeLessThan(s.indexOf("first"));
    expect(s).not.toContain("old");
    expect(s).toContain("next: no authorised work"); // computed (computeNext), null: nothing authorised
    expect(s).not.toContain("next: unavailable");
    ui.unmount();
  });

  it("DAG, Agents and Log tabs", async () => {
    add("alpha", "a1");
    add("beta", "b0");
    ensureWorkstream(db, "beta");
    addTask(db, {
      workstream: "beta",
      localId: "b1",
      title: "child",
      impact: 50,
      effortDays: 1,
      blockedBy: ["b0"],
    });
    const ui = await open({ columns: 80, rows: 20 }, "beta");
    await ui.until((s) => s.includes("b1"));
    await ui.press("\t"); // DAG: the selected workstream only
    await ui.until((s) => s.includes("OPEN") && s.includes("b1"));
    expect(ui.screen()).not.toContain("a1");
    await ui.press("\t"); // Agents: none registered
    await ui.until((s) => s.includes("nothing here"));
    await ui.press("\t"); // Log: the selected workstream's ops
    await ui.until((s) => s.includes("beta"));
    expect(ui.screen()).not.toContain("task add a1");
    ui.unmount();
  });

  it("Agents and Log follow the workstream switch ([ ])", async () => {
    add("alpha", "a1");
    add("beta", "b1");
    insertAgent(db, { name: "amy", workstream: "alpha", paneId: "%1" });
    insertAgent(db, { name: "bob", workstream: "beta", paneId: "%2" });
    const ui = await open({ columns: 80, rows: 20 }, "alpha");
    // The attention strip covers every workstream on purpose (a dead `bob` shows there): read the list.
    const list = (): string =>
      ui
        .screen()
        .split("\n")
        .filter((l) => !/^[⚠✓]/.test(l))
        .join("\n");
    await ui.until((s) => s.includes("a1"));
    await ui.press("\t"); // DAG
    await ui.press("\t"); // Agents
    await ui.until((s) => s.includes("amy"));
    expect(list()).not.toContain("bob");
    await ui.press("]");
    await ui.until((s) => s.includes("bob"));
    expect(list()).not.toContain("amy");
    await ui.press("\t"); // Log: beta's ops only
    await ui.until((s) => s.includes("b1"));
    expect(list()).not.toContain("a1");
    await ui.press("[");
    await ui.until((s) => s.includes("a1"));
    expect(list()).not.toContain("b1");
    ui.unmount();
  });

  describe("stable columns and sort", () => {
    const task = (id: string, over: Record<string, unknown> = {}) => ({
      key: `w/${id}`,
      workstream: "w",
      id,
      title: `title of ${id}`,
      status: "OPEN",
      substate: "todo",
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
      ...over,
    });
    const col = (text: string, needle: string): number => text.indexOf(needle);

    it("Tasks: the title column does not move with the filter, and the owner precedes the title", () => {
      const snap = empty({
        tasks: [
          task("a", { title: "T-a" }),
          task("long_task_identifier", {
            title: "T-long",
            status: "IN_PROGRESS",
            substate: "active",
            owner: "worker-6",
            owner_workstream: "w",
          }),
        ] as never,
      });
      const all = tabRows("tasks", snap, "w", NO_FILTER, 0).map((r) => r.text);
      const only = tabRows("tasks", snap, "w", { ...NO_FILTER, text: "T-a" }, 0).map((r) => r.text);
      expect(only).toHaveLength(1);
      expect(col(only[0] ?? "", "T-a")).toBe(col(all[0] ?? "", "T-a"));
      expect(col(all[1] ?? "", "@worker-6")).toBeLessThan(col(all[1] ?? "", "T-long"));
      // Unowned rows keep the title in the same column as owned ones.
      expect(col(all[0] ?? "", "T-a")).toBe(col(all[1] ?? "", "T-long"));
    });

    it("Tasks: a long title is the clipped column; the owner stays whole", () => {
      const snap = empty({
        tasks: [
          task("t009", {
            title: "x".repeat(400),
            status: "IN_PROGRESS",
            substate: "active",
            owner: "worker-6",
            owner_workstream: "w",
          }),
        ] as never,
      });
      const [r] = tabRows("tasks", snap, "w", NO_FILTER, 0);
      expect(r?.text).toContain("t009");
      expect(r?.text).toContain("@worker-6");
      expect(r?.text.indexOf("@worker-6")).toBeLessThan(40);
    });

    it("Tasks: sort cycles activity, roi, age, id; roi ties go to the smaller effort", () => {
      expect(nextSortLabel("activity")).toBe("roi");
      expect(nextSortLabel("id")).toBe("activity");
      const snap = empty({
        tasks: [
          task("b", { impact: 10, effort_days: 1, created_at: "2026-01-03 00:00:00" }),
          task("a", { impact: 80, effort_days: 4, created_at: "2026-01-02 00:00:00" }), // roi 20
          task("c", { impact: 20, effort_days: 1, created_at: "2026-01-01 00:00:00" }), // roi 20, smaller effort
        ] as never,
      });
      const order = (sort: "activity" | "roi" | "age" | "id"): string[] =>
        tabRows("tasks", snap, "w", { ...NO_FILTER, sort }, 0).map((r) => r.key);
      expect(order("activity")).toEqual(["w/b", "w/a", "w/c"]);
      expect(order("roi")).toEqual(["w/c", "w/a", "w/b"]);
      expect(order("age")).toEqual(["w/c", "w/a", "w/b"]);
      expect(order("id")).toEqual(["w/a", "w/b", "w/c"]);
    });

    it("Tasks: a delegate task shows its call state, verdict and judged task; a work task none", () => {
      const call = { call_id: "c", wave: null, judges: "w/fix_auth" };
      const snap = empty({
        tasks: [
          task("delegate_a", {
            kind: "delegate",
            call: { ...call, state: "done", verdict: "REFUTED" },
          }),
          task("delegate_b", {
            kind: "delegate",
            call: { ...call, state: "refused", verdict: null, judges: null },
          }),
          task("work", { title: "T-work" }),
        ] as never,
      });
      const rows = tabRows("tasks", snap, "w", NO_FILTER, 0);
      expect(rows[0]?.text).toContain("done REFUTED > w/fix_auth");
      expect(rows[1]?.text).toMatch(/refused +title of delegate_b/);
      expect(col(rows[2]?.text ?? "", "T-work")).toBe(col(rows[0]?.text ?? "", "title of"));
      expect(rows[1]?.line.find((s) => s.text.startsWith("refused"))?.role).toBe("warn");
      const refused = tabRows("tasks", snap, "w", { ...NO_FILTER, text: "refused" }, 0);
      expect(refused.map((r) => r.key)).toEqual(["w/delegate_b"]);
    });

    it("Tasks: no delegate tasks, no call column", () => {
      const snap = empty({ tasks: [task("a", { title: "T-a" })] as never });
      expect(tabRows("tasks", snap, "w", NO_FILTER, 0)[0]?.text).toMatch(/^a +OPEN +T-a$/);
    });

    it("Overview: a Waves card with counts, only when the workstream has waves", () => {
      const wave = {
        key: "w/refute-w",
        workstream: "w",
        wave: "refute-w",
        calls: 5,
        confirmed: 2,
        refuted: 1,
        unverified: 0,
        pending: 2,
        refused: 1,
        updated_at: "2026-01-01",
      };
      expect(overviewCards(empty(), "w", 0).map((c) => c.id)).not.toContain("waves");
      const card = overviewCards(empty({ waves: [wave] }), "w", 0).find((c) => c.id === "waves");
      expect(card?.lines.map(lineText)).toEqual([
        "refute-w  5 calls  2 CONFIRMED  1 REFUTED  2 pending (1 refused)",
      ]);
      expect(overviewCards(empty({ waves: [wave] }), "other", 0).map((c) => c.id)).not.toContain(
        "waves",
      );
    });

    it("Overview: the task cards leave out the call column, so titles keep their place", () => {
      const snap = empty({
        tasks: [
          task("delegate_a", {
            kind: "delegate",
            call: {
              call_id: "c",
              wave: null,
              state: "running",
              verdict: null,
              judges: "w/fix_auth_token_refresh",
            },
          }),
          task("work", { title: "T-work" }),
        ] as never,
      });
      const open = overviewCards(snap, "w", 0).find((c) => c.id === "open");
      const text = open?.lines.map(lineText) ?? [];
      expect(text.join("\n")).not.toContain("fix_auth_token_refresh");
      const noCall = empty({
        tasks: [
          task("delegate_a", { kind: "delegate" }),
          task("work", { title: "T-work" }),
        ] as never,
      });
      const plain = overviewCards(noCall, "w", 0)
        .find((c) => c.id === "open")
        ?.lines.map(lineText);
      expect(text).toEqual(plain);
    });

    it("Overview: Enter on a delegate attention item opens that delegate task's notes", () => {
      const snap = empty({
        attention: [
          {
            key: "delegate:scratch/delegate_x",
            workstream: "scratch",
            kind: "delegate",
            text: "delegate failed: api check",
            target: "scratch/delegate_x",
          },
        ],
      });
      const [r] = tabRows("overview", snap, "w", NO_FILTER, 0);
      expect(r?.text).toBe("scratch/delegate failed: api check");
      expect(r?.drill).toEqual({
        kind: "notes",
        workstream: "scratch",
        id: "delegate_x",
        title: "delegate failed: api check",
      });
      expect(r?.line[0]?.role).toBe("bad");
    });

    it("Agents: host column is `local` or the host; columns do not move under a filter", () => {
      const a = { workstream: "w", tool: null, tasks: [], task: null } as const;
      const snap = empty({
        agents: [
          { ...a, key: "w/x", name: "x", host: null, state: "idle" },
          {
            ...a,
            key: "w/longer-name",
            name: "longer-name",
            host: "dev",
            state: "needs_permission",
          },
        ] as never,
      });
      const all = tabRows("agents", snap, "w", NO_FILTER, 0).map((r) => r.text);
      const one = tabRows("agents", snap, "w", { ...NO_FILTER, text: "idle" }, 0).map(
        (r) => r.text,
      );
      expect(all[0]).toMatch(/^x +local +idle +- +tool -$/);
      expect(all[1]).toMatch(/^longer-name +dev +needs_permission +- +tool -$/);
      expect(col(one[0] ?? "", "idle")).toBe(col(all[0] ?? "", "idle"));
    });

    it("Agents: the tool column does not move when an agent claims a task", () => {
      const a = { workstream: "w", tool: null, host: null, state: "idle", tasks: [] } as const;
      const at = (owned: string | null) =>
        empty({
          tasks: [task("long_task_id")] as never,
          agents: [
            { ...a, key: "w/x", name: "x", task: owned === null ? null : `w/${owned}` },
          ] as never,
        });
      const idle = tabRows("agents", at(null), "w", NO_FILTER, 0)[0]?.text ?? "";
      const busy = tabRows("agents", at("long_task_id"), "w", NO_FILTER, 0)[0]?.text ?? "";
      expect(idle.indexOf("tool")).toBe(busy.indexOf("tool"));
    });

    it("Log: seq, time and text start in the same column on every row", () => {
      const item = (seq: number, rendered: string) => ({
        seq,
        scope: "w",
        created_at: `2026-01-01T10:00:0${seq % 10}`,
        rendered,
        actor: "a",
      });
      const snap = empty({
        log: [item(9, "first"), item(10, "second"), item(100, "third")] as never,
      });
      const rows = tabRows("log", snap, "w", NO_FILTER, 0).map((r) => r.text);
      expect(new Set(rows.map((r) => r.search(/first|second|third/))).size).toBe(1);
      expect(rows[0]).toMatch(/^ {2}9 {2}10:00:09 {2}first$/);
      expect(rows[2]).toMatch(/^100 {2}10:00:00 {2}third$/);
    });

    it("DAG: ids carry the indent, statuses and titles line up", () => {
      const e = (id: string, depth: number) => ({
        key: `w/${id}`,
        workstream: "w",
        id,
        title: `T-${id}`,
        status: "OPEN",
        substate: "todo",
        depth,
        parent: null,
        again: false,
        kids: 0,
        closed: 0,
        cap_cut: 0,
      });
      const rows = tabRows(
        "dag",
        empty({ edges: [e("a", 0), e("bb", 1), e("c", 2)] }),
        "w",
        NO_FILTER,
        0,
      );
      const cols = rows.map((r) => r.text.indexOf("T-"));
      expect(new Set(cols).size).toBe(1);
      expect(rows[1]?.text.startsWith("  bb")).toBe(true);
    });
  });

  it("the workstream row scrolls so the SELECTED label is whole, '…' prefix counted", async () => {
    for (const n of ["aaaa", "bbbb", "cccc"]) add(n, "t1");
    // "… bbbb [cccc]" is 13 columns (the "…" counts): at 12 the scroll must also drop bbbb.
    const ui = await open({ columns: 12, rows: 10 }, "cccc");
    await ui.until((s) => s.includes("[cccc]"));
    expect(ui.screen().split("\n")[0]?.trimEnd()).toBe("…[cccc]");
    ui.unmount();
  });

  it("s cycles the Tasks sort and o the status filter", async () => {
    add("beta", "t1");
    const ui = await open({ columns: 100, rows: 20 }, "beta");
    await ui.until((s) => s.includes("t1"));
    expect(ui.screen()).toContain("sort: activity ↓");
    await ui.press("s");
    await ui.until((s) => s.includes("sort: roi ↓") && s.includes("status: active"));
    await ui.press("s");
    await ui.until((s) => s.includes("sort: age ↑"));
    await ui.press("o");
    await ui.until((s) => s.includes("status: open") && s.includes("sort: age ↑"));
    await ui.press("c");
    await ui.until((s) => s.includes("sort: activity ↓") && s.includes("status: active"));
    ui.unmount();
  });

  it("CLOSED is hidden until the status filter asks for it", async () => {
    add("beta", "live");
    add("beta", "done1");
    closeTask(db, "done1", { workstream: "beta", evidence: "test" });
    const ui = await open({ columns: 80, rows: 20 }, "beta");
    await ui.until((s) => s.includes("live"));
    expect(ui.screen()).not.toContain("done1");
    await ui.press("o"); // open
    await ui.press("o"); // in_progress
    await ui.press("o"); // closed
    await ui.until((s) => s.includes("status: closed") && s.includes("done1"));
    expect(ui.screen()).not.toContain("live");
    ui.unmount();
  });

  it("status and text filters persist per tab and workstream across switches", async () => {
    add("alpha", "apple");
    add("alpha", "avocado");
    add("beta", "banana");
    add("beta", "blueberry");
    const ui = await open({ columns: 80, rows: 20 }, "beta");
    await ui.until((s) => s.includes("banana"));
    await ui.press("/");
    await ui.press("blue");
    await ui.until((s) => s.includes("filter: blue_") && !s.includes("banana"));
    await ui.press("\r");
    await ui.press("o");
    await ui.until((s) => s.includes("status: open"));
    // Another tab and another workstream carry their own (empty) filters ...
    await ui.press("\t");
    await ui.until((s) => s.includes("filter: ") && !s.includes("filter: blue"));
    await ui.press("]");
    await ui.press("\u001b[D"); // back to Tasks (left arrow)
    await ui.until((s) => s.includes("[beta]") === false && s.includes("apple"));
    expect(ui.screen()).toContain("status: active");
    expect(ui.screen()).toContain("avocado");
    // ... and beta's survive the round trip.
    await ui.press("[");
    await ui.until((s) => s.includes("[beta]") && s.includes("blueberry"));
    expect(ui.screen()).toContain("filter: blue");
    expect(ui.screen()).toContain("status: open");
    expect(ui.screen()).not.toContain("banana");
    ui.unmount();
  });

  it("Esc while typing reverts the filter and does not quit; c clears", async () => {
    add("beta", "banana");
    add("beta", "cherry");
    const ui = await open({ columns: 80, rows: 20 }, "beta");
    await ui.until((s) => s.includes("banana"));
    await ui.press("/");
    await ui.press("che");
    await ui.until((s) => !s.includes("banana"));
    await ui.press("\u001b");
    await ui.until((s) => s.includes("banana") && s.includes("filter: "));
    await ui.press("/");
    await ui.press("zzz");
    await ui.press("\r");
    await ui.until((s) => s.includes("no rows match the filter"));
    await ui.press("c");
    await ui.until((s) => s.includes("banana"));
    ui.unmount();
  });

  it("the viewport scrolls with the cursor and follows a resize", async () => {
    for (let i = 0; i < 12; i++) add("beta", `t${String(i).padStart(2, "0")}`);
    const ui = await open({ columns: 60, rows: 10 }, "beta"); // 5 data rows
    await ui.until((s) => s.includes("t11"));
    expect(ui.screen()).not.toContain("t06"); // newest first: t11..t07 fit
    await ui.press("G");
    await ui.until((s) => s.includes("t00") && !s.includes("t11"));
    expect(ui.screen()).toMatch(/> t00/);
    ui.resize(60, 20); // 15 data rows: all twelve fit, cursor stays on t00
    await ui.until((s) => s.includes("t11") && s.includes("t00"));
    expect(ui.screen()).toMatch(/> t00/);
    ui.unmount();
  });

  it("every screen line is cut to the terminal width, hostile text included", async () => {
    add("beta", "wide", `日本語${"x".repeat(80)}\u001b[31mred\u001b[0m`);
    const ui = await open({ columns: 40, rows: 12 }, "beta");
    await ui.until((s) => s.includes("wide"));
    const s = ui.screen();
    expect(s).not.toContain("\u001b[31m");
    expect(s).toContain("…");
    for (const line of s.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(40);
    ui.unmount();
  });

  it("the cursor stays on its task when activity reorders the list (default row, after a move, after a filter reset)", async () => {
    add("beta", "one");
    add("beta", "two");
    add("beta", "three");
    rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: db, caller: null });
    const ui = await renderApp(
      createElement(App, {
        runtime: rt,
        initialTab: "tasks",
        pollMs: 0,
        initialWorkstream: "beta",
        now: () => 0,
      }),
      { columns: 60, rows: 12 },
    );
    const bump = (id: string) =>
      addNote(db, id, "bump", { workstream: "beta", author: "t" } as never);
    const lineOf = (s: string, id: string) => s.split("\n").find((l) => l.includes(id)) ?? "";
    // Default row, no key pressed: `three` is selected and a bump of `one` must not move it.
    await ui.until((s) => s.includes("> three"));
    bump("one");
    await ui.until((s) => s.indexOf("one") < s.indexOf("three"));
    expect(lineOf(ui.screen(), "three")).toContain("> three");
    expect(lineOf(ui.screen(), "one")).not.toContain(">");
    // After a move.
    await ui.press("j");
    await ui.until((s) => /> /.test(lineOf(s, "two")) || /> /.test(lineOf(s, "three")));
    const moved = ["one", "two", "three"].find((id) => lineOf(ui.screen(), id).includes("> "));
    bump("two");
    await ui.until((s) => s.indexOf("two") < s.indexOf("one"));
    expect(lineOf(ui.screen(), moved ?? "?")).toContain("> ");
    // After a filter reset: the default row is pinned again, not index 0 of every poll.
    await ui.press("/");
    await ui.press("t");
    await ui.press("\r");
    await ui.press("c");
    await ui.until((s) => s.includes("one") && s.includes("two") && s.includes("three"));
    const pinned = ["one", "two", "three"].find((id) => lineOf(ui.screen(), id).includes("> "));
    expect(pinned).toBe("two"); // the newest at reset time
    const other = pinned === "three" ? "two" : "three";
    bump(other); // another task becomes newest: it lands above the pinned row
    await ui.until((s) => s.indexOf(other) < s.indexOf(pinned ?? "?"));
    expect(lineOf(ui.screen(), pinned ?? "?")).toContain("> ");
    ui.unmount();
  });

  it("a short or narrow terminal keeps the workstream row and the tabs on screen", async () => {
    add("alpha", "a1");
    add("beta", "t1");
    const check = async (columns: number, rows: number): Promise<string> => {
      const ui = await open({ columns, rows }, "beta");
      await ui.until((s) => s.includes("t1"));
      const s = ui.screen();
      ui.unmount();
      return s;
    };
    for (const [columns, rows] of [
      [20, 10],
      [80, 5],
      [80, 3],
      [12, 4],
    ] as const) {
      const s = await check(columns, rows);
      const lines = s.split("\n");
      expect(lines.length, `${columns}x${rows}`).toBeLessThanOrEqual(rows);
      expect(lines[0], `${columns}x${rows}`).toContain("[beta]");
      expect(lines[1], `${columns}x${rows}`).toContain("Tasks");
      expect(s, `${columns}x${rows}`).toContain("t1"); // one data row survives
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
    }
  });

  it("shrinking the terminal re-lays the screen out and keeps the header", async () => {
    for (let i = 0; i < 8; i++) add("beta", `t${i}`);
    const ui = await open({ columns: 80, rows: 20 }, "beta");
    await ui.until((s) => s.includes("t7") && s.includes("t0"));
    ui.resize(20, 10);
    await ui.until((s) => s.includes("Tasks 2/5"));
    let lines = ui.screen().split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain("[beta]");
    ui.resize(80, 4);
    await ui.until((s) => s.split("\n").length === 4);
    lines = ui.screen().split("\n");
    expect(lines[0]).toContain("[beta]");
    expect(lines[1]).toContain("Tasks");
    ui.unmount();
  });

  it("a computed Next renders; unavailable never reads as no work", async () => {
    add("beta", "t1");
    rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: db, caller: null });
    const real = rt;
    const computed: DashboardRuntime = {
      notes: real.notes,
      task: real.task,
      close: real.close,
      refresh: async (q) => {
        const r = await real.refresh(q);
        return {
          ...r,
          snapshot: {
            ...r.snapshot,
            next_source: "computed",
            next: { mode: "alt", commands: ["mu x"] },
          },
        };
      },
    };
    const ui = await renderApp(
      createElement(App, {
        runtime: computed,
        initialTab: "tasks",
        pollMs: null,
        initialWorkstream: "beta",
      }),
      { columns: 80, rows: 12 },
    );
    await ui.until((s) => s.includes("next (alt): mu x"));
    ui.unmount();
  });

  it("empty database: no workstreams, no crash, q quits", async () => {
    const ui = await open();
    await ui.until((s) => s.includes("no workstreams") && s.includes("next: unavailable"));
    await ui.press("j");
    await ui.press("]");
    await ui.press("q");
    await ui.exited;
  });
});
