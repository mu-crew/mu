// CLI smoke test for the typed `TaskIdInvalidError`.
//
// Surfaced by nit_invalid_id_typeerror: `mu task add Bad-ID ...`
// previously fell through to the generic exit-1 catch-all because
// addTask threw a bare `TypeError`. The fix replaces it with a
// `TaskIdInvalidError implements HasNextSteps` and adds it to the
// classifyError() exit-code map (exit 2 = usage, like every typed
// *Invalid* error; the verb's --help is printed too).
//
// This test pins the outward contract (exit code + JSON shape +
// nextSteps); the unit-level coverage of the error class lives in
// test/tasks.test.ts and test/error-nextsteps.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

describe("mu task add — invalid id ergonomics", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-bad-id-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("invalid id exits 4 (not 1) with a typed JSON error envelope", async () => {
    // runCli() now mirrors argv onto process.argv internally so
    // isJsonMode() (which reads process.argv directly) works in tests.
    // No per-test argv shim required.
    const argv = [
      "--json",
      "task",
      "add",
      "Bad ID",
      "-w",
      "test",
      "-t",
      "Anything",
      "-i",
      "50",
      "-e",
      "1",
    ];
    const { doc, stderr, exitCode, error } = await runCliJson(argv, dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBe(2);
    // The failure is ONE document on STDOUT (stderr stays empty).
    expect(stderr).toBe("");
    const envelope = doc as unknown as {
      error: string;
      message: string;
      exit: number;
      usage: string[];
    };
    expect(envelope.error).toBe("TaskIdInvalidError");
    expect(envelope.exit).toBe(2);
    expect(envelope.message).toMatch(/invalid task id/);
    // A usage-class error carries the verb's accepted syntax.
    expect(envelope.usage[0]).toContain("mu task add");
  });

  it("DB has no row after a rejected add (validation runs before INSERT)", async () => {
    await runCli(["task", "add", "Bad ID", "-w", "test", "-t", "x", "-i", "50", "-e", "1"], dbPath);
    const db = openDb({ path: dbPath });
    const row = db.prepare("SELECT 1 FROM tasks").get();
    db.close();
    expect(row).toBeUndefined();
  });
});
