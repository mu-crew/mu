// appendLog mints its HLC and inserts its op in ONE transaction.
//
// flushSegment publishes `hlc > lastPublished`, which is only safe if
// ops become visible in hlc order. appendLog used to autocommit the
// clock bump (nextHlc) and then INSERT separately: a second connection
// that appended and flushed inside that window published a LATER hlc
// first, and the earlier op was skipped by every later flush, forever.
//
// Two real connections to one file; the window is forced by hooking
// the ops INSERT of connection A and appending from connection B there.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendLog } from "../src/logs.js";
import { rmFixtureDir } from "./_fs.js";

let tempDir: string;
let a: Db;
let b: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-log-atomic-"));
  const path = join(tempDir, "mu.db");
  a = openDb({ path });
  b = openDb({ path });
  // B runs on the same thread as A, so it must not wait for A's lock.
  b.pragma("busy_timeout = 0");
});

afterEach(() => {
  for (const db of [a, b]) {
    try {
      db.close();
    } catch {}
  }
  rmFixtureDir(tempDir);
});

/** `db`, with `onInsert` run just before its ops INSERT executes. */
function hookOpsInsert(db: Db, onInsert: () => void): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.trimStart().startsWith("INSERT INTO ops")) return stmt;
          return new Proxy(stmt, {
            get(s, key) {
              if (key === "run")
                return (...args: unknown[]) => {
                  onInsert();
                  return s.run(...(args as Parameters<typeof s.run>));
                };
              const v = Reflect.get(s, key, s);
              return typeof v === "function" ? v.bind(s) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("appendLog clock + insert atomicity", () => {
  it("another connection cannot commit a later op between the mint and the insert", () => {
    let inWindow: "appended" | "busy" | null = null;
    const hooked = hookOpsInsert(a, () => {
      try {
        appendLog(b, { workstream: null, source: "u", payload: "SECOND" });
        inWindow = "appended";
      } catch (err) {
        if ((err as { code?: string }).code !== "SQLITE_BUSY") throw err;
        inWindow = "busy";
      }
    });
    appendLog(hooked, { workstream: null, source: "u", payload: "FIRST" });
    if (inWindow === "busy") appendLog(b, { workstream: null, source: "u", payload: "SECOND" });

    // Commit order (seq) must equal hlc order, or a flush between the
    // two commits strands the earlier hlc.
    const bySeq = a
      .prepare("SELECT payload, hlc FROM ops WHERE entity = 'message' ORDER BY seq")
      .all() as Array<{ payload: string; hlc: string }>;
    const byHlc = [...bySeq].sort((x, y) => (x.hlc < y.hlc ? -1 : 1));
    expect(bySeq.map((r) => r.payload)).toEqual(byHlc.map((r) => r.payload));
    expect(inWindow).toBe("busy");
  });
});
