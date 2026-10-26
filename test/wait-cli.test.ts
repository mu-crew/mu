// `mu wait` in-process (fast tier): the typed ref grammar, the one JSON document for every
// outcome (parse-time errors included), --first/--all, the bounded result and the resume
// command. Real SQLite in a temp dir; no mux, no subprocess (signals are in
// wait-cli.integration.test.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owedRefs, resumeCommand, tallySummary, waitData } from "../src/cli/wait-output.js";
import { type Db, openDb } from "../src/db.js";
import { isJsonMode, isWaitVerbArgv } from "../src/output.js";
import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../src/output-contract.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { setWaitSleepForTests } from "../src/tasks/wait.js";
import { addTask, closeTask } from "../src/tasks.js";
import type { WaitRef, WaitResult, WaitSnapshot } from "../src/wait.js";
import {
  loadResume,
  RESUME_KEEP_DAYS,
  type StoredResume,
  saveResume,
  WaitResumeNotFoundError,
} from "../src/wait-resume.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";

const noIdentity = (fn: () => Promise<void>): Promise<void> =>
  withEnv("PI_SESSION_ID", undefined, () => withEnv("MU_MANAGED_AGENT", undefined, fn));
/** Run `argv` with the given PI_SESSION_ID (undefined = a plain shell, no identity); returns the capture. */
async function asCaller(pi: string | undefined, argv: string[]) {
  let out: Awaited<ReturnType<typeof runCliJson>> | undefined;
  await withEnv("PI_SESSION_ID", pi, () =>
    withEnv("MU_MANAGED_AGENT", undefined, async () => {
      out = await runCliJson(argv, dbPath);
    }),
  );
  if (out === undefined) throw new Error("no capture");
  return out;
}

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
/** The stored wait behind a printed `mu wait --resume <id>`. */
const stored = (resume: string): StoredResume => {
  const id = /--resume (\w+)/.exec(resume)?.[1] ?? "";
  return loadResume(db, id);
};
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
    // Nothing was delivered by a timeout: the stored wait names every ref, so the all-of stays whole.
    expect(d.resume).toMatch(/^mu wait --resume [0-9a-f]{10} -w w$/);
    expect(stored(d.resume)).toMatchObject({
      callers: [],
      spec: { mode: "all", scope: "w", timeout: 0.05, refs: [{ id: "a" }, { id: "b" }] },
    });
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

  it("--on-stall takes exit|warn|steer|release; anything else is a usage error naming all four", async () => {
    const r = await runCli(["wait", "task:a", "-w", "w", "--on-stall", "nope"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).message).toMatch(/'exit', 'warn', 'steer' or 'release'/);
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
    expect(stored(d.resume).spec).toMatchObject({ blockersOf: { workstream: "w", id: "b" } });
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

describe("mu wait --resume <id>: the stored handle", () => {
  const handleOf = (d: unknown): string =>
    /--resume (\w+)/.exec((d as { resume: string }).resume)?.[1] ?? "";

  it("30 explicit refs survive whole: the resume is lossless and the printed line stays tiny", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m${i}`);
    for (const id of ids)
      addTask(db, { localId: id, workstream: "w", title: id, impact: 50, effortDays: 1 });
    const first = await runCliJson(
      ["wait", ...ids.map((i) => `task:w/${i}`), "--all", "--timeout", "0.05"],
      dbPath,
    );
    const d = first.data as { resume: string; open: number };
    expect(d.open).toBe(30);
    expect(d.resume).toMatch(/^mu wait --resume [0-9a-f]{10}$/);
    expect(stored(d.resume).spec.refs.map((r) => r.id)).toEqual(ids);
    // Running it as printed is the same all-of wait: 29 closed is NOT enough, 30 is.
    for (const id of ids.slice(0, 29)) close(id);
    const some = await runCliJson(["wait", "--resume", handleOf(d)], dbPath);
    // (a timeout of the stored 0.05 s: still open, still the same 30)
    expect(some.data).toMatchObject({ timedOut: true, open: 1 });
    close("m29");
    const done = await runCliJson(["wait", "--resume", handleOf(d)], dbPath);
    expect(done.data).toMatchObject({ timedOut: false, open: 0, exit: 0 });
  });

  it("every stored condition is replayed (mode, scope, status, until-text, stall, timeout)", async () => {
    const r = await runCliJson(
      [
        "wait",
        "task:a",
        "-w",
        "w",
        "--status",
        "OPEN",
        "--until-text",
        "never-matches",
        "--stuck-after",
        "30",
        "--on-stall",
        "warn",
        "--timeout",
        "0.05",
        "--all",
      ],
      dbPath,
    );
    expect(stored((r.data as { resume: string }).resume).spec).toMatchObject({
      mode: "all",
      scope: "w",
      status: "OPEN",
      untilText: "never-matches",
      stuckAfter: 30,
      onStall: "warn",
      timeout: 0.05,
    });
  });

  it("the handle keeps the caller identity the wait ran for, whoever runs the resume", async () => {
    const first = await asCaller("sess1", ["wait", "task:a", "-w", "w", "--timeout", "0.05"]);
    const resume = (first.data as { resume: string }).resume;
    expect(stored(resume).callers).toEqual(["pi:sess1"]);
    // A plain shell (no identity) runs it: the stored caller, not an empty one.
    const again = await asCaller(undefined, ["wait", "--resume", handleOf(first.data)]);
    expect(again.doc.ok).toBe(true);
    expect(again.data).toMatchObject({ timedOut: true, open: 1 });
  });

  it("a plain shell with nothing left to wait for gets resume:null and a reason, never a failing command", async () => {
    close("a");
    const r = await runCliJson(["wait", "task:a", "-w", "w"], dbPath);
    expect(r.data).toMatchObject({ firing: { kind: "closed" }, resume: null });
    expect(String((r.data as { resumeWhy: string }).resumeWhy)).toMatch(/nothing left/);
  });

  it("the handle replays the stored wait as it was: any other flag or ref beside it is refused", async () => {
    const first = await runCliJson(["wait", "task:a", "-w", "w", "--timeout", "0.05"], dbPath);
    const id = handleOf(first.data);
    for (const extra of [
      ["task:a"],
      ["--all"],
      ["--timeout", "5"],
      ["--until-text", "x"],
      ["--status", "OPEN"],
    ]) {
      const r = await runCli(["wait", "--resume", id, ...extra], dbPath);
      expect(r.exitCode, extra.join(" ")).toBe(2);
      expect(JSON.parse(r.stdout).message).toMatch(/replays the stored wait/);
    }
    // -w is only a guard: it must name the stored scope.
    const wrong = await runCli(["wait", "--resume", id, "-w", "v"], dbPath);
    expect(wrong.exitCode).toBe(2);
    const right = await runCliJson(["wait", "--resume", id, "-w", "w"], dbPath);
    expect((right.data as { timedOut: boolean }).timedOut).toBe(true);
  });

  it("an unknown handle is exit 3 with the way back; a damaged row is a clear error", async () => {
    const r = await runCli(["wait", "--resume", "deadbeef00"], dbPath);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "WaitResumeNotFoundError" });
    expect(JSON.parse(r.stdout).message).toMatch(/name the refs again/);
    db.prepare(
      "INSERT INTO wait_resumes (id, callers_json, spec_json, created_at) VALUES ('bad0000000', '[]', '{', ?)",
    ).run(new Date().toISOString());
    const bad = await runCli(["wait", "--resume", "bad0000000"], dbPath);
    expect(JSON.parse(bad.stdout).message).toMatch(/unreadable/);
  });

  it("handles older than the retention are dropped when the next one is saved", () => {
    const old = new Date(Date.now() - (RESUME_KEEP_DAYS + 1) * 86_400_000).toISOString();
    db.prepare(
      "INSERT INTO wait_resumes (id, callers_json, spec_json, created_at) VALUES ('old0000000', '[]', '{\"refs\":[]}', ?)",
    ).run(old);
    saveResume(db, [], { refs: [], mode: "first", onStall: "exit" });
    expect(() => loadResume(db, "old0000000")).toThrow(WaitResumeNotFoundError);
  });
});

describe("the bounded result and the resume handle", () => {
  const snap = (i: number, text = ""): WaitSnapshot => ({
    ref: { kind: "agent", workstream: "w", id: `a${i}`, afterRuns: i, incarnation: `inc ${i}` },
    status: "busy",
    afterRuns: i,
    incarnation: `inc ${i}`,
    ...(text !== "" ? { lastText: text } : {}),
    fired: false,
    dead: false,
  });
  const result = (refs: WaitSnapshot[], over: Partial<WaitResult> = {}): WaitResult => ({
    event: { kind: "heartbeat", ref: null },
    refs,
    timedOut: true,
    interrupted: false,
    exit: 0,
    cursor: {},
    humanNeeds: [],
    ...over,
  });
  const HANDLE = "mu wait --resume 0123456789 -w w";
  const wire = (d: unknown): number =>
    Buffer.byteLength(encodeEnvelope(okEnvelope(d as Record<string, unknown>)));

  it("stays within 4096 bytes and keeps firing, exit, resume whatever the size", () => {
    const refs = Array.from({ length: 60 }, (_, i) => snap(i, "x".repeat(3000)));
    const d = waitData({ result: result(refs), exit: 0, resume: HANDLE });
    expect(wire(d)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(d).toMatchObject({
      firing: { kind: "heartbeat" },
      exit: 0,
      timedOut: true,
      open: 60,
      resume: HANDLE,
    });
    expect(d.snapshotsCut).toBeGreaterThan(0);
    expect(String(d.retrieve)).toMatch(/mu agent read/);
  });

  it("nextSteps, humanNeeds and the warning count toward the bound (60 open tasks, 30 needs)", () => {
    const refs = Array.from({ length: 60 }, (_, i) => snap(i));
    const nextSteps = Array.from({ length: 60 }, (_, i) => ({
      intent: `Investigate w/t${i} (status=OPEN)`,
      command: `mu task show t${i} -w w`,
    }));
    const humanNeeds = Array.from({ length: 30 }, (_, i) => ({
      workstream: "w",
      id: `n${i}`,
      reason: "r".repeat(900),
    }));
    const d = waitData({
      result: result(refs, { humanNeeds }),
      exit: 0,
      resume: HANDLE,
      nextSteps,
      warning: "w".repeat(300),
      reason: "no event before the deadline; 60 still open",
    });
    expect(wire(d)).toBeLessThanOrEqual(RESULT_BYTES);
    // What is kept says what it cut; the handle, firing and exit are never cut.
    expect(d).toMatchObject({ resume: HANDLE, exit: 0, open: 60, firing: { kind: "heartbeat" } });
    expect((d.nextSteps as unknown[]).length + Number(d.nextStepsCut)).toBe(60);
    expect(Number(d.humanNeedsCut)).toBeGreaterThan(0);
  });

  it("a wave's findings and refused list shrink to a counted summary, then the snapshots page", () => {
    const tally = {
      findings: Array.from({ length: 80 }, (_, i) => ({
        id: `w/f${i}`,
        confirmed: 1,
        refuted: 0,
        unverified: 0,
        pending: 0,
      })),
      queued: 0,
      running: 0,
      refused: Array.from({ length: 40 }, (_, i) => `pi:s:c${i}`),
    };
    const d = waitData({
      result: result([snap(1), snap(2)], { tally }),
      exit: 0,
      resume: HANDLE,
    });
    expect(wire(d)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(d.tally).toMatchObject({ summary: "80/80 CONFIRMED, 40 refused", findingsCut: 80 });
  });

  it("a null resume says why, in the same bounded document", () => {
    const d = waitData({
      result: result([], { event: { kind: "closed", ref: null }, timedOut: false }),
      exit: 0,
      resume: null,
      resumeWhy: "nothing left",
    });
    expect(d).toMatchObject({ resume: null, resumeWhy: "nothing left" });
  });

  it("a short text survives whole; a long one keeps its tail and says how much it cut", () => {
    const tail = 'CLOSE: task=t evidence="e"\nREPORT:\ndone';
    const d = waitData({
      result: result([snap(1, `${"y".repeat(2000)}${tail}`)]),
      exit: 0,
      resume: HANDLE,
    });
    const s = (d.snapshots as { lastText: string; lastTextCut?: number }[])[0];
    expect(s?.lastText.endsWith(tail)).toBe(true);
    expect(s?.lastTextCut).toBeGreaterThan(0);
  });

  it("the handle is the whole resume: one short line, -w only when scoped", () => {
    expect(resumeCommand("abc123", undefined)).toBe("mu wait --resume abc123");
    expect(resumeCommand("abc123", "my ws")).toBe("mu wait --resume abc123 -w 'my ws'");
  });

  it("owedRefs: an event leaves out what it delivered; a timeout keeps everything", () => {
    const fired: WaitSnapshot = { ...snap(1), fired: true };
    const open = snap(2);
    const explicit = [fired.ref, open.ref];
    const hit = result([fired, open], {
      event: { kind: "settled", ref: fired.ref, runs: 3 },
      timedOut: false,
    });
    expect(owedRefs(hit, "first", explicit).map((r) => r.id)).toEqual(["a2"]);
    expect(owedRefs(result([fired, open]), "first", explicit).map((r) => r.id)).toEqual([
      "a1",
      "a2",
    ]);
    // --all: every ref that fired is delivered, whichever event ended the wait.
    expect(owedRefs(hit, "all", explicit).map((r) => r.id)).toEqual(["a2"]);
  });

  it("owedRefs: 30 refs are all kept, and the OBSERVED incarnation and runs win over the typed ref", () => {
    const refs = Array.from({ length: 30 }, (_, i) => snap(i));
    const explicit = refs.map((s) => ({
      ...s.ref,
      afterRuns: undefined,
      incarnation: undefined,
    })) as WaitRef[];
    const owed = owedRefs(result(refs), "all", explicit);
    expect(owed).toHaveLength(30);
    expect(owed[7]).toEqual({
      kind: "agent",
      workstream: "w",
      id: "a7",
      afterRuns: 7,
      incarnation: "inc 7",
    });
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

describe("exited: a remote command gate's status is the exit (v_remote_gates)", () => {
  it("the document carries the numeric exit, the exited firing event and the snapshot's own status", async () => {
    const { waitData } = await import("../src/cli/wait-output.js");
    const ref = { kind: "agent" as const, workstream: "w", id: "g1" };
    const data = waitData({
      result: {
        event: { kind: "exited", ref },
        refs: [{ ref, status: null, exit: 23, fired: true, dead: false }],
        timedOut: false,
        interrupted: false,
        exit: 23,
        cursor: {},
        humanNeeds: [],
      },
      exit: 23,
      resume: null,
    });
    expect(data).toMatchObject({
      exit: 23,
      firing: { kind: "exited", ref: "agent:w/g1" },
      snapshots: [{ exit: 23, fired: true, dead: false }],
    });
  });
});
