// The root `-w` must reach the verb. It used to be variadic, so
// `mu -w ws task list` parsed `task` and `list` as more workstream
// names and printed root help with exit 0 (f_cli_root_w_variadic), and
// verbs reading `this.opts()` dropped `--workstream=X` entirely
// (f_wsstate_root_w_ignored).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

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

  const names = (data: unknown): string[] =>
    (data as { items: { id: string }[] }).items.map((t) => t.id);

  it("`mu -w wsa task list` lists wsa's tasks, same as the verb-position form", async () => {
    const root = await runCliJson(["-w", "wsa", "task", "list", "--json"], dbPath);
    expect(root.error).toBeUndefined();
    expect(root.exitCode).toBeNull();
    expect(names(root.data)).toEqual(["t-wsa"]);

    const verb = await runCliJson(["task", "list", "-w", "wsa", "--json"], dbPath);
    expect(root.stdout).toBe(verb.stdout);
  });

  it("forwards to a variadic verb -w (state) with every name", async () => {
    const r = await runCliJson(["-w", "wsa", "-w", "wsb", "state", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("wsa");
    expect(r.stdout).toContain("wsb");
  });

  it("rejects two workstreams for a single-workstream verb (exit 2)", async () => {
    const r = await runCli(["-w", "wsa,wsb", "task", "list"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/single workstream here/);
    // One line, no help dump: the message names the fix.
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("rejects a root -w on a verb that takes none, instead of ignoring it", async () => {
    // Whole-DB maintenance is never scoped; only `db query` takes -w.
    const r = await runCli(["-w", "wsa", "db", "compact"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/takes no -w/);
  });

  it("scopes db query's views by a root -w, and mu sql is the same verb", async () => {
    for (const verb of [["db", "query"], ["sql"]]) {
      const r = await runCliJson(["-w", "wsa", ...verb, "SELECT local_id FROM ready"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.data).toEqual({ items: [{ local_id: "t-wsa" }], count: 1, more: 0 });
    }
  });

  // triage_vdb_db_w_swallowed: `mu db -w a query` used to bind -w to the
  // namespace and run the query on the global views, silently.
  it("honours -w placed on the db namespace, or refuses a second, different one", async () => {
    const r = await runCliJson(["db", "-w", "wsa", "query", "SELECT local_id FROM ready"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.data).toEqual({ items: [{ local_id: "t-wsa" }], count: 1, more: 0 });
    const both = await runCli(
      ["db", "-w", "wsa", "query", "SELECT 1", "-w", "wsb", "--table"],
      dbPath,
    );
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toMatch(/given twice/);
    expect(both.stderr.trim().split("\n")).toHaveLength(1);
    const compact = await runCli(["db", "-w", "wsa", "compact"], dbPath);
    expect(compact.exitCode).toBe(2);
    expect(compact.stderr).toMatch(/takes no -w/);
  });

  // f_wsstate_root_w_ignored: teardown and state read `this.opts()`, so a
  // root `--workstream=X` used to vanish and $MU_SESSION picked the
  // target. A destructive verb then tore down the WRONG workstream.
  it("teardown honours root --workstream over $MU_SESSION", async () => {
    await withEnv("MU_SESSION", "wsa", async () => {
      const mux = installMux("tmux", [
        ["list-panes", { stdout: "", stderr: "can't find session", exitCode: 1 }],
      ]);
      try {
        const preview = await runCliJson(
          ["--workstream=wsb", "workstream", "teardown", "--json"],
          dbPath,
        );
        expect(preview.data).toMatchObject({ workstreamName: "wsb", dryRun: true });
        const { revision } = preview.data as { revision: number };
        const r = await runCliJson(
          ["--workstream=wsb", "workstream", "teardown", "--if", String(revision), "--json"],
          dbPath,
        );
        expect(r.error).toBeUndefined();
        expect(r.data).toMatchObject({ workstreamName: "wsb", tornDown: true });
      } finally {
        mux.restore();
      }
    });
    const db = openDb({ path: dbPath });
    const left = db
      .prepare("SELECT name FROM workstreams WHERE torn_down_at IS NULL ORDER BY name")
      .all() as {
      name: string;
    }[];
    db.close();
    expect(left.map((r) => r.name)).toEqual(["wsa"]);
  });

  it("teardown: root -w and a disagreeing positional is a usage error", async () => {
    const r = await runCli(["-w", "wsa", "workstream", "teardown", "wsb", "--if", "1"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/given twice/);
  });

  it("a decoy $MU_SESSION never scopes a root-less verb", async () => {
    await withEnv("MU_SESSION", "wsa", async () => {
      const r = await runCliJson(["task", "list", "--json"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.doc.ok).toBe(false);
      expect(r.doc).not.toHaveProperty("data");
    });
  });

  it("state honours root --workstream over $MU_SESSION", async () => {
    await withEnv("MU_SESSION", "wsa", async () => {
      const r = await runCliJson(["--workstream=nonexist", "state", "--json"], dbPath);
      expect(r.exitCode).toBe(3);
      expect(r.doc.message).toMatch(/no such workstream: nonexist/);
    });
  });

  it("rejects a padded or blank root -w as a usage error, not a trimmed workstream", async () => {
    for (const bad of [" wsa", "wsa ", "", " "]) {
      const r = await runCli(["-w", bad, "task", "list"], dbPath);
      expect(r.exitCode, JSON.stringify(bad)).toBe(2);
      expect(r.stdout).toBe("");
    }
  });

  it("rejects -w on both sides of the verb", async () => {
    const r = await runCli(["-w", "wsa", "task", "list", "-w", "wsb"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/both before and after/);
  });
});

// A root `-w` must reach every verb's `optsWithGlobals()` as the verb's own
// shape (a string, or the list for a variadic -w), never the root's raw
// array: `mu -w auth delegates tally` died 'value.trim is not a function'.
describe("root -w as seen through optsWithGlobals, for every verb with -w", () => {
  const STOP = new Error("stop before the action");

  const leaves = (cmd: Command, path: string[] = []): { path: string[]; cmd: Command }[] =>
    cmd.commands.length === 0
      ? [{ path, cmd }]
      : cmd.commands.flatMap((c) => leaves(c, [...path, c.name()]));

  const probe = buildProgram();
  const withW = leaves(probe).filter((l) =>
    l.cmd.options.some((o) => o.attributeName() === "workstream"),
  );

  it("covers the verbs", () => {
    expect(withW.length).toBeGreaterThan(30);
    expect(withW.map((l) => l.path.join(" "))).toContain("delegates tally");
    expect(withW.map((l) => l.path.join(" "))).toContain("delegates register");
  });

  it.each(withW.map((l) => [l.path.join(" "), l.path] as const))(
    "mu -w ws %s",
    async (_n, path) => {
      const program = buildProgram();
      let seen: unknown = "never reached";
      program.hook("preAction", (_root, leaf) => {
        seen = leaf.optsWithGlobals().workstream;
        throw STOP;
      });
      const leaf = path.reduce<Command>(
        (c, n) => c.commands.find((x) => x.name() === n) as Command,
        program,
      );
      const argv = [
        ...leaf.registeredArguments.filter((a) => a.required).map(() => "x"),
        ...leaf.options.filter((o) => o.mandatory).flatMap((o) => [o.long as string, "x"]),
      ];
      const variadic = leaf.options.find((o) => o.attributeName() === "workstream")?.variadic;
      await program.parseAsync(["-w", "ws", ...path, ...argv], { from: "user" }).catch((e) => {
        if (e !== STOP) throw e;
      });
      expect(seen).toEqual(variadic ? ["ws"] : "ws");
    },
  );
});
