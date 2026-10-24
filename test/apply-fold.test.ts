// The fold (src/fold.ts) is the one definition of a portable row; a live
// apply re-folds the keys an op touches and rebuild folds every key. So
// live state == rebuild for EVERY arrival order of one op set.
//
//   1. Each reviewer repro from the sync-contract rounds, over all
//      arrival orders (24 or 6 of them).
//   2. A randomized property: 500 generated op sets (workstreams, tasks,
//      notes, edges; puts, partial puts, bad values, dels), each applied in a
//      random arrival order, must equal the whole-log projection; every
//      25th case also goes through the real rebuildInto + checkDrift.
//      Fixed seed, so a failure names a reproducible case.
//
// Fast tier: two temp DBs reused across cases (wiped between them).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Op, projectLog } from "../src/apply.js";
import { type Db, openDb } from "../src/db.js";
import { checkDrift } from "../src/drift.js";
import { formatHlc } from "../src/hlc.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import { applyIncomingOp } from "../src/segments.js";
import { rmFixtureDir } from "./_fs.js";

const A = "9f1c8a2e-0000-4000-8000-0000000000aa";
const B = "9f1c8a2e-0000-4000-8000-0000000000bb";
const BASE = 2_000_000_000_000;

let tempDir: string;
let live: Db;
let oracle: Db;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-fold-"));
  live = openDb({ path: join(tempDir, "live.db") });
  oracle = openDb({ path: join(tempDir, "oracle.db") });
});
afterAll(() => {
  live.close();
  oracle.close();
  rmFixtureDir(tempDir);
});

/** Empty every portable table and the log, unobserved by capture. */
const wipers = new WeakMap<Db, ReturnType<Db["prepare"]>[]>();
function wipe(db: Db): void {
  // Prepared once per DB: compiling the cascade/trigger programs of a bare
  // db.exec("DELETE FROM workstreams") costs ~3ms, 11s over the 500 cases.
  let stmts = wipers.get(db);
  if (!stmts) {
    stmts = [db.prepare("DELETE FROM workstreams"), db.prepare("DELETE FROM ops")];
    wipers.set(db, stmts);
  }
  const run = stmts;
  withCaptureSuppressed(db, () => {
    for (const s of run) s.run();
  });
}

/** The portable tables as comparable text, by natural key. */
function snapshot(db: Db): Record<string, unknown[]> {
  const all = (sql: string): unknown[] => db.prepare(sql).all();
  return {
    workstreams: all("SELECT name, created_at, torn_down_at FROM workstreams ORDER BY name"),
    tasks: all(
      `SELECT w.name AS ws, t.local_id, t.title, t.status, t.substate, t.impact, t.effort_days,
              t.scored, t.dispatch_host, t.created_at, t.updated_at
         FROM tasks t JOIN workstreams w ON w.id = t.workstream_id ORDER BY 1, 2`,
    ),
    notes: all(
      `SELECT w.name || '/' || t.local_id AS task, n.author, n.content, n.created_at, n.kind
         FROM task_notes n JOIN tasks t ON t.id = n.task_id
         JOIN workstreams w ON w.id = t.workstream_id
        ORDER BY 1, 2, 3, 4, 5`,
    ),
    edges: all(
      `SELECT wf.name || '/' || f.local_id AS blocker, wt.name || '/' || t.local_id AS blocked,
              e.created_at
         FROM task_edges e JOIN tasks f ON f.id = e.from_task_id JOIN tasks t ON t.id = e.to_task_id
         JOIN workstreams wf ON wf.id = f.workstream_id JOIN workstreams wt ON wt.id = t.workstream_id
        ORDER BY 1, 2`,
    ),
  };
}

function record(db: Db, ops: readonly Op[]): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'n')`,
  );
  for (const o of ops)
    ins.run(o.hlc, o.machineId, o.groupId, o.actor, o.entity, o.key, o.op, o.payload);
}

/** What the log says: the ops sorted by HLC, projected whole. */
function rebuilt(ops: readonly Op[]): Record<string, unknown[]> {
  wipe(oracle);
  record(
    oracle,
    [...ops].sort((a, b) => (a.hlc < b.hlc ? -1 : 1)),
  );
  projectLog(oracle);
  return snapshot(oracle);
}

function arrive(ops: readonly Op[]): Record<string, unknown[]> {
  wipe(live);
  for (const o of ops) applyIncomingOp(live, o);
  return snapshot(live);
}

let seq = 0;
function op(
  wall: number,
  entity: Op["entity"],
  kind: "put" | "del",
  key: string,
  payload: Record<string, unknown> = {},
  machineId = A,
  counter = 0,
): Op {
  return {
    hlc: formatHlc({ wallMs: BASE + wall, counter, machineId }),
    machineId,
    groupId: `g-${++seq}`,
    actor: "peer",
    intent: null,
    entity,
    key,
    op: kind,
    payload: JSON.stringify(payload),
  };
}

const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1
    ? [[...xs]]
    : xs.flatMap((x, i) =>
        permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
      );

const S = "2033-05-18T03:33:20.000Z";
const N = "2033-05-18T03:33:21.000Z";

describe("every arrival order folds to the rebuild (reviewer repros)", () => {
  const sets: Record<string, { ops: Op[]; check: (s: Record<string, unknown[]>) => void }> = {
    "task pair: a dead put's substate must not survive a restore (substate_tombstone_r2)": {
      ops: [
        op(1, "workstream", "put", "w", { created_at: S }),
        op(2, "task", "put", "w/a", {
          title: "a",
          status: "OPEN",
          substate: "triage",
          created_at: S,
          updated_at: S,
        }),
        op(3, "task", "del", "w/a"),
        op(4, "task", "put", "w/a", { title: "a", created_at: S, updated_at: S }),
      ],
      check: (s) => expect(s.tasks).toMatchObject([{ status: "OPEN", substate: "todo" }]),
    },
    "edge re-add carries the re-add's created_at (edge_timestamp_r2)": {
      ops: [
        op(1, "workstream", "put", "w", { created_at: S }),
        op(2, "task", "put", "w/a", { created_at: S, updated_at: S }),
        op(3, "task", "put", "w/b", { created_at: S, updated_at: S }),
        op(4, "edge", "put", "w/a->w/b", { created_at: S }),
        op(5, "edge", "del", "w/a->w/b"),
        op(6, "edge", "put", "w/a->w/b", { created_at: N }),
      ],
      check: (s) => expect(s.edges).toEqual([{ blocker: "w/a", blocked: "w/b", created_at: N }]),
    },
    "a restored workstream's created_at is log-derived, not 'now' (ws_created_at_restore_r2)": {
      ops: [
        op(1, "workstream", "put", "w", { created_at: S }),
        op(2, "workstream", "del", "w"),
        op(3, "workstream", "put", "w", { torn_down_at: null }),
      ],
      check: (s) =>
        expect(s.workstreams).toEqual([
          { name: "w", created_at: new Date(BASE + 3).toISOString(), torn_down_at: null },
        ]),
    },
    "a task put under a deleted workstream makes no row (parent_drift)": {
      ops: [
        op(1, "workstream", "put", "w", { created_at: S }),
        op(2, "task", "put", "w/a", { created_at: S, updated_at: S }),
        op(3, "workstream", "del", "w"),
        op(4, "task", "del", "w/a"),
      ],
      check: (s) => {
        expect(s.workstreams).toEqual([]);
        expect(s.tasks).toEqual([]);
      },
    },
    "a restored workstream drops the dead life's tasks (restore_interleaving)": {
      ops: [
        op(1, "workstream", "put", "w", { created_at: S }),
        op(2, "task", "put", "w/a", { title: "dead", created_at: S, updated_at: S }),
        op(3, "workstream", "del", "w"),
        op(5, "workstream", "put", "w", { created_at: S }, B),
      ],
      check: (s) => {
        expect(s.workstreams).toHaveLength(1);
        expect(s.tasks).toEqual([]);
      },
    },
    "an edge put before an endpoint's delete stays dead across the restore (sync_edge_horizon_test)":
      {
        ops: [
          op(1, "workstream", "put", "w", { created_at: S }),
          op(2, "task", "put", "w/a", { created_at: S, updated_at: S }),
          op(3, "task", "put", "w/b", { created_at: S, updated_at: S }),
          op(4, "edge", "put", "w/a->w/b", { created_at: S }),
          op(5, "task", "del", "w/a"),
          op(6, "task", "put", "w/a", { created_at: S, updated_at: S }),
        ],
        // The edge predates the delete of its blocker: it stays dead after the restore.
        check: (s) => expect(s.edges).toEqual([]),
      },
  };

  for (const [name, set] of Object.entries(sets)) {
    it(name, () => {
      const want = rebuilt(set.ops);
      set.check(want);
      for (const order of permutations(set.ops)) {
        expect(
          arrive(order),
          order.map((o) => `${o.entity}:${o.op}@${o.hlc.slice(9, 15)}`).join(" "),
        ).toEqual(want);
      }
    });
  }
});

// ─── the randomized property ──────────────────────────────────────────

/** mulberry32: a small, fixed-seed PRNG. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(rand: () => number): Op[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const chance = (p: number): boolean => rand() < p;
  const wss = ["w", "x"];
  const tasks = ["w/a", "w/b", "w/c", "x/a"];
  const stamps = [S, N, "2033-05-18T03:33:22.000Z"];
  const taskPayload = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    if (chance(0.5)) p.title = pick(["T1", "T2", "T3"]);
    if (chance(0.45)) p.status = pick(["OPEN", "IN_PROGRESS", "CLOSED", "DEFERRED", "BOGUS", 7]);
    if (chance(0.4))
      p.substate = pick(["todo", "triage", "parked", "doing", "done", "wontfix", "zzz"]);
    if (chance(0.3)) p.impact = pick([1, 40, 100, 0, 101, "x"]);
    if (chance(0.2)) p.effort_days = pick([0.5, 2, 0, -1]);
    if (chance(0.15)) p.scored = pick([0, 1, 7]);
    if (chance(0.15)) p.dispatch_host = pick(["h1", null]);
    if (chance(0.4)) p.created_at = pick(stamps);
    if (chance(0.4)) p.updated_at = pick(stamps);
    if (chance(0.1)) p.owner_id = 4242;
    if (chance(0.05)) p.future_column = { nested: true };
    return p;
  };
  const noteIdentity = (): Record<string, unknown> => ({
    author: pick(["p", "q", null]),
    content: pick(["c1", "c2", "c3"]),
    created_at: pick(stamps),
  });
  const n = 3 + Math.floor(rand() * 12);
  const walls = new Set<number>();
  const hlcs = new Set<string>();
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    let wall = 1 + Math.floor(rand() * (n + 4));
    // Mostly distinct walls; an occasional tie is broken by counter/machine.
    if (walls.has(wall) && chance(0.7)) wall += n + 5 + i;
    walls.add(wall);
    const machineId = pick([A, B]);
    let counter = Math.floor(rand() * 3);
    // An HLC names one op: never mint the same (wall, counter, machine) twice.
    while (hlcs.has(`${wall}/${counter}/${machineId}`)) counter += 1;
    hlcs.add(`${wall}/${counter}/${machineId}`);
    const r = rand();
    if (r < 0.14) {
      const p: Record<string, unknown> = {};
      if (chance(0.6)) p.created_at = pick(stamps);
      if (chance(0.3)) p.torn_down_at = pick([N, null]);
      ops.push(op(wall, "workstream", "put", pick(wss), p, machineId, counter));
    } else if (r < 0.2) {
      ops.push(op(wall, "workstream", "del", pick(wss), {}, machineId, counter));
    } else if (r < 0.46) {
      ops.push(op(wall, "task", "put", pick(tasks), taskPayload(), machineId, counter));
    } else if (r < 0.52) {
      ops.push(op(wall, "task", "del", pick(tasks), {}, machineId, counter));
    } else if (r < 0.7) {
      const key = `${pick(tasks)}#${pick(["1", "2", "9"])}`;
      const p = noteIdentity();
      if (chance(0.3)) p.kind = pick(["verdict", "brief", "telemetry"]);
      ops.push(op(wall, "note", "put", key, p, machineId, counter));
    } else if (r < 0.77) {
      const key = `${pick(tasks)}#${pick(["1", "2", "9"])}`;
      // Self-describing tombstone, or bare (names its note by the put under its key).
      ops.push(op(wall, "note", "del", key, chance(0.5) ? noteIdentity() : {}, machineId, counter));
    } else if (r < 0.92) {
      const key = `${pick(tasks)}->${pick(tasks)}`;
      ops.push(
        op(
          wall,
          "edge",
          "put",
          key,
          chance(0.7) ? { created_at: pick(stamps) } : {},
          machineId,
          counter,
        ),
      );
    } else {
      ops.push(op(wall, "edge", "del", `${pick(tasks)}->${pick(tasks)}`, {}, machineId, counter));
    }
  }
  if (chance(0.4)) {
    // An edge's life across an endpoint's delete/restore. Counter 7 keeps these
    // HLCs clear of the random ops above; the walls interleave with them.
    const w0 = 1 + Math.floor(rand() * (n + 4));
    const [from, to] = pick([
      ["w/a", "w/b"],
      ["w/b", "w/a"],
      ["w/a", "x/a"],
    ] as const);
    const victim = pick([from, to]);
    const m = pick([A, B]);
    const edge = `${from}->${to}`;
    ops.push(op(w0, "edge", "put", edge, { created_at: pick(stamps) }, m, 7));
    ops.push(op(w0 + 1, "task", "del", victim, {}, m, 7));
    if (chance(0.7))
      ops.push(op(w0 + 2, "task", "put", victim, { created_at: S, updated_at: S }, m, 7));
    if (chance(0.4)) ops.push(op(w0 + 3, "edge", "put", edge, { created_at: pick(stamps) }, m, 7));
  }
  return ops;
}

/** Independent of the fold: a live edge needs a put newer than every delete of
 *  itself, of either endpoint task, and of either endpoint's workstream. */
function edgeLivenessViolations(ops: readonly Op[], edges: unknown[]): string[] {
  const newestDel = (entity: Op["entity"], key: string): string =>
    ops
      .filter((o) => o.entity === entity && o.key === key && o.op === "del")
      .reduce((m, o) => (o.hlc > m ? o.hlc : m), "");
  const bad: string[] = [];
  for (const e of edges as { blocker: string; blocked: string }[]) {
    const key = `${e.blocker}->${e.blocked}`;
    const horizon = [
      newestDel("edge", key),
      newestDel("task", e.blocker),
      newestDel("task", e.blocked),
      newestDel("workstream", e.blocker.split("/")[0] as string),
      newestDel("workstream", e.blocked.split("/")[0] as string),
    ].reduce((m, h) => (h > m ? h : m), "");
    if (!ops.some((o) => o.entity === "edge" && o.key === key && o.op === "put" && o.hlc > horizon))
      bad.push(key);
  }
  return bad;
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe("randomized: live == rebuild (500 cases, fixed seed)", () => {
  const CASES = 500;
  it(`${CASES} generated op sets, each in a random arrival order and its reverse`, () => {
    const rand = prng(0x5eed);
    for (let c = 0; c < CASES; c++) {
      const ops = generate(rand);
      const want = rebuilt(ops);
      const order = shuffled(ops, rand);
      const label = `case ${c}: ${order.map((o) => `${o.entity}:${o.op}:${o.key}@${o.hlc.slice(9, 15)}`).join(" ")}`;
      expect(edgeLivenessViolations(ops, want.edges as unknown[]), label).toEqual([]);
      expect(arrive(order), label).toEqual(want);
      expect(arrive([...order].reverse()), `${label} (reversed)`).toEqual(want);
      if (c % 25 === 0) {
        // The real thing too: arrival into `live`, then rebuildInto + diff.
        arrive(order);
        const drift = checkDrift(live);
        expect(drift.records, label).toEqual([]);
      }
    }
  });
});
