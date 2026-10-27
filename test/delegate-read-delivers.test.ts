// Reading a finished delegate's report (`mu task notes`) is its delivery for the caller
// that owns the call (wait_owned_drain_v2, dogfood-switch F2): a later wait does not hand
// the same answer back. Anything else stays a pure read. Real SQLite, in-process CLI.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { getDelegateCall, listDelegates, withDelivered } from "../src/delegates.js";
import { addTask } from "../src/tasks.js";
import { setWaitSleepForTests } from "../src/wait.js";
import { readCursors } from "../src/wait-cursor.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { runCliJson } from "./_runCli.js";
import { answer, mkDelegate } from "./_wait-fixtures.js";

let dir: string;
let dbPath: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-read-delivers-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  addTask(db, { localId: "x", workstream: "w", title: "x" });
  setWaitSleepForTests(async () => {});
});
afterEach(() => {
  setWaitSleepForTests(undefined);
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

/** Run `argv` as `pi:<session>` (undefined: a plain shell with no caller). */
async function as(session: string | undefined, argv: string[]) {
  // biome-ignore lint/suspicious/noExplicitAny: CLI JSON documents, asserted field by field
  let out: Awaited<ReturnType<typeof runCliJson<any>>> | undefined;
  await withEnv("PI_SESSION_ID", session, () =>
    withEnv("MU_MANAGED_AGENT", undefined, async () => {
      out = await runCliJson(argv, dbPath);
    }),
  );
  if (out === undefined) throw new Error("no capture");
  return out;
}
const notes = (session: string | undefined, callId: string) => {
  const c = getDelegateCall(db, callId);
  return as(session, ["task", "notes", c?.task ?? "", "-w", "scratch", "--json"]);
};
const consumed = (caller: string) => [...readCursors(db, caller).keys()];

describe("mu task notes on a delegate task", () => {
  it("its caller reading a finished call takes it: a later wait on an unready target does not end on it", async () => {
    const a = mkDelegate(db, "pi:s");
    answer(db, a);
    expect((await notes("s", a)).data.items.length).toBeGreaterThan(0);
    expect(consumed("pi:s")).toEqual([`delegate:scratch/${a}`]);
    // The dogfood shape: an explicit wait on a task that is not done yet.
    const w = await as("s", ["wait", "task:w/x", "--timeout", "0.05", "--json"]);
    expect(w.data.firing.kind).not.toBe("delegate");
    expect(w.data.timedOut).toBe(true);
  });

  it("a second read and a later wait consume nothing twice (idempotent)", async () => {
    const a = mkDelegate(db, "pi:s");
    const b = mkDelegate(db, "pi:s");
    answer(db, a);
    answer(db, b);
    await notes("s", a);
    await notes("s", a);
    const w = await as("s", ["wait", "--json"]);
    expect(w.data.firing.ref).toBe(`delegate:${b}`);
    expect(consumed("pi:s").sort()).toEqual([`delegate:scratch/${a}`, `delegate:scratch/${b}`]);
  });

  it("a running call is not consumed: its answer still comes with a wait", async () => {
    const a = mkDelegate(db, "pi:s");
    await notes("s", a);
    expect(consumed("pi:s")).toEqual([]);
    answer(db, a);
    const w = await as("s", ["wait", "--json"]);
    expect(w.data.firing.ref).toBe(`delegate:${a}`);
  });

  it("another caller's read and a plain shell's read are pure reads", async () => {
    const a = mkDelegate(db, "pi:s");
    answer(db, a);
    await notes("other", a);
    await notes(undefined, a);
    expect(consumed("pi:s")).toEqual([]);
    expect(consumed("pi:other")).toEqual([]);
    const w = await as("s", ["wait", "--json"]);
    expect(w.data.firing.ref).toBe(`delegate:${a}`);
  });
});

describe("delegates list: delivered", () => {
  it("is true once the owning caller took the answer, by a read or a wait", async () => {
    const a = mkDelegate(db, "pi:s", { wave: "v" });
    const b = mkDelegate(db, "pi:s", { wave: "v" });
    answer(db, a);
    answer(db, b);
    const before = withDelivered(db, listDelegates(db, "pi:s"));
    expect(before.map((r) => r.delivered)).toEqual([false, false]);
    await notes("s", a);
    const l = await as("s", ["delegates", "--wave", "v", "--json"]);
    expect(l.data.items.map((r: { delivered: boolean }) => r.delivered)).toEqual([true, false]);
    await as("s", ["wait", "--json"]);
    const after = await as("s", ["delegates", "--wave", "v", "--json"]);
    expect(after.data.items.map((r: { delivered: boolean }) => r.delivered)).toEqual([true, true]);
  });
});
