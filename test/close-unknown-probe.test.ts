// rr_r3_close_unknown_probe: `agent close` deletes a row (and frees what it
// holds: task claim, worktree) only once its pane is proven gone, in every
// workstream. A probe that cannot answer, or no multiplexer at all, refuses
// (AgentPaneStillAliveError, "unknown", exit 4) and names `--force`, which
// overrides only that doubt, never a pane that answered alive.
// Fast tier: real SQLite in a temp dir, mocked mux.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentPaneStillAliveError,
  closeAgent,
  getAgent,
  insertAgent,
  pendingPaneIdFor,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { agentRevision } from "../src/revision.js";
import { claimTask } from "../src/tasks/claim.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { listWorktrees, registerWorktree } from "../src/worktree.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, installNoMux, type MuxExecutor, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

const OK = { stdout: "", stderr: "", exitCode: 0 };
const DENIED = { stdout: "", stderr: "permission denied", exitCode: 1 };

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness | undefined;

const use = (exec: MuxExecutor): void => {
  mux?.restore();
  mux = installMux("tmux", exec);
};
/** The kill "works" but no probe can answer. */
const unanswerable: MuxExecutor = async (args) => (args[0] === "kill-pane" ? OK : DENIED);
/** The kill does nothing and the pane answers alive. */
const alive: MuxExecutor = async (args) =>
  args[0] === "display-message" ? { ...OK, stdout: `${args[2]}\n` } : OK;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mu-cup-"));
  process.env.MU_STATE_DIR = dir;
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "ws");
  addTask(db, { workstream: "ws", localId: "t1", title: "T", impact: 50, effortDays: 1 });
  insertAgent(db, { name: "w1", workstream: "ws", paneId: "%2" });
  await claimTask(db, "t1", { workstream: "ws", agentName: "w1" });
  // A registered worktree whose dir is gone: the close rule would release it at once.
  const path = join(dir, "worktrees", "ws", "w1");
  registerWorktree(db, {
    path,
    agent: "w1",
    workstream: "ws",
    root: dir,
    base: "a",
    createdAt: "t",
  });
  db.prepare("UPDATE agents SET cwd = ? WHERE name = 'w1'").run(path);
  use(unanswerable);
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  try {
    db.close();
  } catch {
    // already closed
  }
  const key = "MU_STATE_DIR";
  delete process.env[key];
  rmFixtureDir(dir);
});

const kept = (): void => {
  expect(getAgent(db, "w1", "ws")).toBeDefined();
  expect(getTask(db, "t1", "ws")).toMatchObject({ status: "IN_PROGRESS" });
  expect(listWorktrees(db)).toHaveLength(1);
};

const noMux = (fn: () => Promise<void>): Promise<void> =>
  withEnv("TMUX", undefined, () =>
    withEnv("TMUX_PANE", undefined, () =>
      withEnv("HERDR_ENV", undefined, () =>
        withEnv("MU_MUX", undefined, async () => {
          mux?.restore();
          mux = undefined;
          const none = installNoMux();
          try {
            await fn();
          } finally {
            none.restore();
          }
        }),
      ),
    ),
  );

describe("an unanswerable probe in a LIVE workstream", () => {
  it("refuses with state unknown; row, claim and worktree all stay", async () => {
    const err = await closeAgent(db, "w1", { workstream: "ws" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentPaneStillAliveError);
    expect((err as AgentPaneStillAliveError).state).toBe("unknown");
    expect((err as Error).message).toContain("--force");
    kept();
  });

  it("--force closes it", async () => {
    const r = await closeAgent(db, "w1", { workstream: "ws", force: true });
    expect(r.deletedRow).toBe(true);
    expect(getTask(db, "t1", "ws")).toMatchObject({ status: "OPEN" });
  });

  it("--force never overrides a pane that answers alive", async () => {
    use(alive);
    const err = await closeAgent(db, "w1", { workstream: "ws", force: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentPaneStillAliveError);
    expect((err as AgentPaneStillAliveError).state).toBe(true);
    kept();
  });
});

describe("no multiplexer at all", () => {
  it("a real pane id refuses (unknown); --force closes it", async () => {
    await noMux(async () => {
      const err = await closeAgent(db, "w1", { workstream: "ws" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentPaneStillAliveError);
      expect((err as AgentPaneStillAliveError).state).toBe("unknown");
      kept();
      const r = await closeAgent(db, "w1", { workstream: "ws", force: true });
      expect(r.deletedRow).toBe(true);
    });
  });

  it("a pending placeholder (no pane ever existed) still closes", async () => {
    insertAgent(db, { name: "w2", workstream: "ws", paneId: pendingPaneIdFor("w2") });
    await noMux(async () => {
      const r = await closeAgent(db, "w2", { workstream: "ws" });
      expect(r.deletedRow).toBe(true);
    });
  });
});

describe("the CLI", () => {
  it("one stderr line, exit 4; `--force --if` applies", async () => {
    const rev = agentRevision(db, "ws", "w1");
    db.close();
    const refused = await runCli(["agent", "close", "w1", "-w", "ws", "--if", String(rev)], dbPath);
    expect(refused.exitCode).toBe(4);
    expect(refused.stderr.trim().split("\n")).toHaveLength(1);
    expect(refused.stderr).toContain("--force");
    const ok = await runCli(
      ["agent", "close", "w1", "-w", "ws", "--force", "--if", String(rev)],
      dbPath,
    );
    expect(ok.exitCode).toBeNull();
    db = openDb({ path: dbPath });
    expect(getAgent(db, "w1", "ws")).toBeUndefined();
  });
});
