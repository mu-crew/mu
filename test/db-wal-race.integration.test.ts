// openDb from several processes at once on a fresh file: switching to
// WAL needs an exclusive lock, and SQLite can return SQLITE_BUSY for it
// without consulting busy_timeout, so a loser died with "database is
// locked" (seen as spawn-parallel-race dropping an agent).

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileP = promisify(execFile);
const INDEX = join(process.cwd(), "dist", "index.js");
const describeIfBuilt = existsSync(INDEX) ? describe : describe.skip;

describeIfBuilt("openDb on a fresh file from parallel processes", () => {
  it("every process opens it (no SQLITE_BUSY from the WAL switch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-walrace-"));
    try {
      const script = join(dir, "open.mjs");
      writeFileSync(
        script,
        `import { openDb } from ${JSON.stringify(INDEX)};\nopenDb({ path: process.argv[2] }).close();\n`,
      );
      const failures: string[] = [];
      for (let round = 0; round < 25; round++) {
        const db = join(dir, `r${round}.db`);
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, () => execFileP("node", [script, db])),
        );
        for (const r of results)
          if (r.status === "rejected") failures.push(String((r.reason as Error).message));
      }
      expect(failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
