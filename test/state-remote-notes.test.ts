// listRemoteWorkers / findRemoteDispatch read REMOTE: / REMOTE_BASE:
// note lines. The SQL prefilter is case-sensitive (GLOB) because the
// line parsers are; this pins that the result is unchanged.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { findRemoteDispatch, listRemoteWorkers } from "../src/state.js";
import { addNote, addTask } from "../src/tasks.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-remote-notes-"));
  db = openDb({ path: join(dir, "mu.db") });
  addTask(db, { localId: "t1", workstream: "ws", title: "T", impact: 50, effortDays: 1 });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("REMOTE note prefilter", () => {
  it("finds REMOTE / REMOTE_BASE lines and ignores other casings and prose", () => {
    addNote(db, "t1", "remote: dev:~/lower\nRemote: dev:~/title", { workstream: "ws" });
    addNote(db, "t1", "prose that says REMOTE: then more words", { workstream: "ws" });
    addNote(db, "t1", "brief\nREMOTE: dev:~/ws/worker-1\nREMOTE_BASE: worker-1:abc123", {
      workstream: "ws",
    });

    expect(listRemoteWorkers(db, "ws")).toEqual([
      { taskName: "t1", host: "dev", path: "~/ws/worker-1" },
    ]);
    expect(findRemoteDispatch(db, "ws", "t1", "worker-1")).toEqual({
      taskName: "t1",
      host: "dev",
      path: "~/ws/worker-1",
      agentName: "worker-1",
      baseSha: "abc123",
    });
  });
});
