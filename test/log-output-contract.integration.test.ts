// A printed `mu log` hint is a shell command: run it as printed through a real
// shell against the built CLI. The in-process contract lives in
// log-output-contract.test.ts.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendLog } from "../src/logs.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

const dist = join(process.cwd(), "dist", "cli.js");
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-logout-sh-"));
  dbPath = join(dir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "demo");
  appendLog(db, { workstream: "demo", source: "user", kind: "message", payload: "y".repeat(900) });
  db.close();
});

afterEach(() => rmFixtureDir(dir));

describe.skipIf(!existsSync(dist))("printed hints run through a real shell", () => {
  it("the cut payload's `next=` hint returns it whole", async () => {
    const r = await runCli(["log", "-w", "demo", "-n", "1"], dbPath);
    const next = /next=(mu log --seq \d+)/.exec(r.stdout)?.[1] ?? "";
    expect(next).not.toBe("");
    const out = execFileSync("sh", ["-c", `mu() { node "${dist}" "$@"; }; ${next} --json`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: dir, MU_DB_PATH: dbPath, MU_SYNC_DIR: "" },
    });
    const rows = JSON.parse(out) as { data: { items: { payload: string }[] } };
    expect(rows.data.items[0]?.payload).toBe("y".repeat(900));
  });
});
