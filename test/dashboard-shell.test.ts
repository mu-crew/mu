// The dashboard shell lifecycle (S1): two connections (RO projection, writable
// sync outside render), single-flight bounded sync, final flush, q/Esc exit.

import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/cli/tui/app.js";
import { createRuntime } from "../src/cli/tui/runtime.js";
import { type Db, openDb } from "../src/db.js";
import { ambientFlush } from "../src/sync.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { renderApp } from "./_ink-render.js";

const SYNC = "MU_SYNC_DIR";

describe("dashboard shell", () => {
  let tmp: string;
  let syncDir: string;
  let a: Db;
  let b: Db;
  const opened: Db[] = [];

  const seed = (db: Db, name: string): void => {
    ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: name, title: name, impact: 50, effortDays: 1 });
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-dash-shell-"));
    syncDir = join(tmp, "shared");
    mkdirSync(syncDir);
    a = openDb({ path: join(tmp, "a.db") });
    b = openDb({ path: join(tmp, "b.db") });
    opened.push(a, b);
    delete process.env[SYNC];
  });

  afterEach(() => {
    for (const db of opened.splice(0)) {
      try {
        db.close();
      } catch {}
    }
    delete process.env[SYNC];
    rmFixtureDir(tmp);
  });

  it("projects on a read-only connection (the projection cannot write)", async () => {
    seed(a, "t1");
    const rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: a, caller: null });
    const { snapshot } = await rt.refresh();
    expect(snapshot.tasks.map((t) => t.key)).toEqual(["demo/t1"]);
    expect(snapshot.caller_scope).toBe("none");
    await rt.close();
  });

  it("ingests a peer on the writable sync connection, then projects it", async () => {
    seed(b, "peer1");
    process.env[SYNC] = syncDir;
    await ambientFlush(b, { quiet: true });
    const rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: a, caller: null });
    const { snapshot, warnings } = await rt.refresh();
    expect(warnings).toEqual([]);
    expect(snapshot.tasks.map((t) => t.key)).toEqual(["demo/peer1"]);
    await rt.close();
  });

  it("shares one in-flight refresh and throttles ingest to the sync gap", async () => {
    process.env[SYNC] = syncDir;
    let clock = 0;
    const rt = createRuntime({
      dbPath: join(tmp, "a.db"),
      syncDb: a,
      caller: null,
      syncEveryMs: 1000,
      now: () => clock,
    });
    const first = rt.refresh();
    expect(rt.refresh()).toBe(first);
    await first;
    // Peer lands after the first ingest: not read until the gap passes.
    seed(b, "late");
    await ambientFlush(b, { quiet: true });
    clock = 999;
    expect((await rt.refresh()).snapshot.tasks).toHaveLength(0);
    clock = 1000;
    expect((await rt.refresh()).snapshot.tasks).toHaveLength(1);
    await rt.close();
  });

  it("close() flushes this machine's ops once and refuses further refreshes", async () => {
    seed(a, "mine");
    process.env[SYNC] = syncDir;
    const rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: a, caller: null });
    expect(readdirSync(syncDir)).toEqual([]);
    await rt.close();
    expect(readdirSync(syncDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
    await rt.close(); // idempotent
    await expect(rt.refresh()).rejects.toThrow(/closed/);
  });

  it("sync off: no file written, no ingest", async () => {
    seed(a, "t1");
    const rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: a, caller: null });
    await rt.refresh();
    await rt.close();
    expect(readdirSync(syncDir)).toEqual([]);
  });

  it("renders the snapshot, and q exits", async () => {
    seed(a, "t1");
    const rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: a, caller: null });
    const ui = await renderApp(createElement(App, { runtime: rt, pollMs: null }));
    await ui.until((s) => s.includes("1 workstreams · 1 tasks"));
    ui.press("q");
    await ui.exited;
    await rt.close();
  });

  it("Esc exits too", async () => {
    const rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: a, caller: null });
    const ui = await renderApp(createElement(App, { runtime: rt, pollMs: null }));
    await ui.until((s) => s.includes("0 workstreams"));
    ui.press("\u001b");
    await ui.exited;
    await rt.close();
  });

  it("a failed refresh shows the error and keeps the last good snapshot", async () => {
    seed(a, "t1");
    const rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb: a, caller: null });
    let calls = 0;
    const flaky = {
      refresh: (q?: Parameters<typeof rt.refresh>[0]) =>
        ++calls === 1 ? rt.refresh(q) : Promise.reject(new Error("boom")),
      close: rt.close,
    };
    const ui = await renderApp(createElement(App, { runtime: flaky, pollMs: 0 }));
    await ui.until((s) => s.includes("error: boom") && s.includes("1 tasks"));
    ui.unmount();
    await ui.exited;
    await rt.close();
  });
});
