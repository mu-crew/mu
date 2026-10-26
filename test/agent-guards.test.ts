// Agent-side guards (v_agent_guards): the registry incarnation, the derived
// `agentRevision`, `agent close` as preview + `--if` apply, the replacement
// race (an agent replaced while a close awaits), the fail-closed strict agent
// lock, and the compare-and-swap of every other agent-row writer.
//
// Real SQLite, mocked tmux. The race tests drive the mux executor so the
// replacement lands exactly where a real one would: during `kill-pane`.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentLockPath } from "../src/agents/lock.js";
import {
  AgentLockBusyError,
  AgentReplacedError,
  closeAgent,
  deleteAgent,
  getAgent,
  insertAgent,
  previewClose,
  spawnAgent,
  withAgentLock,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { readFileLockMeta, withFileLock } from "../src/file-lock.js";
import { reconcile } from "../src/reconcile.js";
import { agentRevision, RevisionMismatchError } from "../src/revision.js";
import { addTask, claimTask, getTask, releaseTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { teardownWorkstream, workstreamRevision } from "../src/workstream.js";
import { registerWorktree } from "../src/worktree.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxExecutor, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

const OK = { stdout: "", stderr: "", exitCode: 0 };
const GONE_PANE = { stdout: "", stderr: "can't find pane", exitCode: 1 };

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness | undefined;
const stateKey = "MU_STATE_DIR";

/** tmux where only `live` panes answer display-message; `onKill` runs on kill-pane. */
function tmux(live: () => readonly string[], onKill?: (pane: string) => void): MuxExecutor {
  return async (args) => {
    if (args[0] === "kill-pane") {
      onKill?.(args[2] ?? "");
      return OK;
    }
    if (args[0] === "display-message") {
      const id = args[2] ?? "";
      return live().includes(id) ? { ...OK, stdout: `${id}\n` } : GONE_PANE;
    }
    return { stdout: "", stderr: `unmocked: ${args.join(" ")}`, exitCode: 1 };
  };
}
const use = (exec: MuxExecutor): void => {
  mux?.restore();
  mux = installMux("tmux", exec);
};

const task = (id: string, ws = "auth"): void => {
  addTask(db, { localId: id, workstream: ws, title: id, impact: 50, effortDays: 1 });
};
const sock = (name: string, ws = "auth"): string => ctlSocketPath(ws, name, dir);
const touchSock = (name: string, ws = "auth"): void => {
  mkdirSync(dirname(sock(name, ws)), { recursive: true });
  writeFileSync(sock(name, ws), "");
};
const kills = (): string[] =>
  (mux?.calls ?? []).filter((c) => c[0] === "kill-pane").map((c) => c[2] ?? "");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-agent-guards-"));
  process.env[stateKey] = dir;
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  use(tmux(() => []));
});

afterEach(() => {
  mux?.restore();
  try {
    db.close();
  } catch {}
  delete process.env[stateKey];
  delete process.env.MU_AGENT_LOCK_TIMEOUT_MS;
  rmFixtureDir(dir);
});

describe("incarnation", () => {
  it("a deleted name created again, even with the same pane id, is a new incarnation", () => {
    const a = insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    deleteAgent(db, "w1", "auth");
    const b = insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    expect(b.incarnation).not.toBe(a.incarnation);
    expect(getAgent(db, "w1", "auth")?.incarnation).toBe(b.incarnation);
  });
});

describe("agentRevision", () => {
  it("is 0 for a name with no agent and no worktree", () => {
    expect(agentRevision(db, "auth", "ghost")).toBe(0);
  });

  it("ABA: a name deleted and recreated with identical fields never matches the old revision", () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", cwd: "/x" });
    const before = agentRevision(db, "auth", "w1");
    expect(before).toBeGreaterThan(0);
    expect(agentRevision(db, "auth", "w1")).toBe(before); // stable on re-read
    deleteAgent(db, "w1", "auth");
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", cwd: "/x" });
    expect(agentRevision(db, "auth", "w1")).not.toBe(before);
  });

  it("moves with the gate marker: a gate and a replacement with another token differ", () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", gateToken: "t1" });
    const r0 = agentRevision(db, "auth", "w1");
    db.prepare("UPDATE agents SET gate_token = 't2' WHERE name = 'w1'").run();
    expect(agentRevision(db, "auth", "w1")).not.toBe(r0);
  });

  it("moves with the row's own fields (pane, cwd, host)", () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    const r0 = agentRevision(db, "auth", "w1");
    db.prepare("UPDATE agents SET pane_id = '%2' WHERE name = 'w1'").run();
    const r1 = agentRevision(db, "auth", "w1");
    db.prepare("UPDATE agents SET cwd = '/elsewhere' WHERE name = 'w1'").run();
    const r2 = agentRevision(db, "auth", "w1");
    db.prepare("UPDATE agents SET host = 'big' WHERE name = 'w1'").run();
    const r3 = agentRevision(db, "auth", "w1");
    expect(new Set([r0, r1, r2, r3]).size).toBe(4);
  });

  it("moves when a task is claimed or released: ownership writes tasks.owner_id, not the agent row", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    task("t1");
    const r0 = agentRevision(db, "auth", "w1");
    await claimTask(db, "t1", { agentName: "w1", workstream: "auth" });
    const r1 = agentRevision(db, "auth", "w1");
    expect(r1).not.toBe(r0);
    await releaseTask(db, "t1", { workstream: "auth" });
    expect(agentRevision(db, "auth", "w1")).not.toBe(r1);
  });

  it("counts tasks it owns in ANOTHER workstream", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    task("t1", "other");
    const r0 = agentRevision(db, "auth", "w1");
    await claimTask(db, "t1", { agentName: "w1", workstream: "other", agentWorkstream: "auth" });
    expect(agentRevision(db, "auth", "w1")).not.toBe(r0);
  });

  it("an orphan worktree has a revision of its own, and a replaced registry row moves it", () => {
    const reg = (base: string): void =>
      registerWorktree(db, {
        path: join(dir, "wt"),
        agent: "gone",
        workstream: "auth",
        root: "/repo",
        base,
        createdAt: "t",
      });
    reg("aaa");
    const r0 = agentRevision(db, "auth", "gone");
    expect(r0).toBeGreaterThan(0);
    reg("bbb"); // INSERT OR REPLACE at the same path
    expect(agentRevision(db, "auth", "gone")).not.toBe(r0);
    // Another name's orphan is not this one's revision.
    expect(agentRevision(db, "auth", "other")).toBe(0);
  });
});

describe("agent close: preview, then --if", () => {
  beforeEach(() => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    use(tmux(() => ["%1"]));
  });

  it("previewClose writes and kills nothing, and names the blast radius", async () => {
    task("t1");
    await claimTask(db, "t1", { agentName: "w1", workstream: "auth" });
    const p = await previewClose(db, "w1", { workstream: "auth" });
    expect(p).toMatchObject({
      kind: "agent",
      paneId: "%1",
      revision: agentRevision(db, "auth", "w1"),
      ownedTasks: [{ ref: "auth/t1", status: "IN_PROGRESS", reverts: true }],
      worktree: null,
    });
    expect(kills()).toEqual([]);
    expect(getAgent(db, "w1", "auth")).toBeDefined();
  });

  it("a stale revision refuses with NOTHING killed or deleted", async () => {
    const rev = agentRevision(db, "auth", "w1");
    task("t1");
    await claimTask(db, "t1", { agentName: "w1", workstream: "auth" }); // moves it
    await expect(
      closeAgent(db, "w1", { workstream: "auth", ifRevision: rev }),
    ).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(kills()).toEqual([]);
    expect(getAgent(db, "w1", "auth")).toBeDefined();
    expect(getTask(db, "t1", "auth")?.status).toBe("IN_PROGRESS");
  });

  it("a current revision applies", async () => {
    const rev = agentRevision(db, "auth", "w1");
    use(tmux(() => [])); // the pane dies on the kill
    const r = await closeAgent(db, "w1", { workstream: "auth", ifRevision: rev });
    expect(r).toMatchObject({ killedPane: true, deletedRow: true });
  });

  it("an absent agent is a no-op whatever --if says", async () => {
    const r = await closeAgent(db, "ghost", { workstream: "auth", ifRevision: 12345 });
    expect(r).toEqual({ killedPane: false, deletedRow: false, worktree: null });
    expect(await previewClose(db, "ghost", { workstream: "auth" })).toMatchObject({
      kind: "none",
      revision: 0,
    });
  });

  it("the orphan path is fenced too: a stale revision leaves the leftover worktree registered", async () => {
    registerWorktree(db, {
      path: join(dir, "wt"),
      agent: "orph",
      workstream: "auth",
      root: "/repo",
      base: "aaa",
      createdAt: "t",
    });
    const p = await previewClose(db, "orph", { workstream: "auth" });
    expect(p.kind).toBe("orphan-worktree");
    await expect(
      closeAgent(db, "orph", { workstream: "auth", ifRevision: p.revision + 1 }),
    ).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 1 });
  });
});

describe("agent close: replaced while it works", () => {
  /** Replace worker-1 (%1) during the kill: respawn as `pane`, claim a task, bind a socket. */
  const replaceDuringKill = (pane: string, livePanes: string[]) => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
    task("t1");
    use(
      tmux(
        () => livePanes,
        async () => {
          deleteAgent(db, "worker-1", "auth");
          insertAgent(db, { name: "worker-1", workstream: "auth", paneId: pane });
          await claimTask(db, "t1", { agentName: "worker-1", workstream: "auth" });
          touchSock("worker-1");
        },
      ),
    );
  };

  it("the replacement keeps its row, task, socket (refuter repro: %1 -> %2 during killPane)", async () => {
    replaceDuringKill("%2", ["%2"]);
    await expect(closeAgent(db, "worker-1", { workstream: "auth" })).rejects.toBeInstanceOf(
      AgentReplacedError,
    );
    expect(getAgent(db, "worker-1", "auth")?.paneId).toBe("%2");
    expect(getTask(db, "t1", "auth")?.status).toBe("IN_PROGRESS");
    expect(existsSync(sock("worker-1"))).toBe(true);
    expect(kills()).toEqual(["%1"]);
  });

  it("the same pane id reused is still a different incarnation", async () => {
    replaceDuringKill("%1", []); // the replacement reuses %1; the probe says it is gone
    await expect(closeAgent(db, "worker-1", { workstream: "auth" })).rejects.toBeInstanceOf(
      AgentReplacedError,
    );
    expect(getAgent(db, "worker-1", "auth")?.paneId).toBe("%1");
    expect(getTask(db, "t1", "auth")?.status).toBe("IN_PROGRESS");
    expect(existsSync(sock("worker-1"))).toBe(true);
  });

  it("a replaced agent's worktree registry row is not released for the replacement", async () => {
    // The re-check before the release is what protects the replacement's worktree.
    const path = join(dir, "wt-w1");
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cwd: path });
    registerWorktree(db, {
      path,
      agent: "worker-1",
      workstream: "auth",
      root: join(dir, "no-such-repo"),
      base: "aaa",
      createdAt: "t",
    });
    use(
      tmux(
        () => [],
        () => {
          deleteAgent(db, "worker-1", "auth");
          insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cwd: path });
        },
      ),
    );
    await expect(closeAgent(db, "worker-1", { workstream: "auth" })).rejects.toBeInstanceOf(
      AgentReplacedError,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 1 });
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("a replacement landing DURING the worktree release is protected by the final delete's CAS", async () => {
    // Nothing between the re-check and the delete is synchronous: the release awaits git.
    // A trigger on the registry forget stands in for the other process landing there.
    const path = join(dir, "wt-w1");
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cwd: path });
    registerWorktree(db, {
      path,
      agent: "worker-1",
      workstream: "auth",
      root: join(dir, "no-such-repo"),
      base: "aaa",
      createdAt: "t",
    });
    use(tmux(() => []));
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name = 'auth'").get() as { id: number }
    ).id;
    db.exec(`CREATE TEMP TRIGGER swap AFTER DELETE ON worktrees BEGIN
      DELETE FROM agents WHERE name = 'worker-1';
      INSERT INTO agents (name, workstream_id, pane_id, status, created_at, updated_at)
        VALUES ('worker-1', ${wsId}, '%1', 'spawning', 't', 't');
    END`);
    await expect(closeAgent(db, "worker-1", { workstream: "auth" })).rejects.toBeInstanceOf(
      AgentReplacedError,
    );
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("a replacement landing after the worktree release never loses its row", async () => {
    // The CAS on the final delete, not just the re-check before it.
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
    use(tmux(() => []));
    const a = getAgent(db, "worker-1", "auth");
    deleteAgent(db, "worker-1", "auth");
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
    expect(deleteAgent(db, "worker-1", "auth", { incarnation: a?.incarnation ?? -1 })).toBe(false);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });
});

describe("the other agent-row writers carry the identity", () => {
  it("deleteAgent: incarnation and pane are both compared; a bare pane id still works", () => {
    const a = insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    expect(deleteAgent(db, "w1", "auth", { incarnation: a.incarnation + 99 })).toBe(false);
    expect(deleteAgent(db, "w1", "auth", { incarnation: a.incarnation, paneId: "%9" })).toBe(false);
    expect(deleteAgent(db, "w1", "auth", "%9")).toBe(false);
    expect(deleteAgent(db, "w1", "auth", { incarnation: a.incarnation, paneId: "%1" })).toBe(true);
  });

  it("reconcile prune: a same-name replacement under the same pane id is kept", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    use(async (args) => {
      if (args[0] === "list-panes") {
        // During discovery: close and re-register as another incarnation; its pane is
        // absent from this listing, so the stale snapshot looks like a ghost.
        deleteAgent(db, "w1", "auth");
        insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
        touchSock("w1");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    });
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.prunedGhosts).toBe(0);
    expect(getAgent(db, "w1", "auth")).toBeDefined();
    expect(existsSync(sock("w1"))).toBe(true);
  });

  it("teardown: a replacement registered during the session kill keeps its row and socket", async () => {
    task("t1");
    insertAgent(db, { name: "mw", workstream: "auth", paneId: "%1" });
    touchSock("mw");
    use(async (args) => {
      if (args[0] === "list-panes") return { stdout: "@1\t%1\t_mu\n", stderr: "", exitCode: 0 };
      if (args[0] === "kill-session") {
        deleteAgent(db, "mw", "auth");
        insertAgent(db, { name: "mw", workstream: "auth", paneId: "%2" });
        touchSock("mw");
        return OK;
      }
      if (args[0] === "display-message") return GONE_PANE;
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    });
    await expect(
      teardownWorkstream(db, {
        workstream: "auth",
        ifRevision: workstreamRevision(db, "auth"),
        muxSession: "mu-auth",
      }),
    ).rejects.toThrow(/changed since/);
    expect(getAgent(db, "mw", "auth")?.paneId).toBe("%2");
    expect(existsSync(sock("mw"))).toBe(true);
  });
});

describe("teardown: the same pane id re-registered during the kill", () => {
  it("revision equality (name@pane) cannot see it; the row CAS keeps the replacement and its socket", async () => {
    task("t1");
    insertAgent(db, { name: "mw", workstream: "auth", paneId: "%1" });
    use(async (args) => {
      if (args[0] === "list-panes") return { stdout: "@1\t%1\t_mu\n", stderr: "", exitCode: 0 };
      if (args[0] === "kill-session") {
        deleteAgent(db, "mw", "auth");
        insertAgent(db, { name: "mw", workstream: "auth", paneId: "%1" });
        touchSock("mw");
        return OK;
      }
      if (args[0] === "display-message") return GONE_PANE;
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    });
    await teardownWorkstream(db, {
      workstream: "auth",
      ifRevision: workstreamRevision(db, "auth"),
      muxSession: "mu-auth",
    });
    // a torn-down workstream hides its rows from getAgent: read the table
    expect(db.prepare("SELECT pane_id FROM agents WHERE name = 'mw'").all()).toEqual([
      { pane_id: "%1" },
    ]);
    expect(existsSync(sock("mw"))).toBe(true);
  });
});

describe("the agent lock fails closed", () => {
  it("close refuses (nothing killed) while another holder has the lock", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    use(tmux(() => ["%1"]));
    process.env.MU_AGENT_LOCK_TIMEOUT_MS = "60";
    await withAgentLock(db, "auth", "w1", async () => {
      await expect(closeAgent(db, "w1", { workstream: "auth" })).rejects.toBeInstanceOf(
        AgentLockBusyError,
      );
    });
    expect(kills()).toEqual([]);
    expect(getAgent(db, "w1", "auth")).toBeDefined();
  });

  it("a --worktree spawn's staging takes the same lock: busy refuses before any row exists", async () => {
    process.env.MU_AGENT_LOCK_TIMEOUT_MS = "60";
    await withAgentLock(db, "auth", "w2", async () => {
      await expect(
        spawnAgent(db, { name: "w2", workstream: "auth", worktree: true }),
      ).rejects.toBeInstanceOf(AgentLockBusyError);
    });
    expect(getAgent(db, "w2", "auth")).toBeUndefined();
  });

  it("an aged agent lock is NOT stolen from a live holder (strict): a long close keeps it", async () => {
    process.env.MU_AGENT_LOCK_TIMEOUT_MS = "80";
    await withAgentLock(db, "auth", "w1", async () => {
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(agentLockPath(db, "auth", "w1"), old, old);
      await expect(withAgentLock(db, "auth", "w1", async () => {})).rejects.toBeInstanceOf(
        AgentLockBusyError,
      );
    });
  });

  it("locks of different names do not contend", async () => {
    await withAgentLock(db, "auth", "a", async () => {
      await withAgentLock(db, "auth", "b", async () => {}, { acquireTimeoutMs: 60 });
    });
  });

  it("the lock lives beside the db it protects", () => {
    expect(agentLockPath(db, "auth", "w1")).toBe(join(dir, "locks", "agent-auth.w1.lock"));
  });
});

describe("withFileLock: strict ownership", () => {
  const lock = (): string => join(dir, "locks", "x.lock");
  const age = (path: string): void => {
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path, old, old);
  };
  const unavailable = (): never => {
    throw new Error("unavailable");
  };

  it("never steals an aged lock from a LIVE holder (a long close is not abandoned)", async () => {
    let inner = false;
    await withFileLock(
      lock(),
      "holder",
      async () => {
        age(lock());
        await expect(
          withFileLock(
            lock(),
            "thief",
            async () => {
              inner = true;
            },
            { strict: true, staleLockMs: 0, acquireTimeoutMs: 80, onUnavailable: unavailable },
          ),
        ).rejects.toThrow("unavailable");
      },
      { strict: true },
    );
    expect(inner).toBe(false);
  });

  it("steals an aged lock whose holder is gone", async () => {
    mkdirSync(lock(), { recursive: true });
    writeFileSync(
      join(lock(), "meta.json"),
      JSON.stringify({ pid: 2 ** 22 + 12345, label: "dead", acquiredAt: "t", token: "dead" }),
    );
    age(lock());
    let ran = false;
    await withFileLock(
      lock(),
      "taker",
      async () => {
        ran = true;
      },
      { strict: true, staleLockMs: 0, acquireTimeoutMs: 500, onUnavailable: unavailable },
    );
    expect(ran).toBe(true);
  });

  it("release is by token: a holder whose lock was stolen never removes the new holder's", async () => {
    let metaWhileThiefHolds: string | undefined;
    await withFileLock(lock(), "first", async () => {
      age(lock());
      // Legacy (non-strict) mode steals any aged lock: the overlap the old release allowed.
      await withFileLock(
        lock(),
        "second",
        async () => {
          metaWhileThiefHolds = (await readFileLockMeta(lock()))?.label;
          // `first` finishes while `second` still holds: it must leave the lock alone.
        },
        { staleLockMs: 0, acquireTimeoutMs: 500 },
      );
    });
    expect(metaWhileThiefHolds).toBe("second");
  });

  it("first release does not remove a lock the second still holds", async () => {
    const seen: (string | undefined)[] = [];
    let releaseSecond: () => void = () => {};
    const secondHeld = new Promise<void>((r) => {
      releaseSecond = r;
    });
    let secondStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      secondStarted = r;
    });
    const first = withFileLock(lock(), "first", async () => {
      age(lock());
      void withFileLock(
        lock(),
        "second",
        async () => {
          secondStarted();
          await secondHeld;
        },
        { staleLockMs: 0, acquireTimeoutMs: 500 },
      );
      await started;
    });
    await first; // first releases while second holds
    seen.push((await readFileLockMeta(lock()))?.label);
    releaseSecond();
    expect(seen).toEqual(["second"]);
  });
});

describe("CLI: bare close previews, --if applies", () => {
  beforeEach(() => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
    use(tmux(() => ["%1"]));
  });

  it("bare close is ONE ok envelope with the revision, the --if apply as next, and no kill", async () => {
    const r = await runCliJson(["agent", "close", "w1", "-w", "auth", "--json"], dbPath);
    expect(r.doc.ok).toBe(true);
    expect(r.data).toMatchObject({
      kind: "agent",
      dryRun: true,
      pane_id: "%1",
      revision: agentRevision(db, "auth", "w1"),
      id: getAgent(db, "w1", "auth")?.incarnation,
    });
    expect(r.doc.next).toEqual({
      mode: "alt",
      commands: [`mu agent close w1 -w auth --if ${agentRevision(db, "auth", "w1")}`],
    });
    expect(kills()).toEqual([]);
  });

  it("a stale --if is one failure envelope, exit 4, expected_rev/current_rev, nothing killed", async () => {
    const rev = agentRevision(db, "auth", "w1");
    const r = await runCliJson(
      ["agent", "close", "w1", "-w", "auth", "--if", String(rev + 1), "--json"],
      dbPath,
    );
    expect(r.doc).toMatchObject({ ok: false, exit: 4, expected_rev: rev + 1, current_rev: rev });
    expect(r.exitCode).toBe(4);
    expect(kills()).toEqual([]);
    expect(getAgent(db, "w1", "auth")).toBeDefined();
  });

  it("the previewed revision applies", async () => {
    const rev = agentRevision(db, "auth", "w1");
    use(tmux(() => []));
    const r = await runCliJson(
      ["agent", "close", "w1", "-w", "auth", "--if", String(rev), "--json"],
      dbPath,
    );
    expect(r.doc.ok).toBe(true);
    expect(r.data).toMatchObject({ killedPane: true, deletedRow: true });
    expect(getAgent(db, "w1", "auth")).toBeUndefined();
  });

  it("an unknown name previews as kind none with no apply hint", async () => {
    const r = await runCliJson(["agent", "close", "ghost", "-w", "auth", "--json"], dbPath);
    expect(r.data).toMatchObject({ kind: "none", revision: 0 });
    expect(r.doc.next).toBeNull();
  });
});

describe("round 2: identity from one read, rollback and socket fenced", () => {
  it.each(["%2", "%1"])(
    "previewClose never mixes the original identity with a replacement's revision (replacement on %s)",
    async (replacementPane) => {
      // A registered worktree makes the preview await git; the name is replaced meanwhile.
      const path = mkdtempSync(join(tmpdir(), "mu-wt-prev-"));
      try {
        const a = insertAgent(db, {
          name: "worker-1",
          workstream: "auth",
          paneId: "%1",
          cwd: path,
        });
        registerWorktree(db, {
          path,
          agent: "worker-1",
          workstream: "auth",
          root: path,
          base: "aaa",
          createdAt: "t",
        });
        const pending = previewClose(db, "worker-1", { workstream: "auth" });
        // previewClose is parked in its worktree check: replace the agent now.
        deleteAgent(db, "worker-1", "auth");
        const b = insertAgent(db, {
          name: "worker-1",
          workstream: "auth",
          paneId: replacementPane,
          cwd: path,
        });
        const p = await pending;
        expect(p.incarnation).toBe(b.incarnation);
        expect(p.incarnation).not.toBe(a.incarnation);
        expect(p.paneId).toBe(replacementPane);
        expect(p.revision).toBe(agentRevision(db, "auth", "worker-1"));
      } finally {
        rmFixtureDir(path);
      }
    },
  );

  it("a rollback does not kill a pane id now held by another incarnation", async () => {
    // spawn's liveness probe fails; while it does, the row is replaced by a fresh
    // incarnation on the same pane id (a restarted mux reusing %1).
    const prev = process.env.MU_SPAWN_LIVENESS_MS;
    process.env.MU_SPAWN_LIVENESS_MS = "10";
    setSleepForTests(async () => {});
    const state = freshMockState();
    const fake = mockTmux(state);
    let swapped = false;
    use(async (args) => {
      if (args[0] === "display-message" && args[2] === "%1" && !swapped) {
        swapped = true;
        const cur = getAgent(db, "alice", "auth");
        deleteAgent(db, "alice", "auth", { incarnation: cur?.incarnation ?? -1 });
        insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1" });
        state.panes.delete("%1"); // the probe: gone
      }
      return fake.executor(args);
    });
    try {
      await expect(
        spawnAgent(db, { name: "alice", workstream: "auth", cli: "sh", command: "sh", ctl: false }),
      ).rejects.toThrow();
    } finally {
      resetSleep();
      if (prev === undefined) delete process.env.MU_SPAWN_LIVENESS_MS;
      else process.env.MU_SPAWN_LIVENESS_MS = prev;
    }
    expect(swapped).toBe(true);
    expect(getAgent(db, "alice", "auth")?.paneId).toBe("%1");
    expect(fake.calls.filter((c) => c[0] === "kill-pane")).toEqual([]);
  });
});

describe("round 3: one read transaction, rollback leaves foreign panes", () => {
  /** Run `inject` once, right before the first `get`/`all` of a statement whose SQL has `marker`. */
  function interleaveBefore(marker: string, inject: () => void): void {
    const orig = db.prepare.bind(db);
    let done = false;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const st = orig(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (done || !sql.includes(marker)) return st;
      return new Proxy(st, {
        get(t, p) {
          const v = t[p as string];
          if (typeof v !== "function") return v;
          if (p !== "get" && p !== "all") return v.bind(t);
          return (...a: unknown[]) => {
            if (!done) {
              done = true;
              inject();
            }
            return v.apply(t, a);
          };
        },
      });
    };
  }

  it("another process replacing the name between the preview's statements is not seen half and half", async () => {
    const other = openDb({ path: dbPath });
    try {
      const a = insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1" });
      let b: { incarnation: number } | undefined;
      // agentRevision's agent SELECT: the revision is read after the identity.
      interleaveBefore("a.gate_token, a.created_at", () => {
        deleteAgent(other, "w1", "auth");
        b = insertAgent(other, { name: "w1", workstream: "auth", paneId: "%2" });
      });
      const p = await previewClose(db, "w1", { workstream: "auth" });
      expect(b).toBeDefined();
      // Either wholly A (stale: `--if` then refuses) or wholly B; never A's identity with B's revision.
      const current = agentRevision(db, "auth", "w1");
      if (p.incarnation === a.incarnation) {
        expect(p.paneId).toBe("%1");
        expect(p.revision).not.toBe(current);
        await expect(
          closeAgent(db, "w1", { workstream: "auth", ifRevision: p.revision }),
        ).rejects.toBeInstanceOf(RevisionMismatchError);
        expect(getAgent(db, "w1", "auth")?.paneId).toBe("%2");
        expect(kills()).toEqual([]);
      } else {
        expect(p.incarnation).toBe(b?.incarnation);
        expect(p.paneId).toBe("%2");
        expect(p.revision).toBe(current);
      }
    } finally {
      other.close();
    }
  });

  it("the preview's worktree state is of the row it describes: a replacement during the git check retries", async () => {
    // A's worktree is a non-git dir (state: dirty); B's is missing. A preview that
    // skipped the staleness compare would report B's path with A's `dirty`.
    const pathA = mkdtempSync(join(tmpdir(), "mu-wt-a-"));
    const pathB = join(pathA, "gone");
    try {
      insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", cwd: pathA });
      registerWorktree(db, {
        path: pathA,
        agent: "w1",
        workstream: "auth",
        root: pathA,
        base: "aaa",
        createdAt: "t",
      });
      const pending = previewClose(db, "w1", { workstream: "auth" });
      deleteAgent(db, "w1", "auth");
      db.prepare("DELETE FROM worktrees WHERE path = ?").run(pathA);
      insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", cwd: pathB });
      registerWorktree(db, {
        path: pathB,
        agent: "w1",
        workstream: "auth",
        root: pathA,
        base: "aaa",
        createdAt: "t",
      });
      const p = await pending;
      expect(p.worktree).toEqual({ path: pathB, state: "missing" });
      expect(p.refusesDirty).toBe(false);
    } finally {
      rmFixtureDir(pathA);
    }
  });

  it.each(["same workstream", "other workstream"])(
    "a rollback does not kill a pane id another agent now holds (%s)",
    async (where) => {
      const prev = process.env.MU_SPAWN_LIVENESS_MS;
      process.env.MU_SPAWN_LIVENESS_MS = "10";
      setSleepForTests(async () => {});
      const state = freshMockState();
      const fake = mockTmux(state);
      let swapped = false;
      use(async (args) => {
        if (args[0] === "display-message" && args[2] === "%1" && !swapped) {
          swapped = true;
          // alice's pane died; a restarted mux handed %1 to bob, registered meanwhile.
          insertAgent(db, {
            name: "bob",
            workstream: where === "same workstream" ? "auth" : "billing",
            paneId: "%1",
          });
          state.panes.delete("%1");
        }
        return fake.executor(args);
      });
      try {
        await expect(
          spawnAgent(db, {
            name: "alice",
            workstream: "auth",
            cli: "sh",
            command: "sh",
            ctl: false,
          }),
        ).rejects.toThrow();
      } finally {
        resetSleep();
        if (prev === undefined) delete process.env.MU_SPAWN_LIVENESS_MS;
        else process.env.MU_SPAWN_LIVENESS_MS = prev;
      }
      expect(swapped).toBe(true);
      expect(getAgent(db, "alice", "auth")).toBeUndefined();
      expect(getAgent(db, "bob", where === "same workstream" ? "auth" : "billing")?.paneId).toBe(
        "%1",
      );
      expect(fake.calls.filter((c) => c[0] === "kill-pane")).toEqual([]);
    },
  );
});

describe("withFileLock strict: reclaim and metadata fail closed", () => {
  const lock = (): string => join(dir, "locks", "y.lock");
  const unavailable = (): never => {
    throw new Error("unavailable");
  };
  const age = (path: string): void => {
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path, old, old);
  };
  const deadHolder = (): void => {
    mkdirSync(lock(), { recursive: true });
    writeFileSync(
      join(lock(), "meta.json"),
      JSON.stringify({ pid: 2 ** 22 + 12345, label: "dead", acquiredAt: "t", token: "dead" }),
    );
    age(lock());
  };

  it("many takers racing to reclaim one dead holder's lock never overlap (two removers)", async () => {
    for (let trial = 0; trial < 15; trial++) {
      rmSync(lock(), { recursive: true, force: true });
      deadHolder();
      let inside = 0;
      let peak = 0;
      const taker = (i: number) =>
        withFileLock(
          lock(),
          `t${i}`,
          async () => {
            inside++;
            peak = Math.max(peak, inside);
            await new Promise((r) => setTimeout(r, 15));
            inside--;
          },
          { strict: true, staleLockMs: 0, acquireTimeoutMs: 5000, onUnavailable: unavailable },
        );
      await Promise.all([0, 1, 2, 3, 4, 5].map(taker));
      expect(peak).toBe(1);
    }
  });

  it("a live lock whose record is unreadable is never stolen, however old", async () => {
    mkdirSync(lock(), { recursive: true });
    writeFileSync(join(lock(), "meta.json"), "{not json");
    age(lock());
    let ran = false;
    await expect(
      withFileLock(
        lock(),
        "thief",
        async () => {
          ran = true;
        },
        { strict: true, staleLockMs: 0, acquireTimeoutMs: 80, onUnavailable: unavailable },
      ),
    ).rejects.toThrow("unavailable");
    expect(ran).toBe(false);
    expect(existsSync(lock())).toBe(true);
  });

  it("a lock dir with foreign contents and no record is not stolen either", async () => {
    mkdirSync(lock(), { recursive: true });
    writeFileSync(join(lock(), "other"), "");
    age(lock());
    await expect(
      withFileLock(lock(), "thief", async () => {}, {
        strict: true,
        staleLockMs: 0,
        acquireTimeoutMs: 80,
        onUnavailable: unavailable,
      }),
    ).rejects.toThrow("unavailable");
  });

  it("an acquire that cannot publish its record runs nothing (read-only locks dir)", async () => {
    mkdirSync(join(dir, "locks"), { recursive: true });
    chmodSync(join(dir, "locks"), 0o555);
    let ran = false;
    try {
      await expect(
        withFileLock(
          lock(),
          "x",
          async () => {
            ran = true;
          },
          { strict: true, acquireTimeoutMs: 80, onUnavailable: unavailable },
        ),
      ).rejects.toThrow("unavailable");
    } finally {
      chmodSync(join(dir, "locks"), 0o755);
    }
    expect(ran).toBe(false);
  });

  it("a held lock never appears without its record, and leaves no staging litter", async () => {
    await withFileLock(
      lock(),
      "x",
      async () => {
        expect((await readFileLockMeta(lock()))?.label).toBe("x");
      },
      { strict: true, onUnavailable: unavailable },
    );
    expect(readdirSync(join(dir, "locks"))).toEqual([]);
  });

  it("a stale claim file left by a crashed remover fails closed (blocks, never steals)", async () => {
    deadHolder();
    writeFileSync(`${lock()}.reclaim`, "999");
    await expect(
      withFileLock(lock(), "t", async () => {}, {
        strict: true,
        staleLockMs: 0,
        acquireTimeoutMs: 80,
        onUnavailable: unavailable,
      }),
    ).rejects.toThrow("unavailable");
  });
});
