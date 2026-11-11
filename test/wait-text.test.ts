// `mu wait --text` (fast tier): the plain-lines result. Line 1 is the event and the resume; every
// other fact (exit and reason, each ref's state, a task's or delegate's report, warnings,
// notices, owed news) sits above `---`; below it only an agent's last words. The CLI cases run
// in-process on real SQLite; the agent cases (no ctl here) feed waitText a WaitResult.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WaitDataInput } from "../src/cli/wait-output.js";
import { waitText } from "../src/cli/wait-text.js";
import { type Db, openDb } from "../src/db.js";
import { finishDelegate, markDelegate, registerDelegateCall } from "../src/delegates.js";
import { COURSE_CHECK_CLOSED } from "../src/next-hints.js";
import { addTask, closeTask } from "../src/tasks.js";
import type { WaitResult, WaitSnapshot } from "../src/wait.js";
import { setWaitSleepForTests } from "../src/wait.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { type Capture, runCli } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-text-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  for (const id of ["a", "b"]) {
    addTask(db, { localId: id, workstream: "w", title: id, impact: 50, effortDays: 1 });
  }
  setWaitSleepForTests((ms) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))));
});
afterEach(() => {
  setWaitSleepForTests(undefined);
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function wait(argv: string[]): Promise<Capture> {
  let out: Capture | undefined;
  await withEnv("PI_SESSION_ID", undefined, () =>
    withEnv("MU_MANAGED_AGENT", undefined, async () => {
      out = await runCli(["wait", ...argv], dbPath);
    }),
  );
  if (out === undefined) throw new Error("no capture");
  return out;
}
/** The lines above and below the first `---` line. */
const split = (out: string): { head: string[]; body: string[] } => {
  const lines = out.trimEnd().split("\n");
  const at = lines.indexOf("---");
  expect(at).toBeGreaterThan(0);
  return { head: lines.slice(0, at), body: lines.slice(at + 1) };
};

describe("mu wait --text: task and delegate refs", () => {
  it("a closed task prints its state and its report above ---, not 'no final text'", async () => {
    closeTask(db, "a", {
      workstream: "w",
      evidence: "e",
      report: "REPORT a: done\n---\nsecond part",
    });
    const r = await wait(["task:w/a", "--text"]);
    expect(r.exitCode).toBeNull();
    const { head, body } = split(r.stdout);
    expect(head[0]).toBe("event: closed on task:w/a | resume: no resume");
    expect(head).toContain("task:w/a: CLOSED/done");
    expect(head).toContain("report of task:w/a:");
    // Indented, so the report's own `---` never reads as the separator.
    expect(head).toEqual(expect.arrayContaining(["  REPORT a: done", "  ---", "  second part"]));
    expect(body).toEqual(["no final text: task:w/a is a task ref; its report is above"]);
  });

  it("a task closed with --evidence only (the worker flow) prints its close evidence above ---", async () => {
    closeTask(db, "a", { workstream: "w", evidence: "tests pass: npm test exit 0" });
    const { head, body } = split((await wait(["task:w/a", "--text"])).stdout);
    expect(head).toContain("close evidence of task:w/a:");
    expect(head.join("\n")).toContain("tests pass: npm test exit 0");
    expect(head).not.toContain("report of task:w/a: none filed");
    expect(body).toEqual(["no final text: task:w/a is a task ref; its report is above"]);
  });

  it("a report beats the close evidence", async () => {
    closeTask(db, "a", { workstream: "w", evidence: "ev", report: "THE REPORT" });
    const { head } = split((await wait(["task:w/a", "--text"])).stdout);
    expect(head).toContain("report of task:w/a:");
    expect(head).not.toContain("close evidence of task:w/a:");
  });

  it("the latest report wins, as `mu task notes --report` prints it", async () => {
    closeTask(db, "a", { workstream: "w", evidence: "e", report: "old" });
    const notes = await runCli(["task", "note", "a", "-w", "w", "--report", "new"], dbPath);
    expect(notes.exitCode).toBeNull();
    const { head } = split((await wait(["task:w/a", "--text"])).stdout);
    expect(head).toContain("  new");
    expect(head).not.toContain("  old");
  });

  it("a done delegate prints its verdict and its answer (its own task's report)", async () => {
    registerDelegateCall(db, {
      callId: "pi:s:1",
      caller: "pi:s",
      workstream: "w",
      request: { text: "check a" },
      state: "starting",
      record: { workstream: "w", task: "a" },
    });
    markDelegate(db, "pi:s:1", "running", { agent: "d1" });
    finishDelegate(db, "pi:s:1", {
      outcome: "done",
      text: "VERDICT: CONFIRMED\nthe answer",
      author: "d1",
    });
    const { head, body } = split((await wait(["delegate:pi:s:1", "--text"])).stdout);
    expect(head[0]).toBe("event: delegate on delegate:pi:s:1 | resume: no resume");
    expect(head).toContain("delegate:pi:s:1: done, verdict CONFIRMED, owner d1");
    expect(head).toEqual(expect.arrayContaining(["  VERDICT: CONFIRMED", "  the answer"]));
    expect(body[0]).toMatch(/is a delegate ref; its report is above/);
  });

  it("--all prints every delivered ref's report above ---", async () => {
    closeTask(db, "a", { workstream: "w", evidence: "e", report: "RA" });
    closeTask(db, "b", { workstream: "w", evidence: "e", report: "RB" });
    const { head } = split((await wait(["task:w/a", "task:w/b", "--all", "--text"])).stdout);
    expect(head).toEqual(expect.arrayContaining(["  RA", "  RB"]));
  });
});

describe("mu wait --text: the timeout and the resume", () => {
  it("a heartbeat lists the open refs and the warning above ---; its resume keeps --text", async () => {
    const r = await wait(["task:w/a", "--text", "--timeout", "0.05"]);
    expect(r.exitCode).toBeNull();
    const { head, body } = split(r.stdout);
    expect(head[0]).toMatch(/^event: heartbeat on none \| resume: mu wait --resume \w+ --text$/);
    expect(head).toContain("timed out: nothing consumed; run the resume");
    expect(head).toContain("task:w/a: OPEN/todo");
    expect(head).toContain("open: 1");
    expect(head.some((l) => /^warning: --timeout 0\.05 is below/.test(l))).toBe(true);
    expect(body).toEqual(["no final text"]);
    // The printed resume runs as printed, and stays in text mode.
    closeTask(db, "a", { workstream: "w", evidence: "e", report: "late" });
    const resume = /resume: (mu wait .*)$/.exec(head[0] ?? "")?.[1] ?? "";
    const again = await wait(resume.split(" ").slice(2));
    expect(again.exitCode).toBeNull();
    expect(split(again.stdout).head).toEqual(
      expect.arrayContaining(["task:w/a: CLOSED/done", "  late"]),
    );
  });

  it("a course-check notice is a line above ---", async () => {
    for (let i = 0; i < COURSE_CHECK_CLOSED; i++) {
      addTask(db, { localId: `x${i}`, workstream: "w", title: "x" });
      closeTask(db, `x${i}`, { workstream: "w", evidence: "e" });
    }
    const { head } = split(
      (await wait(["task:a", "-w", "w", "--text", "--timeout", "0.05"])).stdout,
    );
    expect(head.some((l) => /^notice: course check due: /.test(l))).toBe(true);
  });

  it("without --text the result is the JSON document", async () => {
    const r = await wait(["task:w/a", "--timeout", "0.05"]);
    expect(JSON.parse(r.stdout).data.firing).toEqual({ kind: "heartbeat", ref: null });
    expect(JSON.parse(r.stdout).data.resume).not.toMatch(/--text/);
  });
});

const snap = (over: Partial<WaitSnapshot> & Pick<WaitSnapshot, "ref">): WaitSnapshot => ({
  status: "idle",
  fired: false,
  dead: false,
  ...over,
});
const agent = (id: string) => ({ kind: "agent" as const, workstream: "w", id });
const result = (over: Partial<WaitResult>): WaitResult =>
  ({
    event: { kind: "heartbeat", ref: null },
    exit: 0,
    timedOut: false,
    interrupted: false,
    refs: [],
    delivered: [],
    cursor: {},
    humanNeeds: [],
    ...over,
  }) as WaitResult;
const input = (r: WaitResult, over: Partial<WaitDataInput> = {}): WaitDataInput => ({
  result: r,
  exit: r.exit,
  resume: null,
  ...over,
});

describe("waitText: agent refs", () => {
  it("a settled agent's last words are below ---, its state above", () => {
    const s = snap({
      ref: agent("w1"),
      status: "needs_input",
      fired: true,
      runs: 2,
      lastText: "DONE\n",
    });
    const out = waitText(
      input(
        result({ event: { kind: "settled", ref: agent("w1") }, refs: [s], delivered: [s.ref] }),
        { resume: "mu wait --resume abc -w w" },
      ),
      new Map(),
    );
    expect(out).toBe(
      [
        "event: settled on agent:w/w1 | resume: mu wait --resume abc -w w --text",
        "exit: 0",
        "agent:w/w1: needs_input, run 2",
        "---",
        "DONE",
      ].join("\n"),
    );
  });

  it("a dead worker: exit 6 and its reason above ---, no words below", () => {
    const s = snap({ ref: agent("w2"), status: null, dead: true });
    const out = waitText(
      input(result({ event: { kind: "dead", ref: agent("w2") }, exit: 6, refs: [s] }), {
        reason: "agent w/w2 is gone",
      }),
      new Map(),
    );
    const { head, body } = split(out);
    expect(head).toEqual([
      "event: dead on agent:w/w2 | resume: no resume",
      "exit: 6 (agent w/w2 is gone)",
      "agent:w/w2: gone, dead",
    ]);
    expect(body).toEqual(["no final text"]);
  });

  it("a ready batch names every event; each other agent's words get their own --- <ref>", () => {
    const a = snap({ ref: agent("a1"), fired: true, lastText: "words a" });
    const b = snap({ ref: agent("b1"), fired: true, lastText: "words b" });
    const out = waitText(
      input(
        result({
          event: { kind: "settled", ref: a.ref },
          events: [
            { kind: "settled", ref: a.ref },
            { kind: "settled", ref: b.ref },
          ],
          refs: [b, a],
          delivered: [a.ref, b.ref],
          owed: 3,
        }),
        { warning: "W", notices: ["N"] },
      ),
      new Map(),
    );
    const { head, body } = split(out);
    expect(head).toContain("events: settled agent:w/a1, settled agent:w/b1");
    expect(head).toEqual(expect.arrayContaining(["owed: 3", "warning: W", "notice: N"]));
    expect(body).toEqual(["words a", "--- agent:w/b1", "words b"]);
  });
});
