// The ready batch (`mu wait --ready`, a7_ready_engine; proposal a7_wait_drain_rca_2 P1/P2 + r3
// D1/D2). One wait fires every ready, never-returned completion (up to READY_BATCH_MAX); an urgent
// event fires alone; a member another process consumed meanwhile is dropped, never printed twice.
// Snapshots mark what this result consumed (`delivered`) and what is still owed (`owed`).
// Real SQLite; agents scripted (no ctl, no mux).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MuResult } from "../extension/mu-run.js";
import { waitData } from "../src/cli/wait-output.js";
import { type Db, openDb } from "../src/db.js";
import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../src/output-contract.js";
import { addTask, closeTask } from "../src/tasks.js";
import {
  type AgentReading,
  setWaitSleepForTests,
  type WaitOptions,
  type WaitResult,
  type WaitSnapshot,
  waitForEvents,
} from "../src/wait.js";
import { cursorKey, DELEGATE_TOKEN, readCursors, recordCursors } from "../src/wait-cursor.js";
import type { Item } from "../src/wait-item.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { dropStale, READY_BATCH_MAX, selectEvent } from "../src/wait-select.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { runCliWire } from "./_runCli.js";
import {
  agentRef,
  answer,
  controllableWatch,
  mkAgent,
  mkDelegate,
  taskRef,
} from "./_wait-fixtures.js";

let dir: string;
let dbPath: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-ready-"));
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
const base = { pollMs: 1, sync: false, callers: ["c"], timeoutMs: 30 } as const;
const ready = { ...base, mode: "ready" } as const;
const ids = (refs: readonly { id: string }[]): string[] => refs.map((r) => r.id);
const evIds = (r: WaitResult): string[] => (r.events ?? []).map((e) => e.ref?.id ?? e.kind);
const closes = (names: readonly string[], caller = "c"): void => {
  for (const id of names) mk(id);
  registerOwnedWait(
    db,
    caller,
    names.map((id) => taskRef(id)),
  );
  for (const id of names) close(id);
};

describe("engine: a --ready wait fires every ready completion at once", () => {
  it("N <= cap closes: one result delivers all N, each a fired snapshot; then nothing is owed", async () => {
    closes(["a", "b", "c"]);
    const r = await waitForEvents(db, [], ready);
    expect(evIds(r)).toEqual(["a", "b", "c"]);
    expect(ids(r.delivered)).toEqual(["a", "b", "c"]);
    expect(r.refs.filter((s) => s.fired).map((s) => s.ref.id)).toEqual(["a", "b", "c"]);
    expect(r.owed).toBe(0);
    expect(readCursors(db, "c").size).toBe(3); // one cursor per member, no extra
    await expect(waitForEvents(db, [], ready)).rejects.toThrow(/nothing to wait/);
  });

  it(`cap+2 closes: ${READY_BATCH_MAX}, then 2; the first says 2 owed`, async () => {
    const names = Array.from({ length: READY_BATCH_MAX + 2 }, (_, i) => `t${i}`);
    closes(names);
    const r1 = await waitForEvents(db, [], ready);
    expect(evIds(r1)).toEqual(names.slice(0, READY_BATCH_MAX));
    expect(r1.owed).toBe(2);
    expect(r1.refs.filter((s) => s.owed === true).map((s) => s.ref.id)).toEqual(
      names.slice(READY_BATCH_MAX),
    );
    const r2 = await waitForEvents(db, [], ready);
    expect(evIds(r2)).toEqual(names.slice(READY_BATCH_MAX));
    expect(r2.owed).toBe(0);
  });

  it("mixed: delegate answers, closes and a settled run in one batch", async () => {
    mk("t1");
    mk("t2");
    mkAgent(db, "w1");
    registerOwnedWait(db, "c", [taskRef("t1"), taskRef("t2"), agentRef("w1")]);
    const d1 = mkDelegate(db, "c");
    answer(db, d1);
    close("t1");
    close("t2");
    const w = controllableWatch();
    const settled: AgentReading = {
      status: "needs_input",
      settled: true,
      incarnation: "i1",
      runs: 1,
      lastText: "done",
    };
    w.settle(settled);
    const r = await waitForEvents(db, [], {
      ...ready,
      applyClose: false,
      readAgents: async () => new Map(),
      watchAgent: async () => w.handle,
    });
    expect((r.events ?? []).map((e) => e.kind).sort()).toEqual([
      "closed",
      "closed",
      "delegate",
      "settled",
    ]);
    expect(ids(r.delivered).sort()).toEqual([d1, "t1", "t2", "w1"].sort());
  });

  it("an urgent dialog fires alone (exit 7); the completions follow in the next --ready", async () => {
    closes(["a", "b"]);
    mkAgent(db, "dlg");
    registerOwnedWait(db, "c", [agentRef("dlg")]);
    const readAgents = async (): Promise<Map<string, AgentReading>> =>
      new Map<string, AgentReading>([
        [
          "w/dlg",
          {
            status: "needs_permission",
            blocked: { kind: "confirm", title: "?", since: 1 } as never,
            incarnation: "i",
            runs: 0,
          },
        ],
      ]);
    const r1 = await waitForEvents(db, [], { ...ready, readAgents });
    expect(r1.event.kind).toBe("input");
    expect(r1.exit).toBe(7);
    expect(evIds(r1)).toEqual(["dlg"]);
    expect(r1.delivered).toEqual([]);
    // The urgent firing gets no mark; the closes it did not consume are owed.
    expect(r1.refs.find((s) => s.ref.id === "dlg")?.owed).toBeUndefined();
    expect(r1.owed).toBe(2);
    // A seen, unchanged dialog never joins (and never outranks): the closes come out together.
    const r2 = await waitForEvents(db, [], { ...ready, readAgents });
    expect(evIds(r2)).toEqual(["a", "b"]);
    expect(r2.exit).toBe(0);
  });

  it("an explicit target not ready plus 3 owned answers: one result with the 3; the target stays owed", async () => {
    mk("goal");
    const calls = [mkDelegate(db, "c"), mkDelegate(db, "c"), mkDelegate(db, "c")];
    for (const c of calls) answer(db, c);
    const r = await waitForEvents(db, [taskRef("goal")], ready);
    expect(evIds(r)).toEqual(calls);
    expect(ids(r.delivered)).toEqual(calls);
    expect(r.refs.find((s) => s.ref.id === "goal")).toMatchObject({ fired: false });
    // The target is not delivered: a resume still waits on it.
    expect(ids(r.delivered)).not.toContain("goal");
  });

  it("--wave plus --ready: every answered call of the wave in one result, with the tally", async () => {
    const calls = [
      mkDelegate(db, "c", { wave: "A" }),
      mkDelegate(db, "c", { wave: "A" }),
      mkDelegate(db, "c", { wave: "A" }),
    ];
    answer(db, calls[0] as string);
    answer(db, calls[1] as string);
    const r = await waitForEvents(db, [], { ...ready, wave: { name: "A" } });
    expect(evIds(r)).toEqual(calls.slice(0, 2));
    expect(r.tally?.findings.length).toBeGreaterThan(0);
  });

  it("first mode is unchanged: one event, no `events`, its siblings marked owed (D1)", async () => {
    closes(["a", "b", "c"]);
    const r = await waitForEvents(db, [], base);
    expect(r.events).toBeUndefined();
    expect(ids(r.delivered)).toEqual(["a"]);
    expect(r.refs.filter((s) => s.owed === true).map((s) => s.ref.id)).toEqual(["b", "c"]);
    expect(r.owed).toBe(2);
  });
});

describe("selectEvent: urgent items never batch", () => {
  const item = (id: string, kind: Item["kind"], order: number, over: Partial<Item> = {}): Item => {
    const ref = { kind: "task" as const, workstream: "w", id };
    return {
      key: `task:w/${id}`,
      ref,
      snap: { ref, status: "CLOSED", fired: true, dead: false },
      target: false,
      suppressible: true,
      order,
      ...(kind !== undefined ? { kind } : {}),
      done: true,
      ready: true,
      ...over,
    };
  };
  for (const kind of ["dead", "input", "stall"] as const) {
    it(`a ${kind} best fires alone; a ${kind} behind a completion never joins its batch`, () => {
      const urgentFirst = selectEvent([item("u", kind, 0), item("a", "closed", 1)], "ready");
      expect(urgentFirst?.fired.map((i) => i.ref.id)).toEqual(["u"]);
      // Seen urgent news ranks behind never-returned completions: it must stay out of the batch.
      const behind = selectEvent(
        [item("a", "closed", 0), item("u", kind, 1, { seen: true }), item("b", "closed", 2)],
        "ready",
      );
      expect(behind?.fired.map((i) => i.ref.id)).toEqual(["a", "b"]);
    });
  }
  it("a seen completion never joins", () => {
    const r = selectEvent(
      [item("a", "closed", 0), item("b", "closed", 1, { seen: true })],
      "ready",
    );
    expect(r?.fired.map((i) => i.ref.id)).toEqual(["a"]);
  });

  // Review note (delegate_rv-a7rea): a companion has its own token. A wait that saw only it (an
  // explicit wait on the task a settled run closed) consumes it alone, so the guard re-checks it.
  it("dropStale re-checks companions: a stale companion is dropped, its group's live member stays", () => {
    const ev = item("e", "closed", 0);
    const evComp = item("ec", "closed", 1);
    const head = item("h", "closed", 2);
    const comp = item("hc", "closed", 3);
    const gone = item("g", "closed", 4);
    const chosen = {
      event: ev,
      fired: [ev, evComp, head, comp, gone],
      groups: [[ev, evComp], [head, comp], [gone]],
    };
    const staleSet = new Set([evComp, comp, gone]);
    const kept = dropStale(chosen, (i) => i !== undefined && staleSet.has(i));
    expect(kept.event).toBe(ev);
    expect(kept.groups.map((g) => g.map((i) => i.ref.id))).toEqual([["e"], ["h"]]);
    expect(kept.fired.map((i) => i.ref.id)).toEqual(["e", "h"]);
    // Another wait's delivery: not ready here, so never marked owed.
    expect([evComp, comp, gone].map((i) => i.ready)).toEqual([false, false, false]);
    expect([ev, head].map((i) => i.ready)).toEqual([true, true]);
  });
});

describe("the per-member commit guard (concurrency)", () => {
  it("a member another process consumed between the pick and the commit is dropped, never printed twice", async () => {
    const calls = [mkDelegate(db, "c"), mkDelegate(db, "c"), mkDelegate(db, "c")];
    for (const c of calls) answer(db, c);
    const theirs = calls[1] as string;
    let once = false;
    const r = await waitForEvents(db, [], {
      ...ready,
      // Runs after this wait's picture and before its commit: another process consumes c2.
      onPicture: () => {
        if (once) return;
        once = true;
        recordCursors(db, "c", [
          { key: cursorKey("delegate", "scratch", theirs), token: DELEGATE_TOKEN },
        ]);
      },
    });
    expect(evIds(r)).toEqual([calls[0], calls[2]]);
    expect(ids(r.delivered)).toEqual([calls[0], calls[2]]);
    // Not owed either: it is the other wait's delivery.
    expect(r.refs.find((s) => s.ref.id === theirs)?.owed).toBeUndefined();
    expect(r.owed).toBe(0);
  });

  it("a superseded --ready batch keeps superseded:true, delivers nothing and marks every member owed (D2)", async () => {
    closes(["a", "b"]);
    const { beginWait } = await import("../src/wait-registration.js");
    const r = await waitForEvents(db, [], {
      ...ready,
      beforePoll: async () => {
        beginWait(db, "c");
      },
    });
    expect(r.superseded).toBe(true);
    expect(r.eventConsumed).toBe(false);
    expect(r.delivered).toEqual([]);
    expect(r.refs.filter((s) => s.owed === true).map((s) => s.ref.id)).toEqual(["a", "b"]);
    expect(readCursors(db, "c").size).toBe(0);
    // The newer wait delivers each member once.
    const next = await waitForEvents(db, [], ready);
    expect(evIds(next)).toEqual(["a", "b"]);
  });
});

/** A small seeded PRNG (mulberry32): the property test is reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: --ready waits over a random mix deliver each completion exactly once and lose none", () => {
  for (const seed of [1, 2, 3, 7, 42, 1234]) {
    it(`seed ${seed}`, async () => {
      const rand = rng(seed);
      const tasks = Array.from({ length: 8 }, (_, i) => `t${i}`);
      for (const id of tasks) mk(id);
      registerOwnedWait(
        db,
        "c",
        tasks.map((t) => taskRef(t)),
      );
      mkAgent(db, "dlg");
      registerOwnedWait(db, "c", [agentRef("dlg")]);
      const calls = Array.from({ length: 6 }, () => mkDelegate(db, "c"));
      let since = 1;
      let inputs = 0;
      const readAgents: WaitOptions["readAgents"] = async () =>
        new Map<string, AgentReading>([
          [
            "w/dlg",
            {
              status: "needs_permission",
              blocked: { kind: "confirm", title: "?", since } as never,
              incarnation: "i",
              runs: 0,
            },
          ],
        ]);
      const open = (id: string): boolean =>
        db.prepare("SELECT 1 FROM tasks WHERE local_id = ? AND status <> 'CLOSED'").get(id) !==
        undefined;
      const unanswered = (c: string): boolean =>
        db
          .prepare(
            "SELECT 1 FROM delegate_calls WHERE call_id = ? AND state NOT IN ('done','failed','cancelled','timed_out')",
          )
          .get(c) !== undefined;
      const pending = new Set([...tasks, ...calls]);
      const seen: string[] = [];
      const take = (r: WaitResult): void => {
        if (r.event.kind === "input") {
          inputs++;
          expect(r.events?.length).toBe(1); // urgent fires alone
          return;
        }
        // What the result consumed is what it names: `delivered` == the events' refs.
        expect(ids(r.delivered).sort()).toEqual(evIds(r).sort());
        expect((r.events ?? []).length).toBeLessThanOrEqual(READY_BATCH_MAX);
        for (const id of ids(r.delivered)) {
          seen.push(id);
          expect(pending.delete(id), `${id} delivered twice or never due`).toBe(true);
        }
      };
      for (let i = 0; i < 60; i++) {
        for (let k = Math.floor(rand() * 4); k > 0; k--) {
          const roll = rand();
          const t = tasks[Math.floor(rand() * tasks.length)] as string;
          const c = calls[Math.floor(rand() * calls.length)] as string;
          if (roll < 0.45) {
            if (open(t)) close(t);
          } else if (roll < 0.9) {
            if (unanswered(c)) answer(db, c);
          } else since++; // the dialog changes: news again
        }
        const r = await waitForEvents(db, [], { ...ready, timeoutMs: 8, readAgents });
        if (r.event.kind !== "heartbeat") take(r);
      }
      for (const t of tasks) if (open(t)) close(t);
      for (const c of calls) if (unanswered(c)) answer(db, c);
      for (let i = 0; i < 20 && pending.size > 0; i++) {
        const r = await waitForEvents(db, [], { ...ready, timeoutMs: 8, readAgents });
        if (r.event.kind !== "heartbeat") take(r);
      }
      expect([...pending]).toEqual([]);
      expect(seen).toHaveLength(tasks.length + calls.length);
      expect(inputs).toBeGreaterThan(0);
    });
  }
});

// ─── the CLI result ────────────────────────────────────────────────

/** `mu <argv>` in-process with `env` (pi session `s` unless overridden). */
async function mu(argv: readonly string[], env: Record<string, string | undefined> = {}) {
  let r: MuResult = { code: 1, stdout: "", stderr: "no capture" };
  const all = { PI_SESSION_ID: "s", MU_MANAGED_AGENT: undefined, ...env };
  const keys = Object.keys(all);
  const run = async (i: number): Promise<void> => {
    const k = keys[i];
    if (k === undefined) {
      const c = await runCliWire(argv, dbPath);
      r = { code: c.exitCode ?? 0, stdout: c.stdout, stderr: c.stderr };
      return;
    }
    await withEnv(k, all[k as keyof typeof all], () => run(i + 1));
  };
  await run(0);
  return r;
}
type Snap = { ref: string; delivered?: boolean; owed?: boolean } & Record<string, unknown>;
type Doc = {
  data: {
    firing?: { kind?: string; ref?: string | null };
    events?: { kind: string; ref: string }[];
    owed?: number;
    reason?: string;
    notices?: string[];
    snapshots?: Snap[];
    snapshotsCut?: number;
  } & Record<string, unknown>;
  next: { commands: string[] } | null;
};
const doc = (r: MuResult): Doc => JSON.parse(r.stdout) as Doc;

describe("CLI: mu wait --ready", () => {
  it("`events` comes right after `firing`; reason has one phrase per event; marks on the snapshots", async () => {
    closes(["a", "b"], "pi:s");
    const out = await mu(["wait", "--ready", "--timeout", "1", "--json"]);
    expect(out.code, out.stderr).toBe(0);
    const d = doc(out).data;
    expect(Object.keys(d).slice(0, 2)).toEqual(["firing", "events"]);
    expect(d.events?.map((e) => e.ref)).toEqual(["task:w/a", "task:w/b"]);
    expect(d.reason).toBe("2 events: task w/a is CLOSED; task w/b is CLOSED");
    expect(d.snapshots?.filter((s) => s.delivered === true).map((s) => s.ref)).toEqual([
      "task:w/a",
      "task:w/b",
    ]);
    expect(d.owed).toBe(0);
    expect(doc(out).next?.commands ?? []).not.toContain("mu wait --ready");
  });

  it("a first wait over 3 closes marks 1 delivered and 2 owed, and its next is the ready batch (D1)", async () => {
    closes(["a", "b", "c"], "pi:s");
    const out = await mu(["wait", "-w", "w", "--timeout", "1", "--json"]);
    const d = doc(out).data;
    expect(d.firing?.ref).toBe("task:w/a");
    const mark = (s: Snap) => (s.delivered ? "delivered" : s.owed ? "owed" : "-");
    expect(d.snapshots?.map((s) => `${s.ref}=${mark(s)}`)).toEqual([
      "task:w/a=delivered",
      "task:w/b=owed",
      "task:w/c=owed",
    ]);
    expect(d.owed).toBe(2);
    expect(doc(out).next?.commands[0]).toBe("mu wait --ready -w w");
    expect(d.notices?.[0]).toBe("2 owed: mu wait --ready -w w");
  });

  it("cap+2: the first result says 2 owed and names the ready batch; the second has none", async () => {
    const names = Array.from({ length: READY_BATCH_MAX + 2 }, (_, i) => `t${i}`);
    closes(names, "pi:s");
    const first = doc(await mu(["wait", "--ready", "-w", "w", "--timeout", "1", "--json"]));
    expect(first.data.events).toHaveLength(READY_BATCH_MAX);
    expect(first.data.owed).toBe(2);
    expect(first.data.notices?.[0]).toBe("2 owed: mu wait --ready -w w");
    const second = doc(await mu(["wait", "--ready", "-w", "w", "--timeout", "1", "--json"]));
    expect(second.data.events).toHaveLength(2);
    expect(second.data.owed).toBe(0);
    expect(second.data.notices ?? []).toEqual([]);
  });

  // Review probes P2/P5 (delegate_rv-a7rea): an explicit wait whose owed news is unowned targets.
  // A bare `--ready` watches only what the caller owns, so it would never return them: `next` is
  // the resume, which does.
  it("P2: `mu wait a b`, both closed, unowned: next is the resume, and following it returns b", async () => {
    mk("a");
    mk("b");
    close("a");
    close("b");
    const out = await mu(["wait", "task:w/a", "task:w/b", "--timeout", "1", "--json"]);
    expect(out.code, out.stderr).toBe(0);
    const d = doc(out);
    expect(d.data.firing?.ref).toBe("task:w/a");
    const next = d.next?.commands[0] ?? "";
    expect(next).toMatch(/^mu wait --resume \S+$/);
    expect(d.data.notices ?? []).not.toContainEqual(
      expect.stringContaining("owed: mu wait --ready"),
    );
    const again = doc(await mu([...next.split(" ").slice(1), "--json"]));
    expect(again.data.firing?.ref).toBe("task:w/b");
  });

  it("P5: `mu wait a b c -w w`, a and b closed, c open: next is the resume, which returns b", async () => {
    for (const id of ["a", "b", "c"]) mk(id);
    close("a");
    close("b");
    const out = await mu([
      "wait",
      "task:w/a",
      "task:w/b",
      "task:w/c",
      "-w",
      "w",
      "--timeout",
      "1",
      "--json",
    ]);
    expect(out.code, out.stderr).toBe(0);
    const d = doc(out);
    expect(d.data.firing?.ref).toBe("task:w/a");
    const next = d.next?.commands[0] ?? "";
    expect(next).toMatch(/^mu wait --resume \S+ -w w$/);
    const again = doc(await mu([...next.split(" ").slice(1), "--json"]));
    expect(again.data.firing?.ref).toBe("task:w/b");
  });

  it("--ready with --first or --all is a usage error", async () => {
    for (const other of ["--first", "--all"]) {
      const out = await mu(["wait", "--ready", other, "--json"]);
      expect(out.code).toBe(2);
      expect(out.stdout).toContain("--ready");
    }
  });

  it("the resume handle stores the mode: --resume of a --ready wait is a ready batch", async () => {
    mk("goal");
    const out = doc(await mu(["wait", "task:w/goal", "--ready", "--timeout", "0.05", "--json"]));
    const resume = String(out.data.resume ?? "");
    const id = resume.split(" ")[3] ?? "";
    expect(id).not.toBe("");
    const row = db.prepare("SELECT spec_json FROM wait_resumes WHERE id = ?").get(id) as {
      spec_json: string;
    };
    expect(JSON.parse(row.spec_json).mode).toBe("ready");
  });

  it("as a managed claude caller: --ready over 3 answers and 2 closes is one result; an explicit wait returns them at once", async () => {
    const env = {
      PI_SESSION_ID: undefined,
      MU_MANAGED_AGENT: "1",
      MU_WORKSTREAM: "w",
      MU_AGENT_NAME: "orch",
    };
    mkAgent(db, "orch", "w", "claude");
    closes(["c1", "c2"], "w/orch");
    const calls = [
      mkDelegate(db, "w/orch", { record: { workstream: "w", task: "c1" } }),
      mkDelegate(db, "w/orch", { record: { workstream: "w", task: "c1" } }),
      mkDelegate(db, "w/orch", { record: { workstream: "w", task: "c1" } }),
    ];
    for (const c of calls) answer(db, c);
    const out = await mu(["wait", "--ready", "-w", "w", "--timeout", "1", "--json"], env);
    expect(out.code, out.stderr).toBe(0);
    const d = doc(out).data;
    expect(d.events?.map((e) => e.ref).sort()).toEqual(
      [...calls.map((c) => `delegate:${c}`), "task:w/c1", "task:w/c2"].sort(),
    );
    expect(d.owed).toBe(0);
    // A default explicit wait on an open task with answers ready returns at once (no holding)...
    mk("goal");
    const more = [
      mkDelegate(db, "w/orch", { record: { workstream: "w", task: "c1" } }),
      mkDelegate(db, "w/orch", { record: { workstream: "w", task: "c1" } }),
    ];
    for (const c of more) answer(db, c);
    const exp = doc(await mu(["wait", "task:w/goal", "-w", "w", "--timeout", "1", "--json"], env));
    expect(exp.data.firing?.ref).toBe(`delegate:${more[0]}`);
    // ...and its next names the ready batch for the answer it left.
    expect(exp.data.owed).toBe(1);
    expect(exp.next?.commands[0]).toBe("mu wait --ready -w w");
  });
});

describe("CLI output: a full batch is never paged", () => {
  const longId = (n: number) => `pi:01a1b5b2-9a68-7403-bf5d-53dd94ca2a00:db41a2-${10 + n}`;
  const snap = (ref: WaitSnapshot["ref"], over: Partial<WaitSnapshot> = {}): WaitSnapshot => ({
    ref,
    status: "done",
    fired: true,
    dead: false,
    ...over,
  });
  it(`${READY_BATCH_MAX} worst-case members with 3 KB texts and 40 open refs: every member printed`, () => {
    const members = Array.from({ length: READY_BATCH_MAX }, (_, i) =>
      i % 2 === 0
        ? { kind: "delegate" as const, workstream: "scratch", id: longId(i) }
        : { kind: "agent" as const, workstream: "a-rather-long-workstream", id: `worker-${i}` },
    );
    const open = Array.from({ length: 40 }, (_, i) =>
      snap(
        { kind: "task", workstream: "a-rather-long-workstream", id: `open-task-number-${i}` },
        { status: "IN_PROGRESS", fired: false, owner: `worker-${i}` },
      ),
    );
    const result: WaitResult = {
      event: { kind: "delegate", ref: members[0] ?? null },
      events: members.map((ref) => ({ kind: ref.kind === "agent" ? "settled" : "delegate", ref })),
      // The members after the open refs: paging must still keep them.
      refs: [
        ...open,
        ...members.map((ref) =>
          snap(ref, {
            ...(ref.kind === "delegate"
              ? {
                  verdict: "CONFIRMED",
                  record: "a-rather-long-workstream/some-task",
                  callTask: "delegate_x",
                }
              : { lastText: "x".repeat(3000), runs: 2 }),
          }),
        ),
      ],
      owed: 0,
      delivered: members,
      timedOut: false,
      interrupted: false,
      exit: 0,
      cursor: {},
      humanNeeds: [],
    };
    const d = waitData({
      result,
      exit: 0,
      resume: "mu wait --resume 0123456789 -w a-rather-long-workstream",
    });
    expect(Buffer.byteLength(encodeEnvelope(okEnvelope(d)))).toBeLessThanOrEqual(RESULT_BYTES);
    const shown = (d.snapshots as Snap[]).map((s) => s.ref);
    for (const m of members) {
      const ref = m.kind === "delegate" ? `delegate:${m.id}` : `${m.kind}:${m.workstream}/${m.id}`;
      expect(shown).toContain(ref);
    }
    expect(d.snapshotsCut).toBeGreaterThan(0); // the open refs were paged instead
  });
});
