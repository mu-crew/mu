// Characterisation for a7_wait_drain_rca_3 (the round-2 refutation, delegate_refute-a7b in
// scratch). Pins TODAY's behaviour, not the wanted one, on three gaps the round-2 proposal left:
//   1. snapshots cannot tell "consumed by this result" from "terminal, still owed" (RC3): the
//      engine knows (WaitResult.delivered, src/wait.ts build) but the output never prints it.
//   2. a superseded generation (src/wait.ts commit: `!ended.applied` skips recordCursors) still
//      returns its events, and the settle and the Stop hook present them as consumed, so the
//      newer wait prints them a second time. Single and batch (`--all`).
//   3. a settle that meets delegates of two waves.
// a7_ready_engine (unit A: engine, output, Stop hook) flipped the marks and superseded pins to the
// new behaviour, and a7_ready_settle (unit B: the pi settle, nudge.ts) the settle halves (NOW).
// Real SQLite; no agents.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MuResult, MuRunOpts } from "../extension/mu-run.js";
import { type MuNudgeCtx, registerNudge } from "../extension/nudge.js";
import { SUPERSEDED_LINE } from "../extension/settle-events.js";
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

/** `mu <argv>` in-process as pi session `sid` (caller `pi:<sid>`; no managed identity). One at a
 *  time: the in-process CLI captures one stdout (the settle reads answers in parallel). */
let queue: Promise<unknown> = Promise.resolve();
async function mu(sid: string, argv: readonly string[]): Promise<MuResult> {
  let r: MuResult = { code: 1, stdout: "", stderr: "no capture" };
  const run = queue.then(() =>
    withEnv("PI_SESSION_ID", sid, () =>
      withEnv("MU_MANAGED_AGENT", undefined, async () => {
        const c = await runCliWire(argv, dbPath);
        r = { code: c.exitCode ?? 0, stdout: c.stdout, stderr: c.stderr };
      }),
    ),
  );
  queue = run.catch(() => {});
  await run;
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

describe("superseded generations deliver nothing of theirs (NOW: engine, Stop hook and settle)", () => {
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
    // NOW (unit B): the settle shows one line, does not continue, waits no more, delivers nothing.
    const s = settle(async () => ({ code: 0, stdout: json, stderr: "" }));
    const turn = await s.emit();
    expect(turn?.continue).toBeUndefined();
    expect(turn?.entries?.map((e) => e.content)).toEqual([SUPERSEDED_LINE]);
    expect(s.waits).toHaveLength(1);
    expect(s.delivered).toEqual([]);
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

describe("a settle over delegates of two waves (NOW: one union loop)", () => {
  it("interleaved waves A and B, all answered: 1 turn, each wave summarised once, 4 bodies", async () => {
    const a1 = mkDelegate(db, "pi:s", { wave: "A" });
    const b1 = mkDelegate(db, "pi:s", { wave: "B" });
    const a2 = mkDelegate(db, "pi:s", { wave: "A" });
    const b2 = mkDelegate(db, "pi:s", { wave: "B" });
    const all = [a1, b1, a2, b2];
    for (const c of all) answer(db, c, `VERDICT: CONFIRMED\nreport of ${c}`);
    const s = settle((args, sid) => mu(sid, args));
    const turns: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await s.emit();
      if (r === undefined) break;
      expect(r.continue).toBe(true);
      turns.push(r.entries?.[0]?.content ?? "");
    }
    expect(turns).toHaveLength(1);
    const text = turns[0] ?? "";
    const count = (needle: string) => text.split(needle).length - 1;
    const ran =
      "Work you own is still running, so the settle ran `mu wait --ready --on-stall exit --json` for you. 4 events:";
    const sumA = "Wave A: 2/2 CONFIRMED, 0 REFUTED, 0 UNVERIFIED, 0 pending, 0 refused.";
    const sumB = "Wave B: 2/2 CONFIRMED, 0 REFUTED, 0 UNVERIFIED, 0 pending, 0 refused.";
    expect(count(sumA)).toBe(1);
    expect(count(sumB)).toBe(1);
    // The text order: what ran and one line per event, the wave heads, then wave A, then wave B.
    const at = (needle: string) => text.indexOf(needle);
    expect(at(ran)).toBeGreaterThan(0);
    expect(at(ran)).toBeLessThan(at("\nwave A in\nwave B in\n"));
    expect(at("\nwave B in\n")).toBeLessThan(at(sumA));
    expect(at(sumA)).toBeLessThan(at(sumB));
    for (const [c, w] of [
      [a1, "A"],
      [b1, "B"],
      [a2, "A"],
      [b2, "B"],
    ] as const)
      expect(text).toContain(`(call ${c}) done, CONFIRMED: in wave ${w} below`);
    // Each consumed answer has exactly one body, under its own wave.
    for (const c of all) {
      expect(count(`Delegate answer: call ${c},`)).toBe(1);
      expect(count(`\nreport of ${c}`)).toBe(1);
    }
    expect(at(`report of ${a2}`)).toBeLessThan(at(sumB));
    expect(at(`report of ${b1}`)).toBeGreaterThan(at(sumB));
    // Delivered once each, and only what the text shows; the next settle owes nothing.
    expect(s.delivered).toHaveLength(2);
    expect([...((s.delivered[0] as string[] | undefined) ?? [])].sort()).toEqual([...all].sort());
    expect(s.delivered[1]).toHaveProperty("before");
    expect(s.waits).toHaveLength(2);
  });

  it("a wave summarised in an earlier settle prints only what is new: `wave A: 1 more in`", async () => {
    const a1 = mkDelegate(db, "pi:s", { wave: "A" });
    const a2 = mkDelegate(db, "pi:s", { wave: "A" });
    mk("t");
    registerOwnedWait(db, "pi:s", [taskRef("t")]);
    answer(db, a1, `VERDICT: CONFIRMED\nreport of ${a1}`);
    // The first settle's wave loop meets the close before a2 is in: summary so far, then the close.
    let n = 0;
    const s = settle(async (args, sid) => {
      if (++n === 2) close("t");
      if (n === 3) answer(db, a2, `VERDICT: REFUTED\nreport of ${a2}`);
      return mu(sid, args);
    });
    const t1 = (await s.emit())?.entries?.[0]?.content ?? "";
    expect(t1).toContain("It waited for wave A, which is not all in (below):");
    expect(t1).toContain("Wave A: 1/2 CONFIRMED, 0 REFUTED, 0 UNVERIFIED, 1 pending, 0 refused.");
    expect(t1).toContain("Another event came before the rest of wave A:");
    const t2 = (await s.emit())?.entries?.[0]?.content ?? "";
    // Not the whole wave again: the new answer, and the tally line.
    expect(t2).toContain(
      "It waited until wave A was in:\n\nwave A: 1 more in\nWave A: 1/2 CONFIRMED, 1 REFUTED, 0 UNVERIFIED, 0 pending, 0 refused.\n\nDelegate answer: call",
    );
    expect(t2).not.toContain(`(call ${a1})`);
    expect(t2).toContain(`report of ${a2}`);
    expect(t2).not.toContain(`report of ${a1}`);
    expect(s.delivered.slice(0, 2)).toEqual([[a1], [a2]]);
  });
});
