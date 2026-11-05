// Recorded checks (spec D5, D8; U11): `mu task check` / `mu task verdict`,
// the portable `checks` table, the `--if-ready` rule and the re-fold of
// stored `check` ops inside upgradeSchema.
//
//   1. The SDK: ULID ids, the captured ops, refusals.
//   2. The fold and apply: every arrival order of a check's ops (a verdict
//      before its brief included) equals the whole-log projection; a task's
//      horizon kills its checks; a check before its task lands with the task.
//   3. The upgrade: a v13 file from before `checks` (the populated fixture)
//      that recorded a peer's check ops gains the rows at open, verdicts that
//      arrived out of hlc order included; schema 13, segment format unchanged.
//   4. `--if-ready` waits for a missing verdict; `mu state` lists the
//      unanswered check for an orchestrator with no identity of the issuer.

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyOp, type Op, projectLog } from "../src/apply.js";
import { CAPTURE_VERSION, GUARD_CHECK_ID } from "../src/capture.js";
import {
  CheckArgError,
  CheckNotFoundError,
  issueCheck,
  listChecks,
  newCheckId,
  recordCheckVerdict,
} from "../src/checks.js";
import { setStdinReaderForTests } from "../src/cli/stdin.js";
import {
  CURRENT_SCHEMA_VERSION,
  type Db,
  openDb,
  SYNCED_ENTITIES,
  upgradeSchema,
} from "../src/db.js";
import { checkCheapDriftInvariant, checkDrift } from "../src/drift.js";
import { foldCheck } from "../src/fold.js";
import { formatHlc } from "../src/hlc.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import { decodeLine, encodeSegmentLine, SEGMENT_FORMAT_VERSION } from "../src/segments.js";
import { stateSnapshot } from "../src/state.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addTask } from "../src/tasks/edit.js";
import { closeTask, deleteTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson, runCliWire } from "./_runCli.js";

const PEER = "9f1c8a2e-0000-4000-8000-0000000000aa";
const PEER2 = "9f1c8a2e-0000-4000-8000-0000000000bb";
const BASE = 2_000_000_000_000;
const ID = "01JC0000000000000000000000";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let dir: string;
let n = 0;
let open: Db[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-checks-"));
  writeFileSync(
    join(dir, "v13.db"),
    gunzipSync(readFileSync(join(__dirname, "fixtures", "v13-populated.db.gz"))),
  );
});
afterAll(() => rmFixtureDir(dir));
afterEach(() => {
  for (const d of open) {
    try {
      d.close();
    } catch {}
  }
  open = [];
});

const track = (d: Db): Db => {
  open.push(d);
  return d;
};
const fresh = (): Db => track(openDb({ path: join(dir, `fresh-${++n}.db`) }));

/** A workstream `d` with tasks `a` and an umbrella `u` that `a` blocks. */
function seeded(): Db {
  const db = fresh();
  ensureWorkstream(db, "d");
  addTask(db, { workstream: "d", localId: "a", title: "a" });
  addTask(db, { workstream: "d", localId: "u", title: "umbrella" });
  addBlockEdge(db, "d", "u", "a");
  return db;
}

const checkOps = (db: Db) =>
  db
    .prepare("SELECT key, op, payload, intent FROM ops WHERE entity = 'check' ORDER BY seq")
    .all() as { key: string; op: string; payload: string; intent: string | null }[];

let seq = 0;
function op(
  wall: number,
  entity: string,
  kind: "put" | "del",
  key: string,
  payload: Record<string, unknown> = {},
  machineId = PEER,
): Op {
  return {
    hlc: formatHlc({ wallMs: BASE + wall, counter: 0, machineId }),
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

/** A peer's task `d/a` (and its workstream), then a check on it. */
const TASK = op(1, "task", "put", "d/a", { title: "a", status: "OPEN", substate: "todo" });
const ISSUE = op(2, "check", "put", `d/a#${ID}`, {
  checker: "claude/opus",
  brief: "is it right?",
  verdict: null,
  state: "open",
  created_at: "2033-05-18T03:33:20.002Z",
  updated_at: "2033-05-18T03:33:20.002Z",
});
const VERDICT = op(3, "check", "put", `d/a#${ID}`, {
  verdict: "VERDICT: REFUTED\nEVIDENCE: line 3",
  state: "answered",
  updated_at: "2033-05-18T03:33:20.003Z",
});

function record(db: Db, ops: readonly Op[]): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'n')`,
  );
  for (const o of ops)
    ins.run(o.hlc, o.machineId, o.groupId, o.actor, o.entity, o.key, o.op, o.payload);
}

/** Record AND apply, as ingest does. */
function arrive(db: Db, ops: readonly Op[]): void {
  for (const o of ops) {
    applyOp(db, o);
    record(db, [o]);
  }
}

const rows = (db: Db) =>
  db
    .prepare(
      "SELECT id, task_id, checker, brief, verdict, state, created_at, updated_at FROM checks ORDER BY id",
    )
    .all();

const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1
    ? [[...xs]]
    : xs.flatMap((x, i) =>
        permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
      );

// ─── 1. The SDK ───────────────────────────────────────────────────────

describe("newCheckId", () => {
  it("is a 26-character Crockford ULID whose prefix sorts by time", () => {
    const zero = new Uint8Array(10);
    expect(newCheckId(0, zero)).toBe("0".repeat(26));
    expect(newCheckId(1, zero)).toBe(`${"0".repeat(9)}1${"0".repeat(16)}`);
    expect(newCheckId(0, new Uint8Array(10).fill(255))).toBe(`${"0".repeat(10)}${"Z".repeat(16)}`);
    const a = newCheckId(BASE);
    const b = newCheckId(BASE + 1);
    expect(a).toMatch(ULID_RE);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => newCheckId(BASE))).size).toBe(200);
  });
});

describe("issueCheck / recordCheckVerdict", () => {
  it("record the brief and the verdict as captured check ops under <task>#<ulid>", () => {
    const db = seeded();
    const c = issueCheck(db, "a", { workstream: "d", by: "codex/gpt-5", brief: "B", author: "o" });
    expect(c).toMatchObject({ task: "a", by: "codex/gpt-5", brief: "B", verdict: null });
    expect(c.state).toBe("open");
    expect(c.id).toMatch(ULID_RE);
    const r = recordCheckVerdict(db, "a", {
      workstream: "d",
      check: c.id.toLowerCase(),
      verdict: "VERDICT: CONFIRMED\nEVIDENCE: ran it\n\n",
    });
    expect(r).toMatchObject({ changed: true, replaced: false });
    expect(r.check).toMatchObject({ label: "CONFIRMED", state: "answered" });
    expect(r.check.verdict).toBe("VERDICT: CONFIRMED\nEVIDENCE: ran it");

    const ops = checkOps(db);
    expect(ops.map((o) => [o.key, o.op, o.intent])).toEqual([
      [`d/a#${c.id}`, "put", "check.issue"],
      [`d/a#${c.id}`, "put", "check.verdict"],
    ]);
    expect(JSON.parse(ops[0]?.payload ?? "{}")).toMatchObject({
      checker: "codex/gpt-5",
      brief: "B",
    });
    // The verdict op carries only what changed: per-field merge with a peer.
    expect(Object.keys(JSON.parse(ops[1]?.payload ?? "{}")).sort()).toEqual([
      "state",
      "updated_at",
      "verdict",
    ]);
    expect(checkDrift(db).clean).toBe(true);
  });

  it("the same verdict again writes nothing; a different one replaces it", () => {
    const db = seeded();
    const c = issueCheck(db, "a", { workstream: "d", by: "claude/opus", brief: "B" });
    const v = { workstream: "d", check: c.id, verdict: "VERDICT: REFUTED" };
    recordCheckVerdict(db, "a", v);
    expect(recordCheckVerdict(db, "a", v)).toMatchObject({ changed: false, replaced: false });
    expect(checkOps(db)).toHaveLength(2);
    const again = recordCheckVerdict(db, "a", { ...v, verdict: "VERDICT: CONFIRMED" });
    expect(again).toMatchObject({ changed: true, replaced: true });
    expect(again.check.label).toBe("CONFIRMED");
  });

  it("refuses a bad --by, an empty brief, a verdict with no VERDICT line, and a check of another task", () => {
    const db = seeded();
    for (const by of ["opus", "gpt/x", "claude/", "claude/a b"]) {
      expect(() => issueCheck(db, "a", { workstream: "d", by, brief: "B" })).toThrow(CheckArgError);
    }
    expect(() => issueCheck(db, "a", { workstream: "d", by: "pi/m", brief: "  " })).toThrow(
      CheckArgError,
    );
    const c = issueCheck(db, "a", { workstream: "d", by: "muse/m", brief: "B" });
    expect(() =>
      recordCheckVerdict(db, "a", { workstream: "d", check: c.id, verdict: "looks fine" }),
    ).toThrow(CheckArgError);
    expect(() =>
      recordCheckVerdict(db, "u", { workstream: "d", check: c.id, verdict: "VERDICT: REFUTED" }),
    ).toThrow(CheckNotFoundError);
    expect(listChecks(db, "d", { open: true }).map((x) => x.id)).toEqual([c.id]);
    expect(checkOps(db)).toHaveLength(1);
  });

  it("deleting the task tombstones its checks", () => {
    const db = seeded();
    const c = issueCheck(db, "a", { workstream: "d", by: "claude/opus", brief: "B" });
    deleteTask(db, "a", "d");
    expect(rows(db)).toEqual([]);
    expect(checkOps(db).map((o) => [o.key, o.op])).toEqual([
      [`d/a#${c.id}`, "put"],
      [`d/a#${c.id}`, "del"],
    ]);
  });
});

// ─── 2. Fold and apply ────────────────────────────────────────────────

describe("the check fold", () => {
  it("every arrival order of task, brief and verdict lands the projected row", () => {
    const oracle = fresh();
    record(oracle, [TASK, ISSUE, VERDICT]);
    projectLog(oracle);
    const want = rows(oracle).map((r) => ({ ...(r as object), task_id: undefined }));
    expect(want).toEqual([
      expect.objectContaining({
        id: ID,
        checker: "claude/opus",
        brief: "is it right?",
        verdict: "VERDICT: REFUTED\nEVIDENCE: line 3",
        state: "answered",
      }),
    ]);
    for (const order of permutations([TASK, ISSUE, VERDICT])) {
      const db = fresh();
      arrive(db, order);
      expect(rows(db).map((r) => ({ ...(r as object), task_id: undefined }))).toEqual(want);
    }
  });

  it("a verdict alone is answered with no brief yet; the brief fills in when it arrives", () => {
    const db = fresh();
    arrive(db, [TASK, VERDICT]);
    expect(rows(db)).toEqual([
      expect.objectContaining({ brief: "", checker: "", state: "answered" }),
    ]);
    arrive(db, [ISSUE]);
    expect(rows(db)).toEqual([
      expect.objectContaining({ brief: "is it right?", checker: "claude/opus", state: "answered" }),
    ]);
  });

  it("concurrent verdicts from two machines: the later hlc wins in either order", () => {
    const late = op(4, "check", "put", `d/a#${ID}`, { verdict: "VERDICT: CONFIRMED" }, PEER2);
    for (const order of [
      [VERDICT, late],
      [late, VERDICT],
    ]) {
      const db = fresh();
      arrive(db, [TASK, ISSUE, ...order]);
      expect(rows(db)).toEqual([expect.objectContaining({ verdict: "VERDICT: CONFIRMED" })]);
    }
  });

  it("a task or check del kills it; a put after the del brings it back", () => {
    expect(
      foldCheck([ISSUE, VERDICT], formatHlc({ wallMs: BASE + 3, counter: 0, machineId: PEER })),
    ).toBeNull();
    const del = op(5, "check", "del", `d/a#${ID}`);
    expect(foldCheck([ISSUE, VERDICT, del], null)).toBeNull();
    const again = op(6, "check", "put", `d/a#${ID}`, { brief: "again" });
    expect(foldCheck([ISSUE, VERDICT, del, again], null)).toMatchObject({
      brief: "again",
      checker: "",
      verdict: null,
      state: "open",
    });
    const db = fresh();
    arrive(db, [TASK, ISSUE, op(7, "task", "del", "d/a")]);
    expect(rows(db)).toEqual([]);
  });

  it("a check key that is not <task>#<id> is a no-op, never a malformed-key error", () => {
    const db = fresh();
    arrive(db, [TASK]);
    expect(applyOp(db, op(8, "check", "put", "d", { brief: "a log line" })).changed).toBe(false);
    expect(applyOp(db, op(9, "check", "put", "d/a#", {})).changed).toBe(false);
    expect(rows(db)).toEqual([]);
  });

  it("check syncs, and a check op rides a segment line of the unchanged format", () => {
    expect(SYNCED_ENTITIES).toContain("check");
    expect(SEGMENT_FORMAT_VERSION).toBe(2);
    const d = decodeLine(encodeSegmentLine({ ...VERDICT, actor: null, intent: null }));
    expect(d.ok && JSON.parse(d.payloadText)).toEqual(JSON.parse(VERDICT.payload));
  });
});

// ─── 3. The upgrade ───────────────────────────────────────────────────

describe("upgradeSchema re-folds the check ops an older v13 file recorded", () => {
  /** The fixture as an older build left it after ingesting a peer's checks:
   *  no checks table, and the ops (verdict recorded BEFORE its brief, a later
   *  hlc first) in the log, projected nowhere. Plus a pre-U11 log line under
   *  the same entity, which must not wedge the upgrade. */
  function olderFileWithPeerChecks(): string {
    const p = join(dir, `v13-${++n}.db`);
    copyFileSync(join(dir, "v13.db"), p);
    const verdict = { ...VERDICT, key: `alpha/t1#${ID}` };
    const issue = { ...ISSUE, key: `alpha/t1#${ID}` };
    const other = op(4, "check", "put", `alpha/t2#${newCheckId(BASE)}`, {
      checker: "codex/gpt-5",
      brief: "unanswered",
    });
    const raw = new Database(p);
    try {
      expect(
        raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'checks'").get(),
      ).toBeUndefined();
      expect(raw.prepare("SELECT capture_version AS c FROM schema_version").get()).toEqual({
        c: 4,
      });
      const ins = raw.prepare(
        `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'n')`,
      );
      for (const o of [verdict, other, issue]) {
        ins.run(o.hlc, o.machineId, o.groupId, o.actor, o.entity, o.key, o.op, o.payload);
      }
      ins.run(
        formatHlc({ wallMs: BASE + 9, counter: 0, machineId: PEER }),
        PEER,
        "g",
        "x",
        "check",
        "alpha",
        "put",
        '"a log line"',
      );
    } finally {
      raw.close();
    }
    return p;
  }

  it("the rows appear at open, out-of-order verdicts included; schema 13, no new ops", () => {
    const p = olderFileWithPeerChecks();
    const db = track(openDb({ path: p }));
    expect(
      db.prepare("SELECT version, capture_version AS capture FROM schema_version").get(),
    ).toEqual({ version: CURRENT_SCHEMA_VERSION, capture: CAPTURE_VERSION });
    expect(CURRENT_SCHEMA_VERSION).toBe(13);
    expect(listChecks(db, "alpha").map((c) => [c.task, c.by, c.brief, c.label, c.state])).toEqual([
      ["t1", "claude/opus", "is it right?", "REFUTED", "answered"],
      ["t2", "codex/gpt-5", "unanswered", null, "open"],
    ]);
    // Projected, not re-captured: the log holds exactly the four stored ops.
    expect(checkOps(db)).toHaveLength(4);
    expect(checkDrift(db).clean).toBe(true);
    db.close();
    open.pop();
    const again = track(openDb({ path: p }));
    expect(listChecks(again, "alpha")).toHaveLength(2);
    expect(checkOps(again)).toHaveLength(4);
  });

  it("a failure during the re-fold rolls the whole upgrade back: no table, the old stamp", () => {
    const p = olderFileWithPeerChecks();
    const raw = new Database(p);
    try {
      // The re-fold's applyOp cannot write a checks row.
      const failing = new Proxy(raw, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target) as unknown;
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("INSERT INTO checks")) throw new Error("disk full");
              return target.prepare(sql);
            };
          }
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as Db;
      expect(() => upgradeSchema(failing)).toThrow("disk full");
      expect(
        raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'checks'").get(),
      ).toBeUndefined();
      expect(raw.prepare("SELECT capture_version AS c FROM schema_version").get()).toEqual({
        c: 4,
      });
    } finally {
      raw.close();
    }
  });
});

// ─── 4. --if-ready and mu state ───────────────────────────────────────

describe("--if-ready waits for a missing verdict", () => {
  it("a CLOSED blocker with an unanswered check holds the umbrella until its verdict", () => {
    const db = seeded();
    const c = issueCheck(db, "a", { workstream: "d", by: "claude/opus", brief: "B" });
    closeTask(db, "a", { workstream: "d", evidence: "done" });
    const skipped = closeTask(db, "u", { workstream: "d", ifReady: true, evidence: "all in" });
    expect(skipped).toMatchObject({
      skipped: "not_ready",
      blockingIds: [],
      pendingChecks: [{ task: "a", check: c.id }],
    });
    recordCheckVerdict(db, "a", { workstream: "d", check: c.id, verdict: "VERDICT: CONFIRMED" });
    const closed = closeTask(db, "u", { workstream: "d", ifReady: true, evidence: "all in" });
    expect(closed).toMatchObject({ status: "CLOSED", changed: true });
  });
});

describe("the CLI verbs and mu state", () => {
  let dbPath: string;
  let db: Db;
  let mux: MuxHarness;
  const IDENTITY = ["PI_SESSION_ID", "TMUX_PANE", "MU_MANAGED_AGENT", "MU_AGENT_NAME"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of IDENTITY) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dbPath = join(dir, `cli-${++n}.db`);
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    addTask(db, { workstream: "d", localId: "u", title: "umbrella" });
    addBlockEdge(db, "d", "u", "a");
    mux = installMux("tmux", [["list-panes", ""]]);
  });
  afterEach(() => {
    for (const k of IDENTITY) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setStdinReaderForTests(null);
    mux.restore();
    try {
      db.close();
    } catch {}
  });

  it("check prints check=<ulid>; a replacement orchestrator sees it in mu state until the verdict", async () => {
    setStdinReaderForTests(async () => "Is the fix right?\n");
    // The first orchestrator issues it under its own name.
    let issued: Awaited<ReturnType<typeof runCliWire>> | undefined;
    await withEnv("MU_AGENT_NAME", "orch", async () => {
      issued = await runCliWire(
        ["task", "check", "a", "-w", "d", "--by", "claude/opus", "--brief", "-"],
        dbPath,
      );
    });
    if (issued === undefined) throw new Error("check did not run");
    expect(issued.error).toBeUndefined();
    expect(issued.exitCode).toBeNull();
    const id = /^check=([0-9A-Z]{26})$/m.exec(issued.stdout)?.[1];
    expect(id).toMatch(ULID_RE);

    // The orchestrator was killed: a new one, with no identity of the old, reads state.
    const state = await runCliJson(["state", "-w", "d"], dbPath);
    expect(state.exitCode).toBeNull();
    expect(state.data.workstreams[0].checks).toEqual([
      expect.objectContaining({ id, task: "a", by: "claude/opus", brief: "Is the fix right?" }),
    ]);

    const skip = await runCliJson(
      ["task", "close", "u", "-w", "d", "--if-ready", "--json"],
      dbPath,
    );
    expect(skip.exitCode).toBeNull();
    expect(skip.data).toMatchObject({
      skipped: "not_ready",
      pendingChecks: [{ task: "a", check: id }],
    });

    setStdinReaderForTests(async () => "VERDICT: CONFIRMED\nEVIDENCE: npm test exit 0\n");
    const v = await runCliWire(
      ["task", "verdict", "a", "-w", "d", "--check", id ?? "", "-"],
      dbPath,
    );
    expect(v.exitCode).toBeNull();
    expect(v.stdout).toContain(`check=${id} verdict=CONFIRMED`);
    const after = await runCliJson(["state", "-w", "d"], dbPath);
    expect(after.data.workstreams[0].checks).toEqual([]);
    const snap = await stateSnapshot(db, { workstreams: ["d"], caller: null });
    expect(snap.workstreams[0]?.checks).toEqual([]);
  });

  it("a bad --by is usage (exit 2), an unknown check is not found (exit 3); nothing is written", async () => {
    const bad = await runCliWire(
      ["task", "check", "a", "-w", "d", "--by", "nobody/x", "--brief", "b"],
      dbPath,
    );
    expect(bad.exitCode).toBe(2);
    const missing = await runCliWire(
      ["task", "verdict", "a", "-w", "d", "--check", ID, "VERDICT: REFUTED"],
      dbPath,
    );
    expect(missing.exitCode).toBe(3);
    expect(checkOps(db)).toEqual([]);
  });

  it("mu db query --write refuses a check id that is not a ULID; nothing is written", async () => {
    const tid = (db.prepare("SELECT id FROM tasks WHERE local_id = 'a'").get() as { id: number })
      .id;
    const r = await runCliWire(
      [
        "db",
        "query",
        "--write",
        `INSERT INTO checks (id, task_id, checker, brief, created_at, updated_at) VALUES ('x#y', ${tid}, 'claude/opus', 'b', 'n', 'n')`,
      ],
      dbPath,
    );
    expect(r.exitCode).not.toBeNull();
    expect(rows(db)).toEqual([]);
    expect(checkOps(db)).toEqual([]);
  });
});

// Keep the capture-suppressed helper honest: a suppressed insert leaves no op.
describe("capture", () => {
  it("a check written under the echo guard mints no op", () => {
    const db = seeded();
    const tid = (db.prepare("SELECT id FROM tasks WHERE local_id = 'a'").get() as { id: number })
      .id;
    withCaptureSuppressed(db, () =>
      db
        .prepare(
          "INSERT INTO checks (id, task_id, checker, brief, created_at, updated_at) VALUES (?, ?, 'x/y', 'b', 'n', 'n')",
        )
        .run(ID, tid),
    );
    expect(checkOps(db)).toEqual([]);
  });

  it("a local insert refuses a check id that is not a ULID, so every key apply can parse", () => {
    const db = seeded();
    const tid = (db.prepare("SELECT id FROM tasks WHERE local_id = 'a'").get() as { id: number })
      .id;
    const ins = db.prepare(
      "INSERT INTO checks (id, task_id, checker, brief, created_at, updated_at) VALUES (?, ?, 'x/y', 'b', 'n', 'n')",
    );
    for (const id of ["x#y", "", null, ID.toLowerCase(), `${ID}0`, "01JC000000000000000000000U"]) {
      expect(() => ins.run(id, tid)).toThrow(GUARD_CHECK_ID);
    }
    expect(rows(db)).toEqual([]);
    expect(checkOps(db)).toEqual([]);
    ins.run(ID, tid);
    expect(checkOps(db).map((o) => o.key)).toEqual([`d/a#${ID}`]);
  });

  it("state cannot be split from the verdict: a state-only or verdict-only write is refused", () => {
    const db = seeded();
    const c = issueCheck(db, "a", { workstream: "d", by: "claude/opus", brief: "B" });
    expect(() => db.prepare("UPDATE checks SET state = 'answered'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE checks SET verdict = 'VERDICT: REFUTED'").run()).toThrow(
      /CHECK/,
    );
    expect(checkOps(db)).toHaveLength(1);
    recordCheckVerdict(db, "a", { workstream: "d", check: c.id, verdict: "VERDICT: REFUTED" });
    expect(() => db.prepare("UPDATE checks SET state = 'open'").run()).toThrow(/CHECK/);
    expect(checkDrift(db).clean).toBe(true);
  });
});

// The doctor's drift checks cover checks: a row the log cannot explain, or
// one that differs from its fold, is reported under its natural key.
describe("drift", () => {
  it("a check row with no op is unexplained by the cheap invariant", () => {
    const db = seeded();
    const tid = (db.prepare("SELECT id FROM tasks WHERE local_id = 'a'").get() as { id: number })
      .id;
    expect(checkCheapDriftInvariant(db).clean).toBe(true);
    withCaptureSuppressed(db, () =>
      db
        .prepare(
          "INSERT INTO checks (id, task_id, checker, brief, created_at, updated_at) VALUES (?, ?, 'x/y', 'b', 'n', 'n')",
        )
        .run(ID, tid),
    );
    const report = checkCheapDriftInvariant(db);
    expect(report.clean).toBe(false);
    expect(report.unexplainedRows).toEqual([{ table: "checks", key: `d/a#${ID}` }]);
  });

  it("a check whose verdict differs from its fold is drift under <task>#<id>", () => {
    const db = seeded();
    const c = issueCheck(db, "a", { workstream: "d", by: "claude/opus", brief: "B" });
    withCaptureSuppressed(db, () =>
      db
        .prepare(
          "UPDATE checks SET verdict = 'VERDICT: CONFIRMED', state = 'answered' WHERE id = ?",
        )
        .run(c.id),
    );
    const report = checkDrift(db);
    expect(report.clean).toBe(false);
    expect(report.rowsCompared.checks).toBe(1);
    expect(
      report.records
        .filter((r) => r.table === "checks")
        .map((r) => [r.key, r.field])
        .sort(),
    ).toEqual([
      [`d/a#${c.id}`, "state"],
      [`d/a#${c.id}`, "verdict"],
    ]);
  });
});
