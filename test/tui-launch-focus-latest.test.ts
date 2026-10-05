// Regression for f_tui_launch_focus_tiebreak_ignores_tasks: the
// launch-focus tie-break matched ops.key exactly, so task / note / edge
// ops (keyed "<ws>/<local_id>…") never counted as workstream activity.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { latestActiveWorkstream } from "../src/cli/tui-launch-focus.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

describe("latestActiveWorkstream", () => {
  it("counts task ops (key '<ws>/<id>') as workstream activity", () => {
    db = openDb({ path: join(mkdtempSync(join(tmpdir(), "mu-launch-latest-")), "mu.db") });
    ensureWorkstream(db, "alpha");
    ensureWorkstream(db, "beta");
    // alpha's only post-creation activity is task work.
    addTask(db, { workstream: "alpha", localId: "t1", title: "t", impact: 50, effortDays: 1 });
    expect(latestActiveWorkstream(db, ["alpha", "beta"])).toBe("alpha");
    addTask(db, { workstream: "beta", localId: "t1", title: "t", impact: 50, effortDays: 1 });
    expect(latestActiveWorkstream(db, ["alpha", "beta"])).toBe("beta");
  });

  it("does not let a prefix-sharing workstream ('alpha-2') count for 'alpha'", () => {
    db = openDb({ path: join(mkdtempSync(join(tmpdir(), "mu-launch-latest-")), "mu.db") });
    ensureWorkstream(db, "alpha");
    ensureWorkstream(db, "beta");
    ensureWorkstream(db, "alpha-2");
    addTask(db, { workstream: "alpha-2", localId: "t1", title: "t", impact: 50, effortDays: 1 });
    expect(latestActiveWorkstream(db, ["alpha", "beta"])).toBe("beta");
  });
});
