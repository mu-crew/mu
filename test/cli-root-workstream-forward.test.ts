// The root `-w` must reach the verb. It used to be variadic, so
// `mu -w ws task list` parsed `task` and `list` as more workstream
// names and printed root help with exit 0 (f_cli_root_w_variadic), and
// verbs reading `this.opts()` dropped `--workstream=X` entirely
// (f_wsstate_root_w_ignored).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux } from "./_mux.js";
import { runCli } from "./_runCli.js";

describe("root-position -w forwards to the verb's -w", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-root-w-fwd-"));
    dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    for (const ws of ["wsa", "wsb"]) {
      ensureWorkstream(db, ws);
      addTask(db, { localId: `t-${ws}`, workstream: ws, title: ws, impact: 10, effortDays: 1 });
    }
    db.close();
  });

  afterEach(() => rmFixtureDir(dir));

  const names = (stdout: string): string[] =>
    (JSON.parse(stdout) as { items: { name: string }[] }).items.map((t) => t.name);

  it("`mu -w wsa task list` lists wsa's tasks, same as the verb-position form", async () => {
    const root = await runCli(["-w", "wsa", "task", "list", "--json"], dbPath);
    expect(root.error).toBeUndefined();
    expect(root.exitCode).toBeNull();
    expect(names(root.stdout)).toEqual(["t-wsa"]);

    const verb = await runCli(["task", "list", "-w", "wsa", "--json"], dbPath);
    expect(root.stdout).toBe(verb.stdout);
  });

  it("forwards to a variadic verb -w (state) with every name", async () => {
    const r = await runCli(["-w", "wsa", "-w", "wsb", "state", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("wsa");
    expect(r.stdout).toContain("wsb");
  });

  it("rejects two workstreams for a single-workstream verb (exit 2)", async () => {
    const r = await runCli(["-w", "wsa,wsb", "task", "list"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/single workstream here/);
    // Usage is the verb's, not the root's.
    expect(r.stderr).toContain("Usage: mu task list");
  });

  it("rejects a root -w on a verb that takes none, instead of ignoring it", async () => {
    const r = await runCli(["-w", "wsa", "sql", "SELECT 1"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/takes no -w/);
  });

  // f_wsstate_root_w_ignored: teardown and state read `this.opts()`, so a
  // root `--workstream=X` used to vanish and $MU_SESSION picked the
  // target. A destructive verb then tore down the WRONG workstream.
  it("teardown honours root --workstream over $MU_SESSION", async () => {
    await withEnv("MU_SESSION", "wsa", async () => {
      const mux = installMux("tmux", [
        ["has-session", { stdout: "", stderr: "can't find session", exitCode: 1 }],
      ]);
      try {
        const r = await runCli(
          ["--workstream=wsb", "workstream", "teardown", "--yes", "--json"],
          dbPath,
        );
        expect(r.error).toBeUndefined();
        expect(JSON.parse(r.stdout)).toMatchObject({ workstreamName: "wsb", tornDown: true });
      } finally {
        mux.restore();
      }
    });
    const db = openDb({ path: dbPath });
    const left = db.prepare("SELECT name FROM workstreams ORDER BY name").all() as {
      name: string;
    }[];
    db.close();
    expect(left.map((r) => r.name)).toEqual(["wsa"]);
  });

  it("teardown: root -w and a disagreeing positional is a usage error", async () => {
    const r = await runCli(["-w", "wsa", "workstream", "teardown", "wsb", "--yes"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/given twice/);
  });

  it("state honours root --workstream over $MU_SESSION", async () => {
    await withEnv("MU_SESSION", "wsa", async () => {
      const r = await runCli(["--workstream=nonexist", "state", "--json"], dbPath);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toMatch(/no such workstream: nonexist/);
    });
  });

  it("rejects -w on both sides of the verb", async () => {
    const r = await runCli(["-w", "wsa", "task", "list", "-w", "wsb"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/both before and after/);
  });
});
