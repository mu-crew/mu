// k_soft_teardown round 2 (rv4_st_*): one block per finding, each from the
// refuter's repro. Fast tier: real SQLite in a temp dir, mocked mux.
//
//   moved_panes          a registered pane outside mu-<ws> that lives blocks teardown
//   reinit_liveness      init --if over a torn-down name probes the mux first
//   sweep_toctou         --empty --if never blesses a change made after the preview
//   worktree_retention   teardown removes no worktree and leaves its row
//   error_lines          the refusals are ONE stderr line

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPaneStillAliveError, closeAgent, insertAgent } from "../src/agents.js";
import { cmdTeardown } from "../src/cli/workstream.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { checkOrphanedAgents } from "../src/fleet-hazards.js";
import { MuxError } from "../src/mux.js";
import { addTask } from "../src/tasks/edit.js";
import {
  ensureWorkstream,
  reinitWorkstream,
  sweepRevision,
  WorkstreamHasAgentsError,
  WorkstreamPanesLiveError,
  WorkstreamRevisionMismatchError,
  WorkstreamSessionLiveError,
  workstreamRevision,
} from "../src/workstream.js";
import { listWorktrees, registerWorktree } from "../src/worktree.js";
import { envelopeData } from "./_envelope.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxExecutor, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";
import { softTeardown } from "./_teardown.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness | undefined;

const OK = { stdout: "", stderr: "", exitCode: 0 };
const GONE_SESSION = { stdout: "", stderr: "can't find session", exitCode: 1 };
const GONE_PANE = { stdout: "", stderr: "can't find pane", exitCode: 1 };
const DENIED = { stdout: "", stderr: "permission denied", exitCode: 1 };
const LIVE_SESSION = { stdout: "@1\t%1\t_mu\n", stderr: "", exitCode: 0 };

/** tmux where `list-panes` answers `session` and each pane id answers `alive`. */
function tmux(opts: {
  session?: typeof OK;
  alive?: readonly string[];
  paneProbe?: typeof OK;
  onKill?: (target: string) => void;
}): MuxExecutor {
  return async (args) => {
    if (args[0] === "list-panes") return opts.session ?? GONE_SESSION;
    if (args[0] === "display-message") {
      if (opts.paneProbe) return opts.paneProbe;
      const id = args[2] ?? "";
      return opts.alive?.includes(id) ? { ...OK, stdout: `${id}\n` } : GONE_PANE;
    }
    if (args[0] === "kill-session") {
      opts.onKill?.(args[args.indexOf("-t") + 1] ?? "");
      return OK;
    }
    return { stdout: "", stderr: `unmocked: ${args.join(" ")}`, exitCode: 1 };
  };
}
const use = (exec: MuxExecutor): void => {
  mux?.restore();
  mux = installMux("tmux", exec);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-td-r2-"));
  process.env.MU_STATE_DIR = dir;
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  use(tmux({}));
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

const seed = (ws: string): void => {
  ensureWorkstream(db, ws);
  addTask(db, { workstream: ws, localId: "a", title: "A", impact: 50, effortDays: 1 });
};
const tornDownAt = (ws: string): string | null =>
  (
    db.prepare("SELECT torn_down_at AS t FROM workstreams WHERE name = ?").get(ws) as {
      t: string | null;
    }
  ).t;
const agentNames = (): string[] =>
  (db.prepare("SELECT name FROM agents ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );
const taskCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
const tearDownLocally = (ws: string): void => {
  db.prepare("UPDATE workstreams SET torn_down_at = '2026-01-01T00:00:00.000Z' WHERE name = ?").run(
    ws,
  );
};
/** The CLI on the same DB file (the CLI opens its own connection). */
const run = async (...argv: string[]) => {
  db.close();
  const r = await runCli(argv, dbPath);
  db = openDb({ path: dbPath });
  return r;
};
/** Stdout of `fn`, from console.log (what emitJson writes). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const real = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += `${a.join(" ")}\n`;
  };
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return out;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR escapes is the point
const SGR = /\u001b\[[\d;]*m/g;
const stderrLines = (s: string): string[] =>
  s
    .replace(SGR, "")
    .split("\n")
    .filter((l) => l.trim() !== "");

describe("moved_panes: liveness is the registered pane id, not session membership", () => {
  beforeEach(() => {
    seed("ws");
    insertAgent(db, { name: "moved", workstream: "ws", paneId: "%3" });
  });

  it("a registered pane that lives outside the session blocks the teardown; nothing is killed or written", async () => {
    const kills: string[] = [];
    use(tmux({ session: LIVE_SESSION, alive: ["%3"], onKill: (t) => kills.push(t) }));
    const err = await softTeardown(db, "ws").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkstreamPanesLiveError);
    expect(kills).toEqual([]);
    expect(agentNames()).toEqual(["moved"]);
    expect(tornDownAt("ws")).toBeNull();
  });

  it("a failed per-pane probe aborts the same way (could not ask is not dead)", async () => {
    use(tmux({ session: LIVE_SESSION, paneProbe: DENIED }));
    await expect(softTeardown(db, "ws")).rejects.toBeInstanceOf(MuxError);
    expect(agentNames()).toEqual(["moved"]);
    expect(tornDownAt("ws")).toBeNull();
  });

  it("a registered pane that is really gone does not block", async () => {
    use(tmux({ session: LIVE_SESSION, alive: [] }));
    const r = await softTeardown(db, "ws");
    expect(r.deletedAgents).toBe(1);
    expect(tornDownAt("ws")).not.toBeNull();
  });

  it("a pane inside the session is probed AFTER the kill; dead means its row goes", async () => {
    use(tmux({ session: { ...OK, stdout: "@1\t%3\tpi\n" }, alive: [] }));
    const r = await softTeardown(db, "ws");
    expect(r.killedMux).toBe(true);
    expect(r.orphanedAgents).toEqual([]);
    expect(agentNames()).toEqual([]);
  });

  it("the CLI says so in one line and exits 4", async () => {
    use(tmux({ session: LIVE_SESSION, alive: ["%3"] }));
    const rev = workstreamRevision(db, "ws");
    const r = await run("workstream", "teardown", "ws", "--if", String(rev));
    expect(r.exitCode).toBe(4);
    expect(stderrLines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain("mu agent close moved -w ws");
  });
});

describe("reinit_liveness: init --if over a torn-down name asks the mux first", () => {
  beforeEach(() => {
    seed("ws");
    tearDownLocally("ws");
  });

  it("a live old session (no agent rows at all) refuses; the old rows survive", async () => {
    use(tmux({ session: LIVE_SESSION }));
    const rev = workstreamRevision(db, "ws");
    await expect(reinitWorkstream(db, "ws", rev)).rejects.toBeInstanceOf(
      WorkstreamSessionLiveError,
    );
    expect(taskCount()).toBe(1);
    expect(tornDownAt("ws")).not.toBeNull();
  });

  it("a failed probe aborts BEFORE any delete", async () => {
    use(async () => DENIED);
    const rev = workstreamRevision(db, "ws");
    await expect(reinitWorkstream(db, "ws", rev)).rejects.toBeInstanceOf(MuxError);
    expect(taskCount()).toBe(1);
    expect(tornDownAt("ws")).not.toBeNull();
  });

  it("through the CLI: live session exits 4 in one line; a failed probe leaves the tasks (exit != 0)", async () => {
    const rev = workstreamRevision(db, "ws");
    use(tmux({ session: LIVE_SESSION }));
    const live = await run("workstream", "init", "ws", "--if", String(rev));
    expect(live.exitCode).toBe(4);
    expect(stderrLines(live.stderr)).toHaveLength(1);
    expect(taskCount()).toBe(1);

    use(async () => DENIED);
    const denied = await run("workstream", "init", "ws", "--if", String(rev));
    expect(denied.exitCode).not.toBeNull();
    expect(denied.exitCode).not.toBe(0);
    expect(taskCount()).toBe(1);
    expect(tornDownAt("ws")).not.toBeNull();
  });

  it("no session: it proceeds (deletes the old rows, creates the new one)", async () => {
    const rev = workstreamRevision(db, "ws");
    await reinitWorkstream(db, "ws", rev);
    expect(taskCount()).toBe(0);
    expect(tornDownAt("ws")).toBeNull();
  });
});

describe("sweep_toctou: the sweep applies the previewed members, not whatever they became", () => {
  const changeE2 = (): void => {
    addTask(db, { workstream: "e2", localId: "new", title: "N", impact: 50, effortDays: 1 });
    insertAgent(db, { workstream: "e2", name: "late", paneId: "%9" });
  };

  it("a member that gained a task and an agent while an earlier member was killed is refused", async () => {
    ensureWorkstream(db, "e1");
    ensureWorkstream(db, "e2");
    const revision = sweepRevision(
      new Map([
        ["e1", workstreamRevision(db, "e1")],
        ["e2", workstreamRevision(db, "e2")],
      ]),
    );
    use(
      tmux({
        session: LIVE_SESSION,
        // both are "alive"; the change lands while e1's session is being killed
        onKill: (target) => {
          if (target.includes("mu-e1")) changeE2();
        },
      }),
    );
    // cmdTeardown runs on THIS connection, so the racing writes are visible to it.
    const out = await captureStdout(() =>
      cmdTeardown(db, { empty: true, if: revision, json: true }),
    );
    const j = envelopeData<{ tornDown: number; failed: { workstreamName: string }[] }>(out);
    expect(j.tornDown).toBe(1);
    expect(j.failed.map((f) => f.workstreamName)).toEqual(["e2"]);
    expect(tornDownAt("e1")).not.toBeNull();
    expect(tornDownAt("e2")).toBeNull();
    expect(agentNames()).toEqual(["late"]);
  });

  it("a change made BEFORE the member's turn but after the preview (while e1 is idle) is refused too", async () => {
    ensureWorkstream(db, "e1");
    ensureWorkstream(db, "e2");
    const revision = sweepRevision(
      new Map([
        ["e1", workstreamRevision(db, "e1")],
        ["e2", workstreamRevision(db, "e2")],
      ]),
    );
    changeE2();
    // e2 is no longer empty, so the sweep set itself changed: refused whole.
    await expect(cmdTeardown(db, { empty: true, if: revision, json: true })).rejects.toBeInstanceOf(
      WorkstreamRevisionMismatchError,
    );
    expect(tornDownAt("e1")).toBeNull();
  });
});

describe("worktree_retention: teardown never removes a worktree", () => {
  it("leaves the directory and the registry row; the result lists it as kept", async () => {
    seed("ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    const path = join(dir, "worktrees", "ws", "w1");
    mkdirSync(path, { recursive: true });
    registerWorktree(db, {
      path,
      agent: "w1",
      workstream: "ws",
      root: dir,
      base: "abc",
      createdAt: "t",
    });
    const r = await softTeardown(db, "ws");
    expect(r.keptWorktrees).toEqual([{ agent: "w1", path }]);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(dir, "worktrees", "ws"))).toBe(true);
    expect(listWorktrees(db).map((w) => w.path)).toEqual([path]);
  });

  it("the CLI names `mu agent close` for each kept worktree and no removal", async () => {
    seed("ws");
    const path = join(dir, "worktrees", "ws", "w1");
    mkdirSync(path, { recursive: true });
    registerWorktree(db, {
      path,
      agent: "w1",
      workstream: "ws",
      root: dir,
      base: "abc",
      createdAt: "t",
    });
    const rev = workstreamRevision(db, "ws");
    const r = await run("workstream", "teardown", "ws", "--if", String(rev));
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("never removed");
    expect(r.stdout).toContain("mu agent close w1 -w ws");
    expect(existsSync(path)).toBe(true);
  });
});

describe("error_lines: each refusal is one stderr line (--json keeps nextSteps)", () => {
  it("stale revision", async () => {
    seed("ws");
    const stale = workstreamRevision(db, "ws");
    addTask(db, { workstream: "ws", localId: "b", title: "B", impact: 50, effortDays: 1 });
    const r = await run("workstream", "teardown", "ws", "--if", String(stale));
    expect(r.exitCode).toBe(4);
    const lines = stderrLines(r.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /changed since preview \(rev \d+ → \d+\); preview again: mu workstream teardown ws$/,
    );
  });

  it("torn-down -w verb", async () => {
    seed("ws");
    await softTeardown(db, "ws");
    const r = await run("task", "list", "-w", "ws");
    expect(r.exitCode).toBe(3);
    const lines = stderrLines(r.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mu workstream init ws");
  });

  it("init over local agent rows", async () => {
    seed("ws");
    tearDownLocally("ws");
    db.prepare(
      `INSERT INTO agents (workstream_id, name, cli, pane_id, status, role, created_at, updated_at)
       VALUES ((SELECT id FROM workstreams WHERE name = 'ws'), 'w1', 'pi', '%1', 'spawning', 'full-access', 'now', 'now')`,
    ).run();
    const rev = workstreamRevision(db, "ws");
    const r = await run("workstream", "init", "ws", "--if", String(rev));
    expect(r.exitCode).toBe(4);
    expect(stderrLines(r.stderr)).toHaveLength(1);
  });

  it("--json still carries nextSteps", async () => {
    seed("ws");
    const stale = workstreamRevision(db, "ws");
    addTask(db, { workstream: "ws", localId: "b", title: "B", impact: 50, effortDays: 1 });
    const r = await run("workstream", "teardown", "ws", "--if", String(stale), "--json");
    const env = JSON.parse(stderrLines(r.stderr)[0] as string) as {
      nextSteps: { command: string }[];
    };
    expect(env.nextSteps.map((n) => n.command)).toEqual(["mu workstream teardown ws"]);
  });
});

// ─── round 3: the row rule ─────────────────────────────────────────────
//
//   a row is deleted only when its recorded pane is known dead, asked by
//   pane id AFTER the kill and per row; otherwise it is kept (orphaned).
//   `agent close` acts on rows of torn-down workstreams, or refuses loudly.

/** tmux where `%pane` is alive only AFTER the session kill (moved during it). */
function movedDuringKill(pane: string, sessionPanes = "@1\t%1\t_mu\n"): MuxExecutor {
  let killed = false;
  return async (args) => {
    if (args[0] === "list-panes") return { ...OK, stdout: sessionPanes };
    if (args[0] === "kill-session") {
      killed = true;
      return OK;
    }
    if (args[0] === "display-message") {
      return args[2] === pane && killed ? { ...OK, stdout: `${pane}\n` } : GONE_PANE;
    }
    return { stdout: "", stderr: `unmocked: ${args.join(" ")}`, exitCode: 1 };
  };
}
const sockFile = (agent: string): string => {
  const p = ctlSocketPath("ws", agent, dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "");
  return p;
};

describe("move_during_kill: a pane that comes alive after the session kill keeps its row", () => {
  it("the moved pane's row, socket and agent survive; the workstream is still marked torn down; the dead one goes", async () => {
    seed("ws");
    insertAgent(db, { name: "racer", workstream: "ws", paneId: "%5" });
    insertAgent(db, { name: "gone", workstream: "ws", paneId: "%6" });
    const racerSock = sockFile("racer");
    const goneSock = sockFile("gone");
    use(movedDuringKill("%5"));
    const r = await softTeardown(db, "ws");
    expect(r.killedMux).toBe(true);
    expect(r.deletedAgents).toBe(1);
    expect(r.orphanedAgents).toEqual([{ name: "racer", paneId: "%5", reason: "alive" }]);
    expect(agentNames()).toEqual(["racer"]);
    expect(existsSync(racerSock)).toBe(true);
    expect(existsSync(goneSock)).toBe(false);
    expect(tornDownAt("ws")).not.toBeNull();
  });

  it("a probe that fails after the kill keeps the row too (unknown is not dead)", async () => {
    seed("ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    let killed = false;
    use(async (args) => {
      if (args[0] === "list-panes") return LIVE_SESSION;
      if (args[0] === "kill-session") {
        killed = true;
        return OK;
      }
      if (args[0] === "display-message") return killed ? DENIED : GONE_PANE;
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    });
    const r = await softTeardown(db, "ws");
    expect(r.orphanedAgents).toEqual([{ name: "w1", paneId: "%1", reason: "unknown" }]);
    expect(agentNames()).toEqual(["w1"]);
  });

  it("the CLI reports the kept row in one block and names `mu agent close`", async () => {
    seed("ws");
    insertAgent(db, { name: "racer", workstream: "ws", paneId: "%5" });
    use(movedDuringKill("%5"));
    const rev = workstreamRevision(db, "ws");
    const r = await run("workstream", "teardown", "ws", "--if", String(rev));
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("KEPT 1 agent row(s)");
    expect(r.stdout).toContain("racer (%5)");
    expect(r.stdout).toContain("mu agent close racer -w ws");
  });

  it("doctor warns about the kept row", async () => {
    seed("ws");
    insertAgent(db, { name: "racer", workstream: "ws", paneId: "%5" });
    use(movedDuringKill("%5"));
    expect(checkOrphanedAgents(db).severity).toBe("ok");
    await softTeardown(db, "ws");
    const h = checkOrphanedAgents(db);
    expect(h).toMatchObject({ name: "orphaned-agents", severity: "warn" });
    expect(h.detail).toContain("ws/racer (%5)");
    expect((h.remediation ?? []).join("\n")).toContain("mu agent close");
  });
});

describe("peer_close: `agent close` acts on rows of a torn-down workstream, or refuses loudly", () => {
  const peerTorn = (): void => {
    seed("ws");
    insertAgent(db, { name: "mw", workstream: "ws", paneId: "%2" });
    tearDownLocally("ws"); // a peer's torn_down_at reached this machine
  };
  const alive =
    (pane: string): MuxExecutor =>
    async (args) => {
      if (args[0] === "kill-pane") return OK; // the move/kill did not stop it
      if (args[0] === "display-message")
        return args[2] === pane ? { ...OK, stdout: `${pane}\n` } : GONE_PANE;
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };

  it("a live pane: refuses (AgentPaneStillAliveError), keeps the row", async () => {
    peerTorn();
    use(alive("%2"));
    await expect(closeAgent(db, "mw", { workstream: "ws" })).rejects.toBeInstanceOf(
      AgentPaneStillAliveError,
    );
    expect(agentNames()).toEqual(["mw"]);
  });

  it("an unanswerable probe in a torn-down workstream refuses too", async () => {
    peerTorn();
    use(async (args) => (args[0] === "kill-pane" ? OK : DENIED));
    await expect(closeAgent(db, "mw", { workstream: "ws" })).rejects.toBeInstanceOf(
      AgentPaneStillAliveError,
    );
    expect(agentNames()).toEqual(["mw"]);
  });

  it("a dead pane: the row is deleted (it was invisible before)", async () => {
    peerTorn();
    use(tmux({}));
    const r = await closeAgent(db, "mw", { workstream: "ws" });
    expect(r.deletedRow).toBe(true);
    expect(agentNames()).toEqual([]);
  });

  it("the worktree is NOT released while the recorded pane lives", async () => {
    peerTorn();
    // directory already gone: the close rule would release it, so only the live pane stops it
    const path = join(dir, "worktrees", "ws", "mw");
    registerWorktree(db, {
      path,
      agent: "mw",
      workstream: "ws",
      root: dir,
      base: "abc",
      createdAt: "t",
    });
    db.prepare("UPDATE agents SET cwd = ? WHERE name = 'mw'").run(path);
    use(alive("%2"));
    await expect(closeAgent(db, "mw", { workstream: "ws" })).rejects.toBeInstanceOf(
      AgentPaneStillAliveError,
    );
    expect(listWorktrees(db).map((w) => w.path)).toEqual([path]);
  });

  it("the CLI close: exit 4 in one line for a live pane; exit 0 once it is gone", async () => {
    peerTorn();
    use(alive("%2"));
    const refused = await run("agent", "close", "mw", "-w", "ws");
    expect(refused.exitCode).toBe(4);
    expect(stderrLines(refused.stderr)).toHaveLength(1);
    expect(agentNames()).toEqual(["mw"]);
    use(tmux({}));
    const ok = await run("agent", "close", "mw", "-w", "ws");
    expect(ok.exitCode).toBeNull();
    expect(agentNames()).toEqual([]);
  });

  it("init over the rows names the exact command (and the refusal is the recovery's own)", async () => {
    peerTorn();
    const rev = workstreamRevision(db, "ws");
    use(tmux({}));
    const err = await reinitWorkstream(db, "ws", rev).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkstreamHasAgentsError);
    expect((err as Error).message).toContain("mu agent close mw -w ws");
  });
});
