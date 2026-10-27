// v_state_log slice A: `mu state` / `mu me` read ONE canonical, read-only,
// bounded JSON document. Real SQLite, mocked mux (fast tier).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentOutput } from "../src/agent-output.js";
import { insertAgent } from "../src/agents.js";
import { boundState } from "../src/cli/state.js";
import { jsonDocument } from "../src/cli/tasks/records.js";
import { type Db, openDb } from "../src/db.js";
import { finishDelegate, registerDelegateCall } from "../src/delegates.js";
import { recordHumanNeeded } from "../src/human-needed.js";
import { COURSE_CHECK_CLOSED } from "../src/next-hints.js";
import { isStateVerbArgv } from "../src/output.js";
import { type StateSnapshot, stateSnapshot } from "../src/state.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { claimTask, closeTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson, runCliWire } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;

const IDENTITY_KEYS = ["PI_SESSION_ID", "TMUX_PANE", "MU_MANAGED_AGENT", "MU_AGENT_NAME"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Ambient identity (this suite may run inside a pi session or a mu pane) must not leak in.
  for (const k of IDENTITY_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "mu-state-contract-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  // An empty, successful pane list: the session exists and holds nothing.
  mux = installMux("tmux", [["list-panes", ""]]);
});
afterEach(() => {
  for (const k of IDENTITY_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  mux.restore();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const task = (ws: string, id: string, extra: Partial<Parameters<typeof addTask>[1]> = {}) =>
  addTask(db, { workstream: ws, localId: id, title: id, impact: 10, effortDays: 1, ...extra });
const scrub = { MU_MANAGED_AGENT: undefined, MU_AGENT_NAME: undefined, MU_WORKSTREAM: undefined };

/** Run `fn` with the identity env set (undefined deletes), restoring it after. */
async function asEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const keys = Object.keys(env);
  const run = async (i: number): Promise<void> => {
    const key = keys[i];
    if (key === undefined) return fn();
    await withEnv(key, env[key], () => run(i + 1));
  };
  await run(0);
}
const NO_ID = { ...scrub, PI_SESSION_ID: undefined, TMUX_PANE: undefined };

describe("mu state: one JSON document, SQL names, by default", () => {
  it("prints the envelope with no --json; every task field is an SQL column name", async () => {
    ensureWorkstream(db, "ws");
    task("ws", "alpha");
    const r = await runCliJson(["state", "-w", "ws"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.data.caller).toBeNull();
    expect(r.data.me).toBeNull();
    const [w] = r.data.workstreams;
    expect(Object.keys(w).sort()).toEqual(
      [
        "agents",
        "blocked",
        "counts",
        "delegates",
        "human_needs",
        "in_progress",
        "orphans",
        "ready",
        "recent_closed",
        "triage",
        "waves",
        "workstream",
        "workstream_id",
      ].sort(),
    );
    expect(w.ready[0]).toEqual({
      id: "alpha",
      title: "alpha",
      status: "OPEN",
      substate: "todo",
      impact: 10,
      effort_days: 1,
      owner: null,
      kind: "work",
      wave: null,
      updated_at: expect.any(String),
      activity_seq: expect.any(Number),
    });
    expect(w.counts).toMatchObject({ tasks: 1, open: 1, ready: 1, blocked: 0, closed: 0 });
    expect(JSON.stringify(r.data)).not.toMatch(/workstreamName|effortDays|recentClosed|inProgress/);
  });

  it("a course check due is a one-line data.notices entry; absent when nothing is due", async () => {
    ensureWorkstream(db, "ws");
    task("ws", "alpha");
    const quiet = await runCliJson(["state", "-w", "ws"], dbPath);
    expect(quiet.data).not.toHaveProperty("notices");
    for (let i = 0; i < COURSE_CHECK_CLOSED; i++) {
      task("ws", `c${i}`);
      closeTask(db, `c${i}`, { workstream: "ws", evidence: "ok" });
    }
    const due = await runCliJson(["state", "-w", "ws"], dbPath);
    expect(due.data.notices).toEqual([
      expect.stringMatching(
        /^course check due: 10 closed since .*\. Stop dispatching: finish merging, then follow recipes\/course-correct\.md$/,
      ),
    ]);
  });

  it("--json is still accepted and prints the same document", async () => {
    ensureWorkstream(db, "ws");
    const a = await runCliJson(["state", "-w", "ws"], dbPath);
    const b = await runCliJson(["state", "-w", "ws", "--json"], dbPath);
    expect(b.stdout).toBe(a.stdout);
  });
});

describe("scope: every form is kept; errors are the JSON document too", () => {
  beforeEach(() => {
    for (const w of ["a", "b", "c"]) ensureWorkstream(db, w);
  });
  const names = (r: { data: { workstreams: { workstream: string }[] } }) =>
    r.data.workstreams.map((w) => w.workstream);

  it.each([
    ["comma", ["-w", "a,b"]],
    ["repeat", ["-w", "a", "-w", "b"]],
    ["variadic", ["-w", "a", "b"]],
    ["mixed with a duplicate", ["-w", "a,b", "-w", "a"]],
    ["root -w before the verb", ["-w", "a", "-w", "b", "state"]],
  ])("%s -> the same two workstreams, in order", async (_n, flags) => {
    const argv = flags.includes("state") ? flags : ["state", ...flags];
    const r = await runCliJson(argv, dbPath);
    expect(r.exitCode).toBeNull();
    expect(names(r)).toEqual(["a", "b"]);
  });

  it("--all is every live workstream; a one-name read keeps the same array shape", async () => {
    expect(names(await runCliJson(["state", "--all"], dbPath))).toEqual(["a", "b", "c"]);
    expect(names(await runCliJson(["state", "-w", "c"], dbPath))).toEqual(["c"]);
  });

  it("--all on an empty machine is an empty array, not an error", async () => {
    const empty = join(dir, "empty.db");
    const r = await runCliJson(["state", "--all"], empty);
    expect(r.exitCode).toBeNull();
    expect(r.data.workstreams).toEqual([]);
  });

  it.each([
    ["bare state", ["state"], 2, "UsageError"],
    ["unknown -w", ["state", "-w", "nope"], 3, "WorkstreamNotFoundError"],
    ["--all with -w", ["state", "--all", "-w", "a"], 2, "UsageError"],
    ["padded name", ["state", "-w", " a"], 2, "UsageError"],
    ["unknown flag", ["state", "-w", "a", "--hud"], 2, "CommanderError"],
  ])("%s is a failure document on stdout (exit %i)", async (_n, argv, exit, error) => {
    const r = await runCliWire(argv, dbPath);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error, exit });
    expect(r.exitCode).toBe(exit);
  });

  it("only `state` and a bare `me` default to JSON: root -w values and other verbs do not count", () => {
    const is = (...a: string[]) => isStateVerbArgv(["node", "mu", ...a]);
    expect(is("state")).toBe(true);
    expect(is("-w", "x", "state", "--all")).toBe(true);
    expect(is("me")).toBe(true);
    expect(is("me", "--full")).toBe(true);
    expect(is("-w", "state", "task", "list")).toBe(false);
    expect(is("task", "state")).toBe(false);
    expect(is("me", "tasks")).toBe(false);
    expect(is("me", "next")).toBe(false);
    expect(is("sql", "select 1")).toBe(false);
  });
});

describe("activity: raw MAX(ops.seq) per task, not updated_at", () => {
  it("a note, an edge endpoint and a raw SQL write each move a task to the top", async () => {
    ensureWorkstream(db, "ws");
    for (const id of ["t1", "t2", "t3", "t4"]) {
      task("ws", id);
      await claimTask(db, id, { workstream: "ws", self: true, actor: "me" });
    }
    const order = async () =>
      (
        await stateSnapshot(db, { workstreams: ["ws"], caller: null })
      ).workstreams[0]?.in_progress?.map((t) => t.id);
    expect(await order()).toEqual(["t4", "t3", "t2", "t1"]);
    addNote(db, "t1", "hello", { workstream: "ws", author: "me" });
    expect(await order()).toEqual(["t1", "t4", "t3", "t2"]);
    task("ws", "dep");
    addBlockEdge(db, "ws", "t2", "dep");
    expect((await order())?.[0]).toBe("t2");
    // A write that bumps NO updated_at, through raw SQL: only the ops log sees it.
    db.prepare("UPDATE tasks SET impact = 77 WHERE local_id = 't3'").run();
    const first = (await stateSnapshot(db, { workstreams: ["ws"], caller: null })).workstreams[0];
    expect(first?.in_progress?.map((t) => t.id)[0]).toBe("t3");
    expect(first?.in_progress?.[0]?.activity_seq).toBe(
      (db.prepare("SELECT MAX(seq) AS s FROM ops WHERE key = 'ws/t3'").get() as { s: number }).s,
    );
  });
});

describe("agents and remote metadata come from the registry", () => {
  it("host, cwd, base and collected_head ride the agent record; REMOTE notes stay prose", async () => {
    ensureWorkstream(db, "ws");
    insertAgent(db, {
      name: "w1",
      workstream: "ws",
      paneId: "%1",
      host: "dev",
      cwd: "/remote/wt",
      base: "abc123",
      collectedHead: "def456",
    });
    task("ws", "t");
    addNote(db, "t", "REMOTE: other:/x\nREMOTE_BASE: w1:zzz", { workstream: "ws", author: "me" });
    const snap = await stateSnapshot(db, { workstreams: ["ws"], caller: null });
    expect(snap.workstreams[0]?.agents).toMatchObject([
      {
        name: "w1",
        host: "dev",
        cwd: "/remote/wt",
        base: "abc123",
        collected_head: "def456",
        workstream: "ws",
        state: expect.any(String),
      },
    ]);
    expect(JSON.stringify(snap)).not.toContain("other:/x");
  });
});

describe("the snapshot is read-only: no reconcile, no reap", () => {
  it("a registered agent whose pane is gone is still listed and nothing is reconciled", async () => {
    ensureWorkstream(db, "ws");
    insertAgent(db, { name: "ghost", workstream: "ws", paneId: "%999" });
    const seen = mux.calls.length;
    const before = (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
    const snap = await stateSnapshot(db, { workstreams: ["ws"], caller: null });
    expect(snap.workstreams[0]?.agents?.map((a) => a.name)).toEqual(["ghost"]);
    // Reading agent state may ask the state source; it never lists or reaps panes.
    expect(mux.calls.slice(seen).filter((c) => c[0] === "list-panes" && c.includes("-s"))).toEqual(
      [],
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n).toBe(before);
  });

  it("`mu state -w` (the CLI) reconciles explicitly: the ghost is reaped and orphans are listed", async () => {
    ensureWorkstream(db, "ws");
    insertAgent(db, { name: "ghost", workstream: "ws", paneId: "%999" });
    mux.restore();
    mux = installMux("tmux", [["list-panes", "@1\t%7\tpi\n"]]);
    const r = await runCliJson(["state", "-w", "ws"], dbPath);
    expect(r.data.workstreams[0].agents).toEqual([]);
    expect(r.data.workstreams[0].orphans).toEqual([{ pane_id: "%7", command: "pi" }]);
  });
});

describe("the caller's own delegate queue, waves and human needs", () => {
  const reg = (callId: string, caller: string, over: Record<string, unknown> = {}) =>
    registerDelegateCall(db, {
      callId,
      caller,
      workstream: "ws",
      request: { text: "check", label: callId.slice(-2) },
      state: "starting",
      ...over,
    }).call;

  beforeEach(() => {
    ensureWorkstream(db, "ws");
    ensureWorkstream(db, "other");
    task("ws", "f1");
  });

  it("lists only the caller's unfinished calls and its own waves; another session's same wave never mixes in", async () => {
    reg("pi:s1:c1", "pi:s1", { wave: "w", record: { workstream: "ws", task: "f1" } });
    reg("pi:s1:c2", "pi:s1", { wave: "w", state: "refused" });
    reg("pi:s2:c1", "pi:s2", { wave: "w" });
    const mine = await stateSnapshot(db, { workstreams: ["ws"], caller: "pi:s1" });
    const w = mine.workstreams[0];
    expect(w?.delegates.map((d) => d.call_id)).toEqual(["pi:s1:c1", "pi:s1:c2"]);
    expect(w?.delegates[0]).toMatchObject({
      state: "starting",
      wave: "w",
      judges: "ws/f1",
      task: expect.stringMatching(/^delegate_/),
    });
    expect(w?.waves).toEqual([
      expect.objectContaining({
        wave: "w",
        calls: 2,
        pending: 2,
        refused: ["pi:s1:c2"],
      }),
    ]);
    const none = await stateSnapshot(db, { workstreams: ["ws"], caller: null });
    expect(none.workstreams[0]?.delegates).toEqual([]);
    expect(none.workstreams[0]?.waves).toEqual([]);
    const theirs = await stateSnapshot(db, { workstreams: ["ws"], caller: "pi:s2" });
    expect(theirs.workstreams[0]?.delegates.map((d) => d.call_id)).toEqual(["pi:s2:c1"]);
    expect(theirs.workstreams[0]?.waves[0]).toMatchObject({ calls: 1, refused: [] });
  });

  it("finished calls (done, failed, cancelled) leave the queue but stay in the caller's wave tally once", async () => {
    const fin = (id: string, outcome: string, text = "no") =>
      finishDelegate(db, id, { outcome, text, author: "d", record: false });
    reg("pi:s1:a", "pi:s1", { wave: "w" });
    reg("pi:s1:b", "pi:s1", { wave: "w" });
    reg("pi:s1:c", "pi:s1", { wave: "w" });
    reg("pi:s1:q", "pi:s1", { wave: "w", state: "queued" });
    reg("pi:s1:r", "pi:s1", { wave: "w", state: "refused" });
    expect(fin("pi:s1:a", "done", "VERDICT: CONFIRMED yes").state).toBe("done");
    expect(fin("pi:s1:b", "timeout").state).toBe("failed");
    expect(fin("pi:s1:c", "cancelled").state).toBe("cancelled");
    const w = (await stateSnapshot(db, { workstreams: ["ws"], caller: "pi:s1" })).workstreams[0];
    expect(w?.delegates.map((d) => [d.call_id, d.state])).toEqual([
      ["pi:s1:q", "queued"],
      ["pi:s1:r", "refused"],
    ]);
    expect(w?.waves).toEqual([
      expect.objectContaining({
        wave: "w",
        calls: 5,
        confirmed: 1,
        unverified: 2,
        pending: 2,
        refused: ["pi:s1:r"],
      }),
    ]);
  });

  it("open human needs are the caller's, in their own workstream, and generic parked work is not one", async () => {
    recordHumanNeeded(db, { workstream: "ws", caller: "pi:s1", reason: "pick a licence" });
    recordHumanNeeded(db, { workstream: "other", caller: "pi:s1", reason: "elsewhere" });
    recordHumanNeeded(db, { workstream: "ws", caller: "pi:s2", reason: "not yours" });
    task("ws", "parked1");
    db.prepare("UPDATE tasks SET substate = 'parked' WHERE local_id = 'parked1'").run();
    const snap = await stateSnapshot(db, { workstreams: ["ws", "other"], caller: "pi:s1" });
    expect(snap.workstreams.map((w) => w.human_needs.map((h) => h.reason))).toEqual([
      ["pick a licence"],
      ["elsewhere"],
    ]);
  });

  it("a long multiline reason is escaped and clipped in the CLI document with a cut count and the way back", async () => {
    recordHumanNeeded(db, {
      workstream: "ws",
      caller: "pi:s1",
      reason: `line1\n${"x".repeat(2000)}`,
    });
    await asEnv({ ...scrub, PI_SESSION_ID: "s1" }, async () => {
      const r = await runCliJson(["state", "-w", "ws"], dbPath);
      const reason = r.data.workstreams[0].human_needs[0].reason as string;
      expect(reason.length).toBeLessThanOrEqual(160);
      expect(reason).not.toContain("\n");
      expect(reason.startsWith("line1\\n")).toBe(true);
      expect(r.data.cut).toBeGreaterThan(1800);
      expect(r.data.retrieve).toBe("mu state -w ws --full");
      const full = await runCliJson(["state", "-w", "ws", "--full"], dbPath);
      expect(full.data.workstreams[0].human_needs[0].reason).toBe(`line1\n${"x".repeat(2000)}`);
      expect(full.data.cut).toBeUndefined();
    });
  });
});

describe("the cap: the FINAL document is at most 4096 bytes and names its way back", () => {
  it("many tasks with multibyte titles: more/cut/retrieve, whole under --full", async () => {
    ensureWorkstream(db, "ws");
    for (let i = 0; i < 60; i++)
      task("ws", `t${i}`, { title: `日本語のタイトル ${i} ${"é".repeat(30)}` });
    const r = await runCliJson(["state", "-w", "ws"], dbPath);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(4096);
    expect(r.data.more).toBeGreaterThan(0);
    expect(r.data.retrieve).toBe("mu state -w ws --full");
    expect(r.data.workstreams[0].counts.tasks).toBe(60);
    const full = await runCliJson(["state", "-w", "ws", "--full"], dbPath);
    expect(full.data.workstreams[0].ready).toHaveLength(60);
    expect(full.data.more).toBeUndefined();
  });

  it("many workstreams page whole workstreams (min 0), and the way back repeats the scope", async () => {
    const all = Array.from({ length: 60 }, (_, i) => `ws-${String(i).padStart(2, "0")}`);
    for (const w of all) ensureWorkstream(db, w);
    const r = await runCliJson(["state", "--all"], dbPath);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(4096);
    expect(r.data.more).toBeGreaterThan(0);
    expect(r.data.retrieve).toBe("mu state --all --full");
    expect(r.data.workstreams.length).toBeLessThan(60);
  });

  it("140 long workstream names: even the zero-workstream envelope fits, with a short fixed retrieve", async () => {
    const names = Array.from(
      { length: 140 },
      (_, i) => `w${String(i).padStart(3, "0")}${"n".repeat(28)}`,
    );
    for (const w of names) ensureWorkstream(db, w);
    const r = await runCliJson(["state", "-w", names.join(",")], dbPath);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(4096);
    expect(r.data.more).toBeGreaterThan(0);
    expect(r.data.retrieve).toBe("mu state --all --full");
    const full = await runCliJson(["state", "--all", "--full"], dbPath);
    expect(full.data.workstreams).toHaveLength(140);
  });

  it("a wide identity block shrinks its fields until the FINAL document fits", () => {
    const wide = "日本語é".repeat(60);
    const agent = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`f${i}`, wide]),
    ) as unknown as AgentOutput;
    const snap: StateSnapshot = {
      caller: wide,
      me: { caller: wide, agent, owned_tasks: [] },
      workstreams: [],
    };
    const doc = boundState(
      snap,
      `mu state --me -w ${"n".repeat(5000)} --full`,
      false,
      "mu state --me --all --full",
    );
    const out = `${jsonDocument(doc)}\n`;
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4096);
    expect(doc).toMatchObject({ retrieve: "mu state --me --all --full" });
    expect((doc as { cut: number }).cut).toBeGreaterThan(0);
  });

  it("a small read carries no more/cut/retrieve", async () => {
    ensureWorkstream(db, "ws");
    task("ws", "a");
    const r = await runCliJson(["state", "-w", "ws"], dbPath);
    expect(r.data).not.toHaveProperty("more");
    expect(r.data).not.toHaveProperty("cut");
    expect(r.data).not.toHaveProperty("retrieve");
  });
});

describe("mu me IS mu state --me: one identity path, no pane guessing", () => {
  const MANAGED = (name: string, ws: string) => ({
    ...scrub,
    PI_SESSION_ID: undefined,
    MU_MANAGED_AGENT: "1",
    MU_AGENT_NAME: name,
    MU_WORKSTREAM: ws,
  });

  beforeEach(() => {
    ensureWorkstream(db, "ws");
    ensureWorkstream(db, "ws2");
    insertAgent(db, { name: "worker-1", workstream: "ws", paneId: "%1" });
    insertAgent(db, { name: "worker-1", workstream: "ws2", paneId: "%2" });
    task("ws", "mine");
    task("ws", "ready1");
    task("ws2", "theirs");
  });

  it("bare `mu me` runs (not --help) and prints exactly what `mu state --me` prints", async () => {
    await claimTask(db, "mine", { agentName: "worker-1", workstream: "ws" });
    await asEnv(MANAGED("worker-1", "ws"), async () => {
      const me = await runCliWire(["me"], dbPath);
      const st = await runCliWire(["state", "--me"], dbPath);
      expect(me.exitCode).toBeNull();
      expect(me.stdout).toBe(st.stdout);
      const { data } = await runCliJson(["me"], dbPath);
      expect(data.caller).toBe("ws/worker-1");
      expect(data.me.agent).toMatchObject({ name: "worker-1", workstream: "ws", cli: "pi" });
      expect(data.me.owned_tasks.map((t: { id: string }) => t.id)).toEqual(["mine"]);
      expect(data.workstreams.map((w: { workstream: string }) => w.workstream)).toEqual(["ws"]);
      expect(data.workstreams[0].ready.map((t: { id: string }) => t.id)).toEqual(["ready1"]);
      // narrowed: a `me` read does not carry the crew-wide lists
      expect(data.workstreams[0]).not.toHaveProperty("agents");
      expect(data.workstreams[0]).not.toHaveProperty("in_progress");
    });
  });

  it("looks the agent up in ITS workstream: a same-named agent elsewhere never answers", async () => {
    await claimTask(db, "theirs", { agentName: "worker-1", workstream: "ws2" });
    await asEnv(MANAGED("worker-1", "ws"), async () => {
      const { data } = await runCliJson(["me"], dbPath);
      expect(data.me.agent.workstream).toBe("ws");
      expect(data.me.owned_tasks).toEqual([]);
    });
  });

  it("an injected identity with no row is an error, not a pane fallback", async () => {
    await asEnv({ ...MANAGED("ghost", "ws"), TMUX_PANE: "%1" }, async () => {
      const r = await runCliWire(["me"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "UsageError" });
      expect(JSON.parse(r.stdout).message).toContain("ws/ghost");
    });
  });

  it("no identity is a JSON error even with a managed pane id: TMUX_PANE never identifies anyone", async () => {
    await asEnv({ ...NO_ID, TMUX_PANE: "%1" }, async () => {
      for (const argv of [["me"], ["state", "--me"]]) {
        const r = await runCliWire(argv, dbPath);
        expect(r.exitCode, argv.join(" ")).toBe(2);
        expect(r.stderr).toBe("");
        expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "UsageError", exit: 2 });
        expect(JSON.parse(r.stdout).message).toContain("no identity");
      }
    });
  });

  it("a pi session is `pi:<session>` with no agent row: its own delegates and needs, scoped to where it has work", async () => {
    registerDelegateCall(db, {
      callId: "pi:sess:1",
      caller: "pi:sess",
      workstream: "ws2",
      request: { text: "check" },
      state: "starting",
    });
    recordHumanNeeded(db, { workstream: "ws", caller: "pi:sess", reason: "decide" });
    await asEnv({ ...scrub, PI_SESSION_ID: "sess", TMUX_PANE: undefined }, async () => {
      const { data } = await runCliJson(["me"], dbPath);
      expect(data.caller).toBe("pi:sess");
      expect(data.me).toEqual({ caller: "pi:sess", agent: null, owned_tasks: [] });
      expect(data.workstreams.map((w: { workstream: string }) => w.workstream)).toEqual([
        "ws",
        "ws2",
      ]);
      expect(data.workstreams[0].human_needs).toEqual([
        { id: expect.any(String), reason: "decide" },
      ]);
      expect(data.workstreams[1].delegates.map((d: { call_id: string }) => d.call_id)).toEqual([
        "pi:sess:1",
      ]);
      // explicit -w narrows a --me read
      const one = await runCliJson(["state", "--me", "-w", "ws2"], dbPath);
      expect(one.data.workstreams.map((w: { workstream: string }) => w.workstream)).toEqual([
        "ws2",
      ]);
    });
  });

  it("`me tasks` / `me next` stay (managed agents), refuse a pi session, and never read a pane", async () => {
    await asEnv(MANAGED("worker-1", "ws"), async () => {
      const next = await runCliJson(["me", "next", "--json"], dbPath);
      expect(next.data.items.map((t: { id: string }) => t.id)).toHaveLength(1);
      const tasks = await runCliJson(["me", "tasks", "--json"], dbPath);
      expect(tasks.data.items).toEqual([]);
    });
    await asEnv({ ...NO_ID, PI_SESSION_ID: "sess", TMUX_PANE: "%1" }, async () => {
      const r = await runCliWire(["me", "next", "--json"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(JSON.parse(r.stdout).message).toContain("not a managed agent");
    });
  });

  it("`me --include-closed` is gone (the identity read is one fixed shape)", async () => {
    await asEnv(MANAGED("worker-1", "ws"), async () => {
      const r = await runCliWire(["me", "--include-closed"], dbPath);
      expect(r.exitCode).toBe(2);
    });
  });
});
