// Characterisation for a7_wait_drain_rca_2 (live repro crew-hill2 2026-11-07: 7 task closes took
// 7 orchestrator settle turns; dogfood-switch F2). Pins TODAY's behaviour through the real CLI
// (`mu wait ... --json`, in-process) and the real pi settle (extension/nudge.ts registerNudge),
// not the wanted one. A fire-all-ready fix flips the expectations marked CURRENT; every event
// must still be delivered exactly once. Real SQLite; no agents, no mux.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MuResult, MuRunOpts } from "../extension/mu-run.js";
import { type MuNudgeCtx, registerNudge } from "../extension/nudge.js";
import { type Db, openDb } from "../src/db.js";
import { getDelegateCall } from "../src/delegates.js";
import { addTask, closeTask } from "../src/tasks.js";
import { setWaitSleepForTests } from "../src/wait.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { runCliWire } from "./_runCli.js";
import { answer, mkDelegate, taskRef } from "./_wait-fixtures.js";

const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", "mu", "SKILL.md"), "utf8");
const CLOSES = ["a2", "a4n", "a6", "a7", "b2", "b3a", "b4a"];

let dir: string;
let dbPath: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-settle-drain-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  setWaitSleepForTests(async () => {});
});
afterEach(() => {
  setWaitSleepForTests(undefined);
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const mk = (id: string) =>
  addTask(db, { localId: id, workstream: "w", title: id, impact: 50, effortDays: 1 });
const close = (id: string) => closeTask(db, id, { workstream: "w", evidence: "e" });

/** `mu <argv>` in-process as pi session `sid` (caller `pi:<sid>`; no managed identity). */
async function mu(sid: string, argv: readonly string[]): Promise<MuResult> {
  let r: MuResult = { code: 1, stdout: "", stderr: "no capture" };
  await withEnv("PI_SESSION_ID", sid, () =>
    withEnv("MU_MANAGED_AGENT", undefined, async () => {
      const c = await runCliWire(argv, dbPath);
      r = { code: c.exitCode ?? 0, stdout: c.stdout, stderr: c.stderr };
    }),
  );
  return r;
}
type Data = {
  firing?: { kind?: string; ref?: string | null };
  timedOut?: boolean;
  drained?: boolean;
  snapshots?: { ref: string; status?: string; fired?: boolean }[];
  cursor?: Record<string, unknown>;
};
const data = (r: MuResult): Data => (JSON.parse(r.stdout) as { data: Data }).data;
const fired = (r: MuResult): string => {
  const d = data(r);
  return d.firing?.ref ? `${d.firing.kind}:${d.firing.ref}` : `${d.firing?.kind}`;
};

describe("N owned task closes through a bare `mu wait` (CURRENT: one per call)", () => {
  it("7 closes take 7 waits; the first result already prints the other 6 CLOSED+fired, unconsumed", async () => {
    for (const id of [...CLOSES, "a3"]) mk(id);
    registerOwnedWait(
      db,
      "pi:s",
      [...CLOSES, "a3"].map((id) => taskRef(id)),
    );
    for (const id of CLOSES) close(id);
    const got: string[] = [];
    const first = await mu("s", ["wait", "--first", "--timeout", "1", "--json"]);
    got.push(fired(first));
    for (let i = 0; i < CLOSES.length; i++) {
      got.push(fired(await mu("s", ["wait", "--first", "--timeout", "1", "--json"])));
    }
    // CURRENT: src/wait.ts select (first mode) fires ready[0] only; a3 still open -> heartbeat.
    expect(got).toEqual([...CLOSES.map((id) => `closed:task:w/${id}`), "heartbeat"]);
    // The reading trap (orchestrator session 2026-11-07 l.282 then l.290): the first result's
    // snapshots show every ready close as CLOSED, fired:true, but only one cursor was written.
    const d = data(first);
    const closedShown = (d.snapshots ?? []).filter((s) => s.status === "CLOSED" && s.fired);
    expect(closedShown.map((s) => s.ref).sort()).toEqual(CLOSES.map((id) => `task:w/${id}`).sort());
    expect(Object.keys(d.cursor ?? {}).filter((k) => k.startsWith("task:"))).toEqual(["task:w/a2"]);
  });

  it("a bare --all cannot drain the ready closes while one owned task is open", async () => {
    for (const id of [...CLOSES, "a3"]) mk(id);
    registerOwnedWait(
      db,
      "pi:s",
      [...CLOSES, "a3"].map((id) => taskRef(id)),
    );
    for (const id of CLOSES) close(id);
    const r = await mu("s", ["wait", "--all", "--timeout", "1", "--json"]);
    // CURRENT: no targets -> targets = every item, and `every(done)` fails on a3: a heartbeat
    // that consumed nothing (no exactly-once "every ready event now" shape exists).
    expect(data(r).timedOut).toBe(true);
    expect(Object.keys(data(r).cursor ?? {})).toEqual([]);
  });
});

describe("the pi settle over the real `mu wait` (CURRENT: one event per settle turn)", () => {
  const SESSION: MuNudgeCtx = { sessionManager: { getSessionId: () => "s1" } };
  const state: MuResult = {
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      data: { caller: "pi:s1", workstreams: [] },
      next: null,
    }),
    stderr: "",
  };
  const settle = () => {
    const handlers: ((e: unknown, c: MuNudgeCtx) => unknown)[] = [];
    const pi = {
      on(event: string, h: (e: unknown, c: MuNudgeCtx) => unknown) {
        if (event === "agent_before_settle") handlers.push(h);
        return () => {};
      },
    };
    const waits: string[][] = [];
    const run = async (
      args: readonly string[],
      _signal?: AbortSignal,
      _stdin?: string,
      opts?: MuRunOpts,
    ): Promise<MuResult> => {
      if (args[0] === "state") return state;
      if (args[0] === "wait") waits.push([...args]);
      return mu(opts?.env?.PI_SESSION_ID ?? "", args);
    };
    registerNudge(pi, run, SKILL);
    const emit = async () => {
      let last: unknown;
      for (const h of handlers) last = await h({ outcome: "completed" }, SESSION);
      return last as { continue?: boolean; entries?: { content: string }[] } | undefined;
    };
    return { emit, waits };
  };

  it("7 owned closes ready at one settle: 7 continued turns, one close each, then the turn ends", async () => {
    for (const id of CLOSES) mk(id);
    registerOwnedWait(
      db,
      "pi:s1",
      CLOSES.map((id) => taskRef(id)),
    );
    for (const id of CLOSES) close(id);
    const s = settle();
    const turns: string[] = [];
    for (let i = 0; i < CLOSES.length; i++) {
      const r = await s.emit();
      expect(r?.continue).toBe(true);
      const text = r?.entries?.[0]?.content ?? "";
      const m = /"firing":\{"kind":"closed","ref":"task:w\/(\w+)"\}/.exec(text);
      turns.push(m?.[1] ?? "?");
    }
    // CURRENT: N closes -> N settle turns (the live crew-hill2 repro: a2 .. b4a, 17:29-17:30Z).
    expect(turns).toEqual(CLOSES);
    expect(await s.emit()).toBeUndefined(); // drained: nothing owed, the turn ends
    expect(s.waits).toHaveLength(CLOSES.length + 1);
  });
});

describe("settle -> notes -> wait: no double delivery (F2's alternative reading)", () => {
  it("an answer a settle-shaped wait consumed is never handed back by a later wait of any shape", async () => {
    mk("t");
    const call = mkDelegate(db, "pi:s");
    answer(db, call);
    const first = await mu("s", ["wait", "--first", "--on-stall", "exit", "--json"]);
    expect(fired(first)).toBe(`delegate:delegate:${call}`);
    // The model reads the answer from its notes (a pure read).
    const task = getDelegateCall(db, call)?.task ?? "";
    const notes = await mu("s", ["task", "notes", task, "-w", "scratch"]);
    expect(notes.stdout).toContain("VERDICT: CONFIRMED");
    // Then waits on an explicit open ref, first and --all: the answer is not returned again.
    expect(fired(await mu("s", ["wait", "task:w/t", "--timeout", "1", "--json"]))).toBe(
      "heartbeat",
    );
    expect(fired(await mu("s", ["wait", "task:w/t", "--all", "--timeout", "1", "--json"]))).toBe(
      "heartbeat",
    );
    // And a bare wait finds nothing owed.
    const bare = await mu("s", ["wait", "--first", "--timeout", "1", "--json"]);
    expect(JSON.parse(bare.stdout)).toMatchObject({ ok: false, error: "WaitNothingError" });
  });

  it("read is not delivery (F2's actual order): notes first, then the next explicit wait returns it ONCE", async () => {
    mk("t");
    const call = mkDelegate(db, "pi:s");
    answer(db, call);
    const task = getDelegateCall(db, call)?.task ?? "";
    expect((await mu("s", ["task", "notes", task, "-w", "scratch"])).stdout).toContain("VERDICT");
    // By design since 42471d22 (a pipe cannot prove a read): the wait still owes it, once.
    const w = ["wait", "task:w/t", "--timeout", "1", "--json"];
    expect(fired(await mu("s", w))).toBe(`delegate:delegate:${call}`);
    expect(fired(await mu("s", w))).toBe("heartbeat");
  });
});

describe("the printed result names what it consumed (the exactly-once printing rule)", () => {
  it("--wave --all over 12 long answers consumes 12 but pages some out of `snapshots` (CURRENT)", async () => {
    const calls = Array.from({ length: 12 }, () => mkDelegate(db, "pi:s", { wave: "big" }));
    for (const c of calls) answer(db, c, `VERDICT: CONFIRMED\n${"x".repeat(3000)}`);
    const r = await mu("s", ["wait", "--wave", "big", "--all", "--timeout", "1", "--json"]);
    const d = data(r) as Data & { snapshotsCut?: number };
    const consumed = db
      .prepare(
        "SELECT COUNT(*) AS n FROM wait_cursors WHERE caller = 'pi:s' AND ref LIKE 'delegate:%'",
      )
      .get() as { n: number };
    expect(consumed.n).toBe(12);
    // CURRENT: src/cli/wait-output.ts orders the firing ref, then open refs, then the fired ones,
    // so the 4096-byte page cuts consumed calls first (only `snapshotsCut` + `retrieve` say so).
    // A batch fix must never page out a delivered member.
    expect(d.snapshots?.length).toBeLessThan(12);
    expect(d.snapshotsCut).toBeGreaterThan(0);
  });
});
