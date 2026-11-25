// MU_REMOTE_WORKSPACE=1 (a rung-2 remote command env, Spec B D1.2c): a `mu`
// there must not open the host's default DB. Refused before anything opens.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyError } from "../src/cli/handle.js";
import { openDb, RemoteWorkspaceDbError } from "../src/db.js";

const KEYS = ["MU_REMOTE_WORKSPACE", "MU_DB_PATH"] as const;
let saved: Array<string | undefined>;
let dir: string;

beforeEach(() => {
  saved = KEYS.map((k) => process.env[k]);
  dir = mkdtempSync(join(tmpdir(), "mu-remote-ws-"));
});
afterEach(() => {
  KEYS.forEach((k, i) => {
    const v = saved[i];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  rmSync(dir, { recursive: true, force: true });
});

describe("remote workspace marker", () => {
  for (const unset of [undefined, ""]) {
    it(`refuses the default DB with MU_DB_PATH=${JSON.stringify(unset)}`, () => {
      process.env.MU_REMOTE_WORKSPACE = "1";
      if (unset === undefined) delete process.env.MU_DB_PATH;
      else process.env.MU_DB_PATH = unset;
      let thrown: unknown;
      try {
        openDb();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RemoteWorkspaceDbError);
      expect(String((thrown as Error).message)).toMatch(/MU_REMOTE_WORKSPACE.*MU_DB_PATH/);
      expect(classifyError(thrown).exitCode).toBe(4);
    });
  }

  it("opens an explicit MU_DB_PATH", () => {
    process.env.MU_REMOTE_WORKSPACE = "1";
    process.env.MU_DB_PATH = join(dir, "mu.db");
    openDb().close();
    expect(existsSync(join(dir, "mu.db"))).toBe(true);
  });

  it("is inert without the marker", () => {
    delete process.env.MU_REMOTE_WORKSPACE;
    process.env.MU_DB_PATH = join(dir, "mu.db");
    openDb().close();
  });
});
