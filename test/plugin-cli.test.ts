// `mu plugin add | list | rm` and `mu host add --plugin` (plugins spec D14, D5
// host_profiles): registration is by absolute path, refused while in use; a
// `--plugin` profile has no shell or exec, keeps its fetch template, and its
// identity is `plugin:<name>:<instance>`. A template profile is stored and
// printed as it always was. An older host_profiles shape is rebuilt in place.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireHostSpawn } from "../src/agents/spawn-remote.js";
import { type Db, openDb } from "../src/db.js";
import { hostIdentity, resolveHost } from "../src/host-provider.js";
import { addHost, getHost, HostProfileError } from "../src/hosts.js";
import { PluginNotFoundError, PluginRefusedError } from "../src/plugins/errors.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin, linkSeam } from "./_plugin.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let f: FakePlugin;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpcl-"));
  dbPath = join(dir, "mu.db");
  f = fakePlugin(dir);
});

afterEach(async () => {
  await closePluginSessions();
  rmFixtureDir(dir);
});

describe("mu plugin (CLI)", () => {
  it("add, list, rm", async () => {
    const a = await runCliJson(["plugin", "add", "fake", "--json", "--", ...f.argv], dbPath);
    expect(a.exitCode).toBeNull();
    expect(a.data).toMatchObject({
      plugin: { name: "fake", argv: f.argv, protocol: 1, version: "0.1.0", instance: "fake-1" },
      refreshed: false,
    });
    expect(a.data.plugin.seams.link).toMatchObject({ slots: "self", maxScriptBytes: 131072 });
    const l = await runCliJson(["plugin", "list", "--json"], dbPath);
    expect(l.data.items.map((p: { name: string }) => p.name)).toEqual(["fake"]);
    const human = await runCli(["plugin", "list"], dbPath);
    expect(human.stdout).toContain("fake-1");
    expect(human.stdout).toContain("link");
    const again = await runCliJson(["plugin", "add", "fake", "--json", "--", ...f.argv], dbPath);
    expect(again.data).toMatchObject({ refreshed: true });
    const r = await runCliJson(["plugin", "rm", "fake", "--json"], dbPath);
    expect(r.data).toEqual({ plugin: "fake", removed: true });
    expect((await runCliJson(["plugin", "list", "--json"], dbPath)).data.items).toEqual([]);
  });

  it("add runs the handshake once and leaves no plugin process", async () => {
    await runCliJson(["plugin", "add", "fake", "--json", "--", ...f.argv], dbPath);
    expect(f.calls().map((c) => c.method)).toEqual(["initialize", "shutdown"]);
  });

  it("add with another argv for a registered name refuses (exit 4)", async () => {
    await runCliJson(["plugin", "add", "fake", "--json", "--", ...f.argv], dbPath);
    const b = await runCliJson(
      ["plugin", "add", "fake", "--json", "--", f.path, join(dir, "other.json")],
      dbPath,
    );
    expect(b.exitCode).toBe(4);
    expect(JSON.stringify(b.doc)).toMatch(/registered with another argv/);
  });

  it("add refuses a relative path (exit 4) and a load-rule failure (exit 4)", async () => {
    expect(
      (await runCliJson(["plugin", "add", "fake", "--json", "--", "mu-plugin-fake"], dbPath))
        .exitCode,
    ).toBe(4);
    f.set({ speaks: [2, 2] });
    expect(
      (await runCliJson(["plugin", "add", "fake", "--json", "--", ...f.argv], dbPath)).exitCode,
    ).toBe(4);
  });

  it("rm refuses while a host profile names the plugin (exit 4); rm of nothing is false", async () => {
    await runCliJson(["plugin", "add", "fake", "--json", "--", ...f.argv], dbPath);
    const h = await runCliJson(
      ["host", "add", "box", "--plugin", "fake", "--fetch", "true", "--json"],
      dbPath,
    );
    expect(h.exitCode).toBeNull();
    const r = await runCliJson(["plugin", "rm", "fake", "--json"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(JSON.stringify(r.doc)).toMatch(/in use by host box/);
    await runCliJson(["host", "rm", "box", "--json"], dbPath);
    expect((await runCliJson(["plugin", "rm", "fake", "--json"], dbPath)).data).toEqual({
      plugin: "fake",
      removed: true,
    });
    expect((await runCliJson(["plugin", "rm", "fake", "--json"], dbPath)).data).toEqual({
      plugin: "fake",
      removed: false,
    });
  });
});

describe("mu host add --plugin", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb({ path: dbPath });
  });

  afterEach(() => {
    db.close();
  });

  it("stores no shell or exec; the link is the plugin's; the identity is plugin:<name>:<instance>", async () => {
    await addPlugin(db, "fake", f.argv);
    const p = addHost(db, {
      name: "box",
      plugin: "fake",
      fetch: "true",
      repo: "/r",
      max_sessions: null,
    });
    expect(p).toMatchObject({
      name: "box",
      shell: null,
      exec: null,
      fetch: "true",
      plugin: "fake",
      transport: "session",
    });
    const v = resolveHost(db, "box");
    expect(v.link.name).toBe("fake");
    expect(v.link.fingerprint(v)).toBe("plugin:fake:fake-1");
    expect(hostIdentity(db, "box")).toBe("plugin:fake:fake-1");
  });

  it("a template profile is stored and read as it always was: no plugin key", () => {
    const p = addHost(db, {
      name: "dev",
      shell: "true",
      exec: "sh -c {cmd}",
      fetch: "true",
      repo: null,
      max_sessions: null,
    });
    expect("plugin" in p).toBe(false);
    expect("plugin" in getHost(db, "dev")).toBe(false);
    expect(hostIdentity(db, "dev")).toBe("sh -c {cmd}");
  });

  it("refuses an unregistered plugin (exit 3), template fields, a lease transport, and a missing --shell", async () => {
    expect(() =>
      addHost(db, { name: "box", plugin: "nope", fetch: "true", repo: null, max_sessions: null }),
    ).toThrow(PluginNotFoundError);
    await addPlugin(db, "fake", f.argv);
    expect(() =>
      addHost(db, {
        name: "box",
        plugin: "fake",
        exec: "x {cmd}",
        fetch: "true",
        repo: null,
        max_sessions: null,
      }),
    ).toThrow(/--plugin takes no --exec/);
    expect(() =>
      addHost(db, {
        name: "box",
        plugin: "fake",
        transport: "lease",
        fetch: "true",
        repo: null,
        max_sessions: null,
      }),
    ).toThrow(/--plugin takes no --transport/);
    expect(() =>
      addHost(db, { name: "dev", exec: "x {cmd}", fetch: "true", repo: null, max_sessions: null }),
    ).toThrow(/--shell is required \(or --plugin <name>/);
    const cli = await runCliJson(
      ["host", "add", "box", "--plugin", "nope", "--fetch", "true", "--json"],
      dbPath,
    );
    expect(cli.exitCode).toBe(3);
  });

  it("takes no --fetch when the plugin's link fetches; requires it when the link does not", async () => {
    await addPlugin(db, "fake", f.argv);
    const ok = await runCliJson(["host", "add", "box", "--plugin", "fake", "--json"], dbPath);
    expect(ok.exitCode).toBeNull();
    expect(getHost(db, "box").fetch).toBe("");
    const show = await runCli(["host", "show", "box"], dbPath);
    expect(show.stdout).not.toMatch(/fetch/);
    const tmpl = await runCliJson(
      ["host", "add", "dev", "--shell", "true", "--exec", "sh -c {cmd}", "--json"],
      dbPath,
    );
    expect(tmpl.exitCode).not.toBeNull();
    expect(JSON.stringify(tmpl.doc)).toMatch(/--fetch is required/);
    const g = fakePlugin(dir, { seams: linkSeam({ fetch: false }) }, "nofetch");
    await addPlugin(db, "nofetch", g.argv);
    expect(() =>
      addHost(db, { name: "box2", plugin: "nofetch", repo: null, max_sessions: null }),
    ).toThrow(/--fetch is required: plugin nofetch's link does not fetch/);
  });

  it("refuses a plugin with no link seam", async () => {
    f.set({
      seams: {
        job: { kind: "k", view: "bound", handle: "file", start: { lookup: true, fenceKey: false } },
      },
    });
    await addPlugin(db, "fake", f.argv);
    expect(() =>
      addHost(db, { name: "box", plugin: "fake", fetch: "true", repo: null, max_sessions: null }),
    ).toThrow(PluginRefusedError);
  });

  it("show and list print the plugin; --json carries it", async () => {
    await addPlugin(db, "fake", f.argv);
    addHost(db, { name: "box", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
    const show = await runCli(["host", "show", "box"], dbPath);
    expect(show.stdout).toMatch(/plugin +fake/);
    expect(show.stdout).not.toMatch(/shell|exec {2}/);
    const json = await runCliJson(["host", "show", "box", "--json"], dbPath);
    expect(json.data.host).toMatchObject({ plugin: "fake", shell: null, exec: null });
  });

  it("a spawn on a --plugin host refuses before any effect", async () => {
    await addPlugin(db, "fake", f.argv);
    addHost(db, { name: "box", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
    await expect(
      requireHostSpawn(db, { name: "w", workstream: "ws", host: "box" } as Parameters<
        typeof requireHostSpawn
      >[1]),
    ).rejects.toThrow(HostProfileError);
    expect(f.calls().filter((c) => c.method !== "initialize" && c.method !== "shutdown")).toEqual(
      [],
    );
  });
});

describe("the host_profiles rebuild", () => {
  it("a file with the older shape gets plugin and nullable templates, rows and recovery triggers kept", () => {
    const db = openDb({ path: dbPath });
    db.close();
    const raw = new Database(dbPath);
    raw.exec(`
      DROP TRIGGER remote_recovery_agent_del_v2;
      DROP TRIGGER remote_recovery_workstream_del_v2;
      DROP TABLE host_profiles;
      CREATE TABLE host_profiles (
        name TEXT PRIMARY KEY, shell TEXT NOT NULL, exec TEXT NOT NULL, fetch TEXT NOT NULL,
        repo TEXT, max_sessions INTEGER CHECK (max_sessions > 0),
        transport TEXT NOT NULL DEFAULT 'session', stop TEXT, attach TEXT, capabilities TEXT);
      INSERT INTO host_profiles (name, shell, exec, fetch, repo) VALUES ('old', 's', 'e {cmd}', 'f', '/r');
    `);
    raw.close();
    const again = openDb({ path: dbPath });
    try {
      const cols = again
        .prepare("SELECT name, \"notnull\" AS nn FROM pragma_table_info('host_profiles')")
        .all() as {
        name: string;
        nn: number;
      }[];
      expect(cols.find((c) => c.name === "plugin")).toBeDefined();
      expect(cols.find((c) => c.name === "shell")?.nn).toBe(0);
      expect(cols.find((c) => c.name === "exec")?.nn).toBe(0);
      expect(getHost(again, "old")).toMatchObject({
        shell: "s",
        exec: "e {cmd}",
        fetch: "f",
        repo: "/r",
      });
      const triggers = again
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'remote_recovery_%'",
        )
        .all() as { name: string; sql: string }[];
      expect(triggers.map((t) => t.name).sort()).toEqual([
        "remote_recovery_agent_del_v2",
        "remote_recovery_workstream_del_v2",
      ]);
      for (const t of triggers) expect(t.sql).toContain("FROM host_profiles WHERE");
      expect(
        again
          .prepare("SELECT name FROM sqlite_master WHERE name = 'host_profiles_pre_plugin'")
          .get(),
      ).toBeUndefined();
    } finally {
      again.close();
    }
  });
});
