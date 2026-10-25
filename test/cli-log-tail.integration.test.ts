// `mu log --tail` as a real process: NDJSON only, rows flushed before an
// interrupt, and the conventional exit code for the signal. Needs `dist/`
// (`npm run build`), like test/spawn-parallel-race.integration.test.ts.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendLog, latestSeq } from "../src/logs.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let dbPath: string;
let db: Db;
let child: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-logtail-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "demo");
});

afterEach(() => {
  try {
    child?.kill("SIGKILL");
  } catch {}
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

function startTail(): {
  lines: string[];
  exited: Promise<{ code: number | null; signal: string | null }>;
} {
  const lines: string[] = [];
  child = spawn(
    process.execPath,
    ["dist/cli.js", "log", "-w", "demo", "--tail", "--since", String(latestSeq(db))],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        MU_DB_PATH: dbPath,
        MU_SYNC_DIR: "",
        MU_LOG_TAIL_INTERVAL_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let buf = "";
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    lines.push(...parts);
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child?.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { lines, exited };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
  expect(cond()).toBe(true);
}

describe("mu log --tail (process)", () => {
  it("streams NDJSON rows with no header, and SIGINT ends it with 130 after the rows are out", async () => {
    const { lines, exited } = startTail();
    appendLog(db, { workstream: "demo", source: "user", payload: "one" });
    appendLog(db, { workstream: "demo", source: "user", payload: "two" });
    await until(() => lines.length >= 2);
    child?.kill("SIGINT");
    const { code } = await exited;
    expect(code).toBe(130);
    expect(lines.map((l) => (JSON.parse(l) as { payload: string }).payload)).toEqual([
      "one",
      "two",
    ]);
  }, 20_000);

  it("SIGTERM ends it with 143", async () => {
    const { lines, exited } = startTail();
    appendLog(db, { workstream: "demo", source: "user", payload: "up" });
    await until(() => lines.length >= 1); // the handlers are installed once it has polled
    child?.kill("SIGTERM");
    expect((await exited).code).toBe(143);
  }, 20_000);
});
