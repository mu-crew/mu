// v_scope: scope is explicit (-w / qualified ref) or the injected managed
// identity, nothing else. `$MU_SESSION` and the mux session name never
// route a verb; they may only be SUGGESTED in the one-line error.
//
// Every routing case runs twice: "inside" tmux ($TMUX/$TMUX_PANE set, a
// mocked session literally named mu-decoy) and "outside" (both unset, the
// t3code / IDE terminal / CI shape). A decoy workstream holds the data a
// wrong route would show, so a misroute is a visible assertion failure.
//
// Fast tier: in-process runCli, per-test temp DB and state dir, mocked mux.
// The no-mux block mocks BOTH backends' executors unavailable and shows
// that task / DAG / sql keep working while doctor and agent verbs exit 5.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import { NoMultiplexerError } from "../src/mux.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, installUnreachableMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

const ENV_KEYS = [
  "TMUX",
  "TMUX_PANE",
  "HERDR_ENV",
  "HERDR_WORKSPACE_ID",
  "MU_SESSION",
  "MU_MANAGED_AGENT",
  "MU_AGENT_NAME",
  "MU_WORKSTREAM",
  "MU_MUX",
  "MU_STATE_DIR",
  "MU_SYNC_DIR",
] as const;

let dir: string;
let dbPath: string;
const saved: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** The injected identity spawn gives a managed worker (four of the six keys). */
const MANAGED = {
  MU_MANAGED_AGENT: "1",
  MU_AGENT_NAME: "self-1",
  MU_WORKSTREAM: "own",
} as const;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "mu-scope-"));
  dbPath = join(dir, "mu.db");
  process.env.MU_STATE_DIR = dir;
  const db = openDb({ path: dbPath });
  for (const ws of ["own", "decoy"]) {
    ensureWorkstream(db, ws);
    addTask(db, { localId: `t-${ws}`, workstream: ws, title: ws, impact: 10, effortDays: 1 });
  }
  addTask(db, { localId: "shared", workstream: "own", title: "own", impact: 10, effortDays: 1 });
  addTask(db, {
    localId: "shared",
    workstream: "decoy",
    title: "decoy",
    impact: 10,
    effortDays: 1,
  });
  addTask(db, { localId: "only-own", workstream: "own", title: "o", impact: 10, effortDays: 1 });
  insertAgent(db, { name: "self-1", workstream: "own", paneId: "%7" });
  insertAgent(db, { name: "other-1", workstream: "decoy", paneId: "%9" });
  db.close();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmFixtureDir(dir);
});

const names = (stdout: string): string[] =>
  (JSON.parse(stdout) as { items: { name: string }[] }).items.map((t) => t.name).sort();

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

/** One line, no help dump: what a missing scope must look like on stderr. */
function expectOneLineMissingScope(raw: string): void {
  const stderr = plain(raw);
  const lines = stderr.trim().split("\n");
  expect(lines, stderr).toHaveLength(1);
  expect(lines[0]).toMatch(/^.*no workstream: pass -w <name>/);
  expect(stderr).not.toContain("Usage:");
}

for (const where of ["inside", "outside"] as const) {
  describe(`scope never routes ambiently (${where} tmux)`, () => {
    let mux: MuxHarness;

    beforeEach(() => {
      if (where === "inside") setEnv({ TMUX: "/tmp/fake,1,0", TMUX_PANE: "%9" });
      mux = installMux("tmux", [
        ["display-message", "mu-decoy\n"],
        ["list-panes", { stdout: "", stderr: "can't find session", exitCode: 1 }],
      ]);
    });
    afterEach(() => mux.restore());

    it("task list with no scope is a one-line teaching error, never the decoy's data", async () => {
      setEnv({ MU_SESSION: "decoy" });
      const r = await runCli(["task", "list", "--json"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expectOneLineMissingScope(r.stderr);
    });

    it("the session name is only a suggestion", async () => {
      const r = await runCli(["task", "list"], dbPath);
      expect(r.exitCode).toBe(2);
      if (where === "inside") expect(r.stderr).toContain("(tmux session mu-decoy: -w decoy)");
      else expect(r.stderr).not.toContain("decoy");
    });

    it("-w selects exactly that partition, root position too", async () => {
      setEnv({ MU_SESSION: "decoy" });
      const verb = await runCli(["task", "list", "-w", "own", "--json"], dbPath);
      expect(names(verb.stdout)).toEqual(["only-own", "shared", "t-own"]);
      const root = await runCli(["-w", "own", "task", "list", "--json"], dbPath);
      expect(root.stdout).toBe(verb.stdout);
    });

    it("injected managed identity scopes the verb, over MU_SESSION and the session", async () => {
      setEnv({ ...MANAGED, MU_SESSION: "decoy" });
      const r = await runCli(["task", "list", "--json"], dbPath);
      expect(r.exitCode).toBeNull();
      expect(names(r.stdout)).toEqual(["only-own", "shared", "t-own"]);
    });

    it("an explicit -w beats the injected identity", async () => {
      setEnv(MANAGED);
      const r = await runCli(["task", "list", "-w", "decoy", "--json"], dbPath);
      expect(names(r.stdout)).toEqual(["shared", "t-decoy"]);
      const root = await runCli(["-w", "decoy", "task", "list", "--json"], dbPath);
      expect(root.stdout).toBe(r.stdout);
    });

    it("a stale MU_WORKSTREAM without MU_MANAGED_AGENT does not route", async () => {
      setEnv({ MU_WORKSTREAM: "own", MU_AGENT_NAME: "self-1" });
      const r = await runCli(["task", "list"], dbPath);
      expect(r.exitCode).toBe(2);
      expectOneLineMissingScope(r.stderr);
    });

    it("a bare ref with no scope never guesses: it names the qualified form", async () => {
      const r = await runCli(["task", "show", "only-own"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("own/only-own");
      expect(r.stderr).toMatch(/no workstream: pass -w <name>/);
    });

    it("a qualified ref is explicit scope and needs no mux", async () => {
      const r = await runCli(["task", "show", "own/only-own", "--json"], dbPath);
      expect(r.exitCode).toBeNull();
      expect(JSON.parse(r.stdout).task.workstreamName).toBe("own");
    });

    it("mutating verbs refuse too: nothing is closed in the decoy workstream", async () => {
      setEnv({ MU_SESSION: "decoy" });
      const r = await runCli(["task", "close", "t-decoy", "--evidence", "x"], dbPath);
      expect(r.exitCode).toBe(2);
      const db = openDb({ path: dbPath });
      const row = db.prepare("SELECT status FROM tasks WHERE local_id = 't-decoy'").get() as {
        status: string;
      };
      db.close();
      expect(row.status).toBe("OPEN");
    });

    it("state: bare is an error (also --json), --all and -w are explicit", async () => {
      setEnv({ MU_SESSION: "decoy" });
      for (const argv of [["state"], ["state", "--json"]]) {
        const r = await runCli(argv, dbPath);
        expect(r.exitCode, argv.join(" ")).toBe(2);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("--all");
        expect(r.stderr.trim().split("\n")).toHaveLength(1);
      }
      const all = await runCli(["state", "--all", "--json"], dbPath);
      expect(all.exitCode).toBeNull();
      const one = await runCli(["state", "-w", "own", "--json"], dbPath);
      expect(JSON.parse(one.stdout).workstreamName).toBe("own");
    });

    it("state: injected identity scopes a bare `mu state`", async () => {
      setEnv(MANAGED);
      const r = await runCli(["state", "--json"], dbPath);
      expect(r.exitCode).toBeNull();
      expect(JSON.parse(r.stdout).workstreamName).toBe("own");
    });

    it("log: write and bare read need a scope; --all is the explicit global read", async () => {
      setEnv({ MU_SESSION: "decoy" });
      const before = (() => {
        const db = openDb({ path: dbPath });
        const n = listLogs(db, {}).length;
        db.close();
        return n;
      })();
      const w = await runCli(["log", "hello"], dbPath);
      expect(w.exitCode).toBe(2);
      expectOneLineMissingScope(w.stderr);
      const read = await runCli(["log", "--json"], dbPath);
      expect(read.exitCode).toBe(2);
      expect(read.stdout).toBe("");
      const db = openDb({ path: dbPath });
      expect(listLogs(db, {}).length).toBe(before);
      db.close();
      const all = await runCli(["log", "--all", "--json"], dbPath);
      expect(all.exitCode).toBeNull();
    });

    it("log: authorship and partition come from the injected identity, not the pane", async () => {
      // $TMUX_PANE (when set) is the decoy agent's pane: it must not matter.
      setEnv({ ...MANAGED, TMUX_PANE: "%9" });
      const r = await runCli(["log", "from the worker"], dbPath);
      expect(r.exitCode).toBeNull();
      const db = openDb({ path: dbPath });
      const row = listLogs(db, { workstream: "own" }).find((l) => l.payload === "from the worker");
      db.close();
      expect(row?.source).toBe("self-1");
      expect(row?.workstreamName).toBe("own");
    });

    it("me: the injected identity wins over a pane that belongs to another agent", async () => {
      setEnv({ ...MANAGED, TMUX_PANE: "%9" });
      const r = await runCli(["me", "--json"], dbPath);
      expect(r.exitCode, r.stderr).toBeNull();
      expect(JSON.parse(r.stdout).agent).toMatchObject({ name: "self-1", workstreamName: "own" });
    });

    it("me: injected identity works with no $TMUX_PANE at all", async () => {
      setEnv(MANAGED);
      const r = await runCli(["me", "--json"], dbPath);
      expect(r.exitCode, r.stderr).toBeNull();
      expect(JSON.parse(r.stdout).agent.name).toBe("self-1");
      const next = await runCli(["me", "next", "--json"], dbPath);
      expect(next.exitCode, next.stderr).toBeNull();
    });

    it("me: a managed identity with no agent row is an error, not a pane guess", async () => {
      setEnv({ ...MANAGED, MU_AGENT_NAME: "ghost-1", TMUX_PANE: "%9" });
      const r = await runCli(["me", "--json"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("own/ghost-1");
    });

    it("task note authorship is MU_AGENT_NAME, never the pane", async () => {
      setEnv({ ...MANAGED, TMUX_PANE: "%9" });
      const r = await runCli(["task", "note", "t-own", "hello"], dbPath);
      expect(r.exitCode, r.stderr).toBeNull();
      const db = openDb({ path: dbPath });
      const row = db
        .prepare(
          "SELECT n.author FROM task_notes n JOIN tasks t ON t.id = n.task_id WHERE t.local_id = 't-own' AND n.content = 'hello'",
        )
        .get() as { author: string } | undefined;
      db.close();
      expect(row?.author).toBe("self-1");
    });
  });
}

describe("blank and padded workstream names are rejected everywhere, never trimmed into another", () => {
  beforeEach(() => {
    installMux("tmux", []);
  });

  it.each([
    [["task", "show", "t-own", "-w", " ", "--json"]],
    [["task", "show", "t-own", "-w", " own", "--json"]],
    [["task", "show", "t-own", "-w", "own ", "--json"]],
    [["task", "show", "t-own", "-w", "", "--json"]],
    [["task", "list", "-w", " own"]],
    [["-w", " own", "task", "list"]],
    [["-w", "", "task", "list"]],
    [["-w", " ", "task", "list"]],
    [["state", "-w", " own"]],
    [["state", "-w", ""]],
    [["state", "-w", "own, decoy"]],
    [["log", "-w", " own"]],
    [["task", "owned-by", "self-1", "-w", " own"]],
    [["-w", " own", "task", "owned-by", "self-1"]],
    [["agent", "wait", "self-1", "-w", " own"]],
  ])("%j exits 2 and reads nothing", async (argv) => {
    const r = await runCli(argv, dbPath);
    expect(r.exitCode, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stdout).toBe("");
  });

  it("a trailing comma is a comma artifact, not a blank name", async () => {
    const r = await runCli(["-w", "own,", "task", "list", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(names(r.stdout)).toContain("t-own");
  });
});

describe("no multiplexer at all (no tmux, no herdr)", () => {
  let unreachable: { restore(): void };

  beforeEach(() => {
    unreachable = installUnreachableMux("tmux", () => new NoMultiplexerError(["tmux", "herdr"]));
  });
  afterEach(() => unreachable.restore());

  it("task, DAG, wait and sql verbs keep working with explicit scope", async () => {
    const list = await runCli(["task", "list", "-w", "own", "--json"], dbPath);
    expect(list.exitCode, list.stderr).toBeNull();
    expect(names(list.stdout)).toContain("t-own");
    const root = await runCli(["-w", "own", "task", "list", "--json"], dbPath);
    expect(root.stdout).toBe(list.stdout);
    for (const argv of [
      ["task", "tree", "own/t-own", "--json"],
      ["task", "show", "own/t-own", "--json"],
      ["task", "wait", "own/t-own", "--status", "OPEN", "--timeout", "1", "--json"],
      ["sql", "SELECT COUNT(*) AS n FROM tasks", "--json"],
    ]) {
      const r = await runCli(argv, dbPath);
      expect(r.exitCode, `${argv.join(" ")}: ${r.stderr}`).toBeNull();
    }
  });

  it("a missing scope is still the one-line error, with no mux to suggest from", async () => {
    setEnv({ TMUX: "/tmp/fake,1,0" });
    const r = await runCli(["task", "list"], dbPath);
    expect(r.exitCode).toBe(2);
    expectOneLineMissingScope(r.stderr);
  });

  it("agent verbs fail with one line naming the install, exit 5", async () => {
    const r = await runCli(["agent", "list", "-w", "own"], dbPath);
    expect(r.exitCode).toBe(5);
    const lines = plain(r.stderr).trim().split("\n");
    expect(lines[0]).toMatch(/^no multiplexer: .*install tmux/);
    // The one-line error carries at most one Next hint.
    expect(lines.filter((l) => l.includes("mu ")).length).toBeLessThanOrEqual(2);
  });

  it("doctor prints its report, then exits 5 naming the install", async () => {
    const r = await runCli(["doctor"], dbPath);
    expect(r.exitCode, r.stderr).toBe(5);
    expect(r.stdout).toContain("multiplexer");
    expect(r.stdout).toContain("NONE");
    expect(plain(r.stderr)).toMatch(/no multiplexer: .*install tmux/);
  });

  it("doctor --json still emits the integrity facts, then the error envelope with exit 5", async () => {
    const r = await runCli(["doctor", "--json"], dbPath);
    expect(r.exitCode, r.stderr).toBe(5);
    const report = JSON.parse(r.stdout.trim()) as {
      environment: { mux: { ok: boolean } };
      db: unknown;
    };
    expect(report.environment.mux.ok).toBe(false);
    expect(report.db).toBeDefined();
    const env = JSON.parse(r.stderr.trim().split("\n")[0] ?? "") as {
      error: string;
      exitCode: number;
      message: string;
    };
    expect(env).toMatchObject({ error: "NoMultiplexerError", exitCode: 5 });
    expect(env.message).toMatch(/install tmux/);
  });
});

describe("a mux binary with no client is not 'no mux'", () => {
  it("doctor exits 0 when tmux answers, with $TMUX/$TMUX_PANE/$HERDR_ENV unset", async () => {
    const mux = installMux("tmux", [["-V", "tmux 3.4"]]);
    try {
      const r = await runCli(["doctor", "--json"], dbPath);
      expect(r.exitCode, r.stderr).toBeNull();
      expect(JSON.parse(r.stdout).environment.mux.ok).toBe(true);
    } finally {
      mux.restore();
    }
  });
});
