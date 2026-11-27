// A failed @mu_* tag write is visible on every spawn surface (agent spawn, orchestrate),
// on stderr once or in --json `warnings`, and `mu doctor`'s crew-tags row is green, warns,
// or stays quiet with the mux down. Fake tmux (mockTmux): no real panes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, installNoMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson, runCliWire } from "./_runCli.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: { restore(): void } | undefined;
let tagsFail: boolean;

const TAG_LINE = /@mu_\* tags not set on %\d+ \(tmux: injected\); murmur will show this agent/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

function fakeTmux(): MuxHarness {
  const fake = mockTmux(freshMockState()).executor;
  return installMux("tmux", async (args) =>
    tagsFail && args[0] === "set-option" && args.includes("@mu_agent")
      ? { stdout: "", stderr: "injected", exitCode: 1 }
      : fake(args),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-crew-tags-cli-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  tagsFail = true;
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  resetSleep();
  resetCommandResolverForTests();
  const key = "MU_SPAWN_LIVENESS_MS";
  delete process.env[key];
  db.close();
  rmFixtureDir(dir);
});

describe("a failed tag write on spawn", () => {
  const spawnArgs = ["agent", "spawn", "worker-1", "-w", "auth", "--cli", "sh", "--command", "sh"];

  it("agent spawn: one stderr warning; the pane lives", async () => {
    mux = fakeTmux();
    const r = await runCli(spawnArgs, dbPath);
    expect(r.exitCode).toBeNull();
    const lines = plain(r.stderr)
      .split("\n")
      .filter((l) => TAG_LINE.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^warning: /);
  });

  it("agent spawn --json: in `warnings`, nothing on stderr", async () => {
    mux = fakeTmux();
    const r = await runCliWire([...spawnArgs, "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    const doc = (JSON.parse(r.stdout) as { data: { warnings?: string[] } }).data;
    expect(doc.warnings?.filter((w) => TAG_LINE.test(w))).toHaveLength(1);
    expect(r.stderr).not.toMatch(TAG_LINE);
  });

  it("agent spawn on success: no tag warning", async () => {
    tagsFail = false;
    mux = fakeTmux();
    const r = await runCliWire([...spawnArgs, "--json"], dbPath);
    const doc = (JSON.parse(r.stdout) as { data: { warnings?: string[] } }).data;
    expect(doc.warnings ?? []).not.toContainEqual(expect.stringMatching(TAG_LINE));
  });

  it("orchestrate: stderr once, and --json `warnings`", async () => {
    mux = fakeTmux();
    const human = await runCli(
      ["orchestrate", "-w", "auth", "--cli", "sh", "--command", "sh", "--name", "orch-1"],
      dbPath,
    );
    expect(human.exitCode).toBeNull();
    expect(plain(human.stderr).match(new RegExp(TAG_LINE.source, "g"))).toHaveLength(1);
    const json = await runCliWire(
      ["orchestrate", "-w", "auth", "--cli", "sh", "--command", "sh", "--name", "orch-2", "--json"],
      dbPath,
    );
    const doc = (JSON.parse(json.stdout) as { data: { warnings?: string[] } }).data;
    expect(doc.warnings?.filter((w) => TAG_LINE.test(w))).toHaveLength(1);
    expect(json.stderr).not.toMatch(TAG_LINE);
  });
});

describe("mu doctor crew tags", () => {
  type Doc = { environment: { crewTags: { status: string; warnings: string[] } } };

  it("green when every live agent's pane names its agent", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", cli: "sh", paneId: "%1", paneIdentity: "1|2" });
    mux = installMux("tmux", [["list-panes -a -F #{pane_id}|#{pid}", "%1|1|2|w1|ws|worker\n"]]);
    const { data } = await runCliJson<Doc>(["doctor", "--json"], dbPath);
    expect(data.environment.crewTags).toMatchObject({ status: "ok", warnings: [] });
  });

  it("warns, naming the agent and the fix", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", cli: "sh", paneId: "%1", paneIdentity: "1|2" });
    mux = installMux("tmux", [["list-panes -a -F #{pane_id}|#{pid}", "%1|1|2|||\n"]]);
    const { data } = await runCliJson<Doc>(["doctor", "--json"], dbPath);
    expect(data.environment.crewTags.status).toBe("warn");
    expect(data.environment.crewTags.warnings).toEqual([
      "ws/w1 (%1): @mu_agent unset, @mu_workstream unset, @mu_role unset; murmur shows it as human; fix: mu agent retag -w ws w1",
    ]);
    const human = await runCli(["doctor"], dbPath);
    expect(plain(human.stdout)).toMatch(/crew tags\s*: WARN 1 agent pane untagged/);
  });

  it("never fails or throws when no multiplexer runs: the mux row carries the failure", async () => {
    insertAgent(db, { name: "w1", workstream: "ws", cli: "sh", paneId: "%1", paneIdentity: "1|2" });
    mux = installNoMux();
    const r = await runCliWire(["doctor", "--json"], dbPath);
    const doc = JSON.parse(r.stdout) as { error: string; data: Doc };
    expect(doc.error).toBe("NoMultiplexerError");
    expect(doc.data.environment.crewTags.status).not.toBe("fail");
    expect(doc.data.environment.crewTags.warnings).toEqual([]);
  });
});
