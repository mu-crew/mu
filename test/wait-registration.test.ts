// wait_registrations: the machine-local record of what a caller owes a wait.
// Real SQLite, no mux. Registration never consumes anything: wait_cursors
// (the consumed runs) is not touched by any function here.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  beginWait,
  endWait,
  type RegisteredRef,
  readWaitRegistration,
  registerOwnedWait,
  WAIT_REGISTRATION_MAX_REFS,
  WaitRegistrationError,
} from "../src/wait-registration.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

const task = (id: string, workstream = "w"): RegisteredRef => ({ kind: "task", workstream, id });
const agent = (id: string, workstream = "w"): RegisteredRef => ({
  kind: "agent",
  workstream,
  id,
});
const delegate = (id: string, workstream = "w"): RegisteredRef => ({
  kind: "delegate",
  workstream,
  id,
});
const keys = (caller: string) =>
  readWaitRegistration(db, caller)?.refs.map((r) => `${r.kind}:${r.workstream}/${r.id}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-reg-"));
  db = openDb({ path: join(dir, "mu.db") });
});
afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

describe("registerOwnedWait", () => {
  it("stores typed refs, armed, generation 0; nothing registered reads undefined", () => {
    expect(readWaitRegistration(db, "w/orch")).toBeUndefined();
    const reg = registerOwnedWait(db, "w/orch", [task("t1"), agent("w1")]);
    expect(reg).toMatchObject({ caller: "w/orch", state: "armed", generation: 0 });
    expect(keys("w/orch")).toEqual(["agent:w/w1", "task:w/t1"]);
    expect(readWaitRegistration(db, "w/orch")).toEqual(reg);
  });

  it("merges and dedupes across calls, in one canonical order", () => {
    registerOwnedWait(db, "c", [task("b"), task("a")]);
    registerOwnedWait(db, "c", [task("a"), delegate("d1"), task("c", "z")]);
    expect(keys("c")).toEqual(["delegate:w/d1", "task:w/a", "task:w/b", "task:z/c"]);
  });

  it("the same id of another kind or workstream is another ref", () => {
    registerOwnedWait(db, "c", [task("x"), agent("x"), task("x", "other")]);
    expect(keys("c")).toEqual(["agent:w/x", "task:other/x", "task:w/x"]);
  });

  it("callers are independent", () => {
    registerOwnedWait(db, "a", [task("t1")]);
    registerOwnedWait(db, "b", [task("t2")]);
    expect(keys("a")).toEqual(["task:w/t1"]);
    expect(keys("b")).toEqual(["task:w/t2"]);
  });

  it("is idempotent: the same refs again change nothing, not even updated_at's refs", () => {
    registerOwnedWait(db, "c", [task("t1")]);
    const before = readWaitRegistration(db, "c");
    registerOwnedWait(db, "c", [task("t1")]);
    expect(readWaitRegistration(db, "c")?.refs).toEqual(before?.refs);
    expect(readWaitRegistration(db, "c")?.generation).toBe(before?.generation);
  });

  it("registering while a wait is in flight keeps state and generation", () => {
    registerOwnedWait(db, "c", [task("t1")]);
    const w = beginWait(db, "c");
    registerOwnedWait(db, "c", [task("t2")]);
    expect(readWaitRegistration(db, "c")).toMatchObject({
      state: "waiting",
      generation: w?.generation,
    });
    expect(keys("c")).toEqual(["task:w/t1", "task:w/t2"]);
  });

  it.each([
    ["a blank caller", " ", [task("t1")]],
    ["a bad workstream", "c", [task("t1", "Bad Name")]],
    ["a bad task id", "c", [task("Not Valid")]],
    ["a bad agent name", "c", [agent("Bad Name")]],
    ["a delegate id with a shell metacharacter", "c", [delegate("a;rm -rf")]],
    ["an overlong delegate id", "c", [delegate("d".repeat(65))]],
    [
      "an unknown kind",
      "c",
      [{ kind: "pane", workstream: "w", id: "x" } as unknown as RegisteredRef],
    ],
    ["an empty list", "c", []],
  ])("refuses %s and stores nothing", (_why, caller, refs) => {
    expect(() => registerOwnedWait(db, caller, refs)).toThrow(WaitRegistrationError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM wait_registrations").get()).toEqual({ n: 0 });
  });

  it("one bad ref refuses the whole call: earlier valid refs are not stored", () => {
    registerOwnedWait(db, "c", [task("keep")]);
    expect(() => registerOwnedWait(db, "c", [task("ok"), task("BAD")])).toThrow(
      WaitRegistrationError,
    );
    expect(keys("c")).toEqual(["task:w/keep"]);
  });

  it("is bounded: more than the cap refuses, exactly the cap is accepted", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => task(`t${i}`));
    registerOwnedWait(db, "c", many(WAIT_REGISTRATION_MAX_REFS));
    expect(keys("c")).toHaveLength(WAIT_REGISTRATION_MAX_REFS);
    expect(() => registerOwnedWait(db, "c", [task("one-more")])).toThrow(/at most/);
    expect(keys("c")).toHaveLength(WAIT_REGISTRATION_MAX_REFS);
  });

  it("never touches wait_cursors, ops, or the cursor's consumed runs", () => {
    db.prepare(
      "INSERT INTO wait_cursors (caller, ref, incarnation, runs) VALUES ('c', 'agent:w/w1', 'i', 7)",
    ).run();
    const ops = db.prepare("SELECT COUNT(*) AS n FROM ops").get();
    registerOwnedWait(db, "c", [agent("w1")]);
    beginWait(db, "c");
    expect(db.prepare("SELECT * FROM wait_cursors").all()).toEqual([
      { caller: "c", ref: "agent:w/w1", incarnation: "i", runs: 7 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops").get()).toEqual(ops);
  });
});

describe("beginWait / endWait: one active wait per caller", () => {
  it("beginWait returns the refs and a generation, and marks the row waiting", () => {
    registerOwnedWait(db, "c", [task("t1"), agent("w1")]);
    const w = beginWait(db, "c");
    expect(w).toEqual({ generation: 1, refs: [agent("w1"), task("t1")] });
    expect(readWaitRegistration(db, "c")).toMatchObject({ state: "waiting", generation: 1 });
  });

  it("nothing registered, or nothing left owed: beginWait is undefined and writes nothing", () => {
    expect(beginWait(db, "c")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM wait_registrations").get()).toEqual({ n: 0 });
    registerOwnedWait(db, "c", [task("t1")]);
    const w = beginWait(db, "c");
    endWait(db, "c", w?.generation ?? -1, [task("t1")]);
    expect(beginWait(db, "c")).toBeUndefined();
  });

  it("endWait removes ONLY the delivered refs: an undelivered sibling stays owed", () => {
    registerOwnedWait(db, "c", [task("a"), task("b"), delegate("d1")]);
    const w = beginWait(db, "c");
    const r = endWait(db, "c", w?.generation ?? -1, [task("a")]);
    expect(r).toEqual({ applied: true });
    expect(readWaitRegistration(db, "c")).toMatchObject({ state: "armed" });
    expect(keys("c")).toEqual(["delegate:w/d1", "task:w/b"]);
  });

  it("endWait with nothing delivered (timeout, interrupt) keeps every ref and re-arms", () => {
    registerOwnedWait(db, "c", [task("a"), task("b")]);
    const w = beginWait(db, "c");
    endWait(db, "c", w?.generation ?? -1, []);
    expect(readWaitRegistration(db, "c")).toMatchObject({ state: "armed" });
    expect(keys("c")).toEqual(["task:w/a", "task:w/b"]);
  });

  it("a ref registered mid-wait survives the wait's end, even when delivered refs go", () => {
    registerOwnedWait(db, "c", [task("a")]);
    const w = beginWait(db, "c");
    registerOwnedWait(db, "c", [delegate("late")]);
    endWait(db, "c", w?.generation ?? -1, [task("a")]);
    expect(keys("c")).toEqual(["delegate:w/late"]);
  });

  it("a ref delivered but already gone (or never registered) is not an error", () => {
    registerOwnedWait(db, "c", [task("a")]);
    const w = beginWait(db, "c");
    expect(endWait(db, "c", w?.generation ?? -1, [task("zzz")])).toEqual({ applied: true });
    expect(keys("c")).toEqual(["task:w/a"]);
  });

  it("a newer wait supersedes an older one: the older finally cannot overwrite it", () => {
    registerOwnedWait(db, "c", [task("a"), task("b")]);
    const older = beginWait(db, "c");
    const newer = beginWait(db, "c"); // e.g. the older process died or was re-run
    expect(newer?.generation).toBeGreaterThan(older?.generation ?? 0);
    expect(endWait(db, "c", older?.generation ?? -1, [task("a")])).toEqual({ applied: false });
    expect(readWaitRegistration(db, "c")).toMatchObject({
      state: "waiting",
      generation: newer?.generation,
    });
    expect(keys("c")).toEqual(["task:w/a", "task:w/b"]);
    expect(endWait(db, "c", newer?.generation ?? -1, [task("b")])).toEqual({ applied: true });
    expect(keys("c")).toEqual(["task:w/a"]);
  });

  it("a second endWait of the same generation is a no-op (replay-safe)", () => {
    registerOwnedWait(db, "c", [task("a"), task("b")]);
    const w = beginWait(db, "c");
    endWait(db, "c", w?.generation ?? -1, [task("a")]);
    registerOwnedWait(db, "c", [task("a")]); // owed again after the first end
    expect(endWait(db, "c", w?.generation ?? -1, [task("a")])).toEqual({ applied: false });
    expect(keys("c")).toEqual(["task:w/a", "task:w/b"]);
  });

  it("generations only grow, also after every owed ref was delivered (the row is kept)", () => {
    registerOwnedWait(db, "c", [task("a")]);
    const g1 = beginWait(db, "c")?.generation ?? 0;
    endWait(db, "c", g1, [task("a")]);
    expect(readWaitRegistration(db, "c")).toMatchObject({ refs: [], state: "armed" });
    registerOwnedWait(db, "c", [task("a")]);
    const g2 = beginWait(db, "c")?.generation ?? 0;
    expect(g2).toBeGreaterThan(g1);
    // The first wait's generation can no longer match.
    expect(endWait(db, "c", g1, [task("a")])).toEqual({ applied: false });
  });

  it("endWait of an unknown caller is a no-op", () => {
    expect(endWait(db, "nobody", 1, [])).toEqual({ applied: false });
  });

  it("a failure inside endWait rolls the whole write back", () => {
    registerOwnedWait(db, "c", [task("a"), task("b")]);
    const w = beginWait(db, "c");
    const before = readWaitRegistration(db, "c");
    expect(() =>
      endWait(db, "c", w?.generation ?? -1, [{ kind: "bogus" } as unknown as RegisteredRef]),
    ).toThrow(WaitRegistrationError);
    expect(readWaitRegistration(db, "c")).toEqual(before);
  });

  it("holds no write lock between begin and end: another connection writes meanwhile", () => {
    registerOwnedWait(db, "c", [task("a")]);
    beginWait(db, "c");
    const other = new Database(join(dir, "mu.db"));
    try {
      other.pragma("busy_timeout = 100");
      expect(() =>
        other.prepare("UPDATE schema_version SET version = version WHERE id = 1").run(),
      ).not.toThrow();
    } finally {
      other.close();
    }
  });

  it("two connections racing beginWait get distinct generations", () => {
    registerOwnedWait(db, "c", [task("a")]);
    const db2 = openDb({ path: join(dir, "mu.db") });
    try {
      const a = beginWait(db, "c");
      const b = beginWait(db2, "c");
      expect(a?.generation).not.toBe(b?.generation);
    } finally {
      db2.close();
    }
  });
});

describe("storage", () => {
  it("a corrupt refs_json reads as an error, never as an empty (lost) registration", () => {
    registerOwnedWait(db, "c", [task("a")]);
    db.prepare("UPDATE wait_registrations SET refs_json = 'not json'").run();
    expect(() => readWaitRegistration(db, "c")).toThrow(WaitRegistrationError);
  });

  it("state and generation are constrained", () => {
    registerOwnedWait(db, "c", [task("a")]);
    expect(() => db.prepare("UPDATE wait_registrations SET state = 'done'").run()).toThrow(
      /CHECK/i,
    );
    expect(() => db.prepare("UPDATE wait_registrations SET generation = -1").run()).toThrow(
      /CHECK/i,
    );
  });
});
