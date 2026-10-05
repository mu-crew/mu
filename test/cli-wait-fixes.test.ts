// Regressions for `mu task wait` / `mu agent wait` edge cases:
//   - --timeout / --stuck-after take fractional seconds and reject
//     suffixes (parseInt read "0.5" as 0 = wait forever, "10m" as 10).
//   - a task deleted mid-wait never counts as reaching --status OPEN.
//   - exit 6 fires only when the reaper removed the owner's agent row,
//     not on a manual release or delete of the watched task.
//   - agent wait reports a dead pane (and exits 6) even when another
//     watched agent finished, and --any does not claim "All N finished".
//   - task notes --since compares instants, not raw strings.
//
// Fast tier: runCli in-process, temp DB, mocked tmux, wait sleeps
// stubbed to <= 10 ms and used as the "between polls" mutation point.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import { deleteAgent, insertAgent, setAgentWaitSleepForTests } from "../src/agents.js";
import { parseSeconds } from "../src/cli.js";
import { type Db, openDb } from "../src/db.js";
import {
  addNote,
  addTask,
  claimTask,
  deleteTask,
  listNotes,
  releaseTask,
  setWaitSleepForTests,
  waitForTasks,
} from "../src/tasks.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

const WS = "wf";
let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
/** Panes the mocked tmux reports, id → murmur state token. */
let panes: Map<string, string>;

const shortSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 10)));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-fixes-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  panes = new Map();
  setMurmurRunnerForTests(async () => null);
  resetAgentStateCacheForTests();
  mux = installMux("tmux", async (args) => {
    if (args[0] === "list-panes" && args.includes("-s")) {
      const out = [...panes.keys()].map((id) => `@1\t${id}\tt\tsh\n`).join("");
      return { stdout: out, stderr: "", exitCode: 0 };
    }
    if (args[0] === "list-panes") {
      const out = [...panes].map(([id, token]) => `${id}\t${token}\t1000\n`).join("");
      return { stdout: out, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
});

afterEach(() => {
  setWaitSleepForTests(undefined);
  setAgentWaitSleepForTests(undefined);
  setMurmurRunnerForTests(null);
  resetAgentStateCacheForTests();
  mux.restore();
  process.exitCode = undefined;
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function addT(id: string): void {
  addTask(db, { localId: id, workstream: WS, title: id, impact: 50, effortDays: 1 });
}

/** Run `mutate` once, at the first sleep between polls. */
function onFirstSleep(set: typeof setWaitSleepForTests, mutate: () => void): void {
  let done = false;
  set(async (ms) => {
    if (!done) {
      done = true;
      mutate();
    }
    await shortSleep(ms);
  });
}

describe("parseSeconds", () => {
  it("accepts fractions and rejects suffixes", () => {
    expect(parseSeconds("0.5")).toBe(0.5);
    expect(parseSeconds("0")).toBe(0);
    expect(parseSeconds("600")).toBe(600);
    for (const bad of ["10m", "1s", "", " ", "-1", "abc", "Infinity"]) {
      expect(() => parseSeconds(bad)).toThrow();
    }
  });
});

describe("mu task wait --timeout", () => {
  it("a fractional timeout times out instead of waiting forever", async () => {
    addT("t1");
    setWaitSleepForTests(shortSleep);
    const res = await runCli(["task", "wait", "t1", "-w", WS, "--timeout", "0.05"], dbPath);
    expect(res.error).toBeUndefined();
    expect(res.exitCode).toBe(5);
  });

  it("a suffixed timeout is a usage error, not N seconds", async () => {
    addT("t1");
    const res = await runCli(["task", "wait", "t1", "-w", WS, "--timeout", "10m"], dbPath);
    expect(res.exitCode).toBe(2);
    const stuck = await runCli(["task", "wait", "t1", "-w", WS, "--stuck-after", "1s"], dbPath);
    expect(stuck.exitCode).toBe(2);
  });

  it("--help does not advertise a nonexistent --all flag", async () => {
    const res = await runCli(["task", "wait", "--help"], dbPath);
    expect(res.stdout).not.toContain("(--all)");
  });
});

describe("waitForTasks: a task deleted mid-wait", () => {
  it("does not count as reaching --status OPEN", async () => {
    addT("a");
    insertAgent(db, { name: "w1", workstream: WS, paneId: "%1", cli: "sh" });
    await claimTask(db, "a", { workstream: WS, agentName: "w1" });
    onFirstSleep(setWaitSleepForTests, () => deleteTask(db, "a", WS));
    const r = await waitForTasks(db, [{ workstreamName: WS, name: "a" }], {
      status: "OPEN",
      timeoutMs: 60,
      pollMs: 10,
    });
    expect(r.timedOut).toBe(true);
    expect(r.refs[0]?.reachedTarget).toBe(false);
  });
});

describe("mu task wait exit 6 (reaper)", () => {
  beforeEach(async () => {
    addT("t1");
    panes.set("%1", "working");
    insertAgent(db, { name: "w1", workstream: WS, paneId: "%1", cli: "sh" });
    await claimTask(db, "t1", { workstream: WS, agentName: "w1" });
  });

  const wait = () =>
    runCli(["task", "wait", "t1", "-w", WS, "--timeout", "0.2", "--stuck-after", "0"], dbPath);

  it("fires when the owner's pane dies and the reaper reopens the task", async () => {
    onFirstSleep(setWaitSleepForTests, () => panes.delete("%1"));
    const res = await wait();
    expect(res.exitCode).toBe(6);
    expect(res.stderr).toMatch(/reaper/i);
  });

  it("does not fire on a manual release (owner still registered)", async () => {
    onFirstSleep(setWaitSleepForTests, () => releaseTask(db, "t1", { workstream: WS }));
    const res = await wait();
    expect(res.exitCode).toBe(5);
    expect(res.stderr).not.toMatch(/reaper/i);
  });

  it("does not fire when the watched task is deleted", async () => {
    onFirstSleep(setWaitSleepForTests, () => deleteTask(db, "t1", WS));
    const res = await wait();
    expect(res.exitCode).toBe(5);
    expect(res.stderr).not.toMatch(/reaper/i);
  });

  it("still fires when the owner row is removed directly (agent close)", async () => {
    onFirstSleep(setWaitSleepForTests, () => deleteAgent(db, "w1", WS));
    const res = await wait();
    expect(res.exitCode).toBe(6);
  });
});

describe("mu agent wait summary and exit code", () => {
  beforeEach(() => {
    panes.set("%1", "working");
    panes.set("%2", "working");
    insertAgent(db, { name: "a1", workstream: WS, paneId: "%1", cli: "sh" });
    insertAgent(db, { name: "a2", workstream: WS, paneId: "%2", cli: "sh" });
  });

  it("a pane that died beside a finished agent is reported and exits 6", async () => {
    onFirstSleep(setAgentWaitSleepForTests, () => {
      panes.set("%1", "idle");
      panes.delete("%2");
    });
    const res = await runCli(["agent", "wait", "a1", "a2", "-w", WS, "--timeout", "5"], dbPath);
    expect(res.error).toBeUndefined();
    expect(res.stdout).toContain(`died: ${WS}/a2`);
    expect(res.stdout).not.toContain("All 2 agent(s) finished");
    expect(process.exitCode).toBe(6);
  });

  it("--any names the agent that finished instead of 'All N finished'", async () => {
    onFirstSleep(setAgentWaitSleepForTests, () => panes.set("%1", "idle"));
    const res = await runCli(
      ["agent", "wait", "a1", "a2", "-w", WS, "--any", "--timeout", "5"],
      dbPath,
    );
    expect(res.error).toBeUndefined();
    expect(res.stdout).toContain(`${WS}/a1 finished (1/2)`);
    expect(res.stdout).not.toContain("All 2");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a fractional --timeout times out", async () => {
    setAgentWaitSleepForTests(shortSleep);
    const res = await runCli(["agent", "wait", "a1", "-w", WS, "--timeout", "0.05"], dbPath);
    expect(res.error).toBeUndefined();
    expect(process.exitCode).toBe(5);
  });
});

describe("listNotes since", () => {
  it("compares the cutoff as an instant (no millis, offsets)", () => {
    addT("n1");
    addNote(db, "n1", "hello", { workstream: WS, author: "me" });
    db.prepare("UPDATE task_notes SET created_at = ?").run("2026-10-05T10:07:00.411Z");
    const since = (s: string) => listNotes(db, "n1", WS, { since: s }).length;
    // Same second without millis: lexically 'Z' > '.', so this hid the note.
    expect(since("2026-10-05T10:07:00Z")).toBe(1);
    // 10:06Z written with an offset: lexically later than the note.
    expect(since("2026-10-05T12:06:00+02:00")).toBe(1);
    // Cutoffs after the note still hide it.
    expect(since("2026-10-05T10:07:01Z")).toBe(0);
    expect(since("2026-10-05T12:08:00+02:00")).toBe(0);
  });
});
