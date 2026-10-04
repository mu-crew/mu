// `mu workstream init` hints <project>-<purpose> for a bare name, and
// `mu state` hints one-per-effort for a large, mostly-closed workstream
// (docs/reference/naming.md § Workstream names).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask, closeTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-ws-naming-"));
  dbPath = join(tempDir, "mu.db");
  setTmuxExecutor(async (args) => {
    if (args[0] === "has-session") return { exitCode: 1, stdout: "", stderr: "no session" };
    if (args[0] === "list-sessions") return { exitCode: 1, stdout: "", stderr: "no server" };
    return { exitCode: 0, stdout: "", stderr: "" };
  });
});

afterEach(() => {
  resetTmuxExecutor();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("workstream init naming hint", () => {
  it("a name without '-' gets a <project>-<purpose> hint, in text and --json", async () => {
    const text = await runCli(["workstream", "init", "auth"], dbPath);
    expect(text.stdout).toMatch(/hint: name workstreams <project>-<purpose> \(e\.g\. .+-auth\)/);
    const json = JSON.parse(
      (await runCli(["workstream", "init", "billing", "--json"], dbPath)).stdout,
    ) as {
      hint?: string;
    };
    expect(json.hint).toContain("<project>-<purpose>");
  });

  it("a <project>-<purpose> name gets no hint", async () => {
    const r = await runCli(["workstream", "init", "hail-auth"], dbPath);
    expect(r.stdout).not.toContain("hint:");
    const json = JSON.parse(
      (await runCli(["workstream", "init", "hail-db", "--json"], dbPath)).stdout,
    ) as {
      hint?: string;
    };
    expect(json.hint).toBeUndefined();
  });
});

describe("mu state one-per-effort hint", () => {
  function seed(total: number, open: number): void {
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "big-ws");
    for (let i = 0; i < total; i++) {
      addTask(db, {
        localId: `t${i}`,
        workstream: "big-ws",
        title: `t${i}`,
        impact: 10,
        effortDays: 1,
      });
      if (i >= open) closeTask(db, `t${i}`, { workstream: "big-ws" });
    }
    db.close();
  }

  it("hints past 300 tasks with under 10% open", async () => {
    seed(310, 5);
    const r = await runCli(["state", "-w", "big-ws"], dbPath);
    expect(r.stdout).toContain("hint: 310 tasks, 5 open");
  });

  it("stays quiet when much of the workstream is still open", async () => {
    seed(310, 100);
    const r = await runCli(["state", "-w", "big-ws"], dbPath);
    expect(r.stdout).not.toContain("tasks, 100 open");
  });
});
