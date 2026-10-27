// MU_PANE_ENV: a spawned pane records the DB, state dir and sync dir mu gave it. A mu
// run in that pane whose own resolution differs (an interactive shell rc that a harness
// re-sources reset MU_SYNC_DIR or MU_DB_PATH) warns once, reads, never writes or syncs.

import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { PANE_ENV_VAR, paneEnvMismatch, paneEnvValue } from "../src/pane-env.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { runCliJson, runCliWire } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpe-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "ws");
  addTask(db, { workstream: "ws", localId: "a", title: "a" });
  db.close();
});
afterEach(() => rmFixtureDir(dir));

const state = () => join(dir, "state");
const pane = (o: { db?: string; sync?: string } = {}) =>
  paneEnvValue({ db: o.db ?? dbPath, state: state(), sync: o.sync ?? "" });
/** Run `fn` as if inside a pane spawned with `value`, state dir pinned. */
const inPane = (value: string, fn: () => Promise<void>) =>
  withEnv(PANE_ENV_VAR, value, () => withEnv("MU_STATE_DIR", state(), fn));

describe("paneEnvMismatch", () => {
  it("absent or blank: no check; equal: none", async () => {
    expect(paneEnvMismatch({})).toEqual([]);
    expect(paneEnvMismatch({ [PANE_ENV_VAR]: "" })).toEqual([]);
    const env = { [PANE_ENV_VAR]: pane(), MU_DB_PATH: dbPath, MU_STATE_DIR: state() };
    expect(paneEnvMismatch(env)).toEqual([]);
  });

  it("a different DB, state dir or a sync dir the pane did not have is a mismatch", () => {
    const base = { MU_DB_PATH: dbPath, MU_STATE_DIR: state() };
    const v = pane();
    expect(paneEnvMismatch({ ...base, [PANE_ENV_VAR]: v, MU_DB_PATH: "/x/mu.db" })).toEqual([
      { field: "MU_DB_PATH", pane: dbPath, now: "/x/mu.db" },
    ]);
    expect(
      paneEnvMismatch({ ...base, [PANE_ENV_VAR]: v, MU_SYNC_DIR: "/home/u/mu" }).map(
        (m) => m.field,
      ),
    ).toEqual(["MU_SYNC_DIR"]);
    // Turning sync OFF cannot write a foreign folder: not a mismatch.
    const synced = pane({ sync: "/s" });
    expect(paneEnvMismatch({ ...base, [PANE_ENV_VAR]: synced })).toEqual([]);
  });

  it("an unparseable value is ignored (never blocks a verb)", () => {
    expect(paneEnvMismatch({ [PANE_ENV_VAR]: "{not json" })).toEqual([]);
  });
});

describe("a mu run whose env differs from its pane's", () => {
  it("a read works and warns once on stderr", async () => {
    await inPane(pane({ db: join(dir, "other.db") }), async () => {
      const r = await runCliJson(["task", "list", "-w", "ws", "--json"], dbPath);
      expect(r.doc.ok).toBe(true);
      expect(r.stderr.match(/MU_PANE_ENV/g)).toHaveLength(1);
      expect(r.stderr).toContain("MU_DB_PATH");
      expect(r.stderr).toContain("other-agent-clis.md");
    });
  });

  it("a write refuses with exit 4 and changes nothing", async () => {
    await inPane(pane({ db: join(dir, "other.db") }), async () => {
      const r = await runCliJson(["task", "add", "b", "-w", "ws", "-t", "b", "--json"], dbPath);
      expect(r.doc).toMatchObject({ ok: false, error: "PaneEnvMismatchError", exit: 4 });
      expect(r.exitCode).toBe(4);
      expect(r.stderr).not.toContain("warning:"); // said once, as the error
    });
    const check = openDb({ path: dbPath });
    expect(check.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    check.close();
  });

  it("never syncs: a sync dir the pane did not have gets no segment, even on a read", async () => {
    const sync = join(dir, "sync");
    mkdirSync(sync);
    await inPane(pane(), () =>
      withEnv("MU_SYNC_DIR", sync, async () => {
        const r = await runCliWire(["task", "list", "-w", "ws"], dbPath);
        expect(r.exitCode).toBeNull();
      }),
    );
    expect(readdirSync(sync)).toEqual([]);
  });

  it("a missing DB at the new path is refused, not created", async () => {
    const other = join(dir, "nope", "mu.db");
    await inPane(pane(), async () => {
      const r = await runCliJson(["task", "list", "-w", "ws", "--json"], other);
      expect(r.doc).toMatchObject({ ok: false, error: "PaneEnvMismatchError" });
    });
    expect(existsSync(other)).toBe(false);
  });

  it("MU_ALLOW_FOREIGN_DB=1 lets the write through", async () => {
    await inPane(pane({ db: join(dir, "other.db") }), () =>
      withEnv("MU_ALLOW_FOREIGN_DB", "1", async () => {
        const r = await runCliJson(["task", "add", "b", "-w", "ws", "-t", "b", "--json"], dbPath);
        expect(r.doc.ok).toBe(true);
        expect(r.stderr).not.toContain("MU_PANE_ENV");
      }),
    );
  });
});
