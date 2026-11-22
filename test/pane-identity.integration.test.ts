// A tmux pane id is unique only within one server's lifetime: after a server
// restart, an unrelated pane can recycle `%1`. A row records the server it was
// spawned on (`agents.pane_identity`) and owns a pane only on that server.
//
// Real tmux on a PRIVATE socket of its own (never the suite's shared one, whose
// server other tests use): the test kills only that server.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBaseStates } from "../src/agent-state.js";
import { AgentPaneDeadError } from "../src/agents/errors.js";
import { getAgent, insertAgent } from "../src/agents.js";
import { agentChannel, channelTarget } from "../src/channels/index.js";
import { type Db, openDb } from "../src/db.js";
import { viewOwned } from "../src/jobs/view.js";
import { reconcile } from "../src/reconcile.js";
import {
  capture,
  ensureSession,
  paneAlive,
  resetTmuxExecutor,
  serverIdentity,
  spawnAgent,
  tmux,
} from "../src/tmux.js";
import { pollUntil } from "./_env.js";
import { tmuxIntegrationAvailable } from "./_mux.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;
const SLEEP = "sh -c 'echo FOREIGN-PANE; while true; do sleep 60; done'";

describeIfTmux("pane identity across a tmux server restart (real tmux, private socket)", () => {
  let dir: string;
  let db: Db;
  let outer: string | undefined;
  const ws = "idws";
  const session = `mu-${ws}`;

  const spawn = (name: string) =>
    spawnAgent({
      session,
      window: name,
      name,
      cli: "pi",
      command: SLEEP,
      commandSource: "cli-key",
      env: {},
    });

  /** Kill the private server and start a new one whose first agent pane recycles the old id. */
  const restartServer = async (): Promise<string> => {
    await tmux(["kill-server"]).catch(() => {});
    await pollUntil(async () => (await serverIdentity()) === undefined, {
      description: "old server gone",
    });
    await ensureSession(session);
    return spawn("someone-else");
  };

  beforeEach(() => {
    outer = process.env.MU_TMUX_SOCKET;
    process.env.MU_TMUX_SOCKET = `mu-test-pid-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    resetTmuxExecutor();
    dir = mkdtempSync(join(tmpdir(), "mu-pane-identity-"));
    db = openDb({ path: join(dir, "mu.db") });
  });

  afterEach(async () => {
    try {
      await tmux(["kill-server"]);
    } catch {}
    if (outer === undefined) delete process.env.MU_TMUX_SOCKET;
    else process.env.MU_TMUX_SOCKET = outer;
    resetTmuxExecutor();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a recycled pane id on a new server is dead for the row, and left untouched", async () => {
    await ensureSession(session);
    const pane = await spawn("worker");
    const identity = await serverIdentity();
    expect(identity).toMatch(/^\d+\|\d+$/);
    insertAgent(db, {
      name: "worker",
      workstream: ws,
      paneId: pane,
      paneIdentity: identity ?? null,
    });
    insertAgent(db, { name: "legacy", workstream: ws, paneId: pane }); // no identity: unverified
    expect(await reconcile(db, { workstream: ws, mode: "report-only" })).toMatchObject({
      prunedGhosts: 0,
    });

    const foreign = await restartServer();
    expect(foreign).toBe(pane); // the id was recycled
    expect(await paneAlive(foreign)).toBe(true);
    const row = getAgent(db, "worker", ws);
    if (row === undefined) throw new Error("row missing");

    // Liveness: the state read, ownership and every pane-addressed delivery say dead.
    expect(await viewOwned(row.paneIdentity)).toBe(false);
    const reading = (await readBaseStates([row], {})).values().next().value;
    expect(reading).toMatchObject({ alive: false });
    const target = channelTarget(db, row);
    await expect(agentChannel(target).send(target, "hello", {})).rejects.toBeInstanceOf(
      AgentPaneDeadError,
    );

    // Reconcile prunes only the identified row; the legacy row keeps today's check.
    const report = await reconcile(db, { workstream: ws });
    expect(report.prunedGhosts).toBe(1);
    expect(getAgent(db, "worker", ws)).toBeUndefined();
    expect(getAgent(db, "legacy", ws)).toBeDefined();

    // The foreign pane was never touched.
    expect(await paneAlive(foreign)).toBe(true);
    expect(await capture(foreign)).toContain("FOREIGN-PANE");
  }, 30_000);

  it("the same server keeps its row", async () => {
    await ensureSession(session);
    const pane = await spawn("worker");
    insertAgent(db, {
      name: "worker",
      workstream: ws,
      paneId: pane,
      paneIdentity: (await serverIdentity()) ?? null,
    });
    expect((await reconcile(db, { workstream: ws })).prunedGhosts).toBe(0);
    expect(getAgent(db, "worker", ws)).toBeDefined();
  }, 30_000);
});
