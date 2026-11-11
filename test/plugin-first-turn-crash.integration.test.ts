// An at-start --task spawn SIGKILLed mid-way (plugins spec D8 G1a, G1b; review
// of P6e2): the spawn runs built mu in its own process (test/_kill-spawn.mjs)
// and is killed once its view's row is finalized, the view itself never done.
// The replay in this process must converge without a second delivery:
//   - killed after a successful job.start: the receipt never went back to
//     `pane`, so the replay sends nothing and reports the attempt sent;
//   - killed while a replay's lookup recovery opened the view: the next replay
//     still knows its agent (same incarnation) and reports it sent.
// Review 2 of P6e2 (rulings 2, 3): a `mu agent check` while the spawn that
// created the job still runs only reads (never resolves the start, never moves
// the receipt), so the spawn keeps its unknown start and a later replay sends
// nothing new; an on-send kind's start reply (a baseline, no prompt) never
// counts as the first delivery, so a replay after a SIGKILL still sends it.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getReceipt } from "../src/agents/receipts.js";
import { spawnForTask } from "../src/agents/task-spawn.js";
import { getAgent } from "../src/agents.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
import { cmdAgentCheck } from "../src/cli/agents.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask, taskIdFor } from "../src/tasks.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();
const REQUEST = {
  spawn: { name: "w1", workstream: "ws", host: "box", cli: "claude" },
  task: "t1",
  text: "do the t1 work",
};
const receipt = () => getReceipt(h.db, taskIdFor(h.db, "t1", "ws") ?? -1, "manual:t1");
const LOCK = "MU_AGENT_LOCK_TIMEOUT_MS";
let child: ChildProcess | undefined;

afterEach(() => {
  if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child = undefined;
  delete process.env[LOCK];
});

/** Run the spawn in a child and SIGKILL it once w1's row holds the view's pane. */
async function spawnAndKill(): Promise<void> {
  let stderr = "";
  const c = spawn(
    process.execPath,
    [join(import.meta.dirname, "_kill-spawn.mjs"), h.db.name, REQUEST.text],
    {
      env: { ...process.env, HOME: h.dir, MU_SYNC_DIR: "", MU_DB_PATH: h.db.name },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child = c;
  c.stderr?.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise((r) => c.once("exit", r));
  const until = Date.now() + 20_000;
  while (getAgent(h.db, "w1", "ws")?.paneId !== "%1") {
    if (c.exitCode !== null) throw new Error(`the spawn exited ${c.exitCode}: ${stderr}`);
    if (Date.now() > until) throw new Error(`the spawn never finalized its view: ${stderr}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  c.kill("SIGKILL");
  await exited;
  // The view the dead spawn opened is still up; its locks die with it.
  h.panes.set("%1", { command: "view" });
  process.env[LOCK] = "45000";
}

describe("a SIGKILLed at-start --task spawn converges on replay, never delivering twice", () => {
  it("killed after a successful job.start: the replay sends nothing and reports sent", {
    timeout: 90_000,
  }, async () => {
    await h.setup({ firstTurn: "at-start" });
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    await spawnAndKill();
    expect(getCarrierJobByName(h.db, "ws", "w1")?.job).toBe("job-1");
    expect(receipt()?.state).not.toBe("pane"); // monotone: never back from sending
    const out = await spawnForTask(h.db, REQUEST);
    expect(out.state).toBe("sent");
    expect(h.f.backend().starts).toBe(1);
    expect(h.calls("channel.send")).toHaveLength(0);
    expect(getTask(h.db, "t1", "ws")?.ownerId).toBe(getAgent(h.db, "w1", "ws")?.incarnation);
    expect(receipt()).toMatchObject({ state: "sent", runs: 0, paneId: "%1" });
  });

  it("killed during the replay's lookup recovery: the next replay reports sent", {
    timeout: 90_000,
  }, async () => {
    await h.setup({ firstTurn: "at-start" });
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    h.f.set({ faults: { "job.start": ["effectThenExit"] } });
    expect((await spawnForTask(h.db, REQUEST)).state).toBe("unknown");
    // That first spawn crashed (its process is gone): only then may another resolve (D8).
    const dead = spawnSync("true").pid;
    h.db.prepare("UPDATE carrier_jobs SET creator_pid = ?, creator_start = NULL").run(dead);
    await spawnAndKill(); // the child's run is a replay: lookup found, the view opening
    const out = await spawnForTask(h.db, REQUEST);
    expect(out).toMatchObject({ state: "sent" });
    expect(out.stale).toBeUndefined();
    expect(h.f.backend().starts).toBe(1);
    expect(h.calls("channel.send")).toHaveLength(0);
    expect(receipt()).toMatchObject({ state: "sent", paneId: "%1" });
  });
});

describe("review 2 of P6e2: owner-only resolution and at-start-only delivery", () => {
  it("a concurrent mu agent check only reads while the spawn lives; the attempt is never failed or redispatched", {
    timeout: 90_000,
  }, async () => {
    await h.setup({ firstTurn: "at-start" });
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    h.f.set({ faults: { "job.start": ["effectThenExit"] } });
    const marker = join(h.dir, "start-catch");
    let stderr = "";
    const c = spawn(
      process.execPath,
      [join(import.meta.dirname, "_check-race-child.mjs"), h.db.name, marker],
      {
        env: { ...process.env, HOME: h.dir, MU_SYNC_DIR: "", MU_DB_PATH: h.db.name },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child = c;
    c.stderr?.on("data", (d) => {
      stderr += d;
    });
    const exited = new Promise((r) => c.once("exit", r));
    try {
      const until = Date.now() + 20_000;
      while (!existsSync(marker)) {
        if (c.exitCode !== null) throw new Error(`the spawn exited ${c.exitCode}: ${stderr}`);
        if (Date.now() > until) throw new Error(`no barrier: ${stderr}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      // The spawn is paused between the start's rejection and its catch: check only reads.
      await expect(
        cmdAgentCheck(h.db, "w1", receipt()?.msgId ?? "", { workstream: "ws" }),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(getCarrierJobByName(h.db, "ws", "w1")?.job).toBeNull();
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM effects").get()).toEqual({ n: 1 });
    } finally {
      writeFileSync(`${marker}.go`, "go");
      await exited;
    }
    expect(receipt()?.state).toBe("unknown");
    process.env[LOCK] = "45000";
    const out = await spawnForTask(h.db, REQUEST);
    expect(out.state).toBe("sent");
    expect(h.f.backend().starts).toBe(1);
    expect(h.calls("channel.send")).toHaveLength(0);
  });

  it("an on-send start reply's baseline never moves the receipt: it only goes forward to sent", async () => {
    await h.setup(
      { firstTurn: "on-send" },
      {
        replies: {
          "job.start": {
            handle: "job-x",
            view: { command: "sleep 600", env: {} },
            baseline: { runs: 0, incarnation: "inc-1" },
          },
        },
      },
    );
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    h.db.exec(
      "CREATE TEMP TABLE state_log (state TEXT); CREATE TEMP TRIGGER log_state AFTER UPDATE OF state ON spawn_receipts BEGIN INSERT INTO state_log VALUES (NEW.state); END;",
    );
    expect((await spawnForTask(h.db, REQUEST)).state).toBe("sent");
    const states = (h.db.prepare("SELECT state FROM state_log").all() as { state: string }[]).map(
      (r) => r.state,
    );
    expect(states.filter((s, i) => s !== states[i - 1])).toEqual([
      "pane",
      "claimed",
      "sending",
      "sent",
    ]);
    expect(h.calls("channel.send")).toHaveLength(1);
  });

  it("SIGKILL after an on-send start with a baseline: the replay still delivers the prompt", {
    timeout: 90_000,
  }, async () => {
    await h.setup(
      { firstTurn: "on-send" },
      {
        replies: {
          "job.start": {
            handle: "job-on-send-1",
            view: { command: "sleep 600", env: {} },
            baseline: { runs: 0, incarnation: "inc-1" },
          },
        },
      },
    );
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    await spawnAndKill();
    expect(h.calls("job.start")[0]?.params.spec).not.toHaveProperty("firstPrompt");
    expect(receipt()?.state).not.toBe("sent");
    const out = await spawnForTask(h.db, REQUEST);
    expect(out.state).toBe("sent");
    expect(h.calls("channel.send")).toHaveLength(1);
    expect(h.calls("channel.send")[0]?.params).toMatchObject({ text: REQUEST.text });
  });
});
