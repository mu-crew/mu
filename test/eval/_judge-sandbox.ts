import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "../../src/db.ts";
import { addTask, closeTask } from "../../src/tasks.ts";
import { ensureWorkstream } from "../../src/workstream.ts";
import type { RunMetrics, Sandbox } from "../../tools/eval/types.ts";

export const emptyRun = (): RunMetrics => ({
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

export interface JudgeWorld {
  /** Tasks (workstream eval) created and closed through the SDK by "orchestrator": real task.close ops, stamped now. */
  closed?: string[];
  /** With `closed`: each closed task gets a worker `block` run record at now + this many ms (negative: before the close). */
  blockAtMs?: number;
}

/**
 * A sandbox every real judge can run against without a mu, tmux or pi: a git repo, a DB with one raw
 * sql.write op and one hand write to a machine-local table, and the state files the setups leave
 * behind (a judge that cannot find one fails loudly: add it here with the new scenario). `world`
 * adds a runs.log and ops.
 */
export function makeJudgeSandbox(world: JudgeWorld = {}): Sandbox {
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
  if (world.closed) {
    ensureWorkstream(db, "eval");
    for (const id of world.closed) {
      addTask(db, { localId: id, workstream: "eval", title: id });
      closeTask(db, id, { workstream: "eval", author: "orchestrator", evidence: "judge-sandbox" });
    }
  }
  db.close();
  // a hand write to a machine-local table that no op explains
  writeFileSync(
    join(workerDir, "mu-calls.log"),
    "1000 1100 0 - 41 sql UPDATE agents SET pane_id='%9' RETURNING name\n",
  );
  writeFileSync(join(workerDir, "mu-local.log"), "41|agents:1,|agents:99,\n");
  writeFileSync(join(workerDir, "mu-out", "41"), "name\n----\nw1\n");
  if (world.closed && world.blockAtMs !== undefined) {
    const at = Date.now() + world.blockAtMs;
    writeFileSync(
      join(workerDir, "runs.log"),
      `${world.closed.map((id, i) => `${at} w${i + 1} ${id} block - - /w`).join("\n")}\n`,
    );
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, env }).toString().trim();
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
  return { dir, env, workerDir, repoDir, dbPath, tmuxSocket: "x" } as unknown as Sandbox;
}
