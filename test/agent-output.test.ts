// The agent output boundary: `--json` agent records carry SQL column names
// and the real foreign keys; the SDK `AgentRow` stays camelCase. Mapped at
// the CLI boundary only (src/agent-output.ts), never in the SDK.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentToOutput, closePreviewToOutput } from "../src/agent-output.js";
import { getAgent, insertAgent } from "../src/agents.js";
import { type Db, openDb, resolveWorkstreamId } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson, runCliWire } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-aout-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%7", cli: "claude", cwd: "/w" });
});

afterEach(() => {
  mux?.restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The mux answers a pane listing with worker-1's pane alive. */
const paneList = async (args: readonly string[]) => ({
  stdout: args[0] === "list-panes" ? "@1\t%7\tworker-1\tclaude" : "",
  stderr: "",
  exitCode: 0,
});

const SQL_KEYS = [
  "id",
  "name",
  "workstream_id",
  "workstream",
  "cli",
  "pane_id",
  "role",
  "tab",
  "cwd",
  "base",
  "command",
  "command_source",
  "spawner",
  "host",
  "collected_head",
  "repo",
  "gate_token",
  "created_at",
  "updated_at",
];

describe("agentToOutput", () => {
  it("keys are the SQL columns: id is the registry incarnation, workstream_id the real FK", () => {
    const row = getAgent(db, "worker-1", "auth");
    if (!row) throw new Error("seed");
    const out = agentToOutput(row, resolveWorkstreamId(db, "auth"));
    expect(Object.keys(out)).toEqual(SQL_KEYS);
    expect(out).toMatchObject({
      id: row.incarnation,
      name: "worker-1",
      workstream_id: resolveWorkstreamId(db, "auth"),
      workstream: "auth",
      pane_id: "%7",
      cwd: "/w",
    });
    // none of the SDK spellings, and never the deprecated status column
    for (const gone of ["incarnation", "paneId", "workstreamName", "createdAt", "status"]) {
      expect(out).not.toHaveProperty(gone);
    }
  });

  it("adds only the computed fields it is given, snake_cased", () => {
    const row = getAgent(db, "worker-1", "auth");
    if (!row) throw new Error("seed");
    const out = agentToOutput(row, 1, {
      state: "busy",
      source: "ctl",
      ctl: "ok",
      ctlSocket: "/s.sock",
      since: null,
      trustDialog: true,
    });
    expect(out).toMatchObject({
      state: "busy",
      source: "ctl",
      ctl: "ok",
      ctl_socket: "/s.sock",
      since: null,
      trust_dialog: true,
    });
    expect(out).not.toHaveProperty("reason");
    expect(out).not.toHaveProperty("idle");
  });
});

describe("closePreviewToOutput", () => {
  it("names the identity by its SQL keys (id, pane_id) and keeps the verb-level fields", () => {
    const out = closePreviewToOutput({
      agentName: "w",
      workstream: "auth",
      kind: "agent",
      revision: 9,
      incarnation: 4,
      paneId: "%1",
      ownedTasks: [],
      worktree: null,
      remote: null,
      recovery: null,
      carrierJob: null,
      refusesDirty: false,
      discard: false,
      keepBranch: false,
      abandonJob: false,
    });
    expect(out).toMatchObject({ kind: "agent", revision: 9, id: 4, pane_id: "%1", agentName: "w" });
    expect(out).toMatchObject({ recovery_id: null });
    expect(out).not.toHaveProperty("incarnation");
    expect(out).not.toHaveProperty("paneId");
  });
});

describe("agent verbs emit SQL-keyed agent records", () => {
  it("agent list: every record has exactly the SQL keys plus live state", async () => {
    mux = installMux("tmux", paneList);
    const r = await runCliJson(["agent", "list", "-w", "auth", "--json"], dbPath);
    const agents = (r.data as { agents: Record<string, unknown>[] }).agents;
    expect(agents).toHaveLength(1);
    const rec = agents[0] ?? {};
    expect(Object.keys(rec).slice(0, SQL_KEYS.length)).toEqual(SQL_KEYS);
    expect(rec).toMatchObject({
      name: "worker-1",
      pane_id: "%7",
      workstream: "auth",
      id: getAgent(db, "worker-1", "auth")?.incarnation,
    });
    expect(rec).toHaveProperty("state");
    expect(rec).not.toHaveProperty("paneId");
  });

  it("agent show: the same record, with scrollback beside it", async () => {
    mux = installMux("tmux", async () => ({ stdout: "hi\n", stderr: "", exitCode: 0 }));
    const r = await runCliJson(["agent", "show", "worker-1", "-w", "auth", "--json"], dbPath);
    const d = r.data as { agent: Record<string, unknown>; scrollback: string };
    expect(d.agent).toMatchObject({ name: "worker-1", pane_id: "%7", workstream: "auth" });
    expect(d.agent).not.toHaveProperty("workstreamName");
    expect(d.scrollback).toBe("hi\n");
  });

  it("agent close preview: identity keys are id and pane_id", async () => {
    mux = installMux("tmux", paneList);
    const r = await runCliJson(["agent", "close", "worker-1", "-w", "auth", "--json"], dbPath);
    expect(r.data).toMatchObject({
      kind: "agent",
      dryRun: true,
      id: getAgent(db, "worker-1", "auth")?.incarnation,
      pane_id: "%7",
    });
    expect(r.data).not.toHaveProperty("paneId");
    expect(r.data).not.toHaveProperty("incarnation");
  });

  it("me: the agent is the same record", async () => {
    const keys = ["MU_MANAGED_AGENT", "MU_AGENT_NAME", "MU_WORKSTREAM"] as const;
    const saved = keys.map((k) => process.env[k]);
    process.env.MU_MANAGED_AGENT = "1";
    process.env.MU_AGENT_NAME = "worker-1";
    process.env.MU_WORKSTREAM = "auth";
    try {
      mux = installMux("tmux", paneList);
      const r = await runCliJson(["me", "--json"], dbPath);
      expect(r.exitCode, r.stderr).toBeNull();
      expect((r.data as { me: { agent: object } }).me.agent).toMatchObject({
        name: "worker-1",
        pane_id: "%7",
        workstream: "auth",
      });
    } finally {
      keys.forEach((k, i) => {
        const v = saved[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  });
});

describe("agent list is JSON by default", () => {
  it("prints the --json document with no flag; --table prints the table", async () => {
    mux = installMux("tmux", paneList);
    const bare = await runCliWire(["agent", "list", "-w", "auth"], dbPath);
    const flagged = await runCliWire(["agent", "list", "-w", "auth", "--json"], dbPath);
    const doc = JSON.parse(bare.stdout);
    expect(doc).toMatchObject({ ok: true, data: { workstreamName: "auth" } });
    expect(doc.data.agents[0]).toMatchObject({ name: "worker-1", pane_id: "%7" });
    expect(Object.keys(doc.data)).toEqual(Object.keys(JSON.parse(flagged.stdout).data));

    const table = await runCliWire(["agent", "list", "-w", "auth", "--table"], dbPath);
    expect(() => JSON.parse(table.stdout)).toThrow();
    expect(table.stdout).toContain("mu-auth");
    expect(table.stdout).toContain("worker-1");
  });

  it("a failure is one envelope on stdout; --table keeps the human line", async () => {
    mux = installMux("tmux", paneList);
    const r = await runCliWire(["agent", "list", "-w", "nope"], dbPath);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, exit: 3 });
    const t = await runCliWire(["agent", "list", "-w", "nope", "--table"], dbPath);
    expect(t.stdout).toBe("");
    expect(t.stderr).toMatch(/no such workstream: nope/);
    const bad = await runCliWire(["agent", "list", "-w", "auth", "--bogus"], dbPath);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: "CommanderError", exit: 2 });
  });
});
