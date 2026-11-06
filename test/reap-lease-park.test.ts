// The reaper parks a still-reserved lease agent's tasks (spec docs/specs/2026-11-04-lease-adopt.md
// § G3 mu_reap). Reconcile reaps a row whose pane is gone, but for a lease that proves only the
// carrier gone, not the job: a reservation bound to the row that holds a job means the original
// pi may still be writing, so its IN_PROGRESS tasks reopen OPEN/parked, out of `ready`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import {
  bindCarrierJobAgent,
  fillCarrierJob,
  markCarrierLaunch,
  reserveCarrierJob,
} from "../src/carrier-jobs.js";
import { type Db, openDb } from "../src/db.js";
import { reconcile } from "../src/reconcile.js";
import { TaskParkedError } from "../src/tasks/errors.js";
import { addTask, claimTask, getTask, listNotes, listReady } from "../src/tasks.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let db: Db;
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrp-"));
  db = openDb({ path: join(dir, "mu.db") });
  mux = installMux("tmux", mockTmux(freshMockState()).executor);
});

afterEach(() => {
  mux.restore();
  db.close();
  rmFixtureDir(dir);
});

/** A worker on a pane the mock mux does not have, holding task `t1`. */
async function worker(kind: "lease-job" | "lease-nojob" | "session"): Promise<void> {
  const lease = kind !== "session";
  const r = lease
    ? reserveCarrierJob(db, { workstream: "auth", name: "w1", host: "dev", hostStop: "stop" })
    : undefined;
  if (r) markCarrierLaunch(db, r.token);
  const row = insertAgent(db, {
    name: "w1",
    workstream: "auth",
    paneId: "%90",
    host: "dev",
    hostTransport: lease ? "lease" : "session",
    ...(r ? { reservation: r.token } : {}),
    cwd: "/srv/repo",
  });
  if (r) bindCarrierJobAgent(db, r.token, row.incarnation, "%90");
  if (r && kind === "lease-job") fillCarrierJob(db, r.token, "job-7");
  addTask(db, { localId: "t1", workstream: "auth", title: "T1", impact: 50, effortDays: 1 });
  await claimTask(db, "t1", { agentName: "w1", workstream: "auth" });
}

const lastNote = (): string => listNotes(db, "t1", "auth").at(-1)?.content ?? "<no note>";

describe("reconcile reaps a lease row", () => {
  it("with a handle: OPEN/parked, the note names the job and both ways out, ready and a plain claim skip it", async () => {
    await worker("lease-job");
    expect((await reconcile(db, { workstream: "auth" })).prunedGhosts).toBe(1);
    expect(getTask(db, "t1", "auth")).toMatchObject({
      status: "OPEN",
      substate: "parked",
      ownerName: null,
    });
    expect(lastNote()).toBe(
      "[reaper] previous owner w1 gone (pane died); its lease job job-7 on dev may still run, so the task is parked: resume with mu agent reattach w1 -w auth --task t1, or mu agent close w1 -w auth then mu task unpark t1",
    );
    expect(listReady(db, "auth").map((t) => t.name)).not.toContain("t1");
    insertAgent(db, { name: "w2", workstream: "auth", paneId: "%91" });
    await expect(claimTask(db, "t1", { agentName: "w2", workstream: "auth" })).rejects.toThrow(
      TaskParkedError,
    );
  });

  it.each(["lease-nojob", "session"] as const)("%s: OPEN/todo, as before", async (kind) => {
    await worker(kind);
    await reconcile(db, { workstream: "auth" });
    expect(getTask(db, "t1", "auth")).toMatchObject({ status: "OPEN", substate: "todo" });
    expect(lastNote()).toContain("[reaper] previous owner w1 gone (agent removed)");
    expect(listReady(db, "auth").map((t) => t.name)).toContain("t1");
  });
});
