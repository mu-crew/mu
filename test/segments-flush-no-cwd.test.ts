// A flush whose process cwd was deleted has no cwd to borrow and restore:
// it must still append by path inside the locked folder, not throw ENOENT.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { flushSegment, localMachineId, segmentPath } from "../src/segments.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

describe("flushSegment with a deleted cwd", () => {
  const home = process.cwd();
  let tempDir: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), "mu-seg-nocwd-"));
    fs.mkdirSync(join(tempDir, "sync"));
    db = openDb({ path: join(tempDir, "a.db") });
  });

  afterEach(() => {
    process.chdir(home);
    db.close();
    rmFixtureDir(tempDir);
  });

  it("appends the pending op into the locked folder", async () => {
    await withEnv("MU_STATE_DIR", join(tempDir, "state"), async () => {
      const dir = join(tempDir, "sync");
      ensureWorkstream(db, "demo");
      addTask(db, { workstream: "demo", localId: "one", title: "one", impact: 50, effortDays: 1 });
      await flushSegment(db, dir);
      const path = segmentPath(dir, localMachineId(db));
      const before = fs.readFileSync(path, "utf8").split("\n").filter(Boolean).length;
      addTask(db, { workstream: "demo", localId: "two", title: "two", impact: 50, effortDays: 1 });
      const gone = join(tempDir, "gone");
      fs.mkdirSync(gone);
      process.chdir(gone);
      fs.rmSync(gone, { recursive: true, force: true });
      expect(() => process.cwd()).toThrow();
      await flushSegment(db, dir);
      const after = fs.readFileSync(path, "utf8").split("\n").filter(Boolean).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
