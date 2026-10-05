// `mu workstream teardown --empty` must never kill an unregistered
// `mu-*` session. It is only "empty" from THIS DB's point of view: a
// run against a throwaway MU_DB_PATH sees every real workstream as
// unregistered, and the old sweep killed a live crew's agent panes
// that way (f_orch_empty_sweep_live). A shell-only pane check was not
// enough: a `bash -c` loop reports `bash` (g_fix_teardown_busy_shell).
// Also covers the sweep's undo hint (f_wsstate_empty_undo_hint).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  ensureWorkstream,
  listEmptyWorkstreams,
  listUnregisteredMuxWorkstreams,
} from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

/** Sessions → the foreground command of each of their panes. */
type Sessions = Record<string, string[]>;

function tmuxFake(sessions: Sessions, killed: string[]) {
  return async (args: readonly string[]) => {
    const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
    const missing = (t: string) => ({
      stdout: "",
      stderr: `can't find session: ${t}`,
      exitCode: 1,
    });
    const target = args[args.indexOf("-t") + 1] ?? "";
    switch (args[0]) {
      case "list-sessions":
        return ok(Object.keys(sessions).join("\n"));
      case "has-session":
        return target in sessions ? ok() : missing(target);
      case "list-panes": {
        const panes = sessions[target];
        if (panes === undefined) return missing(target);
        return ok(panes.map((cmd, i) => `@1\t%${i}\t\t${cmd}`).join("\n"));
      }
      case "kill-session":
        if (!(target in sessions)) return missing(target);
        delete sessions[target];
        killed.push(target);
        return ok();
      default:
        return { stdout: "", stderr: `unmocked: ${args.join(" ")}`, exitCode: 1 };
    }
  };
}

describe("teardown --empty: live-pane guard and undo hint", () => {
  let dir: string;
  let dbPath: string;
  let db: Db;
  let mux: MuxHarness | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-teardown-empty-live-"));
    dbPath = join(dir, "mu.db");
    db = openDb({ path: dbPath });
    process.env.MU_STATE_DIR = dir;
  });

  afterEach(() => {
    mux?.restore();
    try {
      db.close();
    } catch {
      // already closed
    }
    const key = "MU_STATE_DIR";
    delete process.env[key];
    rmFixtureDir(dir);
  });

  it("never sweeps an unregistered mu-* session, even when every pane reports a shell", async () => {
    // `bash` is what tmux reports for `bash -c "while :; do :; done"`
    // too (g_fix_teardown_busy_shell), so a shell name is no proof of
    // idleness. Unregistered sessions are left to explicit teardown.
    const killed: string[] = [];
    const sessions: Sessions = {
      "mu-busy-shell": ["bash"],
      "mu-livecrew": ["zsh", "node", "pi"],
      "mu-litter": ["zsh", "-bash"],
    };
    mux = installMux("tmux", tmuxFake(sessions, killed));
    ensureWorkstream(db, "bare");

    expect((await listEmptyWorkstreams(db)).map((w) => w.name)).toEqual(["bare"]);
    expect(await listUnregisteredMuxWorkstreams(db)).toEqual(["busy-shell", "litter", "livecrew"]);

    db.close();
    const dry = await runCli(["workstream", "teardown", "--empty", "--json"], dbPath);
    expect(dry.error).toBeUndefined();
    expect(
      (JSON.parse(dry.stdout) as { items: { name: string }[] }).items.map((w) => w.name),
    ).toEqual(["bare"]);

    const r = await runCli(["workstream", "teardown", "--empty", "--yes", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.stdout)).toMatchObject({ tornDown: 1, failed: [] });
    expect(killed).toEqual([]);
    expect(Object.keys(sessions).sort()).toEqual(["mu-busy-shell", "mu-litter", "mu-livecrew"]);
  });

  it("names the skipped unregistered sessions and how to tear one down", async () => {
    mux = installMux("tmux", tmuxFake({ "mu-busy-shell": ["bash"] }, []));
    db.close();
    for (const args of [
      ["workstream", "teardown", "--empty"],
      ["workstream", "teardown", "--empty", "--yes"],
    ]) {
      const r = await runCli(args, dbPath);
      expect(r.error).toBeUndefined();
      expect(r.stdout).toContain("no empty workstreams found");
      expect(r.stdout).toMatch(/Skipped 1 mu-\* session .*: busy-shell/);
      expect(r.stdout).toContain("mu workstream teardown busy-shell --yes");
    }
  });

  it("keeps an unregistered herdr workspace", async () => {
    const workspaces = JSON.stringify({
      result: {
        type: "workspace_list",
        workspaces: [{ label: "mu-livecrew", workspace_id: "w1", tab_count: 1, pane_count: 1 }],
      },
    });
    const panes = JSON.stringify({
      result: {
        type: "pane_list",
        panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }],
      },
    });
    mux = installMux("herdr", [
      ["workspace list", workspaces],
      ["pane list", panes],
    ]);
    expect(await listEmptyWorkstreams(db)).toEqual([]);
  });

  it("still sweeps a registered-empty workstream regardless of panes", async () => {
    ensureWorkstream(db, "bare");
    mux = installMux("tmux", tmuxFake({ "mu-bare": ["pi"] }, []));
    expect((await listEmptyWorkstreams(db)).map((w) => w.name)).toEqual(["bare"]);
  });

  it("the sweep's undo hint points at per-workstream groups, not a bare `mu undo --yes`", async () => {
    ensureWorkstream(db, "e1");
    ensureWorkstream(db, "e2");
    db.close();
    mux = installMux("tmux", tmuxFake({}, []));

    const r = await runCli(["workstream", "teardown", "--empty", "--yes"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("tornDown=2");
    expect(r.stdout).not.toContain("snapshot");
    expect(r.stdout).not.toMatch(/mu undo --yes/);
    expect(r.stdout).toContain("mu workstream list --torn-down");

    // Each teardown is its own group: that is why the hint lists them.
    const list = await runCli(["workstream", "list", "--torn-down", "--json"], dbPath);
    const groups = (JSON.parse(list.stdout) as { items: { group: string }[] }).items.map(
      (i) => i.group,
    );
    expect(new Set(groups).size).toBe(2);
  });
});
