// Spawn presets (spec D6, D17): a worker of a blessed harness is launched with
// its row's model flag for --model and its in-sandbox auto-approve flags; pi
// gets the model flag only (its --approve is folder trust). `mu agent list`
// shows each agent's harness and channel.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "msp-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  saved = { c: process.env.MU_SPAWN_CTL_MS, l: process.env.MU_SPAWN_LIVENESS_MS };
  process.env.MU_SPAWN_CTL_MS = "0";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  ensureWorkstream(db, "auth");
  state = freshMockState();
  mux = installMux("tmux", mockTmux(state).executor);
});

afterEach(() => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  db.close();
  for (const [k, v] of Object.entries({
    MU_SPAWN_CTL_MS: saved.c,
    MU_SPAWN_LIVENESS_MS: saved.l,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmFixtureDir(dir);
});

/** The command the agent's pane was started with (the anchor wrapper's last word, unquoted). */
const launched = (name: string): string => {
  const pane = getAgent(db, name, "auth")?.paneId ?? "";
  const cmd = state.panes.get(pane)?.command ?? "";
  const m = / mu-anchor '(.*)'$/.exec(cmd);
  return m?.[1]?.replace(/'"'"'/g, "'") ?? cmd;
};

describe("spawn presets", () => {
  it("a worker gets its row's model and auto-approve flags; the row keeps the command as given", async () => {
    await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "codex", model: "gpt-5" });
    await spawnAgent(db, { name: "worker-2", workstream: "auth", cli: "muse" });
    expect(launched("worker-1")).toBe("codex -s workspace-write -a never --model gpt-5");
    expect(launched("worker-2")).toBe("muse --approval-mode never");
    expect(getAgent(db, "worker-1", "auth")?.command).toBe("codex");
  });

  it("pi gets --model and never an approval flag; without --model it runs exactly as before", async () => {
    await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "pi", model: "sonnet:high" });
    await spawnAgent(db, { name: "worker-2", workstream: "auth", cli: "pi" });
    expect(launched("worker-1")).toBe("pi --model sonnet:high");
    expect(launched("worker-2")).toBe("pi");
  });

  it("a cli key maps to its harness's flags; a literal --command and an orchestrator get no approval preset", async () => {
    await withEnv("MU_CLAUDE_BIG_COMMAND", "claude --verbose", async () => {
      await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "claude-big" });
    });
    await spawnAgent(db, {
      name: "worker-2",
      workstream: "auth",
      cli: "claude",
      command: "claude --dangerously-skip-permissions",
      model: "opus",
    });
    await spawnAgent(db, {
      name: "orch-1",
      workstream: "auth",
      cli: "cursor-agent",
      orchestrator: true,
    });
    expect(launched("worker-1")).toBe("claude --verbose --permission-mode acceptEdits");
    expect(launched("worker-2")).toBe("claude --dangerously-skip-permissions --model opus");
    expect(launched("orch-1")).toBe("cursor-agent");
  });

  it("--model on the CLI reaches the pane; a remote command gate refuses it", async () => {
    const r = await runCliJson(
      [
        "agent",
        "spawn",
        "worker-1",
        "-w",
        "auth",
        "--cli",
        "claude",
        "--model",
        "sonnet",
        "--json",
      ],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect(launched("worker-1")).toBe("claude --permission-mode acceptEdits --model sonnet");
    const gate = await runCli(
      [
        "agent",
        "spawn",
        "g-1",
        "-w",
        "auth",
        "--host",
        "dev",
        "--command",
        "npm test",
        "--model",
        "x",
      ],
      dbPath,
    );
    expect(gate.exitCode).not.toBeNull();
    expect(gate.stderr).toContain("--model cannot be used with a remote command gate");
  });

  it("a CLI outside the five refuses --model before any pane, rather than dropping it", async () => {
    const r = await runCli(
      ["agent", "spawn", "worker-1", "-w", "auth", "--cli", "aider", "--model", "x"],
      dbPath,
    );
    expect(r.exitCode).not.toBeNull();
    expect(r.stderr).toContain("aider is not claude, codex, cursor-agent, muse or pi");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(state.panes.size).toBe(0);
    // MU_<KEY>_COMMAND naming a harness is enough.
    await withEnv("MU_AIDER_COMMAND", "codex", async () => {
      const ok = await runCli(
        ["agent", "spawn", "worker-2", "-w", "auth", "--cli", "aider", "--model", "x"],
        dbPath,
      );
      expect(ok.exitCode).toBeNull();
    });
    expect(launched("worker-2")).toBe("codex -s workspace-write -a never --model x");
  });
});

describe("mu agent list: harness and channel", () => {
  it("the JSON record and the table both name each agent's harness and channel", async () => {
    await spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      cli: "codex-fast",
      command: "codex",
    });
    await spawnAgent(db, { name: "worker-2", workstream: "auth", cli: "pi" });
    await spawnAgent(db, { name: "worker-3", workstream: "auth", cli: "aider" });
    const r = await runCliJson(["agent", "list", "-w", "auth", "--json"], dbPath);
    const agents = (r.data as { agents: { name: string; harness: unknown; channel: unknown }[] })
      .agents;
    expect(agents.map((a) => [a.name, a.harness, a.channel])).toEqual([
      ["worker-1", "codex", "hooks"],
      ["worker-2", "pi", "ctl"],
      ["worker-3", null, "mux"],
    ]);
    const table = await runCli(["agent", "list", "-w", "auth", "--table"], dbPath);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip the table's colours
    const plain = table.stdout.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/harness\s.*channel/);
    expect(plain).toMatch(/worker-1\s.*codex-fast\s.*codex\s.*hooks/);
    expect(plain).toMatch(/worker-2\s.*pi\s.*pi\s.*ctl/);
  });
});
