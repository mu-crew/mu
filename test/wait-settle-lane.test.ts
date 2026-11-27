// The settle lane (fsj U4, mural r5): the pi settle wait (`MU_WAIT_SETTLE=1`) keeps its own delegate
// cursors and its own wait generation, apart from a shell `mu wait` of the same caller: each lane sees
// every answer once, and neither supersedes the other. Real SQLite; no agents.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { setWaitSleepForTests, type WaitResult, waitForEvents } from "../src/wait.js";
import {
  cursorKey,
  DELEGATE_TOKEN,
  readCursors,
  recordCursors,
  settleKey,
  settleLaneAdopted,
  settleOwed,
} from "../src/wait-cursor.js";
import { registerOwnedWait } from "../src/wait-registration.js";
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
const owedTo = (callId: string) => settleOwed(db, CALLER, [{ workstream: "scratch", callId }]);

describe("the settle lane: each lane sees every delegate answer once", () => {
  it("r5: a shell wait consumes the answer first; the settle wait still returns it", async () => {
    const c = mkDelegate(db, CALLER);
    answer(db, c);
    expect(await delegates(shell)).toEqual([c]); // the model's `mu wait` in bash
    expect(owedTo(c)).toEqual([c]);
    expect(await delegates(settle)).toEqual([c]); // the turn's settle: still owed to the transcript
    expect(owedTo(c)).toEqual([]);
    // Each lane delivers it once.
    expect(await delegates(settle)).toEqual([]);
    expect(await delegates(shell)).toEqual([]);
  });

  it("the settle delivers first: a later shell wait still sees the answer", async () => {
    const c = mkDelegate(db, CALLER);
    answer(db, c);
    expect(await delegates(settle)).toEqual([c]);
    expect(await delegates(shell)).toEqual([c]);
    expect(await delegates(settle)).toEqual([]); // no second delivery into the transcript
    expect(await delegates(shell)).toEqual([]);
    const cursors = readCursors(db, CALLER);
    expect(cursors.get(cursorKey("delegate", "scratch", c))).toEqual(DELEGATE_TOKEN);
    expect(cursors.get(settleKey("scratch", c))).toEqual(DELEGATE_TOKEN);
  });

  for (const first of ["settle", "shell"] as const) {
    it(`concurrent waits of one registered caller (${first} starts first): both deliver, neither is superseded`, async () => {
      const c = mkDelegate(db, CALLER);
      // A registration: each wait takes a generation (the supersede guard).
      registerOwnedWait(db, CALLER, [{ kind: "delegate", workstream: "scratch", id: c }]);
      const long = { timeoutMs: 5000 } as const;
      const order = first === "settle" ? [settle, shell] : [shell, settle];
      const [a, b] = order.map((o) => waitForEvents(db, [], { ...o, ...long }));
      answer(db, c);
      const results = await Promise.all([a, b]);
      for (const r of results) {
        expect(r?.superseded).toBeUndefined();
        expect(r?.event.kind).toBe("delegate");
        expect(r ? ids(r) : []).toEqual([c]);
      }
      expect(owedTo(c)).toEqual([]);
      expect(await delegates(settle)).toEqual([]);
      expect(await delegates(shell)).toEqual([]);
    });
  }

  it("a newer settle wait still supersedes an older one (one settle wait per caller)", async () => {
    const c = mkDelegate(db, CALLER);
    registerOwnedWait(db, CALLER, [{ kind: "delegate", workstream: "scratch", id: c }]);
    const older = waitForEvents(db, [], { ...settle, timeoutMs: 5000 });
    const newer = waitForEvents(db, [], { ...settle, timeoutMs: 5000 });
    answer(db, c);
    const [o, n] = await Promise.all([older, newer]);
    expect(n.superseded).toBeUndefined();
    expect(ids(n)).toEqual([c]);
    expect(o.superseded).toBe(true);
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

describe("adopting the lane on an existing DB (v14, capture 8, never opened by this build)", () => {
  /** Make the file look as an older mu left it: no lane mark, one delegate key for both lanes. */
  const asOlderMu = (mark: number, cursors: { callId: string; runs: number }[]) => {
    db.pragma(`user_version = ${mark}`);
    db.prepare("DELETE FROM wait_cursors").run();
    for (const c of cursors)
      db.prepare(
        "INSERT INTO wait_cursors (caller, ref, incarnation, runs) VALUES (?, ?, 'delegate', ?)",
      ).run(CALLER, cursorKey("delegate", "scratch", c.callId), c.runs);
    db.close();
  };

  it("openDb adopts it: an answer an older mu consumed is never replayed by either lane", async () => {
    const old = mkDelegate(db, CALLER);
    answer(db, old);
    asOlderMu(0, [{ callId: old, runs: 1 }]);
    db = openDb({ path: dbPath });
    expect(settleLaneAdopted(db)).toBe(true);
    expect(owedTo(old)).toEqual([]);
    expect(await delegates(settle)).toEqual([]);
    expect(await delegates(shell)).toEqual([]);
    // A new answer after the adoption: owed to both lanes.
    const fresh = mkDelegate(db, CALLER);
    answer(db, fresh);
    expect(await delegates(shell)).toEqual([fresh]);
    expect(await delegates(settle)).toEqual([fresh]);
    // Adopted once: the next open is a read (no upgrade) and replays nothing.
    db.close();
    db = openDb({ path: dbPath });
    expect(await delegates(settle)).toEqual([]);
  });

  it("a pre-release lane build's keys (delegate+2 shown, +1 shell only) are carried over", async () => {
    const shown = mkDelegate(db, CALLER);
    const shellOnly = mkDelegate(db, CALLER);
    answer(db, shown);
    answer(db, shellOnly);
    asOlderMu(1, [
      { callId: shown, runs: 2 },
      { callId: shellOnly, runs: 1 },
    ]);
    db = openDb({ path: dbPath });
    expect(owedTo(shown)).toEqual([]);
    expect(owedTo(shellOnly)).toEqual([shellOnly]);
    expect(await delegates(shell)).toEqual([]);
    expect(await delegates(settle)).toEqual([shellOnly]);
  });

  it("read-only: the adopted file opens read-only and reads, its stamps unchanged", () => {
    const stamps = () =>
      db.prepare("SELECT * FROM schema_version").all() as Record<string, unknown>[];
    const before = stamps();
    db.close();
    db = openDb({ path: dbPath, readonly: true });
    expect(stamps()).toEqual(before);
    expect(settleLaneAdopted(db)).toBe(true);
    expect(readCursors(db, CALLER).size).toBe(0);
  });

  it("recordCursors on the plain key never touches the lane's", () => {
    const c = mkDelegate(db, CALLER);
    recordCursors(db, CALLER, [
      { key: cursorKey("delegate", "scratch", c), token: DELEGATE_TOKEN },
    ]);
    expect(owedTo(c)).toEqual([c]);
  });
});
