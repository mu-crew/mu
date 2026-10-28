// `mu next` prints ONE JSON document for every outcome, with no --json:
// parse-time and handler failures included (isJsonMode in src/output.ts).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { isJsonMode } from "../src/output.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliWire } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-next-json-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  mux = installMux("tmux", [["list-panes", ""]]);
});
afterEach(() => {
  mux.restore();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

describe("mu next failures are one JSON document without --json", () => {
  it.each([
    ["unknown flag", ["next", "-w", "a", "--bogus"], 2, "CommanderError"],
    ["no scope", ["next"], 2, "UsageError"],
    ["unknown workstream", ["next", "-w", "nope"], 3, "WorkstreamNotFoundError"],
  ])("%s: failure envelope on stdout, exit %i", async (_n, argv, exit, error) => {
    const r = await runCliWire(argv, dbPath);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error, exit });
    expect(r.exitCode).toBe(exit);
  });

  it("only the verb counts: a workstream named next, or `me next`, does not", () => {
    const saved = process.argv;
    try {
      process.argv = ["node", "mu", "-w", "x", "next", "--dry"];
      expect(isJsonMode()).toBe(true);
      process.argv = ["node", "mu", "-w", "next", "task", "list"];
      expect(isJsonMode()).toBe(false);
      process.argv = ["node", "mu", "me", "next"];
      expect(isJsonMode()).toBe(false);
    } finally {
      process.argv = saved;
    }
  });
});
