// Claude's folder-trust dialog (recorded screen in test/fixtures) is a
// non-fatal spawn warning: pane and agent stay, --send is skipped.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectClaudeTrustDialog, detectSpawnStartupError } from "../src/agents/spawn.js";
import {
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

const SCREEN = readFileSync(new URL("./fixtures/claude-trust-dialog.txt", import.meta.url), "utf8");

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let sent: string[][];
let saved: Record<string, string | undefined>;

function installPanes(scrollback: string): void {
  const state = freshMockState();
  const fake = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    if (args[0] === "send-keys" || args[0] === "paste-buffer") sent.push([...args]);
    const res = await fake(args);
    if (args[0] === "new-session") for (const p of state.panes.values()) p.scrollback = scrollback;
    return res;
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mct-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  sent = [];
  saved = { l: process.env.MU_SPAWN_LIVENESS_MS };
  process.env.MU_SPAWN_LIVENESS_MS = "1500";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
});

afterEach(() => {
  mux?.restore();
  resetSleep();
  resetCommandResolverForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (saved.l === undefined) delete process.env.MU_SPAWN_LIVENESS_MS;
  else process.env.MU_SPAWN_LIVENESS_MS = saved.l;
});

describe("claude trust dialog", () => {
  it("the recorded screen is detected, and is not a startup error", () => {
    expect(detectClaudeTrustDialog(SCREEN)).toBe(true);
    expect(detectSpawnStartupError(SCREEN)).toBeUndefined();
    expect(detectClaudeTrustDialog("claude v2\n> ready")).toBe(false);
  });

  it("spawn keeps the pane and agent and flags the dialog", async () => {
    installPanes(SCREEN);
    const agent = await spawnAgent(db, { name: "w-1", workstream: "auth", cli: "claude" });
    expect(agent.trustDialog).toBe(true);
    expect(getAgent(db, "w-1", "auth")).toBeDefined();
  });

  it("a clean claude pane is not flagged", async () => {
    installPanes("claude v2\n> ready");
    const agent = await spawnAgent(db, { name: "w-1", workstream: "auth", cli: "claude" });
    expect(agent.trustDialog).toBeUndefined();
  });

  it("--send is skipped (reported in --json) and no keys are sent", async () => {
    db.close();
    installPanes(SCREEN);
    const r = await runCliJson(
      ["agent", "spawn", "w-1", "-w", "auth", "--cli", "claude", "--send", "hello", "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    expect(r.exitCode ?? 0).toBe(0);
    const out = r.data as { send: { ok: boolean; error: string } };
    expect(out.send).toMatchObject({ ok: false, error: "TrustDialogPending" });
    expect(r.doc.next).toBeNull(); // a skipped send owes no wait
    expect(r.stderr).toBe(""); // --json: the warning rides in the document
    expect((r.data as { warnings: string[] }).warnings.join("\n")).toContain("folder-trust dialog");
    expect(sent).toEqual([]);
    expect(getAgent(db, "w-1", "auth")).toBeDefined();
  });
});

describe("codex / cursor-agent re-source the shell rc", () => {
  it("--json spawn carries one warning naming the flag and the guide; pi gets none", async () => {
    db.close();
    installPanes("ready");
    const codex = await runCliJson(
      ["agent", "spawn", "w-2", "-w", "auth", "--cli", "codex", "--json"],
      dbPath,
    );
    const warnings = (codex.data as { warnings?: string[] }).warnings ?? [];
    expect(warnings.filter((w) => w.includes("--disable shell_snapshot"))).toHaveLength(1);
    expect(warnings.join("\n")).toContain("docs/guide/other-agent-clis.md");
    const cursor = await runCliJson(
      ["agent", "spawn", "w-3", "-w", "auth", "--cli", "cursor-agent", "--json"],
      dbPath,
    );
    expect(((cursor.data as { warnings?: string[] }).warnings ?? []).join("\n")).toContain(
      "ZDOTDIR",
    );
    const pi = await runCliJson(
      ["agent", "spawn", "w-4", "-w", "auth", "--cli", "sh", "--json"],
      dbPath,
    );
    expect((pi.data as { warnings?: string[] }).warnings).toBeUndefined();
    db = openDb({ path: dbPath });
  });

  it("a command that already pins it gets no warning", async () => {
    db.close();
    installPanes("ready");
    const r = await runCliJson(
      [
        "agent",
        "spawn",
        "w-2",
        "-w",
        "auth",
        "--cli",
        "codex",
        "--command",
        "codex --disable shell_snapshot",
        "--json",
      ],
      dbPath,
    );
    expect((r.data as { warnings?: string[] }).warnings).toBeUndefined();
    db = openDb({ path: dbPath });
  });
});
