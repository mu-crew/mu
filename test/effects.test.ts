// The effects journal (plugins spec D4, D5; src/effects.ts) and the schema it
// needs: the `effects` table, `agents.delivery_seq`, the carrier_jobs columns
// and its nullable `host_stop`, completed in place on an existing v14 file.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { getCarrierJob, reserveCarrierJob } from "../src/carrier-jobs.js";
import { type Db, MACHINE_LOCAL_TABLES, openDb } from "../src/db.js";
import {
  claimEffect,
  DeliveryResolvingError,
  EffectHeldError,
  type EffectIntent,
  getEffect,
  leaveEffectUnknown,
  paramsDigest,
  setEffectOwnerForTests,
  settleEffect,
  writeEffect,
} from "../src/effects.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meff-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(() => {
  setEffectOwnerForTests(undefined);
  db.close();
  rmFixtureDir(dir);
});

/** A pid that existed and is gone now: a crashed creator. */
function deadPid(): number {
  const r = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

const intent = (over: Partial<EffectIntent> = {}): EffectIntent => ({
  key: "k1",
  subject: { kind: "job", id: "tok" },
  plugin: "fake",
  method: "job.start",
  params: { target: { host: { name: "h" } }, key: "k1", spec: { cmd: "x" } },
  instance: "fake-1",
  pgid: 1,
  pgidStart: null,
  ...over,
});

const cols = (table: string) =>
  db
    .prepare(`SELECT name, "notnull" AS nn, dflt_value AS d FROM pragma_table_info('${table}')`)
    .all() as {
    name: string;
    nn: number;
    d: string | null;
  }[];

describe("the schema", () => {
  it("has effects (machine-local), agents.delivery_seq and the carrier_jobs columns, host_stop nullable", () => {
    expect(cols("effects").map((c) => c.name)).toEqual([
      "key",
      "subject_kind",
      "subject_id",
      "msg_id",
      "seq",
      "plugin",
      "method",
      "params_json",
      "params_sha",
      "instance",
      "state",
      "creator_pid",
      "creator_start",
      "plugin_pgid",
      "plugin_pgid_start",
      "resolver_pid",
      "resolver_start",
      "created_at",
      "updated_at",
    ]);
    expect(MACHINE_LOCAL_TABLES).toContain("effects");
    expect(cols("agents").find((c) => c.name === "delivery_seq")).toMatchObject({ nn: 1, d: "0" });
    const cj = cols("carrier_jobs");
    for (const c of [
      "kind",
      "plugin",
      "instance",
      "host_id",
      "tree_base",
      "collect_repo",
      "final_owed",
      "stop_gen",
      "collect_next_at",
      "first_msg_id",
      "first_inc",
    ]) {
      expect(cj.map((x) => x.name)).toContain(c);
    }
    expect(cj.find((c) => c.name === "host_stop")?.nn).toBe(0);
    expect(() =>
      db
        .prepare(
          "INSERT INTO effects (key, subject_kind, subject_id, plugin, method, params_json, params_sha, instance, state, creator_pid, plugin_pgid, created_at, updated_at) VALUES ('x', 'agent', '1', 'p', 'm', '{}', 's', 'i', 'pending', 1, 1, 0, 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("an existing v14 file is completed in place: carrier_jobs rebuilt with its rows and name index", () => {
    db.close();
    const raw = new Database(join(dir, "mu.db"));
    raw.exec(`
      DROP TABLE effects;
      ALTER TABLE agents DROP COLUMN delivery_seq;
      DROP TABLE carrier_jobs;
      CREATE TABLE carrier_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, workstream TEXT NOT NULL,
        name TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0, host TEXT NOT NULL,
        host_stop TEXT NOT NULL, launch TEXT NOT NULL DEFAULT 'none' CHECK (launch IN ('none', 'intent')),
        creator_pid INTEGER, creator_start TEXT, agent_id INTEGER, pane_id TEXT, job TEXT, reason TEXT,
        created_at TEXT NOT NULL, recorded_at TEXT, tree_path TEXT, tree_agent_id INTEGER, workstream_id INTEGER);
      CREATE UNIQUE INDEX idx_carrier_jobs_name ON carrier_jobs (workstream, name, ordinal);
      INSERT INTO carrier_jobs (token, workstream, name, host, host_stop, launch, job, created_at)
        VALUES ('t1', 'ws', 'w', 'dev', 'stop {job}', 'intent', 'j1', '2026-11-10T00:00:00Z');
    `);
    raw.close();
    db = openDb({ path: join(dir, "mu.db") });
    expect(getCarrierJob(db, "t1")).toMatchObject({
      host: "dev",
      hostStop: "stop {job}",
      job: "j1",
    });
    expect(cols("carrier_jobs").find((c) => c.name === "host_stop")?.nn).toBe(0);
    expect(cols("effects")).not.toEqual([]);
    expect(cols("agents").map((c) => c.name)).toContain("delivery_seq");
    // The name fence still holds: the index came back on the new table.
    expect(
      reserveCarrierJob(db, { workstream: "ws", name: "w", host: "dev", hostStop: "s" }),
    ).toBeUndefined();
    const idx = db
      .prepare(
        "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_carrier_jobs_name'",
      )
      .get() as { tbl_name: string };
    expect(idx.tbl_name).toBe("carrier_jobs");
  });
});

describe("the journal", () => {
  it("writes ahead with the subject's change in one transaction: exact params, digest, instance, owners", () => {
    const e = writeEffect(db, intent(), () => {
      db.prepare(
        "INSERT INTO plugins (name, argv_json, protocol, version, instance, seams_json, caps_json, schema_digest, added_at, checked_at) VALUES ('marker', '[]', 1, 'v', 'i', '[]', '{}', 's', 'a', 'c')",
      ).run();
    });
    const { json, sha } = paramsDigest(intent().params);
    expect(e).toMatchObject({
      state: "pending",
      params_json: json,
      params_sha: sha,
      instance: "fake-1",
      creator_pid: process.pid,
      plugin_pgid: 1,
      subject_kind: "job",
      subject_id: "tok",
    });
    expect(JSON.parse(e.params_json)).toEqual(intent().params);
    // A failing subject change writes no intent.
    expect(() =>
      writeEffect(db, intent({ key: "k2" }), () => {
        throw new Error("subject refused");
      }),
    ).toThrow("subject refused");
    expect(getEffect(db, "k2")).toBeUndefined();
  });

  it("a live creator owns its pending row: a claim refuses, naming it; the creator records once", () => {
    writeEffect(db, intent());
    expect(() => claimEffect(db, "k1")).toThrow(EffectHeldError);
    expect(() => claimEffect(db, "k1")).toThrow(new RegExp(`pid ${process.pid}`));
    let recorded = 0;
    expect(settleEffect(db, "k1", () => recorded++)).toBe(true);
    expect(settleEffect(db, "k1", () => recorded++)).toBe(false);
    expect(recorded).toBe(1);
    expect(getEffect(db, "k1")).toBeUndefined();
  });

  it("a gone creator's row is claimed; the creator's late write then changes nothing", () => {
    const creator = { pid: deadPid(), start: null };
    setEffectOwnerForTests(creator);
    writeEffect(db, intent());
    setEffectOwnerForTests(undefined);
    expect(claimEffect(db, "k1")?.row).toMatchObject({
      state: "resolving",
      resolver_pid: process.pid,
    });
    // A second resolver refuses while this one lives.
    setEffectOwnerForTests({ pid: process.pid + 0, start: "other" });
    expect(() => claimEffect(db, "k1")).toThrow(/being resolved by pid/);
    // The creator's (late) write: not its row any more.
    setEffectOwnerForTests(creator);
    expect(settleEffect(db, "k1")).toBe(false);
    expect(leaveEffectUnknown(db, "k1")).toBe(false);
    setEffectOwnerForTests(undefined);
    expect(leaveEffectUnknown(db, "k1")).toBe(true);
    expect(getEffect(db, "k1")?.state).toBe("unknown");
    expect(claimEffect(db, "k1")?.row.state).toBe("resolving");
  });

  it("a delivery takes the next delivery_seq; a newer one makes it not the newest; none is written while one resolves", () => {
    ensureWorkstream(db, "ws");
    const a = insertAgent(db, { name: "w", workstream: "ws", cli: "x", paneId: "%1" });
    const d = (key: string, msgId: string): EffectIntent =>
      intent({
        key,
        subject: { kind: "delivery", agentId: a.incarnation, msgId },
        method: "channel.send",
      });
    expect(writeEffect(db, d("d1", "m1")).seq).toBe(1);
    expect(writeEffect(db, d("d2", "m2")).seq).toBe(2);
    leaveEffectUnknown(db, "d1");
    leaveEffectUnknown(db, "d2");
    expect(claimEffect(db, "d1")?.newest).toBe(false);
    leaveEffectUnknown(db, "d1");
    expect(claimEffect(db, "d2")?.newest).toBe(true);
    expect(() => writeEffect(db, d("d3", "m3"))).toThrow(DeliveryResolvingError);
    expect(getEffect(db, "d3")).toBeUndefined();
    settleEffect(db, "d2");
    // The mark outlives its rows.
    expect(writeEffect(db, d("d3", "m3")).seq).toBe(3);
  });
});
