// The TUI's production sync path: the slow tick posts ambientSyncPass to
// the built worker_thread (dist/tui-sync-worker.js). Vitest imports
// source, where that bundle is absent and tuiSyncPass falls back to
// in-process, so the fast tier never runs the worker. This drives the
// real bundle: its bootstrap and DB path, the completion protocol, and
// recovery from a worker that dies mid-pass.
//
// Integration tier: needs `npm run build` first. The bundle's bare
// imports (better-sqlite3, …) resolve from the repo's node_modules, so
// it cannot be built into a temp dir.

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setSyncWorkerPathForTests,
  syncWorkerForTests,
  tuiSyncPass,
} from "../src/cli/tui/state.js";
import { type Db, openDb } from "../src/db.js";
import { flushSegment, localMachineId } from "../src/segments.js";
import { ambientSyncPass } from "../src/sync.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const WORKER = join(process.cwd(), "dist", "tui-sync-worker.js");
const SYNC_DIR_KEY = "MU_SYNC_DIR";

type Pass = Awaited<ReturnType<typeof ambientSyncPass>>;

/** Strip what differs by DB/dir (paths), keep every field and count. */
function normalize(pass: Pass | null, self: Db): unknown {
  if (pass === null) return null;
  const me = localMachineId(self);
  return {
    ingested: pass.ingested.map((i) => ({ ...i, path: basename(i.path) })),
    flushed:
      pass.flushed === null
        ? null
        : {
            ...pass.flushed,
            segmentPath:
              pass.flushed.segmentPath === null
                ? null
                : basename(pass.flushed.segmentPath).replace(me, "<self>"),
          },
  };
}

describe("TUI sync worker (dist/tui-sync-worker.js)", () => {
  let tempDir: string;
  const dbs: Db[] = [];

  const db = (name: string): Db => {
    const d = openDb({ path: join(tempDir, `${name}.db`) });
    dbs.push(d);
    return d;
  };

  /** A sync dir holding one peer's segment with one task in it. */
  const peerDir = async (peer: Db, name: string): Promise<string> => {
    const dir = join(tempDir, name);
    mkdirSync(dir, { recursive: true });
    await flushSegment(peer, dir);
    return dir;
  };

  const taskTitle = (d: Db, localId: string): string | undefined =>
    (
      d.prepare("SELECT title FROM tasks WHERE local_id = ?").get(localId) as
        | { title: string }
        | undefined
    )?.title;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-tui-sync-worker-"));
    await setSyncWorkerPathForTests(WORKER);
  });

  afterEach(async () => {
    try {
      await setSyncWorkerPathForTests(null);
      for (const d of dbs.splice(0)) d.close();
      delete process.env[SYNC_DIR_KEY];
      rmFixtureDir(tempDir);
    } catch {
      // best-effort cleanup
    }
  });

  it("the build emitted the worker bundle", () => {
    expect(existsSync(WORKER), `${WORKER} missing; run npm run build`).toBe(true);
  });

  it("a pass through the worker reports what the in-process pass reports", async () => {
    const peer = db("peer");
    ensureWorkstream(peer, "demo");
    addTask(peer, {
      workstream: "demo",
      localId: "t1",
      title: "From peer",
      impact: 50,
      effortDays: 1,
    });
    const dirIn = await peerDir(peer, "shared-in");
    const dirWorker = await peerDir(peer, "shared-worker");

    const inProc = db("in-proc");
    process.env[SYNC_DIR_KEY] = dirIn;
    const expected = await ambientSyncPass(inProc, { quiet: true });
    expect(expected.ingested).toHaveLength(1);
    expect(expected.ingested[0]?.changed).toBeGreaterThan(0);

    const viaWorker = db("via-worker");
    process.env[SYNC_DIR_KEY] = dirWorker; // the worker copies env at spawn
    const got = await tuiSyncPass(viaWorker);
    expect(syncWorkerForTests()).not.toBeNull(); // the worker ran it, not the fallback
    expect(normalize(got, viaWorker)).toEqual(normalize(expected, inProc));
    // The worker's own connection wrote the DB file the TUI reads.
    expect(taskTitle(viaWorker, "t1")).toBe("From peer");
  });

  it("a killed worker settles its pass, and the next beat respawns it", async () => {
    const peer = db("peer");
    ensureWorkstream(peer, "demo");
    addTask(peer, {
      workstream: "demo",
      localId: "t1",
      title: "From peer",
      impact: 50,
      effortDays: 1,
    });
    process.env[SYNC_DIR_KEY] = await peerDir(peer, "shared");
    const local = db("local");

    const pending = tuiSyncPass(local);
    const first = syncWorkerForTests();
    if (first === null) throw new Error("expected tuiSyncPass to spawn the worker");
    // In flight: the guard turns a concurrent beat away.
    expect(await tuiSyncPass(local)).toBeNull();
    await first.terminate(); // before it can load, so the pass dies mid-flight
    expect(await pending).toBeNull();
    expect(syncWorkerForTests()).toBeNull();

    // syncInFlight cleared: the next beat runs, on a fresh worker.
    const next = await tuiSyncPass(local);
    const second = syncWorkerForTests();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(next?.ingested).toHaveLength(1);
    expect(taskTitle(local, "t1")).toBe("From peer");
  });
});
