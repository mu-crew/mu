// `mu wait` in-process (fast tier): the typed ref grammar, the one JSON document for every
// outcome (parse-time errors included), --first/--all, the bounded result and the resume
// command. Real SQLite in a temp dir; no mux, no subprocess (signals are in
// wait-cli.integration.test.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumeCommand, tallySummary, waitData } from "../src/cli/wait-output.js";
import { type Db, openDb } from "../src/db.js";
import { isJsonMode, isWaitVerbArgv } from "../src/output.js";
import { RESULT_BYTES } from "../src/output-contract.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { setWaitSleepForTests } from "../src/tasks/wait.js";
import { addTask, closeTask } from "../src/tasks.js";
import type { WaitResult, WaitSnapshot } from "../src/wait.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";

const noIdentity = (fn: () => Promise<void>): Promise<void> =>
  withEnv("PI_SESSION_ID", undefined, () => withEnv("MU_MANAGED_AGENT", undefined, fn));

import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
const quick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-cli-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  ensureWorkstream(db, "v");
  for (const [ws, id] of [
    ["w", "a"],
    ["w", "b"],
    ["v", "c"],
  ] as const) {
    addTask(db, { localId: id, workstream: ws, title: id, impact: 50, effortDays: 1 });
  }
  setWaitSleepForTests(quick);
});
afterEach(() => {
  setWaitSleepForTests(undefined);
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});
const close = (id: string, ws = "w") => closeTask(db, id, { workstream: ws, evidence: "e" });

describe("verb-aware JSON default", () => {
  it("`wait` and `task wait` print JSON with no --json; other verbs do not (a root -w is skipped)", () => {
    expect(isWaitVerbArgv(["node", "mu", "wait", "task:a"])).toBe(true);
    expect(isWaitVerbArgv(["node", "mu", "-w", "x", "wait"])).toBe(true);
    expect(isWaitVerbArgv(["node", "mu", "task", "wait", "a"])).toBe(true);
    expect(isWaitVerbArgv(["node", "mu", "-w", "wait", "task", "list"])).toBe(false);
    expect(isWaitVerbArgv(["node", "mu", "agent", "wait", "a"])).toBe(false);
    expect(isJsonMode()).toBe(false);
  });

  it("a parse-time error is one JSON document on stdout, exit 2", async () => {
    const r = await runCli(["wait", "--bogus"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "CommanderError", exit: 2 });
  });
});

describe("the typed ref grammar", () => {
  it("a bare word names no kind: refused with the spelling that works", async () => {
    const r = await runCli(["wait", "a", "-w", "w"], dbPath);
    expect(r.exitCode).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ ok: false, exit: 2 });
    expect(doc.message).toContain("task:a");
    expect(doc.message).toContain("agent:a");
  });

  it("task:<id> uses -w; task:<ws>/<id> carries its own; both in one call", async () => {
    close("a");
    close("c", "v");
    const r = await runCliJson(
      ["wait", "task:a", "task:v/c", "-w", "w", "--all", "--timeout", "2"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const d = r.data as { snapshots: { ref: string; fired: boolean }[]; firing: { kind: string } };
    expect(d.snapshots.map((s) => s.ref).sort()).toEqual(["task:v/c", "task:w/a"]);
    expect(d.snapshots.every((s) => s.fired)).toBe(true);
    expect(d.firing.kind).toBe("closed");
  });

  it("an unknown task or workstream is exit 3 before anything waits, as one document", async () => {
    for (const ref of ["task:nosuch", "task:ghost/a"]) {
      const r = await runCli(["wait", ref, "-w", "w", "--timeout", "60"], dbPath);
      expect(r.exitCode).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({
        ok: false,
        error: "TaskNotFoundError",
        exit: 3,
      });
    }
  });

  it("an unknown agent is exit 3; a bad @runs is a usage error", async () => {
    const miss = await runCli(["wait", "agent:ghost", "-w", "w"], dbPath);
    expect(miss.exitCode).toBe(3);
    const bad = await runCli(["wait", "agent:ghost@x", "-w", "w"], dbPath);
    expect(bad.exitCode).toBe(2);
    expect(JSON.parse(bad.stdout).message).toMatch(/@<runs>/);
  });

  it("an unknown delegate call is exit 3", async () => {
    const r = await runCli(["wait", "delegate:pi:x:1"], dbPath);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, exit: 3 });
  });

  it("no refs and no identity is an honest usage error, never an all-callers wait", async () => {
    await noIdentity(async () => {
      const r = await runCli(["wait"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(JSON.parse(r.stdout).message).toMatch(/nothing to wait for/);
    });
  });

  it("--wave needs the pi session that issued the calls", async () => {
    await noIdentity(async () => {
      const r = await runCli(["wait", "task:a", "-w", "w", "--wave", "claims"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(JSON.parse(r.stdout).message).toMatch(/--wave/);
    });
  });
});

describe("modes and conditions", () => {
  it("first is the default; --first-of is the same; --all and --first together are refused", async () => {
    close("a");
    for (const flag of [[], ["--first"], ["--first-of"]]) {
      const r = await runCliJson(["wait", "task:a", "task:b", "-w", "w", ...flag], dbPath);
      expect((r.data as { firing: { ref: string } }).firing.ref).toBe("task:w/a");
    }
    const both = await runCli(["wait", "task:a", "--first", "--all-of", "-w", "w"], dbPath);
    expect(both.exitCode).toBe(2);
  });

  it("--all-of waits for everything: a timeout lists what is still open", async () => {
    close("a");
    const r = await runCliJson(
      ["wait", "task:a", "task:b", "-w", "w", "--all-of", "--timeout", "0.05"],
      dbPath,
    );
    const d = r.data as { timedOut: boolean; open: number; exit: number; resume: string };
    expect(d).toMatchObject({ timedOut: true, open: 1, exit: 0 });
    // Nothing was delivered by a timeout: the resume names every ref, so the all-of stays whole.
    expect(d.resume).toBe("mu wait task:w/a task:w/b --all -w w --timeout 0.05");
  });

  it("--status targets another status", async () => {
    const r = await runCliJson(
      ["wait", "task:a", "-w", "w", "--status", "OPEN", "--timeout", "1"],
      dbPath,
    );
    expect((r.data as { firing: { kind: string } }).firing.kind).toBe("closed");
    const bad = await runCli(["wait", "task:a", "-w", "w", "--status", "NOPE"], dbPath);
    expect(bad.exitCode).toBe(2);
  });

  it("--until-text refuses a pathological or oversized pattern before waiting; a good one runs", async () => {
    for (const re of ["(a+)+$", "a".repeat(201), "(?=x)", "(a)\\1"]) {
      const r = await runCli(["wait", "task:a", "-w", "w", "--until-text", re], dbPath);
      expect(r.exitCode, re).toBe(2);
      expect(JSON.parse(r.stdout).ok).toBe(false);
    }
    close("a");
    const ok = await runCliJson(
      ["wait", "task:a", "-w", "w", "--until-text", "no-such-report", "--timeout", "0.05"],
      dbPath,
    );
    expect((ok.data as { timedOut: boolean }).timedOut).toBe(true);
  });

  it("--until-idle with --until-text is two conditions: refused", async () => {
    const r = await runCli(
      ["wait", "task:a", "-w", "w", "--until-idle", "--until-text", "x"],
      dbPath,
    );
    expect(r.exitCode).toBe(2);
  });

  it("--on-stall steer|release is not in this build; anything else is a usage error", async () => {
    for (const v of ["steer", "release"]) {
      const r = await runCli(["wait", "task:a", "-w", "w", "--on-stall", v], dbPath);
      expect(r.exitCode).toBe(2);
      expect(JSON.parse(r.stdout).message).toMatch(/not available in this build/);
    }
    const r = await runCli(["wait", "task:a", "-w", "w", "--on-stall", "nope"], dbPath);
    expect(JSON.parse(r.stdout).message).toMatch(/expected 'exit' or 'warn'/);
  });

  it("--blockers-of waits on the open blockers of a task", async () => {
    addBlockEdge(db, "w", "b", "a");
    // `a` blocks `b`: waiting on b's blockers is waiting on a.
    const r = await runCliJson(
      ["wait", "--blockers-of", "b", "-w", "w", "--timeout", "0.05"],
      dbPath,
    );
    const d = r.data as { timedOut: boolean; snapshots: { ref: string }[]; resume: string };
    expect(d.timedOut).toBe(true);
    expect(d.snapshots.map((s) => s.ref)).toContain("task:w/a");
    expect(d.resume).toContain("--blockers-of w/b");
  });
});

describe("the timeout", () => {
  it("is ok:true with a heartbeat event, exit 0; a short one carries the warning", async () => {
    const r = await runCliJson(["wait", "task:a", "-w", "w", "--timeout", "0.05"], dbPath);
    expect(r.doc.ok).toBe(true);
    expect(r.data).toMatchObject({
      firing: { kind: "heartbeat", ref: null },
      timedOut: true,
      exit: 0,
      interrupted: false,
    });
    expect((r.data as { warning: string }).warning).toMatch(/below the 1500s default/);
  });

  it("no stdout noise: one line, no ANSI even with colour forced", async () => {
    await withEnv("FORCE_COLOR", "1", async () => {
      const r = await runCli(["wait", "task:a", "-w", "w", "--timeout", "0.05"], dbPath);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
      expect(r.stdout).not.toMatch(/\u001b/);
    });
  });
});

describe("the bounded result and the resume command", () => {
  const snap = (i: number, text = ""): WaitSnapshot => ({
    ref: { kind: "agent", workstream: "w", id: `a${i}`, afterRuns: i, incarnation: `inc ${i}` },
    status: "busy",
    afterRuns: i,
    incarnation: `inc ${i}`,
    ...(text !== "" ? { lastText: text } : {}),
    fired: false,
    dead: false,
  });
  const result = (refs: WaitSnapshot[]): WaitResult => ({
    event: { kind: "heartbeat", ref: null },
    refs,
    timedOut: true,
    interrupted: false,
    exit: 0,
    cursor: {},
    humanNeeds: [],
  });

  it("stays within 4096 bytes and keeps firing, exit, resume whatever the size", () => {
    const refs = Array.from({ length: 60 }, (_, i) => snap(i, "x".repeat(3000)));
    const d = waitData({
      result: result(refs),
      exit: 0,
      conditions: { mode: "first" },
      explicit: refs.map((s) => s.ref),
    });
    const bytes = Buffer.byteLength(JSON.stringify({ ok: true, data: d, next: null }));
    expect(bytes).toBeLessThanOrEqual(RESULT_BYTES);
    expect(d).toMatchObject({ firing: { kind: "heartbeat" }, exit: 0, timedOut: true, open: 60 });
    expect(String(d.resume)).toMatch(/^mu wait 'agent:w\/a0@0#inc 0' /);
    expect(d.snapshotsCut).toBeGreaterThan(0);
    expect(String(d.retrieve)).toMatch(/mu agent read/);
  });

  it("a short text survives whole; a long one keeps its tail and says how much it cut", () => {
    const tail = 'CLOSE: task=t evidence="e"\nREPORT:\ndone';
    const d = waitData({
      result: result([snap(1, `${"y".repeat(2000)}${tail}`)]),
      exit: 0,
      conditions: { mode: "first" },
      explicit: [],
    });
    const s = (d.snapshots as { lastText: string; lastTextCut?: number }[])[0];
    expect(s?.lastText.endsWith(tail)).toBe(true);
    expect(s?.lastTextCut).toBeGreaterThan(0);
  });

  it("resume repeats every condition with its real value, POSIX-quoted", () => {
    const refs = [snap(2).ref];
    const cmd = resumeCommand(
      result([snap(2)]),
      {
        mode: "all",
        scope: "w",
        status: "CLOSED",
        untilText: "it's (ok|fine)",
        stuckAfter: 30,
        onStall: "warn",
        wave: "claims one",
        blockersOf: "w/goal",
        timeout: 90,
      },
      refs,
    );
    expect(cmd).toBe(
      "mu wait 'agent:w/a2@2#inc 2' --all -w w --status CLOSED --until-text 'it'\"'\"'s (ok|fine)' --stuck-after 30 --on-stall warn --wave 'claims one' --blockers-of w/goal --timeout 90",
    );
  });

  it("an event leaves out what it delivered; a timeout names everything", () => {
    const fired: WaitSnapshot = { ...snap(1), fired: true };
    const open = snap(2);
    const hit: WaitResult = {
      ...result([fired, open]),
      event: { kind: "settled", ref: fired.ref, runs: 3 },
      timedOut: false,
    };
    expect(resumeCommand(hit, { mode: "first" }, [])).toContain("a2");
    expect(resumeCommand(hit, { mode: "first" }, [])).not.toContain("a1");
    expect(resumeCommand(result([fired, open]), { mode: "first" }, [])).toContain("a1");
  });

  it("the wave line reads like a tally", () => {
    expect(
      tallySummary({
        findings: [
          { id: "w/c1", confirmed: 1, refuted: 0, unverified: 0, pending: 0 },
          { id: "w/c2", confirmed: 0, refuted: 1, unverified: 0, pending: 0 },
          { id: "w/c3", confirmed: 0, refuted: 0, unverified: 0, pending: 1 },
        ],
        queued: 1,
        running: 0,
        refused: ["x"],
      }),
    ).toBe("1/3 CONFIRMED, 1 REFUTED, 1 pending, 1 refused");
  });
});
