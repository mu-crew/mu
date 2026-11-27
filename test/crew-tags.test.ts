// Crew tags (src/agents/crew-tags.ts): the identity murmur reads off a pane. On Rex it is
// the block label (the agent's name) and the session label (`mu-<ws>`); on tmux the @mu_*
// options. Doctor reads every pane in one batch; retag writes only what is wrong.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crewTagProblems, crewTagsDoctorCheck, retagAgents } from "../src/agents/crew-tags.js";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import type { CrewTags } from "../src/mux/types.js";
import { rexBackend, tmuxBackend } from "../src/mux.js";
import { installMux, type MuxHarness, REX_PANE } from "./_mux.js";

const OTHER_BLOCK = "block:01a1a0d4-b59b-7416-9cdb-67e9cd36dd6c";

let tempDir: string;
let db: Db;
let mux: MuxHarness | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-crew-tags-"));
  db = openDb({ path: join(tempDir, "mu.db") });
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

/** A Rex server with one session (`label`) holding `blocks`; set_block_label calls land in `set`. */
function rexServer(label: string, blocks: { id: string; label: string }[], set: unknown[] = []) {
  return installMux("rex", async (args) => {
    const method = args[2];
    const input = JSON.parse(args[3] ?? "{}") as Record<string, unknown>;
    const ok = (v: unknown) => ({ stdout: JSON.stringify(v), stderr: "", exitCode: 0 });
    if (method === "session.list") return ok({ sessions: [{ session_id: "s1", label }] });
    if (method === "session.list_blocks") {
      return ok({ blocks: blocks.map((b) => ({ block_id: b.id, label: b.label })) });
    }
    if (method === "target.resolve") {
      return ok({ results: [{ status: "resolved", target: { session_id: "s1" } }] });
    }
    if (method === "session.set_block_label") {
      set.push(input);
      return ok({ revision: 2 });
    }
    return { stdout: "", stderr: `unrouted: ${method}`, exitCode: 1 };
  });
}

describe("Rex label check", () => {
  it("is clean when the block label is the agent and the session is mu-<ws>", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", cli: "pi", paneId: REX_PANE });
    mux = rexServer("mu-ws", [{ id: REX_PANE, label: "w1" }]);
    const r = await crewTagsDoctorCheck(db, rexBackend);
    expect(r.check.status).toBe("ok");
    expect(r.problems).toEqual([]);
  });

  it("warns on a block label that is not the agent's name", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", cli: "pi", paneId: REX_PANE });
    mux = rexServer("mu-ws", [{ id: REX_PANE, label: "zsh" }]);
    const r = await crewTagsDoctorCheck(db, rexBackend);
    expect(r.check.status).toBe("warn");
    expect(r.lines).toEqual([
      `ws/w1 (${REX_PANE}): block label "zsh"; murmur shows it as human; fix: mu agent retag -w ws w1`,
    ]);
  });

  it("warns on a session label that is not mu-<ws>", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", cli: "pi", paneId: REX_PANE });
    mux = rexServer("scratch", [{ id: REX_PANE, label: "w1" }]);
    const r = await crewTagsDoctorCheck(db, rexBackend);
    expect(r.problems[0]?.wrong).toEqual(['session label "scratch"']);
    expect(r.lines[0]).toContain("not mu-ws");
  });

  it("ignores an agent whose block is gone", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", cli: "pi", paneId: REX_PANE });
    mux = rexServer("mu-ws", [{ id: OTHER_BLOCK, label: "someone" }]);
    expect((await crewTagsDoctorCheck(db, rexBackend)).problems).toEqual([]);
  });

  it("retag sets the block label, then is a no-op", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", cli: "pi", paneId: REX_PANE });
    const set: unknown[] = [];
    mux = rexServer("mu-ws", [{ id: REX_PANE, label: "zsh" }], set);
    expect(await retagAgents(db, rexBackend, { workstream: "ws" })).toMatchObject([
      { name: "w1", status: "changed" },
    ]);
    expect(set).toEqual([{ session_id: "s1", block_id: REX_PANE, label: "w1" }]);
    mux.restore();
    mux = rexServer("mu-ws", [{ id: REX_PANE, label: "w1" }], set);
    expect(await retagAgents(db, rexBackend, { workstream: "ws" })).toMatchObject([
      { name: "w1", status: "ok" },
    ]);
    expect(set).toHaveLength(1);
  });

  it("retag cannot fix a session label: partial, nothing written", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", cli: "pi", paneId: REX_PANE });
    const set: unknown[] = [];
    mux = rexServer("scratch", [{ id: REX_PANE, label: "w1" }], set);
    expect(await retagAgents(db, rexBackend)).toMatchObject([{ name: "w1", status: "partial" }]);
    expect(set).toEqual([]);
  });
});

describe("tmux tag check", () => {
  const row = (name: string, paneId: string) =>
    insertAgent(db, { name, workstream: "ws", cli: "pi", paneId });

  it("flags missing, wrong and foreign-role tags; keeps a valid role for the rewrite", () => {
    const a = row("w1", "%1");
    const b = row("w2", "%2");
    const c = row("w3", "%3");
    const tags = new Map<string, CrewTags>([
      ["%1", { agent: "", workstream: "", role: "" }],
      ["%2", { agent: "w2", workstream: "ws", role: "orchestrator" }],
      ["%3", { agent: "w3", workstream: "other", role: "orchestrator" }],
    ]);
    const problems = crewTagProblems(tmuxBackend, [a, b, c], tags);
    expect(problems.map((p) => [p.agent.name, p.wrong])).toEqual([
      ["w1", ["@mu_agent unset", "@mu_workstream unset", "@mu_role unset"]],
      ["w3", ['@mu_workstream "other"']],
    ]);
    expect(problems[0]?.want).toEqual({ agent: "w1", workstream: "ws", role: "worker" });
    expect(problems[1]?.want).toEqual({ agent: "w3", workstream: "ws", role: "orchestrator" });
  });

  it("doctor reads every pane in ONE list-panes -a call", async () => {
    row("w1", "%1");
    row("w2", "%2");
    mux = installMux("tmux", [["list-panes -a", "%1|1|2|w1|ws|worker\n%2|1|2|||\n"]]);
    const r = await crewTagsDoctorCheck(db, tmuxBackend);
    expect(r.problems.map((p) => p.agent.name)).toEqual(["w2"]);
    expect(mux.calls.filter((c) => c[0] === "list-panes")).toHaveLength(1);
  });
});
