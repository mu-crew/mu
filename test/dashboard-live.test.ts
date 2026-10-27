// The dashboard is live (tui_live_updates, 3.x's poll loop): one fast SQL tick and a
// slow agent tick, a flicker guard, drills that re-read on the loop's nonces. A real
// DB written through a second connection; agent probes counted through a mock.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateReading } from "../src/agent-state.js";
import { rmFixtureDir } from "./_fs.js";
import { renderApp } from "./_ink-render.js";
import { installMux, type MuxHarness } from "./_mux.js";

// Agent probes: counted, their state set by the test.
const probe = vi.hoisted(() => ({ calls: 0, state: "busy" as string }));
vi.mock("../src/agent-state.js", async (orig) => {
  const real = await orig<typeof import("../src/agent-state.js")>();
  return {
    ...real,
    readAgentStates: async (agents: readonly { name: string; workstreamName: string }[]) => {
      probe.calls++;
      return new Map<string, StateReading>(
        agents.map((a) => [
          real.agentKey(a),
          { state: probe.state as StateReading["state"], source: "ctl", since: null, alive: true },
        ]),
      );
    },
  };
});

const { insertAgent } = await import("../src/agents.js");
const { App } = await import("../src/cli/tui/app.js");
const { createRuntime } = await import("../src/cli/tui/runtime.js");
const { clampTick, fasterTick, slowerTick, snapshotKey } = await import(
  "../src/cli/tui/use-snapshot.js"
);
const { openDb } = await import("../src/db.js");
const { addNote, addTask } = await import("../src/tasks/edit.js");
const { closeTask } = await import("../src/tasks/lifecycle.js");
const { ensureWorkstream } = await import("../src/workstream.js");

type Db = ReturnType<typeof openDb>;
type Runtime = ReturnType<typeof createRuntime>;
const ENTER = "\r";

let tmp: string;
let db: Db;
let rt: Runtime | undefined;
let mux: MuxHarness | undefined;
let captured = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-dash-live-"));
  db = openDb({ path: join(tmp, "a.db") });
  delete process.env.MU_SYNC_DIR;
  probe.calls = 0;
  probe.state = "busy";
  captured = "line one\n";
  ensureWorkstream(db, "ws");
});
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  mux?.restore();
  mux = undefined;
  db.close();
  rmFixtureDir(tmp);
});

const add = (id: string, title = `title ${id}`): void => {
  addTask(db, { workstream: "ws", localId: id, title, impact: 50, effortDays: 1 });
};
const open = (opts: { tab?: "tasks" | "agents" | "overview"; slowMs?: number } = {}) => {
  rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: db, caller: null });
  return renderApp(
    createElement(App, {
      runtime: rt,
      initialTab: opts.tab ?? "tasks",
      pollMs: 20,
      slowMs: opts.slowMs ?? 60_000,
      initialWorkstream: "ws",
      now: () => 0,
    }),
    { columns: 100, rows: 24 },
  );
};
const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 25));
};

describe("tick control and the key", () => {
  it("+/- halve and double the fast tick inside 100 ms .. 10 s", () => {
    expect(fasterTick(1000)).toBe(500);
    expect(fasterTick(150)).toBe(100);
    expect(slowerTick(1000)).toBe(2000);
    expect(slowerTick(8000)).toBe(10_000);
    expect(clampTick(5)).toBe(100);
  });

  it("the key ignores a running tool's sub-second elapsed time (the unit shown is seconds)", () => {
    const snap = (ms: number) =>
      ({ agents: [{ tool: { name: "bash", since: 0, elapsed_ms: ms } }] }) as never;
    expect(snapshotKey(snap(1200), [])).toBe(snapshotKey(snap(1900), []));
    expect(snapshotKey(snap(1900), [])).not.toBe(snapshotKey(snap(2100), []));
  });
});

describe("lists are live", () => {
  it("a task added and closed by another connection shows without a key; the cursor goes to its neighbour", async () => {
    add("t1");
    add("t2");
    add("t3");
    const ui = await open();
    await ui.until((s) => s.includes("t1") && s.includes("t3"));
    add("t4", "added from outside");
    await ui.until((s) => s.includes("added from outside"));
    // The cursor was on t3 (the top row then); t4 sorts above it and the cursor stays on t3's KEY.
    expect(ui.screen()).toMatch(/> t3/);
    closeTask(db, "t3", { workstream: "ws", evidence: "test" });
    await ui.until((s) => !s.includes("t3") && /> t2/.test(s)); // the neighbour, not the top
    ui.unmount();
  });

  it("a tick with nothing changed renders nothing (flicker guard A)", async () => {
    add("t1");
    const ui = await open();
    await ui.until((s) => s.includes("t1"));
    await ticks(3);
    const before = ui.writes().length;
    await ticks(8);
    expect(ui.writes().length).toBe(before);
    add("t2");
    await ui.until((s) => s.includes("t2"));
    expect(ui.writes().length).toBeGreaterThan(before);
    ui.unmount();
  });
});

describe("agent state rides the slow tier", () => {
  it("fast ticks never probe a known agent; the slow tick and r do", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    const ui = await open({ tab: "agents" });
    await ui.until((s) => s.includes("w1") && s.includes("busy"));
    const first = probe.calls;
    await ticks(6);
    expect(probe.calls).toBe(first); // SQL only
    probe.state = "needs_permission";
    await ui.press("r");
    await ui.until((s) => s.includes("needs_permission"));
    expect(probe.calls).toBe(first + 1);
    ui.unmount();
  });

  it("the slow tick re-probes on its own", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    const ui = await open({ tab: "agents", slowMs: 80 });
    await ui.until((s) => s.includes("busy"));
    probe.state = "needs_permission";
    await ui.until((s) => s.includes("needs_permission"));
    ui.unmount();
  });
});

describe("drills are live", () => {
  it("notes: a new note and a status change show without a key", async () => {
    add("t1", "the task");
    addNote(db, "t1", "first note", { workstream: "ws", author: "me" });
    const ui = await open();
    await ui.until((s) => s.includes("the task"));
    await ui.press(ENTER);
    await ui.until((s) => s.includes("first note") && s.includes("OPEN  unowned  the task"));
    addNote(db, "t1", "second note from outside", { workstream: "ws", author: "me" });
    await ui.until((s) => s.includes("second note from outside"));
    closeTask(db, "t1", { workstream: "ws", evidence: "test" });
    await ui.until((s) => s.includes("CLOSED  unowned  the task"));
    expect(ui.writes().some((w) => w.includes("loading…") && w.includes("second note"))).toBe(
      false,
    );
    ui.unmount();
  });

  it("notes: a scrolled view keeps its place across a refresh; at the end it follows", async () => {
    add("t1", "the task");
    for (let i = 1; i <= 30; i++) addNote(db, "t1", `note body ${i}`, { workstream: "ws" });
    const ui = await open();
    await ui.until((s) => s.includes("the task"));
    await ui.press("A"); // no-op on the list; harmless
    await ui.press(ENTER);
    await ui.press("A"); // every note, oldest first
    await ui.until((s) => s.includes("note body 1\n") || s.includes("note body 1 "));
    await ui.press("j");
    await ui.press("j");
    const at = ui.screen().split("\n")[3];
    addNote(db, "t1", "note body 31", { workstream: "ws" });
    await ticks(6);
    expect(ui.screen().split("\n")[3]).toBe(at); // same place
    await ui.press("G");
    await ui.until((s) => s.includes("note body 31"));
    addNote(db, "t1", "note body 32", { workstream: "ws" });
    await ui.until((s) => s.includes("note body 32")); // followed, no key
    ui.unmount();
  });

  it("scrollback re-captures on the slow tick and keeps the old body while it does", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    mux = installMux("tmux", async (args) => ({
      stdout: args[0] === "capture-pane" ? captured : "",
      stderr: "",
      exitCode: 0,
    }));
    const ui = await open({ tab: "agents", slowMs: 80 });
    await ui.until((s) => s.includes("w1"));
    await ui.press(ENTER);
    await ui.until((s) => s.includes("line one"));
    const from = ui.writes().length;
    captured = "line one\nline two streamed\n";
    await ui.until((s) => s.includes("line two streamed"));
    expect(
      ui
        .writes()
        .slice(from)
        .some((w) => w.includes("loading…")),
    ).toBe(false);
    ui.unmount();
  });
});

describe("runtime tiers", () => {
  it("a fast refresh reads agent state from the slow tier's cache", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: db, caller: null });
    await rt.refresh({}, { slow: true });
    expect(probe.calls).toBe(1);
    probe.state = "needs_permission";
    const fast = await rt.refresh({});
    expect(probe.calls).toBe(1);
    expect(fast.snapshot.agents[0]?.state).toBe("busy");
    insertAgent(db, { name: "w2", workstream: "ws", paneId: "%2" });
    await rt.refresh({}); // a new agent is probed once, alone
    expect(probe.calls).toBe(2);
    const slow = await rt.refresh({}, { slow: true });
    expect(slow.snapshot.agents.map((a) => a.state)).toEqual([
      "needs_permission",
      "needs_permission",
    ]);
  });
});
