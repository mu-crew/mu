// Dashboard drills (v_dashboard_drill): notes, scrollback, log, attach and yank.
// Pure layers first (wrap, runAttach, yank), then the Ink view over a real
// snapshot with a mocked mux. No real tmux, no timers, no subprocess.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { App } from "../src/cli/tui/app.js";
import {
  copyCommand,
  planAttach,
  runAttach,
  type StepRunner,
  yankSequence,
} from "../src/cli/tui/commands.js";
import { clampTop, notesText, wrap } from "../src/cli/tui/drill.js";
import { createRuntime, type DashboardRuntime } from "../src/cli/tui/runtime.js";
import { type Db, openDb } from "../src/db.js";
import type { MuxCommand } from "../src/mux.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { renderApp } from "./_ink-render.js";
import { installMux, installNoMux, type MuxHarness } from "./_mux.js";
import { TAB_LIST, WORKSPACE_LIST } from "./_mux-fixtures.js";

const ESC = "\u001b";
/** The screen with wrapped lines joined: a wrap may split a phrase across lines. */
const flat = (ui: { screen(): string }): string => ui.screen().replace(/\s*\n\s*/g, " ");
// One keypress per Tab: a chunk of several is one event to Ink's input parser.
const tab = async (ui: { press(k: string): Promise<void> }, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await ui.press("\t");
};
const ENTER = "\r";

describe("wrap and clampTop", () => {
  it("no line is wider than the box, at any width, with wide glyphs and a long unbroken token", () => {
    const body = `the quick brown fox 日本語日本語日本語 jumps\n\n  indented line\n${"x".repeat(70)}`;
    for (const width of [2, 3, 7, 20, 40]) {
      for (const line of wrap(body, width)) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrap("a\n\nb", 5)).toEqual(["a", "", "b"]);
  });

  it("strips ANSI and control characters before measuring (they cannot break the wrap)", () => {
    const lines = wrap(`${ESC}[31mred${ESC}[0m text${ESC}]0;title\u0007 more\ttab`, 12);
    expect(lines.join("\n").includes(ESC)).toBe(false);
    expect(lines.join("\n").includes("\u0007")).toBe(false);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(12);
  });

  it("clampTop holds the scroll inside the body, whatever the input", () => {
    expect(clampTop(99, 10, 4)).toBe(6);
    expect(clampTop(-3, 10, 4)).toBe(0);
    expect(clampTop(5, 2, 4)).toBe(0);
    expect(clampTop(Number.MAX_SAFE_INTEGER, 100, 10)).toBe(90);
  });
});

describe("runAttach: ordered steps, required vs optional", () => {
  const step = (n: string, extra: Partial<MuxCommand> = {}): MuxCommand => ({
    command: "x",
    args: [n],
    ...extra,
  });
  const runner =
    (codes: Record<string, number | "throw" | "enoent">, ran: string[]): StepRunner =>
    async (s) => {
      const n = s.args[0] ?? "";
      ran.push(n);
      const c = codes[n] ?? 0;
      if (c === "throw") throw new Error("boom");
      if (c === "enoent") return { code: null, error: "spawn x ENOENT", stderr: "" };
      return { code: c, stderr: c === 0 ? "" : "no server running" };
    };

  it("runs every step in order", async () => {
    const ran: string[] = [];
    expect(await runAttach([step("a"), step("b")], runner({}, ran))).toEqual({
      ok: true,
      warnings: [],
    });
    expect(ran).toEqual(["a", "b"]);
  });

  it("a required failure stops the rest and names the step and why", async () => {
    const ran: string[] = [];
    const r = await runAttach([step("a"), step("b"), step("c")], runner({ b: 1 }, ran));
    expect(ran).toEqual(["a", "b"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("x b failed (exit 1: no server running)");
  });

  it("an optional failure is a warning and the next step still runs", async () => {
    const ran: string[] = [];
    const r = await runAttach(
      [step("a", { optional: true, reason: "select-window may race" }), step("b")],
      runner({ a: 1 }, ran),
    );
    expect(ran).toEqual(["a", "b"]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(["select-window may race (exit 1: no server running)"]);
  });

  it("a missing binary or a throwing runner is a reason, never a crash", async () => {
    expect((await runAttach([step("a")], runner({ a: "enoent" }, []))).reason).toBe(
      "x a failed (spawn x ENOENT)",
    );
    expect((await runAttach([step("a")], runner({ a: "throw" }, []))).reason).toContain("boom");
  });
});

describe("yank", () => {
  it("OSC 52 carries exactly the command; control characters and huge input are refused", () => {
    const y = yankSequence("mu agent read 'w 1' -w ws");
    if (!y.ok) throw new Error("refused");
    expect(y.sequence).toBe(
      `${ESC}]52;c;${Buffer.from("mu agent read 'w 1' -w ws").toString("base64")}\u0007`,
    );
    expect(yankSequence("echo a\nrm -rf /").ok).toBe(false);
    expect(yankSequence(`echo ${ESC}[2J`).ok).toBe(false);
    expect(yankSequence("x".repeat(5000)).ok).toBe(false);
  });

  it("copy commands quote POSIX-safely (an apostrophe cannot end the word)", () => {
    const t = { kind: "notes", workstream: "o'brien", id: "a b", title: "t" } as const;
    expect(copyCommand(t)).toBe(`mu task show 'a b' -w 'o'"'"'brien'`);
    expect(copyCommand(t, { all: true })).toMatch(/ --all$/);
    const s = {
      kind: "scrollback",
      workstream: "ws",
      name: "w1",
      paneId: "%1",
      tab: null,
    } as const;
    expect(copyCommand(s)).toBe("mu agent read w1 -w ws");
    expect(copyCommand(s, { attachLine: "tmux attach-session -t mu-ws:w1" })).toBe(
      "tmux attach-session -t mu-ws:w1",
    );
  });
});

describe("drills in the dashboard", () => {
  let tmp: string;
  let db: Db;
  let rt: DashboardRuntime;
  let mux: MuxHarness | undefined;
  let captured: string;
  const pane = (cmd: string) => cmd.startsWith("capture-pane");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-dash-drill-"));
    db = openDb({ path: join(tmp, "a.db") });
    delete process.env.MU_SYNC_DIR;
    captured = "line one\nline two\n";
  });
  afterEach(async () => {
    await rt?.close();
    mux?.restore();
    mux = undefined;
    db.close();
    rmFixtureDir(tmp);
  });

  const seed = (): void => {
    ensureWorkstream(db, "ws");
    addTask(db, {
      workstream: "ws",
      localId: "t1",
      title: "first task",
      impact: 50,
      effortDays: 1,
    });
    addTask(db, { workstream: "ws", localId: "t2", title: "second", impact: 50, effortDays: 1 });
  };
  const note = (id: string, text: string, kind?: "brief" | "report"): void => {
    addNote(db, id, text, { workstream: "ws", author: "me", ...(kind ? { kind } : {}) });
  };
  const agent = (name = "w1", paneId = "%1", tab?: string): void => {
    ensureWorkstream(db, "ws");
    insertAgent(db, { name, workstream: "ws", paneId, ...(tab ? { tab } : {}) });
  };
  const tmuxMux = (): MuxHarness =>
    installMux("tmux", async (args) => ({
      stdout: pane(args.join(" ")) ? captured : "",
      stderr: "",
      exitCode: 0,
    }));
  const open = (size = { columns: 80, rows: 20 }, runStep?: StepRunner) => {
    rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: db, caller: null });
    return renderApp(
      createElement(App, {
        runtime: rt,
        pollMs: null,
        initialWorkstream: "ws",
        now: () => 0,
        runStep,
      }),
      size,
    );
  };
  const opsCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;

  it("Tasks Enter opens whole notes (pinned marked), Esc returns with the filter intact", async () => {
    seed();
    note("t1", "the brief body\nsecond brief line", "brief");
    const ui = await open();
    await ui.until((s) => s.includes("first task"));
    await ui.press("/");
    await ui.press("first");
    await ui.press(ENTER);
    await ui.press("j"); // keep the filter; one row only
    await ui.press(ENTER);
    await ui.until((s) => s.includes("Notes  ws/t1"));
    expect(ui.screen()).toContain("#1  brief *  me");
    expect(ui.screen()).toContain("second brief line");
    await ui.press(ESC);
    await ui.until((s) => s.includes("filter: first"));
    expect(ui.screen()).toContain("first task");
    expect(ui.screen()).not.toContain("second ");
    ui.unmount();
  });

  it("a long notes tail is whole and scrolls to the end; A shows what the default cut", async () => {
    seed();
    note("t1", "BRIEF", "brief");
    note("t1", "REPORT", "report");
    for (let i = 1; i <= 6; i++) note("t1", `ordinary ${i}`);
    note("t1", `${"word ".repeat(60)}ENDMARK`);
    const ui = await open({ columns: 40, rows: 12 });
    await ui.until((s) => s.includes("first task"));
    await ui.press(ENTER);
    await ui.until((s) => s.includes("Notes  ws/t1"));
    expect(ui.screen()).toContain("notes not shown: A shows them");
    await ui.press("A");
    await ui.until((s) => !s.includes("not shown"));
    await ui.press("G");
    await ui.until((s) => s.includes("ENDMARK"));
    for (const line of ui.screen().split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(40);
    await ui.press("g");
    await ui.until((s) => s.includes("BRIEF"));
    ui.unmount();
  });

  it("scroll clamps at both ends and survives a resize", async () => {
    seed();
    note("t1", Array.from({ length: 40 }, (_, i) => `row-${i}`).join("\n"));
    const ui = await open({ columns: 60, rows: 10 });
    await ui.until((s) => s.includes("first task"));
    await ui.press(ENTER);
    await ui.until((s) => s.includes("row-0"));
    for (let i = 0; i < 5; i++) await ui.press("k"); // above the top: stays
    expect(ui.screen()).toContain("row-0");
    await ui.press("G");
    await ui.until((s) => s.includes("row-39"));
    await ui.press("j"); // past the end: stays
    expect(ui.screen()).toContain("row-39");
    ui.resize(30, 24);
    await ui.until((s) => s.includes("row-39") && s.split("\n").length >= 20);
    ui.resize(30, 4);
    await ui.until((s) => s.includes("row-39"));
    ui.unmount();
  });

  it("Agents Enter reads the scrollback through the mux; r reloads; Esc goes back", async () => {
    seed();
    agent();
    mux = tmuxMux();
    const ui = await open();
    await tab(ui, 2); // → → Agents
    await ui.until((s) => s.includes("w1"));
    await ui.press(ENTER);
    await ui.until((s) => s.includes("Scrollback  ws/w1") && s.includes("line two"));
    expect(mux.calls.some((c) => c[0] === "capture-pane" && c.includes("%1"))).toBe(true);
    captured = "fresh output\n";
    await ui.press("r");
    await ui.until((s) => s.includes("fresh output") && !s.includes("line two"));
    await ui.press(ESC);
    await ui.until((s) => s.includes("Agents"));
    ui.unmount();
  });

  it("a capture that lands after Esc is dropped (no stale body in the next drill)", async () => {
    seed();
    agent();
    let release: (() => void) | undefined;
    mux = installMux("tmux", async (args) => {
      if (!pane(args.join(" "))) return { stdout: "", stderr: "", exitCode: 0 };
      await new Promise<void>((r) => {
        release = r;
      });
      return { stdout: "LATE BODY", stderr: "", exitCode: 0 };
    });
    const ui = await open();
    await tab(ui, 2);
    await ui.until((s) => s.includes("w1"));
    await ui.press(ENTER);
    await ui.until((s) => s.includes("loading…"));
    await ui.press(ESC);
    await ui.until((s) => s.includes("Agents") && !s.includes("Scrollback"));
    release?.();
    await ui.press("x");
    expect(ui.screen()).not.toContain("LATE BODY");
    ui.unmount();
  });

  it("Log Enter shows every field of the op", async () => {
    seed();
    const ui = await open();
    await tab(ui, 3); // Log
    await ui.until((s) => s.includes("task"));
    await ui.press(ENTER);
    await ui.until((s) => s.includes("Log  #"));
    expect(ui.screen()).toMatch(/intent: /);
    expect(ui.screen()).toMatch(/payload:\s/);
    await ui.press(ESC);
    await ui.until((s) => !s.includes("Log  #"));
    ui.unmount();
  });

  it("no drill key writes: the op log is unchanged and the mux sees only capture-pane", async () => {
    seed();
    note("t2", "n");
    agent();
    mux = tmuxMux();
    const before = opsCount();
    const ui = await open();
    await ui.until((s) => s.includes("first task"));
    await ui.press(ENTER);
    for (const k of ["j", "k", "A", "r", "y", "g", "G"]) await ui.press(k);
    await ui.press(ESC);
    await ui.until((s) => s.includes("Tasks  DAG"));
    await tab(ui, 2);
    await ui.until((s) => s.includes("w1"));
    await ui.press(ENTER);
    await ui.until((s) => s.includes("line two"));
    for (const k of ["y", "r", "G"]) await ui.press(k);
    await ui.press(ESC);
    expect(opsCount()).toBe(before);
    for (const c of mux.calls) expect(["capture-pane", "list-panes"]).toContain(c[0] ?? "");
    ui.unmount();
  });

  it("y copies the exact command (OSC 52) and prints it too", async () => {
    seed();
    const ui = await open();
    await ui.until((s) => s.includes("first task"));
    await ui.press("y");
    const sent = Buffer.from("mu task show t2 -w ws").toString("base64");
    await ui.until((s) => s.includes("copied: mu task show t2 -w ws"));
    expect(ui.writes().some((w) => w.includes(`${ESC}]52;c;${sent}`))).toBe(true);
    ui.unmount();
  });

  it("notesText marks pinned notes and keeps content whole", () => {
    const text = notesText({
      notes: [{ n: 2, kind: "report", author: null, content: "x\ny", createdAt: "T" }],
      more: 0,
      total: 2,
      pinned: [2],
    } as never);
    expect(text).toBe("#2  report *  -  T\nx\ny\n");
  });
});

describe("attach", () => {
  let tmp: string;
  let db: Db;
  let rt: DashboardRuntime;
  let mux: MuxHarness | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-dash-attach-"));
    db = openDb({ path: join(tmp, "a.db") });
    delete process.env.MU_SYNC_DIR;
    ensureWorkstream(db, "ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1", tab: "w1tab" });
  });
  afterEach(async () => {
    await rt?.close();
    mux?.restore();
    mux = undefined;
    db.close();
    rmFixtureDir(tmp);
  });
  const calm = async (args: readonly string[]) => ({
    stdout: args[0] === "capture-pane" ? "pane text" : "",
    stderr: "",
    exitCode: 0,
  });
  const open = (runStep: StepRunner) => {
    rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: db, caller: null });
    return renderApp(
      createElement(App, {
        runtime: rt,
        pollMs: null,
        initialWorkstream: "ws",
        now: () => 0,
        runStep,
      }),
      { columns: 100, rows: 20 },
    );
  };
  const toAgents = async (ui: Awaited<ReturnType<typeof open>>) => {
    await tab(ui, 2);
    await ui.until((s) => s.includes("w1"));
  };

  it("Enter never attaches: no step runs until `a`", async () => {
    mux = installMux("tmux", calm);
    const ran: MuxCommand[] = [];
    const ui = await open(async (s) => {
      ran.push(s);
      return { code: 0, stderr: "" };
    });
    await toAgents(ui);
    await ui.press(ENTER);
    await ui.until((s) => s.includes("pane text"));
    expect(ran).toEqual([]);
    ui.unmount();
  });

  it("outside tmux ($TMUX unset): attach-session on the private socket, terminal suspended then restored", async () => {
    await withEnv("TMUX", undefined, () =>
      withEnv("MU_TMUX_SOCKET", "mu-private", async () => {
        mux = installMux("tmux", calm);
        const ran: MuxCommand[] = [];
        let during: boolean | null = null;
        let leftScreen: boolean | null = null;
        let before = 0;
        const holder: { ui?: Awaited<ReturnType<typeof open>> } = {};
        const ui = await open(async (s) => {
          ran.push(s);
          during = holder.ui?.rawMode() ?? null; // false while the step owns the terminal
          // Ink must have left the alternate screen BEFORE the step runs (raw mode alone also
          // drops when the hooks go inactive, so it cannot prove the handoff).
          leftScreen =
            holder.ui
              ?.writes()
              .slice(before)
              .some((w) => w.includes(`${ESC}[?1049l`)) ?? null;
          return { code: 0, stderr: "" };
        });
        holder.ui = ui;
        await toAgents(ui);
        before = ui.writes().length;
        await ui.press("a");
        await ui.until(() => ran.length === 1);
        expect(ran).toEqual([
          { command: "tmux", args: ["-L", "mu-private", "attach-session", "-t", "mu-ws:w1tab"] },
        ]);
        expect(during).toBe(false);
        expect(leftScreen).toBe(true);
        // ...and takes it back afterwards.
        await ui.until(() =>
          ui
            .writes()
            .slice(before)
            .some((w) => w.includes(`${ESC}[?1049h`)),
        );
        await ui.until(() => ui.rawMode() === true); // Ink owns the keyboard again
        await ui
          .until((s) => s.includes("Agents") && !s.includes("could not attach"))
          .catch((e) => {
            console.log(
              "SCR",
              JSON.stringify(
                ui
                  .writes()
                  .slice(-8)
                  .map((w) => w.slice(0, 30)),
              ),
              ui.rawMode(),
            );
            throw e;
          });
        await ui.press("j"); // and keys work again
        ui.unmount();
      }),
    );
  });

  it("inside tmux ($TMUX set): switch-client, with the same socket routing", async () => {
    await withEnv("TMUX", "/tmp/tmux-1/mu-private,1,0", () =>
      withEnv("MU_TMUX_SOCKET", "mu-private", async () => {
        mux = installMux("tmux", calm);
        const ran: MuxCommand[] = [];
        const ui = await open(async (s) => {
          ran.push(s);
          return { code: 0, stderr: "" };
        });
        await toAgents(ui);
        await ui.press("a");
        await ui.until(() => ran.length === 1);
        expect(ran[0]?.args).toEqual(["-L", "mu-private", "switch-client", "-t", "mu-ws:w1tab"]);
        ui.unmount();
      }),
    );
  });

  it("a failed required step falls back to scrollback with the reason and the outside-client line", async () => {
    await withEnv("TMUX", undefined, () =>
      withEnv("MU_TMUX_SOCKET", "mu-private", async () => {
        mux = installMux("tmux", calm);
        const ui = await open(async () => ({ code: 1, stderr: "no server running" }));
        await toAgents(ui);
        await ui.press("a");
        await ui.until((s) => s.includes("could not attach") && s.includes("pane text"));
        const s = ui.screen();
        expect(flat(ui)).toContain("(exit 1: no server running)");
        expect(s).toContain("Scrollback  ws/w1");
        expect(s).toContain("pane text");
        expect(flat(ui)).toContain(
          "from a shell outside the mux: tmux -L mu-private attach-session -t mu-ws:w1tab",
        );
        // The terminal is Ink's again and the drill reads keys.
        expect(ui.rawMode()).toBe(true);
        await ui.press(ESC);
        await ui.until((s2) => s2.includes("Agents") && !s2.includes("could not attach"));
        ui.unmount();
      }),
    );
  });

  it("y on a failed-attach scrollback copies the outside-client line", async () => {
    await withEnv("TMUX", undefined, () =>
      withEnv("MU_TMUX_SOCKET", "mu-private", async () => {
        mux = installMux("tmux", calm);
        const ui = await open(async () => ({ code: 1, stderr: "x" }));
        await toAgents(ui);
        await ui.press("a");
        await ui.until((s) => s.includes("could not attach"));
        await ui.press("y");
        await ui.until((s) => s.includes("copied: tmux"));
        const line = "tmux -L mu-private attach-session -t mu-ws:w1tab";
        const sent = Buffer.from(line).toString("base64");
        expect(ui.writes().some((w) => w.includes(`${ESC}]52;c;${sent}`))).toBe(true);
        ui.unmount();
      }),
    );
  });

  // A real agent's output is long: the scrollback opens at its END, so a notice that is
  // part of the scrolled body is out of sight. These tests use 70 lines.
  const longPane = async (args: readonly string[]) => ({
    stdout:
      args[0] === "capture-pane"
        ? Array.from({ length: 70 }, (_, i) => `output line ${i + 1}`).join("\n")
        : "",
    stderr: "",
    exitCode: 0,
  });

  it("long scrollback: the attach failure and outside line are on screen without scrolling", async () => {
    await withEnv("TMUX", undefined, () =>
      withEnv("MU_TMUX_SOCKET", "mu-private", async () => {
        mux = installMux("tmux", longPane);
        const ui = await open(async () => ({ code: 1, stderr: "no server running" }));
        await toAgents(ui);
        await ui.press("a");
        await ui.until((s) => s.includes("output line 70"));
        const f = flat(ui);
        expect(f).toContain("could not attach");
        expect(f).toContain("(exit 1: no server running)");
        expect(f).toContain("tmux -L mu-private attach-session -t mu-ws:w1tab");
        expect(f).toContain("output line 70");
        // Scrolling the body never moves the notice.
        await ui.press("");
        await ui.press("g");
        expect(flat(ui)).toContain("could not attach");
        expect(flat(ui)).toContain("output line 1 ");
        ui.unmount();
      }),
    );
  });

  it("long scrollback: the yank confirmation (the command) is visible at once", async () => {
    await withEnv("TMUX", undefined, () =>
      withEnv("MU_TMUX_SOCKET", "mu-private", async () => {
        mux = installMux("tmux", longPane);
        const ui = await open(async () => ({ code: 0, stderr: "" }));
        await toAgents(ui);
        await ui.press(ENTER);
        await ui.until((s) => s.includes("output line 70"));
        await ui.press("");
        await ui.press("y");
        await ui.until((s) => s.includes("copied:"));
        expect(flat(ui)).toContain("copied: tmux -L mu-private attach-session -t mu-ws:w1tab");
        expect(flat(ui)).toContain("output line 70");
        ui.unmount();
      }),
    );
  });

  it("a short terminal keeps body rows: the pinned head is capped", async () => {
    await withEnv("TMUX", undefined, async () => {
      mux = installMux("tmux", longPane);
      const ui = await open(async () => ({ code: 1, stderr: "gone" }));
      ui.resize(30, 8);
      await toAgents(ui);
      await ui.press("a");
      await ui.until((s) => s.includes("could not attach") && s.includes("output line 70"));
      ui.unmount();
    });
  });

  it("inside herdr the copied line opens a client from outside, TMUX set or not", async () => {
    for (const tmuxEnv of [undefined, "/tmp/tmux-1/x,1,0"]) {
      await withEnv("TMUX", tmuxEnv, () =>
        withEnv("HERDR_ENV", "1", () =>
          withEnv("MU_HERDR_SESSION", "priv", async () => {
            mux = installMux("herdr", [
              ["workspace list", WORKSPACE_LIST.replace("mu-topotest", "mu-ws")],
              ["tab list --workspace w1", TAB_LIST],
            ]);
            const plan = await planAttach({ workstream: "ws", name: "w1", tab: "mytab" });
            if (!plan.ok) throw new Error(plan.reason);
            // Executed here (inside a client): focus only. Copied: focus, then a client.
            expect(plan.steps).toHaveLength(1);
            expect(plan.line).toBe("herdr --session priv tab focus w1:t2 && herdr --session priv");
            mux.restore();
            mux = undefined;
          }),
        ),
      );
    }
  });

  it("no multiplexer at all: scrollback opens with the reason, nothing runs", async () => {
    await withEnv("TMUX", undefined, () =>
      withEnv("TMUX_PANE", undefined, () =>
        withEnv("HERDR_ENV", undefined, () =>
          withEnv("MU_MUX", undefined, async () => {
            const none = installNoMux();
            try {
              const ran: MuxCommand[] = [];
              const ui = await open(async (s) => {
                ran.push(s);
                return { code: 0, stderr: "" };
              });
              await toAgents(ui);
              await ui.press("a");
              await ui.until((s) => s.includes("could not attach"));
              expect(ui.screen()).toContain("Scrollback  ws/w1");
              expect(ran).toEqual([]);
              expect(ui.screen()).not.toContain("from a shell outside"); // no line to offer
              ui.unmount();
            } finally {
              none.restore();
            }
          }),
        ),
      ),
    );
  });

  it("herdr: both steps run in order, outside a client", async () => {
    await withEnv("HERDR_ENV", undefined, async () => {
      mux = installMux("herdr", [
        ["workspace list", WORKSPACE_LIST.replace("mu-topotest", "mu-ws")],
        ["tab list --workspace w1", TAB_LIST],
      ]);
      const ran: MuxCommand[] = [];
      const ui = await open(async (s) => {
        ran.push(s);
        return { code: 0, stderr: "" };
      });
      await toAgents(ui);
      await ui.press("a");
      await ui.until(() => ran.length === 2);
      expect(ran.map((s) => s.args)).toEqual([["workspace", "focus", "w1"], []]);
      ui.unmount();
    });
  });

  it("herdr with no workspace for the session: a reason and no line", async () => {
    const empty = JSON.stringify({ id: "x", result: { type: "workspace_list", workspaces: [] } });
    mux = installMux("herdr", [["workspace list", empty]]);
    const plan = await planAttach({ workstream: "gone", name: "w1", tab: null });
    expect(plan.ok).toBe(false);
    expect(plan.line).toBeNull();
  });

  it("keys pressed during an attach are not replayed into the next screen", async () => {
    await withEnv("TMUX", undefined, async () => {
      mux = installMux("tmux", calm);
      let finish: (() => void) | undefined;
      const ui = await open(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ code: 1, stderr: "gone" });
          }),
      );
      await toAgents(ui);
      await ui.press("a");
      await ui.until(() => finish !== undefined);
      await ui.press("q"); // would quit the app if App still read keys
      finish?.();
      await ui.until((s) => s.includes("could not attach"));
      await ui.press(""); // let the new screen's input hook register (an effect, after the paint)
      await ui.press(ESC);
      await ui.until((s) => s.includes("Agents") && !s.includes("could not attach"));
      ui.unmount();
    });
  });
});
