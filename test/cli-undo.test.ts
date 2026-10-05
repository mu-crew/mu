// `mu undo --yes` human output (src/cli/undo.ts). The SDK side lives in
// test/undo.test.ts; this file guards what the CLI claims happened.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdUndo } from "../src/cli/undo.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { listRecentGroups } from "../src/undo.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

describe("mu undo --yes output", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-cli-undo-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      db.close();
    } catch {
      // best effort
    }
    rmFixtureDir(tempDir);
  });

  async function captureUndo(group: string): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    await cmdUndo(db, group, { yes: true });
    vi.restoreAllMocks();
    return lines.join("\n");
  }

  it("a repeated no-op undo does not claim it undid the group", async () => {
    await ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: "a", title: "A", impact: 50, effortDays: 1 });
    const add = listRecentGroups(db, 10).find((g) => g.intents.includes("task.add"));
    expect(add).toBeDefined();
    if (add === undefined) return;

    const first = await captureUndo(add.groupId);
    expect(first).toContain("Undid ");

    const second = await captureUndo(add.groupId);
    expect(second).not.toContain("Undid ");
    expect(second).toContain("nothing changed");
  });
});
