// The @mu_* crew tags murmur reads (driver, workstream, role) must land on a
// real pane. The unit tests mock the executor, so they never saw tmux reject
// the guarded, ;-chained set-option that set them.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crewTagsDoctorCheck, retagAgents } from "../src/agents/crew-tags.js";
import { getReceipt } from "../src/agents/receipts.js";
import { spawnForTask } from "../src/agents/task-spawn.js";
import { spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { tmuxBackend } from "../src/mux.js";
import { addTask } from "../src/tasks/edit.js";
import { taskIdFor } from "../src/tasks.js";
import {
  resetSleep,
  resetTmuxExecutor,
  setTmuxExecutor,
  spawnAgent as spawnPane,
  tmux,
} from "../src/tmux.js";
import { freshWorkstream } from "./_fixture.js";
import { killPrivateSession, tmuxIntegrationAvailable } from "./_mux.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;

describeIfTmux("spawnAgent tags a real pane", () => {
  let session: string;

  beforeEach(() => {
    resetTmuxExecutor();
    resetSleep();
    session = `mu-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    try {
      await tmux(["kill-session", "-t", `=${session}`]);
    } catch {}
  });

  it("sets @mu_agent, @mu_workstream and @mu_role", async () => {
    const pane = await spawnPane({
      session,
      window: "w1",
      name: "w1",
      cli: "pi",
      command: "sleep 60",
      env: {},
      paneOptions: { "@mu_agent": "w1", "@mu_workstream": "ws", "@mu_role": "worker" },
    });
    const tags = await tmux([
      "display-message",
      "-p",
      "-t",
      pane,
      "#{@mu_agent}|#{@mu_workstream}|#{@mu_role}",
    ]);
    expect(tags.trim()).toBe("w1|ws|worker");
  });
});

// A failed tag write keeps the pane but is visible: the spawn warns and its receipt keeps it,
// doctor names the agent, `mu agent retag` writes the tags, and doctor is clean again.
describeIfTmux("a failed tag write is visible and repairable", () => {
  let tempDir: string;
  let db: Db;
  let workstream: string;

  beforeEach(() => {
    resetTmuxExecutor();
    resetSleep();
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    tempDir = mkdtempSync(join(tmpdir(), "mu-tags-i-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    workstream = freshWorkstream("tags");
    // Every @mu_* set-option fails, as a tmux that rejects the chained command would.
    const real = setTmuxExecutor(async (args) =>
      args.some((a) => a.includes("set-option") && a.includes("@mu_agent"))
        ? { exitCode: 1, stdout: "", stderr: "injected: unknown option" }
        : real(args),
    );
  });

  afterEach(async () => {
    resetTmuxExecutor();
    const key = "MU_SPAWN_LIVENESS_MS";
    delete process.env[key];
    try {
      db.close();
    } catch {}
    try {
      await killPrivateSession(`mu-${workstream}`);
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("spawn warns, doctor reports, retag fixes, doctor ok", async () => {
    const agent = await spawnAgent(db, {
      name: "w1",
      workstream,
      cli: "sh",
      command: "sh -c 'while true; do sleep 60; done'",
    });
    expect(agent.tagWarning).toMatch(
      new RegExp(`@mu_\\* tags not set on ${agent.paneId} \\(tmux: injected: unknown option\\)`),
    );
    expect(agent.tagWarning).toContain("murmur will show this agent as human");

    const before = await crewTagsDoctorCheck(db, tmuxBackend);
    expect(before.check.status).toBe("warn");
    expect(before.problems.map((p) => p.agent.name)).toEqual(["w1"]);
    expect(before.lines[0]).toContain(`mu agent retag -w ${workstream} w1`);

    // The write path works again: retag writes them, and a second run changes nothing.
    resetTmuxExecutor();
    const fixed = await retagAgents(db, tmuxBackend, { workstream });
    expect(fixed).toMatchObject([{ name: "w1", status: "changed" }]);
    expect(await retagAgents(db, tmuxBackend, { workstream })).toMatchObject([
      { name: "w1", status: "ok" },
    ]);
    const tags = await tmux([
      "display-message",
      "-p",
      "-t",
      agent.paneId,
      "#{@mu_agent}|#{@mu_workstream}|#{@mu_role}",
    ]);
    expect(tags.trim()).toBe(`w1|${workstream}|worker`);
    const after = await crewTagsDoctorCheck(db, tmuxBackend);
    expect(after.check.status).toBe("ok");
    expect(after.problems).toEqual([]);
  });

  it("a task-bound spawn records the warning in its receipt", async () => {
    addTask(db, { localId: "t1", workstream, title: "T1", impact: 50, effortDays: 1 });
    // A mux-channel agent on tmux cannot take the prompt; the receipt is written either way.
    await spawnForTask(db, {
      task: "t1",
      text: "go",
      spawn: { name: "w2", workstream, cli: "sh", command: "sh -c 'sleep 60'" },
    }).catch(() => undefined);
    const rec = getReceipt(db, taskIdFor(db, "t1", workstream) ?? 0, "manual:t1");
    expect(rec?.warning).toMatch(/@mu_\* tags not set on %\d+ \(tmux: injected/);
  });
});
