// Tests for cmdState's dispatch: one JSON document (with or without --json),
// scope errors as the JSON failure document. The removed card/TUI options stay
// unknown options. The document's contract is test/state-output-contract.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalNoColor = vi.hoisted(() => process.env.NO_COLOR);

vi.hoisted(() => {
  process.env.NO_COLOR = "1";
});

afterAll(() => {
  if (originalNoColor === undefined) {
    const key = "NO_COLOR";
    delete process.env[key];
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});

import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { withEnv } from "./_env.js";
import { runCli, runCliJson } from "./_runCli.js";

describe("cmdState dispatch", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-dispatch-"));
    dbPath = join(tempDir, "mu.db");
    setTmuxExecutor(async (args) => {
      if (args[0] === "list-sessions") {
        return { exitCode: 1, stdout: "", stderr: "no server running" };
      }
      if (args[0] === "has-session") return { exitCode: 1, stdout: "", stderr: "no session" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await runCli(["workstream", "init", "ws"], dbPath);
    await runCli(
      [
        "task",
        "add",
        "-w",
        "ws",
        "--title",
        "hello",
        "--impact",
        "50",
        "--effort-days",
        "1",
        "--",
        "hello",
      ],
      dbPath,
    );
  });

  afterEach(() => {
    resetTmuxExecutor();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("prints the JSON document with or without --json, and one document for several workstreams", async () => {
    const bare = await runCliJson(["state", "-w", "ws"], dbPath);
    const flagged = await runCliJson(["state", "-w", "ws", "--json"], dbPath);
    expect(bare.exitCode).toBeNull();
    expect(bare.stdout).toBe(flagged.stdout);
    expect(bare.data.workstreams.map((w: { workstream: string }) => w.workstream)).toEqual(["ws"]);
    await runCli(["workstream", "init", "ws2"], dbPath);
    const multi = await runCliJson(["state", "-w", "ws,ws2"], dbPath);
    expect(multi.exitCode).toBeNull();
    expect(multi.data.workstreams.map((w: { workstream: string }) => w.workstream)).toEqual([
      "ws",
      "ws2",
    ]);
  });

  it("--tui option no longer exists", async () => {
    const { doc, exitCode } = await runCliJson(["state", "--tui", "-w", "ws"], dbPath);
    expect(exitCode).toBe(2);
    expect(String(doc.message).toLowerCase()).toContain("unknown option");
    expect(String(doc.message)).toContain("--tui");
  });

  it("--mission option no longer exists", async () => {
    const { doc, exitCode } = await runCliJson(["state", "--mission", "-w", "ws"], dbPath);
    expect(exitCode).toBe(2);
    expect(String(doc.message).toLowerCase()).toContain("unknown option");
    expect(String(doc.message)).toContain("--mission");
  });

  it("--hud option no longer exists (removed in this refactor)", async () => {
    // --hud is silently ignored by commander as an unknown option in
    // some configurations; the strict commander config in mu errors
    // it out as an unknown option. Either way the legacy --hud
    // muscle-memory call should NOT produce HUD output.
    const { exitCode } = await runCli(["state", "--hud", "-w", "ws"], dbPath);
    // commander rejects unknown options with exit 1 (commander) or
    // 2 (mu's UsageError). Both indicate "this option is gone".
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
  });
});

describe("cmdState empty-workstream paths", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-empty-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Skipping the --all-on-truly-empty test: listWorkstreams() unions
  // DB rows with tmux sessions on the host, so 'truly empty' isn't
  // reproducible from a vitest harness when the dev machine has any
  // mu-* tmux session live (the orchestrator's own sessions count).
  // The path itself is exercised manually via
  //     MU_DB_PATH=/tmp/empty.db mu state --all
  // when no mu-* tmux sessions exist.

  it("bare `mu state` with workstreams on the machine is a one-line error naming -w and --all, exit 2", async () => {
    await runCli(["workstream", "init", "alpha"], dbPath);
    await runCli(["workstream", "init", "beta"], dbPath);
    // A decoy $MU_SESSION must not auto-resolve into one of them.
    await withEnv("MU_SESSION", "alpha", async () => {
      const { doc, stdout, stderr, exitCode } = await runCliJson(["state"], dbPath);
      expect(exitCode).toBe(2);
      expect(stderr).toBe("");
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(doc.ok).toBe(false);
      expect(String(doc.message)).toMatch(/no workstream: pass -w <name> or --all/);
      expect(String(doc.message)).toContain("-w alpha");
    });
  });

  it("`mu state --json` with no scope is the same error, not an empty success", async () => {
    await runCli(["workstream", "init", "alpha"], dbPath);
    await withEnv("MU_SESSION", "alpha", async () => {
      const { doc, data, exitCode } = await runCliJson(["state", "--json"], dbPath);
      expect(exitCode).toBe(2);
      expect(doc.ok).toBe(false);
      expect(data).toBeUndefined();
      expect(String(doc.message)).toMatch(/no workstream: pass -w <name> or --all/);
    });
  });
});
