import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { tmux } from "../src/tmux.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;
let session: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-agent-state-display-"));
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  session = "mu-state";
  await tmux(["new-session", "-d", "-s", session, "sleep", "60"]);
});

afterEach(async () => {
  db.close();
  await tmux(["kill-session", "-t", session]).catch(() => {});
  setMurmurRunnerForTests(null);
  resetAgentStateCacheForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("agent state display", () => {
  it("reports a local murmur state without exposing the stored status", async () => {
    const paneId = (await tmux(["display-message", "-p", "-t", session, "#{pane_id}"])).trim();
    insertAgent(db, { name: "worker-1", workstream: "state", paneId });
    await tmux(["set-option", "-pt", paneId, "@murmur_pane_state", "working"]);
    await tmux(["set-option", "-pt", paneId, "@murmur_pane_since", "1790000000000"]);

    const result = await runCli(["agent", "list", "-w", "state", "--json"], dbPath);
    expect(result.error).toBeUndefined();
    const payload = JSON.parse(result.stdout) as { agents: Array<Record<string, unknown>> };
    expect(payload.agents).toHaveLength(1);
    expect(payload.agents[0]).toMatchObject({
      state: "busy",
      source: "murmur",
      since: new Date(1_790_000_000_000).toISOString(),
    });
    expect(payload.agents[0]).not.toHaveProperty("status");

    await tmux(["set-option", "-pu", "-t", paneId, "@murmur_pane_state"]);
    await tmux(["set-option", "-pu", "-t", paneId, "@murmur_pane_since"]);
    setMurmurRunnerForTests(async () => null);
    resetAgentStateCacheForTests();
    const unknown = await runCli(["agent", "list", "-w", "state", "--json"], dbPath);
    const unknownPayload = JSON.parse(unknown.stdout) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(unknownPayload.agents[0]).toMatchObject({ state: "unknown", source: "none" });
    expect(unknownPayload.agents[0]?.reason).toEqual(expect.any(String));
  });
});
