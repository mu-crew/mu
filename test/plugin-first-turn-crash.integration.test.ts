// An at-start --task spawn SIGKILLed mid-way (plugins spec D8 G1a, G1b; review
// of P6e2): the spawn runs built mu in its own process (test/_kill-spawn.mjs)
// and is killed once its view's row is finalized, the view itself never done.
// The replay in this process must converge without a second delivery:
//   - killed after a successful job.start: the receipt never went back to
//     `pane`, so the replay sends nothing and reports the attempt sent;
//   - killed while a replay's lookup recovery opened the view: the next replay
//     still knows its agent (same incarnation) and reports it sent.

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getReceipt } from "../src/agents/receipts.js";
import { spawnForTask } from "../src/agents/task-spawn.js";
import { getAgent } from "../src/agents.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
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
    await spawnAndKill(); // the child's run is a replay: lookup found, the view opening
    const out = await spawnForTask(h.db, REQUEST);
    expect(out).toMatchObject({ state: "sent" });
    expect(out.stale).toBeUndefined();
    expect(h.f.backend().starts).toBe(1);
    expect(h.calls("channel.send")).toHaveLength(0);
    expect(receipt()).toMatchObject({ state: "sent", paneId: "%1" });
  });
});
