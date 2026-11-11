// The spawn receipt's state machine (src/agents/receipts.ts; plugins spec D8,
// review 2 of P6e2, ruling 5): over every (state × event × actor), only the
// transitions listed below move a receipt, to the state listed, and every
// other one throws ReceiptTransitionError and writes nothing. The actor is the
// attempt's own invocation (`creator`), or another one while the at-start
// job's creating process lives (`other-alive`: read only, nothing allowed) or
// once it is proven gone (`other-gone`). No code outside receipts.ts writes a
// receipt (the one rebuild in db-receipts.ts copies rows whole).
//
// The reviewer's three reproductions are named cases beside the flows they
// break: plugin-first-turn-crash.integration (a concurrent check while the
// spawn lives; an on-send start's baseline, in-process and SIGKILLed) and
// plugin-first-turn (a lookup recovery's failed view, by replay and by check).

import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RECEIPT_EVENTS,
  type ReceiptActor,
  type ReceiptEvent,
  ReceiptTransitionError,
  reserveReceipt,
  transitionReceipt,
} from "../src/agents/receipts.js";
import { type Db, openDb, SPAWN_RECEIPT_STATES, type SpawnReceiptState } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { taskIdFor } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const ACTORS: readonly ReceiptActor[] = ["creator", "other-alive", "other-gone"];
const C = ["creator"] as const;
const CG = ["creator", "other-gone"] as const;

/** The allowed transitions, written out: `event: { from-state: [to-state, actors] }`. */
const ALLOWED: Record<
  ReceiptEvent,
  Partial<Record<SpawnReceiptState, [SpawnReceiptState, readonly ReceiptActor[]]>>
> = {
  pane: { reserved: ["pane", C] },
  claim: { reserved: ["claimed", C], pane: ["claimed", C] },
  send: { claimed: ["sending", C] },
  delivered: { sending: ["sent", C] },
  confirm: { sending: ["sent", CG], unknown: ["sent", CG] },
  unknown: { sending: ["unknown", CG], unknown: ["unknown", CG] },
  unsent: {
    reserved: ["failed", C],
    pane: ["failed", C],
    claimed: ["failed", C],
    sending: ["failed", C],
  },
  never: { sending: ["failed", CG], unknown: ["failed", CG] },
  reset: { failed: ["reserved", C] },
  repoint: {
    pane: ["pane", CG],
    claimed: ["claimed", CG],
    sending: ["sending", CG],
    sent: ["sent", CG],
    unknown: ["unknown", CG],
  },
  note: Object.fromEntries(SPAWN_RECEIPT_STATES.map((s) => [s, [s, C]])),
};

let dir: string;
let db: Db;
let taskId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrcpt-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "ws");
  addTask(db, { localId: "t1", workstream: "ws", title: "T", impact: 50, effortDays: 1 });
  taskId = taskIdFor(db, "t1", "ws") ?? -1;
});

afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

/** A receipt in `state`, written directly (the fixture, not a transition). */
function receiptIn(state: SpawnReceiptState, key: string): void {
  reserveReceipt(db, {
    taskId,
    attemptKey: key,
    name: "w1",
    workstream: "ws",
    requestSha: "s",
    msgId: "m",
  });
  db.prepare("UPDATE spawn_receipts SET state = ? WHERE attempt_key = ?").run(state, key);
}
const stateOf = (key: string) =>
  db.prepare("SELECT state, detail FROM spawn_receipts WHERE attempt_key = ?").get(key) as {
    state: string;
    detail: string | null;
  };

describe("the receipt transition table", () => {
  it("the module's table is exactly the allowed list", () => {
    expect(Object.keys(RECEIPT_EVENTS).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  const cases = (Object.keys(ALLOWED) as ReceiptEvent[]).flatMap((event) =>
    SPAWN_RECEIPT_STATES.flatMap((state) => ACTORS.map((actor) => ({ event, state, actor }))),
  );
  it.each(cases)("$state × $event × $actor", ({ event, state, actor }) => {
    const key = `manual:${event}-${state}-${actor}`;
    receiptIn(state, key);
    const allowed = ALLOWED[event][state];
    if (allowed?.[1].includes(actor)) {
      const r = transitionReceipt(db, taskId, key, event, { detail: "moved" }, actor);
      expect(r.state).toBe(allowed[0]);
      expect(stateOf(key)).toEqual({ state: allowed[0], detail: "moved" });
    } else {
      expect(() => transitionReceipt(db, taskId, key, event, { detail: "moved" }, actor)).toThrow(
        ReceiptTransitionError,
      );
      expect(stateOf(key)).toEqual({ state, detail: null });
    }
  });

  it("a lost compare-and-set writes nothing: the row moved between the read and the write", () => {
    receiptIn("sending", "manual:race");
    const prepare = db.prepare.bind(db);
    // Another writer moves the row just before this transition's UPDATE runs.
    db.prepare = ((sql: string) => {
      if (sql.startsWith("UPDATE spawn_receipts SET")) {
        prepare(
          "UPDATE spawn_receipts SET state = 'unknown' WHERE attempt_key = 'manual:race'",
        ).run();
      }
      return prepare(sql);
    }) as typeof db.prepare;
    try {
      expect(() => transitionReceipt(db, taskId, "manual:race", "delivered")).toThrow(
        ReceiptTransitionError,
      );
    } finally {
      db.prepare = prepare;
    }
    expect(stateOf("manual:race").state).toBe("unknown");
  });
});

describe("one writer", () => {
  it("no source file but receipts.ts writes spawn_receipts (the v14 rebuild copies rows whole)", () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk("src");
    const writers = files.filter(
      (f) =>
        /(UPDATE|INSERT INTO|DELETE FROM)\s+spawn_receipts\b/.test(readFileSync(f, "utf8")) &&
        f !== join("src", "agents", "receipts.ts"),
    );
    expect(writers).toEqual([join("src", "db-receipts.ts")]);
    // The seeding seam is the tests' alone.
    expect(files.filter((f) => /\bupdateReceipt\(/.test(readFileSync(f, "utf8")))).toEqual([
      join("src", "agents", "receipts.ts"),
    ]);
  });
});
