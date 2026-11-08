// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The sandbox mu shim's fp(): the machine-local table checksums observe.ts localWrites diffs.
// Real bash + sqlite3, so integration tier.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fpSql, LOCAL_TABLES, muShim } from "../../tools/eval/sandbox.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

const sqlite = (db: string, sql: string): string =>
  execFileSync("sqlite3", [db, sql], { encoding: "utf8" });

// Checkpoint, then drop -wal and -shm: the file stays WAL-mode with no -shm (macOS's sqlite3
// persists both on close, so remove them by hand).
const dropShm = (db: string): string =>
  `sqlite3 '${db}' 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null && rm -f '${db}-wal' '${db}-shm'`;

const ck = (fp: string | undefined): string | undefined =>
  fp
    ?.split(",")
    .find((kv) => kv.startsWith("agents:"))
    ?.slice("agents:".length);

describe("muShim fp()", () => {
  it("dumps a WAL-mode DB whose -shm file is gone, so a raw write shows as changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-shim-fp-"));
    dirs.push(dir);
    const db = join(dir, "mu.db");
    sqlite(
      db,
      "PRAGMA journal_mode=WAL; CREATE TABLE agents(name TEXT); INSERT INTO agents VALUES('a');",
    );
    // The expected hash, from a copy so the DB under test keeps no -shm.
    const ref = join(dir, "ref.db");
    execFileSync("bash", ["-c", dropShm(db)]);
    copyFileSync(db, ref);
    const want = ck(sqlite(ref, fpSql()).split("\n")[1]);
    expect(want).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(`${db}-shm`)).toBe(false);
    // `sqlite3 -readonly` cannot open this state (error 14): the broken dump the old fp() read.
    const ro = spawnSync("sqlite3", ["-readonly", db, ".dump agents"], { encoding: "utf8" });
    expect(ro.stderr).toContain("(14)");

    // The "CLI" the shim wraps: a raw write to a machine-local table, no op.
    const cli = join(dir, "cli.mjs");
    writeFileSync(
      cli,
      `import { execFileSync } from "node:child_process";\nexecFileSync("sqlite3", [${JSON.stringify(db)}, "INSERT INTO agents VALUES('b');"]);\nexecFileSync("bash", ["-c", ${JSON.stringify(dropShm(db))}]);\n`,
    );
    const shim = join(dir, "mu");
    writeFileSync(shim, muShim(cli), { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, EVAL_WORKER_DIR: dir, MU_DB_PATH: db };
    const key = "MU_AGENT_NAME";
    delete env[key];
    const r = spawnSync("bash", [shim, "sql", "x"], { env, encoding: "utf8" });
    expect(r.status).toBe(0);

    const [, before, after] = readFileSync(join(dir, "mu-local.log"), "utf8").trim().split("|");
    expect(ck(before)).toBe(want);
    expect(ck(after)).not.toBe(ck(before));
    // every machine-local table is listed; one the DB lacks hashes to ""
    expect(before?.split(",").filter(Boolean)).toHaveLength(LOCAL_TABLES.split(" ").length);
    expect(before).toContain("worktrees:,");
    // the shim's span holds mu's own call
    const [, s0, s1] = readFileSync(join(dir, "mu-shim.log"), "utf8").trim().split(" ").map(Number);
    const [s, e] = readFileSync(join(dir, "mu-calls.log"), "utf8").trim().split(" ").map(Number);
    expect(s0).toBeLessThanOrEqual(s ?? 0);
    expect(e).toBeLessThanOrEqual(s1 ?? 0);
    expect((s1 ?? 0) - (s0 ?? 0)).toBeLessThan(60_000);
  });

  it("an unchanged DB fingerprints the same before and after; a schema change shows", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-shim-fp-"));
    dirs.push(dir);
    const db = join(dir, "mu.db");
    sqlite(db, "PRAGMA journal_mode=WAL; CREATE TABLE agents(name TEXT);");
    const cli = join(dir, "cli.mjs");
    writeFileSync(
      cli,
      `if (process.argv[2] === "index") (await import("node:child_process")).execFileSync("sqlite3", [${JSON.stringify(db)}, "CREATE INDEX ai ON agents(name)"]);\n`,
    );
    const shim = join(dir, "mu");
    writeFileSync(shim, muShim(cli), { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, EVAL_WORKER_DIR: dir, MU_DB_PATH: db };
    const key = "MU_AGENT_NAME";
    delete env[key];
    expect(spawnSync("bash", [shim, "read"], { env }).status).toBe(0);
    expect(spawnSync("bash", [shim, "index"], { env }).status).toBe(0);
    const [read, index] = readFileSync(join(dir, "mu-local.log"), "utf8").trim().split("\n");
    const [, b1, a1] = read?.split("|") ?? [];
    const [, b2, a2] = index?.split("|") ?? [];
    expect(a1).toBe(b1);
    expect(b2).toBe(a1);
    expect(ck(a2)).not.toBe(ck(b2));
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
