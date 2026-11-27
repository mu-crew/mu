// The settle lane (fsj U4, mural r5): the pi settle wait (`MU_WAIT_SETTLE=1`) tracks which delegate
// answers reached the transcript apart from what a shell `mu wait` of the same caller consumed. A
// shell wait never hides an answer from the settle; the settle's delivery hides it from the shell.
// Real SQLite; no agents.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { setWaitSleepForTests, type WaitResult, waitForEvents } from "../src/wait.js";
import {
  adoptSettleLane,
  cursorKey,
  DELEGATE_TOKEN,
  readCursors,
  recordCursors,
  settleOwed,
} from "../src/wait-cursor.js";
import { WaitNothingError } from "../src/wait-types.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { runCliWire } from "./_runCli.js";
import { answer, mkDelegate } from "./_wait-fixtures.js";

let dir: string;
let dbPath: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-settle-lane-"));
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

const CALLER = "pi:s1";
const shell = { pollMs: 1, sync: false, callers: [CALLER], timeoutMs: 30, mode: "ready" } as const;
const settle = { ...shell, settleLane: true } as const;
const ids = (r: WaitResult): string[] => (r.events ?? []).map((e) => e.ref?.id ?? e.kind);
/** The wait's delegate events, or [] when it found nothing owed (or only a heartbeat). */
const delegates = async (o: typeof shell | typeof settle): Promise<string[]> => {
  try {
    const r = await waitForEvents(db, [], o);
    return r.event.kind === "delegate" ? ids(r) : [];
  } catch (e) {
    if (e instanceof WaitNothingError) return [];
    throw e;
  }
};

describe("the settle lane: a shell mu wait never consumes the transcript's delivery", () => {
  it("r5: a shell wait consumes the answer first; the settle wait still returns it", async () => {
    const c = mkDelegate(db, CALLER);
    answer(db, c);
    expect(await delegates(shell)).toEqual([c]); // the model's `mu wait` in bash
    expect(await delegates(settle)).toEqual([c]); // the turn's settle: still owed to the transcript
    // Each lane delivers it once.
    expect(await delegates(settle)).toEqual([]);
    expect(await delegates(shell)).toEqual([]);
  });

  it("the settle delivered it: a later shell wait does not repeat it", async () => {
    const c = mkDelegate(db, CALLER);
    answer(db, c);
    expect(await delegates(settle)).toEqual([c]);
    expect(await delegates(shell)).toEqual([]);
  });

  it("an answer a shell wait consumed before the lane existed is not replayed", async () => {
    const old = mkDelegate(db, CALLER);
    answer(db, old);
    // Written by an older mu (one token for both lanes), then opened by this one.
    db.pragma("user_version = 0");
    recordCursors(db, CALLER, [
      { key: cursorKey("delegate", "scratch", old), token: DELEGATE_TOKEN },
    ]);
    expect(settleOwed(db, CALLER, [{ workstream: "scratch", callId: old }])).toEqual([old]);
    db.transaction(() => adoptSettleLane(db))();
    adoptSettleLane(db); // idempotent
    expect(settleOwed(db, CALLER, [{ workstream: "scratch", callId: old }])).toEqual([]);
    const fresh = mkDelegate(db, CALLER);
    answer(db, fresh);
    expect(await delegates(settle)).toEqual([fresh]);
    // After the lane exists, a shell consumption is the shell's alone.
    const later = mkDelegate(db, CALLER);
    answer(db, later);
    expect(await delegates(shell)).toEqual([later]);
    expect(settleOwed(db, CALLER, [{ workstream: "scratch", callId: later }])).toEqual([later]);
    expect(await delegates(settle)).toEqual([later]);
    expect(settleOwed(db, CALLER, [{ workstream: "scratch", callId: later }])).toEqual([]);
    expect(readCursors(db, CALLER).get(cursorKey("delegate", "scratch", later))?.runs).toBe(2);
  });

  it("the CLI: MU_WAIT_SETTLE=1 (what pi's settle wait sets) is the settle lane", async () => {
    const c = mkDelegate(db, CALLER);
    answer(db, c);
    const wait = async (settleEnv: string | undefined) => {
      let out = { stdout: "" };
      await withEnv("PI_SESSION_ID", "s1", () =>
        withEnv("MU_WAIT_SETTLE", settleEnv, async () => {
          out = await runCliWire(["wait", "--ready", "--timeout", "0.05", "--json"], dbPath);
        }),
      );
      return out;
    };
    const fired = (out: { stdout: string }) =>
      (JSON.parse(out.stdout) as { data?: { firing?: { kind?: string; ref?: string } } }).data
        ?.firing;
    // The model's bash `mu wait` (PI_SESSION_ID inherited), then the turn's settle: both get it.
    expect(fired(await wait(undefined))).toMatchObject({ kind: "delegate", ref: `delegate:${c}` });
    expect(fired(await wait("1"))).toMatchObject({ kind: "delegate", ref: `delegate:${c}` });
  });
});
