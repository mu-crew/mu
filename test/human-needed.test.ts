// mu human-needed: a durable, caller-scoped stop. Real SQLite, no mux.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnerFromEnv } from "../src/agents/spawn.js";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { applySettledClose } from "../src/close-block.js";
import { type Db, openDb } from "../src/db.js";
import { HumanNeededInvalidError, openHumanNeeds, recordHumanNeeded } from "../src/human-needed.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import { rebuildInto } from "../src/rebuild.js";
import { claimTask } from "../src/tasks/claim.js";
import {
  acceptTask,
  addTasks,
  closeTask,
  getTask,
  HumanTaskError,
  listNotes,
  listReady,
  openTask,
  releaseTask,
  setTaskStatus,
  unparkTask,
  updateTask,
} from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-human-needed-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  for (const ws of ["a", "b"]) ensureWorkstream(db, ws);
});
afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const need = (caller: string, reason: string, workstream = "a") =>
  recordHumanNeeded(db, { workstream, caller, reason });
const opCount = () => (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;

describe("recordHumanNeeded", () => {
  it("creates a parked human task, brief = reason authored by the caller, one metadata row", () => {
    const r = need("a/orch", "pick the licence");
    expect(r.changed).toBe(true);
    expect(getTask(db, r.id, "a")).toMatchObject({
      kind: "human",
      status: "OPEN",
      substate: "parked",
      ownerName: null,
    });
    expect(listNotes(db, r.id, "a")).toMatchObject([
      { kind: "brief", content: "pick the licence", author: "a/orch" },
    ]);
    expect(db.prepare("SELECT caller FROM human_needs").all()).toEqual([{ caller: "a/orch" }]);
    expect(listReady(db, "a")).toEqual([]);
  });

  it("is atomic: a late metadata-insert failure leaves no task, note, row or op, durably", () => {
    const counts = () =>
      ["tasks", "task_notes", "human_needs", "ops"].map(
        (t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      );
    const before = counts();
    // Fails on the LAST write, after the task and brief rows exist.
    db.exec(
      "CREATE TEMP TRIGGER boom BEFORE INSERT ON human_needs BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(() => need("a/orch", "x")).toThrow(/boom/);
    expect(counts()).toEqual(before);
    db.close();
    db = openDb({ path: dbPath });
    expect(counts()).toEqual(before);
    expect(openHumanNeeds(db, "a/orch")).toEqual([]);
    expect(need("a/orch", "x").changed).toBe(true); // the trigger died with the connection
  });

  it("dedupes the same reason (no ops), appends a brief for a different one, one task", () => {
    const first = need("a/orch", "pick the licence");
    const before = opCount();
    expect(need("a/orch", "  pick the licence ")).toEqual({ id: first.id, changed: false });
    expect(opCount()).toBe(before);
    expect(need("a/orch", "and the name")).toEqual({ id: first.id, changed: true });
    expect(listNotes(db, first.id, "a").map((n) => n.content)).toEqual([
      "pick the licence",
      "and the name",
    ]);
    expect(openHumanNeeds(db, "a/orch")).toEqual([
      { workstream: "a", id: first.id, reason: "pick the licence; and the name" },
    ]);
  });

  it("refuses a blank reason or caller and writes nothing", () => {
    const before = opCount();
    expect(() => need("a/orch", "  ")).toThrow(HumanNeededInvalidError);
    expect(() => need("", "why")).toThrow(/no caller identity/);
    expect(opCount()).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM human_needs").get()).toEqual({ n: 0 });
  });

  it("caller isolation: same-named agents in two workstreams, and another caller, never see each other's need", () => {
    const mine = need("a/orch", "mine", "a");
    need("b/orch", "theirs", "b");
    need("pi:S1", "pi", "a");
    expect(openHumanNeeds(db, "a/orch")).toEqual([
      { workstream: "a", id: mine.id, reason: "mine" },
    ]);
    expect(openHumanNeeds(db, "b/orch").map((n) => n.reason)).toEqual(["theirs"]);
    expect(openHumanNeeds(db, "pi:S1").map((n) => n.reason)).toEqual(["pi"]);
    expect(openHumanNeeds(db, "c/orch")).toEqual([]);
    // Same caller, other workstream: a separate need.
    need("a/orch", "mine too", "b");
    expect(openHumanNeeds(db, "a/orch").map((n) => n.workstream)).toEqual(["a", "b"]);
  });

  it("a note author never confers ownership", () => {
    const r = need("a/orch", "x");
    withCaptureSuppressed(db, () => db.prepare("UPDATE task_notes SET author = 'b/orch'").run());
    expect(openHumanNeeds(db, "b/orch")).toEqual([]);
    expect(openHumanNeeds(db, "a/orch")).toHaveLength(1);
    expect(r.id).toBeTruthy();
  });
});

describe("only kind=human counts", () => {
  it("a human_needs row on a work or delegate task is never a need (read or dedupe)", () => {
    for (const kind of ["work", "delegate"] as const) {
      const { ids } = addTasks(db, [{ title: `t-${kind}`, note: "n" }], { workstream: "a", kind });
      const row = db.prepare("SELECT id FROM tasks WHERE local_id = ?").get(ids[0]) as {
        id: number;
      };
      db.prepare("INSERT INTO human_needs (task_id, caller) VALUES (?, 'a/orch')").run(row.id);
      expect(getTask(db, ids[0] ?? "", "a")).toMatchObject({ kind, status: "OPEN" });
    }
    expect(openHumanNeeds(db, "a/orch")).toEqual([]);
    // Recording does not dedupe into (or append a brief to) those tasks.
    const r = need("a/orch", "n");
    expect(r.changed).toBe(true);
    expect(getTask(db, r.id, "a")?.kind).toBe("human");
    expect(openHumanNeeds(db, "a/orch")).toHaveLength(1);
  });
});

describe("resolution: only an explicit task close", () => {
  it("close resolves it (idempotent) and a restart sees no open need; a new reason opens a NEW task", () => {
    const r = need("a/orch", "decide");
    closeTask(db, r.id, { workstream: "a", evidence: "human said yes" });
    closeTask(db, r.id, { workstream: "a", evidence: "human said yes" });
    db.close();
    db = openDb({ path: dbPath });
    expect(openHumanNeeds(db, "a/orch")).toEqual([]);
    const again = need("a/orch", "decide");
    expect(again.changed).toBe(true);
    expect(again.id).not.toBe(r.id);
    expect(openHumanNeeds(db, "a/orch")).toHaveLength(1);
  });

  it("a reopened closed human task is parked again, never ready", () => {
    const r = need("a/orch", "decide");
    closeTask(db, r.id, { workstream: "a", evidence: "ok" });
    openTask(db, r.id, { workstream: "a" });
    expect(getTask(db, r.id, "a")).toMatchObject({ status: "OPEN", substate: "parked" });
    expect(listReady(db, "a")).toEqual([]);
    expect(openHumanNeeds(db, "a/orch")).toHaveLength(1);
  });

  it("every path back to OPEN lands a human task in parked, never todo/ready", async () => {
    const r = need("a/orch", "decide");
    insertAgent(db, { name: "w1", workstream: "a", paneId: "%1" });
    const agentId = (db.prepare("SELECT id FROM agents").get() as { id: number }).id;
    const close = () => closeTask(db, r.id, { workstream: "a", evidence: "ok" });
    const forceOwned = () =>
      db
        .prepare("UPDATE tasks SET owner_id = ?, status = 'IN_PROGRESS', substate = 'active'")
        .run(agentId);
    const paths: Record<string, () => unknown> = {
      openTask: () => {
        close();
        openTask(db, r.id, { workstream: "a" });
      },
      "setTaskStatus OPEN": () => {
        close();
        setTaskStatus(db, r.id, "OPEN", { workstream: "a" });
      },
      "setTaskStatus OPEN todo": () => {
        close();
        setTaskStatus(db, r.id, "OPEN", { workstream: "a", substate: "todo" });
      },
      "release --reopen (closed)": () => {
        close();
        releaseTask(db, r.id, { workstream: "a", reopen: true });
      },
      "release (owned IN_PROGRESS)": () => {
        forceOwned();
        releaseTask(db, r.id, { workstream: "a" });
      },
      "release --reopen (owned IN_PROGRESS)": () => {
        forceOwned();
        releaseTask(db, r.id, { workstream: "a", reopen: true });
      },
      "reaper (owner agent removed)": () => {
        forceOwned();
        deleteAgent(db, "w1", "a");
      },
      acceptTask: () => acceptTask(db, r.id, { workstream: "a" }),
      // `task update` has no status field: it must not move the task either.
      updateTask: () => updateTask(db, r.id, { title: "renamed", impact: 70 }, { workstream: "a" }),
    };
    for (const [name, run] of Object.entries(paths)) {
      run();
      expect(getTask(db, r.id, "a"), name).toMatchObject({ status: "OPEN", substate: "parked" });
      expect(listReady(db, "a"), name).toEqual([]);
      if (name === "reaper (owner agent removed)")
        insertAgent(db, { name: "w1", workstream: "a", paneId: "%1" });
    }
  });

  it("the same paths over the CLI (release --reopen) keep it out of `task next`", async () => {
    const r = need("a/orch", "decide");
    await runCli(["task", "close", r.id, "-w", "a", "--evidence", "ok"], dbPath);
    const rel = await runCli(["task", "release", r.id, "--reopen", "-w", "a"], dbPath);
    expect(rel.exitCode).toBeNull();
    const next = await runCli(["task", "next", "-w", "a", "--json"], dbPath);
    expect(next.stdout).not.toContain(r.id);
    expect(getTask(db, r.id, "a")).toMatchObject({ status: "OPEN", substate: "parked" });
  });

  it("an ordinary work task still reopens to todo", () => {
    const { ids } = addTasks(db, [{ title: "w", note: "n" }], { workstream: "a" });
    const id = ids[0] ?? "";
    closeTask(db, id, { workstream: "a", evidence: "ok" });
    releaseTask(db, id, { workstream: "a", reopen: true });
    expect(getTask(db, id, "a")).toMatchObject({ status: "OPEN", substate: "todo" });
  });

  it("unpark and claim (even --force, --self) are refused with one line naming `task close`", async () => {
    const r = need("a/orch", "decide");
    insertAgent(db, { name: "w1", workstream: "a", paneId: "%1" });
    expect(() => unparkTask(db, r.id, { workstream: "a" })).toThrow(HumanTaskError);
    expect(() => unparkTask(db, r.id, { workstream: "a" })).toThrow(
      new RegExp(`mu task close ${r.id} -w a`),
    );
    await expect(
      claimTask(db, r.id, { workstream: "a", agentName: "w1", force: true }),
    ).rejects.toThrow(HumanTaskError);
    await expect(
      claimTask(db, r.id, { workstream: "a", self: true, actor: "me", force: true }),
    ).rejects.toThrow(HumanTaskError);
    expect(getTask(db, r.id, "a")).toMatchObject({ status: "OPEN", substate: "parked" });
    expect(listReady(db, "a")).toEqual([]);
  });

  it("a CLOSE block cannot close it, even from a forged owner", async () => {
    const r = need("a/orch", "decide");
    insertAgent(db, { name: "w1", workstream: "a", paneId: "%1" });
    const agentId = (db.prepare("SELECT id FROM agents").get() as { id: number }).id;
    db.prepare("UPDATE tasks SET owner_id = ?, status = 'IN_PROGRESS', substate = 'active'").run(
      agentId,
    );
    const out = applySettledClose(db, {
      workstream: "a",
      agent: "w1",
      agentId,
      incarnation: "i",
      runs: 1,
      settled: true,
      lastText: `CLOSE: task=${r.id} evidence="x"\nREPORT:\ndone`,
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/mu task close/);
    expect(getTask(db, r.id, "a")?.status).toBe("IN_PROGRESS");
  });
});

describe("machine-local storage", () => {
  it("leaves no metadata op, cascades with its task, and rebuild reports the loss", () => {
    const r = need("a/orch", "decide");
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM ops WHERE entity NOT IN ('task','note','workstream')")
          .get() as { n: number }
      ).n,
    ).toBe(0);
    const out = join(dir, "rebuilt.db");
    const report = rebuildInto(db, { targetPath: out });
    expect(report.machineLocalLost).toEqual([{ table: "human_needs", rows: 1 }]);
    const rebuilt = openDb({ path: out });
    try {
      expect(getTask(rebuilt, r.id, "a")).toMatchObject({ kind: "human", substate: "parked" });
      expect(openHumanNeeds(rebuilt, "a/orch")).toEqual([]); // ownership is not restored
    } finally {
      rebuilt.close();
    }
    db.prepare("DELETE FROM tasks").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM human_needs").get()).toEqual({ n: 0 });
  });
});

describe("mu human-needed (in-process CLI)", () => {
  const managed = async (fn: () => Promise<void>): Promise<void> => {
    await withEnv("MU_MANAGED_AGENT", "1", () =>
      withEnv("MU_WORKSTREAM", "a", () => withEnv("MU_AGENT_NAME", "orch", fn)),
    );
  };

  it("spawnerFromEnv identity: managed pair, pi session, else none", () => {
    expect(spawnerFromEnv({ MU_MANAGED_AGENT: "1", MU_WORKSTREAM: "a", MU_AGENT_NAME: "o" })).toBe(
      "a/o",
    );
    expect(spawnerFromEnv({ PI_SESSION_ID: "s" })).toBe("pi:s");
    expect(spawnerFromEnv({ MU_AGENT_NAME: "o", USER: "u" })).toBeNull();
  });

  it("records under the managed caller; --json envelope; root and subcommand -w", async () => {
    await managed(async () => {
      const r = await runCliJson(["human-needed", "pick one", "--json"], dbPath);
      expect(r.exitCode).toBeNull();
      expect(r.doc).toMatchObject({ ok: true, next: null });
      expect(r.data).toMatchObject({ workstream: "a", changed: true });
      const again = await runCliJson(["-w", "a", "human-needed", "pick one", "--json"], dbPath);
      expect(again.data).toMatchObject({ changed: false });
      const other = await runCliJson(["human-needed", "other", "-w", "b", "--json"], dbPath);
      expect(other.data).toMatchObject({ workstream: "b", changed: true });
    });
    const check = openDb({ path: dbPath });
    try {
      expect(openHumanNeeds(check, "a/orch").map((n) => [n.workstream, n.reason])).toEqual([
        ["a", "pick one"],
        ["b", "other"],
      ]);
    } finally {
      check.close();
    }
  });

  it("human output is brief", async () => {
    await managed(async () => {
      const r = await runCli(["human-needed", "pick one"], dbPath);
      expect(r.exitCode).toBeNull();
      expect(r.stdout).toMatch(/Recorded human-needed/);
    });
  });

  it("refuses with no identity (exit 2, nothing written) and on a blank reason", async () => {
    for (const k of ["MU_MANAGED_AGENT", "MU_AGENT_NAME", "PI_SESSION_ID"]) {
      await withEnv(k, undefined, async () => {});
    }
    await withEnv("MU_MANAGED_AGENT", undefined, () =>
      withEnv("PI_SESSION_ID", undefined, async () => {
        const r = await runCliJson(["human-needed", "why", "-w", "a", "--json"], dbPath);
        expect(r.exitCode).toBe(2);
        expect(r.stdout).toMatch(/no caller identity/);
      }),
    );
    await managed(async () => {
      const r = await runCliJson(["human-needed", "  ", "--json"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toMatch(/reason is blank/);
    });
    const check = openDb({ path: dbPath });
    try {
      expect(check.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    } finally {
      check.close();
    }
  });

  it("task show on a human task does not suggest unpark; a refused unpark exits 4", async () => {
    const r = need("a/orch", "decide");
    const show = await runCli(["task", "show", r.id, "-w", "a"], dbPath);
    expect(show.stdout).not.toMatch(/task unpark/);
    const un = await runCli(["task", "unpark", r.id, "-w", "a"], dbPath);
    expect(un.exitCode).toBe(4);
    expect(un.stderr + un.stdout).toMatch(/mu task close/);
  });

  it("refusals print exactly one line (no Next: block) for unpark and claim --force --self", async () => {
    const r = need("a/orch", "decide");
    const lines = (o: { stdout: string; stderr: string }) =>
      (o.stderr + o.stdout).split("\n").filter((l) => l.trim() !== "");
    const un = await runCli(["task", "unpark", r.id, "-w", "a"], dbPath);
    const cl = await runCli(["task", "claim", r.id, "--self", "--force", "-w", "a"], dbPath);
    for (const o of [un, cl]) {
      expect(o.exitCode).toBe(4);
      expect(lines(o)).toHaveLength(1);
      expect(lines(o)[0]).toMatch(new RegExp(`mu task close ${r.id} -w a`));
    }
  });
});
