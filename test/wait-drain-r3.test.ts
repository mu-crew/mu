// Characterisation for a7_wait_drain_rca_3 (the round-2 refutation, delegate_refute-a7b in
// scratch). Pins TODAY's behaviour, not the wanted one, on three gaps the round-2 proposal left:
//   1. snapshots cannot tell "consumed by this result" from "terminal, still owed" (RC3): the
//      engine knows (WaitResult.delivered, src/wait.ts build) but the output never prints it.
//   2. a superseded generation (src/wait.ts commit: `!ended.applied` skips recordCursors) still
//      returns its events, and the settle and the Stop hook present them as consumed, so the
//      newer wait prints them a second time. Single and batch (`--all`).
//   3. a settle that meets delegates of two waves.
// a7_ready_engine (unit A: engine, output, Stop hook) flipped the marks and superseded pins to the
// new behaviour (marked NOW). What is still marked CURRENT is the pi settle (unit B, nudge.ts).
// Real SQLite; no agents.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MuResult, MuRunOpts } from "../extension/mu-run.js";
import { type MuNudgeCtx, registerNudge } from "../extension/nudge.js";
import { reasonOf } from "../src/cli/wait.js";
import { waitData } from "../src/cli/wait-output.js";
import { type Db, openDb } from "../src/db.js";
import { eventsReason, parseStopWait } from "../src/hook-stop.js";
import { encodeEnvelope, okEnvelope } from "../src/output-contract.js";
import { addTask, closeTask } from "../src/tasks.js";
import { setWaitSleepForTests, type WaitResult, waitForEvents } from "../src/wait.js";
import { readCursors } from "../src/wait-cursor.js";
import { beginWait, registerOwnedWait } from "../src/wait-registration.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { runCliWire } from "./_runCli.js";
import { answer, mkDelegate, taskRef } from "./_wait-fixtures.js";

const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", "mu", "SKILL.md"), "utf8");

let dir: string;
let dbPath: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-drain-r3-"));
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
const base = { pollMs: 1, sync: false, callers: ["pi:s"], timeoutMs: 30 } as const;

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
type Snap = { ref: string; status?: string; fired?: boolean } & Record<string, unknown>;
type Data = {
  firing?: { kind?: string; ref?: string | null };
  snapshots?: Snap[];
  cursor?: Record<string, unknown>;
  superseded?: boolean;
};
const data = (r: MuResult): Data => (JSON.parse(r.stdout) as { data: Data }).data;
/** The JSON line `mu wait --json` prints for an engine result. */
const printed = (r: WaitResult): string =>
  encodeEnvelope(okEnvelope(waitData({ result: r, exit: r.exit, resume: null })));

/** The pi settle (extension/nudge.ts) with `waitOut` standing in for every `mu wait` child. */
function settle(waitOut: (args: readonly string[], sid: string) => Promise<MuResult>) {
  const SESSION: MuNudgeCtx = { sessionManager: { getSessionId: () => "s" } };
  const state: MuResult = {
    code: 0,
    stdout: JSON.stringify({ ok: true, data: { caller: "pi:s", workstreams: [] }, next: null }),
    stderr: "",
  };
  const handlers: ((e: unknown, c: MuNudgeCtx) => unknown)[] = [];
  const pi = {
    on(event: string, h: (e: unknown, c: MuNudgeCtx) => unknown) {
      if (event === "agent_before_settle") handlers.push(h);
      return () => {};
    },
  };
  const waits: string[][] = [];
  const delivered: unknown[] = [];
  const run = async (
    args: readonly string[],
    _signal?: AbortSignal,
    _stdin?: string,
    opts?: MuRunOpts,
  ): Promise<MuResult> => {
    if (args[0] === "state") return state;
    const sid = opts?.env?.PI_SESSION_ID ?? "";
    if (args[0] === "wait") {
      waits.push([...args]);
      return waitOut(args, sid);
    }
    return mu(sid, args);
  };
  registerNudge(pi, run, SKILL, undefined, undefined, (d) => delivered.push(d));
  const emit = async () => {
    let last: unknown;
    for (const h of handlers) last = await h({ outcome: "completed" }, SESSION);
    return last as { continue?: boolean; entries?: { content: string }[] } | undefined;
  };
  return { emit, waits, delivered };
}

describe("RC3: snapshots say what this result consumed (NOW, every mode)", () => {
  it("first mode over 3 owned closes: 1 delivered, 2 owed, and the result says so", async () => {
    for (const id of ["a", "b", "c"]) mk(id);
    registerOwnedWait(
      db,
      "pi:s",
      ["a", "b", "c"].map((id) => taskRef(id)),
    );
    for (const id of ["a", "b", "c"]) close(id);
    // The engine knows which one it consumed...
    const r = await waitForEvents(db, [], base);
    expect(r.delivered.map((x) => x.id)).toEqual(["a"]);
    expect(r.refs.filter((s) => s.fired).map((s) => s.ref.id)).toEqual(["a", "b", "c"]);
    // ...and the CLI result prints it: the consumed b reads delivered, the owed c reads owed.
    const out = await mu("s", ["wait", "--first", "--timeout", "1", "--json"]);
    const d = data(out) as Data & Record<string, unknown>;
    expect(d.firing?.ref).toBe("task:w/b");
    const snaps = d.snapshots ?? [];
    expect(snaps.filter((s) => s.fired).map((s) => s.ref)).toEqual(["task:w/b", "task:w/c"]);
    expect(snaps.find((s) => s.ref === "task:w/b")).toMatchObject({ delivered: true });
    expect(snaps.find((s) => s.ref === "task:w/b")).not.toHaveProperty("owed");
    expect(snaps.find((s) => s.ref === "task:w/c")).toMatchObject({ owed: true });
    expect(snaps.find((s) => s.ref === "task:w/c")).not.toHaveProperty("delivered");
    expect(d.owed).toBe(1);
    for (const s of snaps) expect(s).not.toHaveProperty("pending");
  });

  it("--all on two explicit targets, one closed: the heartbeat marks the closed target owed", async () => {
    mk("t1");
    mk("t2");
    close("t1");
    const out = await mu("s", [
      "wait",
      "task:w/t1",
      "task:w/t2",
      "--all",
      "--timeout",
      "1",
      "--json",
    ]);
    const d = data(out) as Data & Record<string, unknown>;
    expect(d.firing?.kind).toBe("heartbeat");
    const t1 = d.snapshots?.find((s) => s.ref === "task:w/t1");
    // NOW: the heartbeat consumed nothing, so t1 reads owed (never delivered).
    expect(t1).toMatchObject({ status: "CLOSED", fired: true, owed: true });
    expect(t1).not.toHaveProperty("delivered");
    expect(d.owed).toBe(1);
  });

  it("N2: a target an earlier wait already consumed is not owed again", async () => {
    mk("t1");
    mk("t2");
    registerOwnedWait(db, "pi:s", [taskRef("t1")]);
    close("t1");
    // A bare wait consumes t1's close.
    expect((await waitForEvents(db, [], base)).delivered.map((x) => x.id)).toEqual(["t1"]);
    const r = await waitForEvents(db, [taskRef("t1"), taskRef("t2")], {
      ...base,
      mode: "all",
      timeoutMs: 5,
    });
    expect(r.event.kind).toBe("heartbeat");
    expect(r.refs.find((s) => s.ref.id === "t1")?.owed).toBeUndefined();
    expect(r.owed).toBe(0);
  });
});

describe("superseded generations deliver nothing of theirs (NOW: engine and Stop hook; settle CURRENT)", () => {
  // A newer wait of the same caller begins.
  const supersede = async (): Promise<void> => {
    beginWait(db, "pi:s");
  };

  it("single: the superseded result delivers nothing and says so; the newer wait delivers the close", async () => {
    mk("a");
    registerOwnedWait(db, "pi:s", [taskRef("a")]);
    close("a");
    const old = await waitForEvents(db, [], { ...base, beforePoll: supersede });
    expect(old.superseded).toBe(true);
    expect(old.event.ref?.id).toBe("a");
    expect(old.eventConsumed).toBe(false);
    expect(old.delivered).toEqual([]);
    expect(readCursors(db, "pi:s").size).toBe(0); // nothing consumed
    const json = printed(old);
    const d = (JSON.parse(json) as { data: Record<string, unknown> }).data;
    expect(d.eventConsumed).toBe(false);
    expect(reasonOf(old, undefined, 0)).toMatch(
      /^superseded: a newer wait of this caller began; what is not marked delivered was not consumed/,
    );
    // The Stop hook reads it as superseded: nothing consumed, so it lets the turn end.
    const hook = parseStopWait(json);
    expect(hook.kind).toBe("superseded");
    // CURRENT (unit B): the settle still continues the turn with it.
    const s = settle(async () => ({ code: 0, stdout: json, stderr: "" }));
    const turn = await s.emit();
    expect(turn?.continue).toBe(true);
    expect(turn?.entries?.[0]?.content).toContain('"superseded":true');
    // The newer generation delivers the close: its only delivery.
    const again = await waitForEvents(db, [], base);
    expect(again.event.ref?.id).toBe("a");
    expect(again.delivered.map((x) => x.id)).toEqual(["a"]);
    expect(again.superseded).toBeUndefined();
  });

  it("batch (--all): no member of the superseded result is delivered; the next wait delivers each once", async () => {
    for (const id of ["a", "b"]) mk(id);
    registerOwnedWait(db, "pi:s", [taskRef("a"), taskRef("b")]);
    for (const id of ["a", "b"]) close(id);
    const old = await waitForEvents(db, [], { ...base, mode: "all", beforePoll: supersede });
    expect(old.superseded).toBe(true);
    expect(old.delivered).toEqual([]);
    expect(old.refs.filter((x) => x.owed === true).map((x) => x.ref.id)).toEqual(["a", "b"]);
    expect(readCursors(db, "pi:s").size).toBe(0);
    expect(parseStopWait(printed(old)).kind).toBe("superseded");
    const next = await waitForEvents(db, [], { ...base, mode: "all" });
    expect(next.delivered.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
});

describe("a superseded result can be partly consumed (NOW: narrowed, two callers)", () => {
  it("--all as two callers, only one superseded: `delivered` names only the consumed member", async () => {
    for (const id of ["a", "b"]) mk(id);
    registerOwnedWait(db, "pi:s", [taskRef("a")]);
    registerOwnedWait(db, "w/orch", [taskRef("b")]);
    for (const id of ["a", "b"]) close(id);
    const r = await waitForEvents(db, [], {
      ...base,
      callers: ["pi:s", "w/orch"],
      mode: "all",
      beforePoll: async () => {
        beginWait(db, "pi:s"); // only pi:s gets a newer wait
      },
    });
    expect(r.superseded).toBe(true);
    // b IS consumed (w/orch's generation applied), a is not: delivered says exactly that.
    expect(r.delivered.map((x) => x.id)).toEqual(["b"]);
    expect(r.refs.find((x) => x.ref.id === "a")?.owed).toBe(true);
    expect([...readCursors(db, "w/orch").keys()]).toEqual(["task:w/b"]);
    expect(readCursors(db, "pi:s").size).toBe(0);
    // Printed: b delivered, a owed; the hook blocks over b only.
    const d = (JSON.parse(printed(r)) as { data: { snapshots: Snap[] } }).data;
    expect(d.snapshots.find((x) => x.ref === "task:w/b")).toMatchObject({ delivered: true });
    expect(d.snapshots.find((x) => x.ref === "task:w/a")).toMatchObject({ owed: true });
    const hook = parseStopWait(printed(r));
    expect(hook.kind).toBe("superseded");
    if (hook.kind !== "superseded") return;
    expect(eventsReason("Keep driving.", "w/orch", 60, hook.data)).toContain(
      "1 event:\n- task w/b CLOSED\n",
    );
    // Nothing lost: the next wait returns a, and only a.
    const again = await waitForEvents(db, [], {
      ...base,
      callers: ["pi:s", "w/orch"],
      mode: "all",
    });
    expect(again.delivered.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("a settle over delegates of two waves (CURRENT)", () => {
  it("interleaved waves A and B, all answered: one wave summary per turn, the other split off", async () => {
    const a1 = mkDelegate(db, "pi:s", { wave: "A" });
    const b1 = mkDelegate(db, "pi:s", { wave: "B" });
    const a2 = mkDelegate(db, "pi:s", { wave: "A" });
    const b2 = mkDelegate(db, "pi:s", { wave: "B" });
    for (const c of [a1, b1, a2, b2]) answer(db, c, `VERDICT: CONFIRMED\nreport of ${c}`);
    const s = settle((args, sid) => mu(sid, args));
    const turns: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await s.emit();
      if (r === undefined) break;
      expect(r.continue).toBe(true);
      turns.push(r.entries?.[0]?.content ?? "");
    }
    // Each wave loop treats the other wave's answer as "another event" and breaks.
    const heads = turns.map((t) =>
      t
        .split("\n")
        .filter((l) => /^(Work you own|Wave |Another event)/.test(l))
        .map((l) => l.replace(/ \(call [^)]*\)/g, "").slice(0, 80)),
    );
    const ran = "Work you own is still running, so the settle ran `mu wait --first --on-stall exi";
    const sumA = "Wave A: 2/2 CONFIRMED, 0 REFUTED, 0 UNVERIFIED, 0 pending, 0 refused.";
    const sumB = "Wave B: 2/2 CONFIRMED, 0 REFUTED, 0 UNVERIFIED, 0 pending, 0 refused.";
    // CURRENT: 4 answers in 2 waves take 3 continued turns. Turn 1: A1 fires, A's loop meets B1
    // ("another event", shown as a lone answer block, no wave B summary) and breaks. Turn 2: A2
    // fires and wave A's summary is printed a second time. Turn 3: B2 and wave B's summary.
    expect(heads).toEqual([
      [ran, sumA, "Another event came before the rest of wave A:"],
      [ran, sumA],
      [ran, sumB],
    ]);
    expect(s.delivered.slice(0, 3)).toEqual([[a1, b1], [a2], [b2]]);
    expect(s.delivered[3]).toHaveProperty("before"); // turn 4: drained, the turn ends
    expect(s.waits).toHaveLength(5);
  });
});
