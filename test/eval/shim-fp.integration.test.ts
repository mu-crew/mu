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
import { muShim } from "../../tools/eval/sandbox.ts";

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

describe("muShim fp()", () => {
  it("dumps a WAL-mode DB whose -shm file is gone, so a raw write shows as changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-shim-fp-"));
    dirs.push(dir);
    const db = join(dir, "mu.db");
    sqlite(
      db,
      "PRAGMA journal_mode=WAL; CREATE TABLE agents(name TEXT); INSERT INTO agents VALUES('a');",
    );
    // The expected dump, from a copy so the DB under test keeps no -shm.
    const ref = join(dir, "ref.db");
    execFileSync("bash", ["-c", dropShm(db)]);
    copyFileSync(db, ref);
    const want = execFileSync("bash", ["-c", `sqlite3 '${ref}' '.dump agents' | cksum`], {
      encoding: "utf8",
    }).split(" ")[0];
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
    const ck = (fp: string | undefined): string | undefined =>
      fp
        ?.split(",")
        .find((kv) => kv.startsWith("agents:"))
        ?.slice("agents:".length);
    expect(ck(before)).toBe(want);
    expect(ck(after)).not.toBe(ck(before));
  });
});
