// R4: one workstream-resolution rule. An unknown -w is WorkstreamNotFoundError (exit 3) on every
// verb, with a did-you-mean and the `workstream init` fix; it is never an empty success, and
// `task add` never mints a typo'd workstream. A task id under the wrong (existing) -w names
// the real workstream (rr_r4_unknown_ws_reads_silent, rr_r4_ws_mismatch_before_resolve).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

describe("an unknown -w", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-unknown-ws-"));
    dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    for (const ws of ["r4ws", "other"]) ensureWorkstream(db, ws);
    addTask(db, { localId: "a1", workstream: "r4ws", title: "a", impact: 10, effortDays: 1 });
    db.close();
  });

  afterEach(() => rmFixtureDir(dir));

  const wsNames = (): string[] => {
    const db = openDb({ path: dbPath });
    try {
      return (
        db.prepare("SELECT name FROM workstreams ORDER BY name").all() as { name: string }[]
      ).map((r) => r.name);
    } finally {
      db.close();
    }
  };

  const reads: [string, string[]][] = [
    ["task list", ["task", "list"]],
    ["task next", ["task", "next"]],
    ["task owned-by", ["task", "owned-by", "w1"]],
    ["agent list", ["agent", "list"]],
    ["log read", ["log"]],
    ["log write", ["log", "hello"]],
    ["human-needed", ["human-needed", "why"]],
  ];

  it.each(reads)(
    "%s -w <typo> exits 3 and names the near workstream and the fix",
    async (_n, argv) => {
      for (const json of [false, true]) {
        const r = await runCli([...argv, "-w", "r4w", ...(json ? ["--json"] : [])], dbPath);
        expect(r.error).toBeUndefined();
        expect(r.exitCode).toBe(3);
        expect(r.stdout + r.stderr).toMatch(/no such workstream: r4w/);
        expect(r.stdout + r.stderr).toMatch(/did you mean r4ws\?/);
        expect(r.stdout + r.stderr).toMatch(/mu workstream init r4w/);
      }
      expect(wsNames()).toEqual(["other", "r4ws"]);
    },
  );

  it("task add -w <typo> refuses and creates nothing; the reserved scratch still auto-creates", async () => {
    const bad = await runCli(["task", "add", "q", "-t", "q", "-w", "nows"], dbPath);
    expect(bad.exitCode).toBe(3);
    expect(bad.stderr).toMatch(/no such workstream: nows.*mu workstream init nows/);
    expect(wsNames()).toEqual(["other", "r4ws"]);

    const ok = await runCli(["task", "add", "q", "-t", "q", "-w", "scratch"], dbPath);
    expect(ok.exitCode).toBeNull();
    expect(wsNames()).toContain("scratch");
  });

  it("a name no workstream can have gets no init fix", async () => {
    const r = await runCli(["task", "list", "-w", "Bad.Name"], dbPath);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toMatch(/no such workstream: Bad\.Name/);
    expect(r.stderr).not.toMatch(/workstream init/);
  });

  it("a task verb with an unknown -w is exit 3, not a task-scope conflict", async () => {
    for (const argv of [
      ["task", "show", "a1", "-w", "nows"],
      ["task", "show", "a1", "-w", "Bad.Name"],
      ["task", "note", "a1", "n", "-w", "nows"],
    ]) {
      const r = await runCli(argv, dbPath);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toMatch(/no such workstream/);
      expect(r.stderr).not.toMatch(/conflict/);
    }
  });

  it("a task id under another existing -w names the task's real workstream", async () => {
    const r = await runCli(["task", "show", "a1", "-w", "other"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/task a1 is in workstream r4ws, not other; pass -w r4ws/);
  });
});
