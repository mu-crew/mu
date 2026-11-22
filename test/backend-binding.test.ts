// Spec A §8.2: one managed backend per workstream. A spawn refuses while a live row
// names another backend; reconcile keeps that row; a Rex terminal driving tmux is allowed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MuxBackendMismatchError } from "../src/agents/errors.js";
import { getAgent, insertAgent, spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { reconcile } from "../src/reconcile.js";
import { installMux, type MuxHarness } from "./_mux.js";

const REX = "block:12345678-1234-1234-1234-123456789abc";
const HERDR = "w1:p2";

let tempDir: string;
let db: Db;
let mux: MuxHarness | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-backend-binding-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  process.env.MU_SPAWN_LIVENESS_MS = "0";
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  const key = "MU_SPAWN_LIVENESS_MS";
  delete process.env[key];
});

const none = async () => ({ stdout: "", stderr: "", exitCode: 1 });

describe("spawn refusal across backends", () => {
  it.each([
    ["tmux", HERDR, "herdr"],
    ["tmux", REX, "rex"],
    ["herdr", "%1", "tmux"],
    ["herdr", REX, "rex"],
    ["rex", "%1", "tmux"],
    ["rex", HERDR, "herdr"],
  ] as const)("%s refuses a workstream with a %s-shaped row", async (active, paneId, other) => {
    insertAgent(db, { name: "old", workstream: "auth", paneId });
    mux = installMux(active, none);
    const err = await spawnAgent(db, { name: "new", workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(MuxBackendMismatchError);
    expect(err.message).toContain(`on ${other}`);
    expect(err.message).toContain(`MU_MUX=${other}`);
    expect(getAgent(db, "new", "auth")).toBeUndefined();
  });

  it("does not refuse across workstreams", async () => {
    insertAgent(db, { name: "old", workstream: "other", paneId: HERDR });
    mux = installMux("tmux", none);
    const err = await spawnAgent(db, { name: "new", workstream: "auth" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(MuxBackendMismatchError);
  });

  it("allows a Rex terminal with tmux workers: only rows count", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    mux = installMux("tmux", none);
    const err = await spawnAgent(db, { name: "w2", workstream: "auth" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(MuxBackendMismatchError);
  });
});

describe("reconcile keeps other backends' rows", () => {
  it("prunes only the active backend's ghost", async () => {
    insertAgent(db, { name: "t", workstream: "auth", paneId: "%1" });
    insertAgent(db, { name: "h", workstream: "auth", paneId: HERDR });
    insertAgent(db, { name: "r", workstream: "auth", paneId: REX });
    mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.prunedGhosts).toBe(1);
    expect(report.foreign.map((a) => a.name).sort()).toEqual(["h", "r"]);
    expect(getAgent(db, "t", "auth")).toBeUndefined();
    expect(getAgent(db, "h", "auth")).toBeDefined();
    expect(getAgent(db, "r", "auth")).toBeDefined();
  });
});
