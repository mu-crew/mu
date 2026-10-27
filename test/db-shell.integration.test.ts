// `mu db --shell`: the sqlite3 CLI, read-only, on the isolated DB.
// Real subprocess: needs dist/ (npm run build) and a sqlite3 on PATH.

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(process.cwd(), "dist", "cli.js");
const HAS_SQLITE3 = spawnSync("sqlite3", ["--version"]).status === 0;
const describeIfReady = existsSync(CLI) && HAS_SQLITE3 ? describe : describe.skip;

describeIfReady("mu db --shell", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const mu = (
    args: string[],
    input?: string,
  ): Promise<{ code: number; out: string; err: string }> =>
    new Promise((resolve) => {
      const child = execFile("node", [CLI, ...args], { env }, (error, out, err) =>
        resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, out, err }),
      );
      child.stdin?.end(input ?? "");
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mu-db-shell-"));
    env = {
      ...process.env,
      MU_DB_PATH: join(dir, "mu.db"),
      MU_SYNC_DIR: "",
      MU_STATE_DIR: join(dir, "state"),
      MU_MANAGED_AGENT: "",
      MU_WORKSTREAM: "",
    };
    for (const ws of ["wa", "wb"]) {
      await mu(["workstream", "init", ws]);
      await mu(["task", "add", `t-${ws}`, "-w", ws, "-t", ws, "-i", "5", "-e", "1"]);
    }
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the isolated DB, scoped to -w with the same views as db query", async () => {
    const all = await mu(["db", "--shell"], "SELECT local_id FROM ready ORDER BY 1;\n");
    expect(all.err).toBe("");
    expect(all.out.trim().split("\n")).toEqual(["t-wa", "t-wb"]);
    const scoped = await mu(["db", "--shell", "-w", "wa"], "SELECT local_id FROM ready;\n");
    expect(scoped.out.trim()).toBe("t-wa");
    expect(scoped.code).toBe(0);
    const unknown = await mu(["db", "--shell", "-w", "nope"], "SELECT 1;\n");
    expect(unknown.code).toBe(3);
  });

  it("cannot write, cannot run a shell command, and the DB is unchanged", async () => {
    const w = await mu(
      ["db", "--shell"],
      "UPDATE tasks SET title = 'shell-wrote';\n.shell echo pwned\n",
    );
    expect(w.err).toMatch(/readonly|read-only|not authorized|safe mode/i);
    expect(w.out).not.toContain("pwned");
    const check = await mu([
      "db",
      "query",
      "SELECT COUNT(*) AS n FROM tasks WHERE title = 'shell-wrote'",
    ]);
    expect(JSON.parse(check.out).data.items).toEqual([{ n: 0 }]);
  });

  it("db query writes still go through mu (captured), while the shell sees them", async () => {
    await mu([
      "db",
      "query",
      "--write",
      "UPDATE tasks SET title = 'via-mu' WHERE local_id = 't-wa'",
    ]);
    const r = await mu(["db", "--shell"], "SELECT title FROM tasks WHERE local_id = 't-wa';\n");
    expect(r.out.trim()).toBe("via-mu");
    const log = await mu(["db", "query", "SELECT intent FROM ops ORDER BY seq DESC LIMIT 1"]);
    expect(JSON.parse(log.out).data.items).toEqual([{ intent: "sql.write" }]);
  });
});
