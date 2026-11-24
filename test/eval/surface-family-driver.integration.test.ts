// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The generated eval-worker driver runs `git` (log, status, rev-parse), so these
// cases are integration: the fast tier starts no git (test/_setup-no-git.ts).
// The driver runs in its sandbox dir, not the checkout the test runs from.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeWorkerDriver } from "../../tools/eval/fixtures.ts";
import type { Sandbox } from "../../tools/eval/types.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-eval-family-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** The eval-worker driver is a shell script over the sqlite3 CLI. */
const HAS_SQLITE3 = spawnSync("sqlite3", ["--version"]).status === 0;

describe.skipIf(!HAS_SQLITE3)("eval-worker as a delegate", () => {
  const ask = async (prompt: string, answers: Record<string, string>): Promise<string> => {
    const { execFileSync } = await import("node:child_process");
    const dir = join(tmp, `del-${Math.random().toString(36).slice(2)}`);
    const sb = { dir, binDir: join(dir, "bin"), workerDir: join(dir, "workers"), env: {} };
    mkdirSync(sb.binDir, { recursive: true });
    await writeWorkerDriver(sb as unknown as Sandbox);
    for (const [k, v] of Object.entries(answers))
      writeFileSync(join(sb.workerDir, "answers", `${k}.txt`), v);
    writeFileSync(join(sb.workerDir, "delegate-delay"), "0\n");
    writeFileSync(join(sb.workerDir, "last-prompt.delegate-x"), prompt);
    const db = join(dir, "x.db");
    execFileSync("sqlite3", [
      db,
      "create table tasks(local_id,owner_id,workstream_id,status);create table agents(id,name);create table workstreams(id,name);",
    ]);
    const out = execFileSync(join(sb.binDir, "eval-worker"), {
      encoding: "utf8",
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        EVAL_WORKER_DIR: sb.workerDir,
        MU_DB_PATH: db,
        MU_AGENT_NAME: "delegate-x",
        MU_WORKSTREAM: "scratch",
      },
    });
    return out;
  };

  it("keys on claim-N, then on a task id in the prompt, else a CONFIRMED naming the prompt", async () => {
    const a = { "1": "ONE", rt2: "RT2" };
    expect(await ask("check claim-1 please", a)).toContain("ONE");
    expect(await ask("refute the brief for task rt2", a)).toContain("RT2");
    const d = await ask("something unrelated", a);
    expect(d).toContain("VERDICT: CONFIRMED");
    expect(d).toContain("something unrelated");
    expect(d).toMatch(/EVIDENCE: .{40,}/);
    expect(d).not.toContain("fixture default");
  });
});

describe.skipIf(!HAS_SQLITE3)("eval-worker in block mode", () => {
  it("prints a CLOSE block that parses even when the task script prints nothing", async () => {
    const { execFileSync } = await import("node:child_process");
    const { parseCloseBlock } = await import("../../src/close-block.ts");
    const dir = join(tmp, "blk");
    const sb = { dir, binDir: join(dir, "bin"), workerDir: join(dir, "workers"), env: {} };
    mkdirSync(sb.binDir, { recursive: true });
    await writeWorkerDriver(sb as unknown as Sandbox, { closeMode: "block" });
    writeFileSync(join(sb.workerDir, "tasks", "r1.sh"), "true\n");
    const db = join(dir, "x.db");
    execFileSync("sqlite3", [
      db,
      "create table tasks(local_id,owner_id,workstream_id,status);create table agents(id,name);create table workstreams(id,name);" +
        "insert into agents values(1,'v1');insert into workstreams values(1,'eval');insert into tasks values('r1',1,1,'IN_PROGRESS');",
    ]);
    const out = execFileSync(join(sb.binDir, "eval-worker"), {
      encoding: "utf8",
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        EVAL_WORKER_DIR: sb.workerDir,
        MU_DB_PATH: db,
        MU_AGENT_NAME: "v1",
        MU_WORKSTREAM: "eval",
      },
    });
    expect(parseCloseBlock(out)).toMatchObject({ kind: "valid", task: "r1" });
  });

  it("on a remote host reads the claim from EVAL_DB_PATH, not the host's own MU_DB_PATH", async () => {
    const { execFileSync } = await import("node:child_process");
    const dir = join(tmp, "rem");
    const sb = { dir, binDir: join(dir, "bin"), workerDir: join(dir, "workers"), env: {} };
    mkdirSync(sb.binDir, { recursive: true });
    await writeWorkerDriver(sb as unknown as Sandbox, { closeMode: "block" });
    writeFileSync(join(sb.workerDir, "tasks", "r1.sh"), "true\n");
    const db = join(dir, "x.db");
    execFileSync("sqlite3", [
      db,
      "create table tasks(local_id,owner_id,workstream_id,status);create table agents(id,name);create table workstreams(id,name);" +
        "insert into agents values(1,'v1');insert into workstreams values(1,'eval');insert into tasks values('r1',1,1,'IN_PROGRESS');",
    ]);
    const out = execFileSync(join(sb.binDir, "eval-worker"), {
      encoding: "utf8",
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        EVAL_WORKER_DIR: sb.workerDir,
        EVAL_DB_PATH: db,
        MU_DB_PATH: join(dir, "host", "mu.db"),
        MU_AGENT_NAME: "v1",
        MU_WORKSTREAM: "eval",
      },
    });
    expect(out).toContain("CLOSE: task=r1");
    expect(out).not.toContain("unable to open");
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
