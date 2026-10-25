// The one teardown path: idempotent, ordered, and the final flush always runs
// (including when boot failed before any step was registered).

import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShutdown, withShutdown } from "../src/cli/dashboard-shutdown.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const SYNC = "MU_SYNC_DIR";

describe("dashboard shutdown", () => {
  let tmp: string;
  let shared: string;
  let db: Db;
  const segments = (): string[] => readdirSync(shared).filter((f) => f.endsWith(".jsonl"));

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-dash-down-"));
    shared = join(tmp, "shared");
    db = openDb({ path: join(tmp, "a.db") });
    ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: "t1", title: "t1", impact: 50, effortDays: 1 });
    // Sync dir exists and is empty: the flush is the only thing that can fill it.
    process.env[SYNC] = shared;
    mkdirSync(shared);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    delete process.env[SYNC];
    rmFixtureDir(tmp);
  });

  it("runs steps in order, then flushes once; run() is idempotent", async () => {
    const order: string[] = [];
    const sd = createShutdown(db);
    sd.add(() => void order.push("render"));
    sd.add(async () => void order.push("runtime"));
    expect(segments()).toEqual([]);
    const first = sd.run();
    expect(sd.run()).toBe(first);
    await first;
    await sd.run();
    expect(order).toEqual(["render", "runtime"]);
    expect(segments()).toHaveLength(1);
  });

  it("a throwing step does not stop later steps or the flush", async () => {
    const sd = createShutdown(db);
    let ran = false;
    sd.add(() => {
      throw new Error("step failed");
    });
    sd.add(() => {
      ran = true;
    });
    await sd.run();
    expect(ran).toBe(true);
    expect(segments()).toHaveLength(1);
  });

  it("a boot error before any step still flushes, and the error propagates", async () => {
    await expect(
      withShutdown(db, async () => {
        throw new Error("injected boot error");
      }),
    ).rejects.toThrow("injected boot error");
    expect(segments()).toHaveLength(1);
  });

  it("a signal runs teardown (flush) and then exits with the signal's code", async () => {
    const codes: number[] = [];
    let release: () => void = () => {};
    const parked = new Promise<void>((r) => {
      release = r;
    });
    const done = withShutdown(
      db,
      () => parked,
      (c) => void codes.push(c),
    );
    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 20));
    expect(codes).toEqual([130]);
    expect(segments()).toHaveLength(1);
    release();
    await done;
    expect(process.listenerCount("SIGINT")).toBe(0);
  });
});
