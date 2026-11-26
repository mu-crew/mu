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
import { closeAgent } from "../src/agents/close.js";
import { AgentPaneDeadError } from "../src/agents/errors.js";
import { getAgent, insertAgent } from "../src/agents.js";
import { agentChannel, channelTarget } from "../src/channels/index.js";
import { type Db, openDb } from "../src/db.js";
import { agentAttachTarget, rowRef, viewCapture, viewOwned } from "../src/jobs/view.js";
import { tmuxBackend } from "../src/mux.js";
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
import { privatePane, tmuxIntegrationAvailable } from "./_mux.js";
import { registerTmuxSocket, stopTestTmux } from "./_server-registry.js";
import { softTeardown } from "./_teardown.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;
const SLEEP = "sh -c 'echo FOREIGN-PANE; while true; do sleep 60; done'";

describeIfTmux("pane identity across a tmux server restart (real tmux, private socket)", () => {
  let dir: string;
  let db: Db;
  let outer: string | undefined;
  let socket: string | undefined;
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
    await pollUntil(async () => (await serverIdentity().catch(() => "exiting")) === undefined, {
      description: "old server gone",
    });
    await ensureSession(session);
    return spawn("someone-else");
  };

  beforeEach(() => {
    outer = process.env.MU_TMUX_SOCKET;
    socket = registerTmuxSocket();
    process.env.MU_TMUX_SOCKET = socket;
    resetTmuxExecutor();
    dir = mkdtempSync(join(tmpdir(), "mu-pane-identity-"));
    db = openDb({ path: join(dir, "mu.db") });
  });

  afterEach(() => {
    try {
      stopTestTmux(socket);
    } catch {}
    socket = undefined;
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
    expect(await capture(await privatePane(foreign))).toContain("FOREIGN-PANE");
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
  // An upgrading user's agents were spawned before `agents.pane_identity`: their rows have
  // none. They keep the check mu made before the column (act on the id), never a refusal.
  it("a legacy row is still captured, sent to, attached and closed by its id", async () => {
    await ensureSession(session);
    const pane = await spawnAgent({
      session,
      window: "old",
      name: "old",
      cli: "pi",
      command: "sh -c 'echo LEGACY-PANE; exec cat'",
      commandSource: "cli-key",
      env: {},
    });
    insertAgent(db, { name: "old", workstream: ws, paneId: pane }); // no identity
    const row = getAgent(db, "old", ws);
    if (row === undefined) throw new Error("row missing");
    expect(row.paneIdentity).toBeUndefined();

    await pollUntil(
      async () => (await viewCapture(pane, null, {}, tmuxBackend)).includes("LEGACY-PANE"),
      {
        description: "legacy pane captured",
      },
    );
    const ref = rowRef(tmuxBackend, pane, row.paneIdentity);
    await tmuxBackend.pasteToPane?.(ref, "pasted-by-mu");
    await tmuxBackend.sendKeys?.(ref, ["typed-by-mu"], { literal: true });
    await pollUntil(
      async () => {
        const out = await viewCapture(pane, null, {}, tmuxBackend);
        return out.includes("pasted-by-mu") && out.includes("typed-by-mu");
      },
      { description: "legacy pane received the send" },
    );
    const attach = await tmuxBackend.attachCommands({
      ...agentAttachTarget(tmuxBackend, row, ws),
      outside: true,
    });
    expect(attach[0]?.args).toContain(pane);

    const closed = await closeAgent(db, "old", { workstream: ws });
    expect(closed).toBeDefined();
    expect(getAgent(db, "old", ws)).toBeUndefined();
    expect(await paneAlive(pane)).toBe(false);
  }, 30_000);

  it("teardown still closes the session of a legacy row's pane", async () => {
    await ensureSession(session);
    const pane = await spawn("old");
    insertAgent(db, { name: "old", workstream: ws, paneId: pane }); // no identity
    const r = await softTeardown(db, ws);
    expect(r.killedMux).toBe(true);
    expect(await paneAlive(pane)).toBe(false);
  }, 30_000);
});
