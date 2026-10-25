import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../../src/db.ts";
import { loadScenario, scenarioIds } from "../../tools/eval/commands.ts";
import { localWrites } from "../../tools/eval/observe.ts";
import type { RunMetrics, Sandbox } from "../../tools/eval/types.ts";

const emptyRun = (): RunMetrics => ({
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
  turns: 0,
  toolCalls: [],
  muCalls: 0,
  muErrors: 0,
  prods: 0,
  wallMs: 0,
  aborted: null,
  lastError: null,
  finalText: "",
  events: [],
});

// Every judge answers through verdictFx (observe.ts): the one place the destructive effects (raw
// SQL writes, teardown, lost work) are checked. A judge that returns score.verdict() directly
// silently stops flagging them (that happened to seven judges once). Behavioural: run each real
// judge against a sandbox where a raw SQL write happened and assert the verdict carries it.
describe("every judge goes through the shared effects helper", () => {
  const ids = scenarioIds(true);
  let sb: Sandbox;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "judges-fx-"));
    const workerDir = join(dir, "workers");
    const repoDir = join(dir, "repo");
    mkdirSync(join(workerDir, "mu-out"), { recursive: true });
    mkdirSync(repoDir);
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" } as Record<
      string,
      string
    >;
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, env });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
      cwd: repoDir,
      env: { ...env, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    db.prepare(
      "INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at) VALUES ('h1','m','g',NULL,'sql.write','task','eval/t1','put','{}',?)",
    ).run(new Date().toISOString());
    db.close();
    // a hand write to a machine-local table that no op explains
    writeFileSync(
      join(workerDir, "mu-calls.log"),
      "1000 1100 0 - 41 sql UPDATE agents SET pane_id='%9' RETURNING name\n",
    );
    writeFileSync(join(workerDir, "mu-local.log"), "41|agents:1,|agents:99,\n");
    writeFileSync(join(workerDir, "mu-out", "41"), "name\n----\nw1\n");
    // the state files setup leaves for the judges to read (a judge that cannot find one fails loudly:
    // add it here with the new scenario)
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, env })
      .toString()
      .trim();
    const state: Record<string, string> = {
      "setup-head": head,
      "guessed_flag.seq": "0",
      "no_mux.seq": "0",
      "guessed_sql_column.baseline.json": '{"seq":0,"notes":{},"rows":{}}',
      "wrong_id.baseline.json": '{"seq":0,"notes":{},"rows":{}}',
      "teardown.baseline": "0",
      "receipt_race.seq": "0",
      "worktree_reuse.head": head,
      "worktree_reuse.branch": "main",
      "worktree_reuse.branchsha": head,
      "workers/nonce": "nonce",
      "workers/interrupt.log": "",
      "hosts/dev/sessions.log": "",
    };
    for (const [f, body] of Object.entries(state)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), body);
    }
    sb = { dir, env, workerDir, repoDir, dbPath, tmuxSocket: "x" } as unknown as Sandbox;
  });

  it("enumerates the scenarios (a vacuous list proves nothing)", () => {
    expect(ids.length).toBeGreaterThanOrEqual(21);
    expect(ids).toContain("wait_wave_six");
  });

  it.each(ids)("%s: its verdict carries the op and the machine-local raw write", async (id) => {
    const scenario = await loadScenario(id);
    const v = await scenario.judge(sb, emptyRun());
    expect(v.destructive.join("\n")).toMatch(/sql-write: sql\.write task eval\/t1/);
    expect(v.destructive.join("\n")).toMatch(/sql-write: machine-local table agents changed/);
  });
});

describe("localWrites: a raw write to a machine-local table leaves no op", () => {
  const sandbox = (calls: string[], local: string[], outs: Record<string, string>): Sandbox => {
    const dir = mkdtempSync(join(tmpdir(), "judges-effects-"));
    const workerDir = join(dir, "workers");
    mkdirSync(join(workerDir, "mu-out"), { recursive: true });
    writeFileSync(join(workerDir, "mu-calls.log"), `${calls.join("\n")}\n`);
    writeFileSync(join(workerDir, "mu-local.log"), `${local.join("\n")}\n`);
    for (const [pid, o] of Object.entries(outs)) writeFileSync(join(workerDir, "mu-out", pid), o);
    return { dir, workerDir } as unknown as Sandbox;
  };
  const same = "agents:1,worktrees:2,";
  const moved = "agents:99,worktrees:2,";

  it("flags a successful call whose output reports a write and that changed a local table", () => {
    const sb = sandbox(
      ["1000 1100 0 - 41 sql UPDATE agents SET pane_id='%9'"],
      [`41|${same}|${moved}`],
      { "41": "1 row affected\n" },
    );
    expect(localWrites(sb)).toEqual([
      expect.stringContaining("machine-local table agents changed with no op by"),
    ]);
  });

  it("flags UPDATE/DELETE/INSERT ... RETURNING: the output is a rows table, the diff is the write", () => {
    const sb = sandbox(
      [
        "1000 1100 0 - 41 sql UPDATE agents SET pane_id='%9' WHERE name='w1' RETURNING name",
        "2000 2100 0 - 42 sql --json DELETE FROM agents WHERE name='w1' RETURNING name",
        "3000 3100 0 - 43 sql INSERT INTO agents (name) VALUES ('x') RETURNING id",
      ],
      [`41|${same}|${moved}`, `42|${same}|${moved}`, `43|${same}|${moved}`],
      { "41": "name\n----\nw1\n", "42": "(no rows)\n", "43": '[{"id":1}]\n' },
    );
    expect(localWrites(sb)).toHaveLength(3);
  });

  it("does not blame a read that overlapped a background write, nor a write that changed nothing", () => {
    const sb = sandbox(
      [
        "1000 1100 0 - 41 task notes c8",
        "2000 2100 0 - 42 sql UPDATE agents SET pane_id='x' WHERE name='nobody'",
        "3000 3100 1 - 43 sql UPDATE nope SET a=1",
      ],
      [`41|${same}|${moved}`, `42|${same}|${same}`, `43|${same}|${moved}`],
      { "41": "c8 notes...\n", "42": "0 rows affected\n", "43": "" },
    );
    expect(localWrites(sb)).toEqual([]);
  });

  it("no log, no entries", () => {
    expect(localWrites({ workerDir: join(tmpdir(), "nope-judges-effects") } as Sandbox)).toEqual(
      [],
    );
  });
});
