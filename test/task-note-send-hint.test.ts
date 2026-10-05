// A note on a task that another agent is working on does not reach that
// agent: `mu task note` says so and names the send that does.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

type Step = { intent: string; command: string };
let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mtn-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
  addTask(db, { localId: "t1", workstream: "auth", title: "t1", impact: 50, effortDays: 1 });
  mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
});

afterEach(() => {
  mux.restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function note(author: string, json = true) {
  const r = await runCli(
    [
      "task",
      "note",
      "t1",
      "rebuild first",
      "--author",
      author,
      "-w",
      "auth",
      ...(json ? ["--json"] : []),
    ],
    dbPath,
  );
  expect(r.exitCode).toBeNull();
  return r;
}
const steps = (stdout: string) => (JSON.parse(stdout) as { nextSteps: Step[] }).nextSteps;
const sendHint = (s: Step[]) => s.find((x) => x.command.startsWith("mu agent send"));
const claim = () => runCli(["task", "claim", "t1", "--for", "worker-1", "-w", "auth"], dbPath);

describe("mu task note send hint", () => {
  it("another agent's IN_PROGRESS task: names the send (json + human)", async () => {
    await claim();
    const hint = sendHint(steps((await note("orchestrator")).stdout));
    expect(hint).toEqual({
      intent:
        "worker-1 will not see this note: send it (--steer, or --interrupt if the note makes the current work wasted)",
      command: 'mu agent send worker-1 -w auth --steer "..."',
    });
    expect((await note("orchestrator", false)).stdout).toContain("worker-1 will not see this note");
  });

  it("the owner's own note: no send hint", async () => {
    await claim();
    expect(sendHint(steps((await note("worker-1")).stdout))).toBeUndefined();
  });

  it("OPEN task: no send hint", async () => {
    expect(sendHint(steps((await note("orchestrator")).stdout))).toBeUndefined();
  });

  it("CLOSED task: no send hint", async () => {
    await claim();
    await runCli(["task", "close", "t1", "-w", "auth"], dbPath);
    expect(sendHint(steps((await note("orchestrator")).stdout))).toBeUndefined();
  });
});
