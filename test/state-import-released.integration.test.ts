// Released builds refuse schema 14 (spec D5, unit P6a). Not a model of the
// rule: the RELEASED source itself, `git archive v4.5.0 src`, imported and
// run against a v14 file this build wrote. Its check is refuseUnusableStamps
// (src/db.ts at v4.5.0): a stored version above its CURRENT_SCHEMA_VERSION
// (13) throws SchemaTooNewError before any write, which its handle() maps to
// exit 4 (conflict).
//
// Integration tier: it runs git. The archive lands in a temp dir beside a
// link to this checkout's node_modules, so the released files resolve
// better-sqlite3 and the rest.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";

const RELEASE = "v4.5.0";
const repo = resolve(__dirname, "..");

interface ReleasedDb {
  CURRENT_SCHEMA_VERSION: number;
  openDb(opts: { path: string }): unknown;
  SchemaTooNewError: new (...args: never[]) => Error;
}
interface ReleasedHandle {
  classifyError(err: unknown): { label: string; exitCode: number };
}

let released: string;
let tmp: string;

beforeAll(() => {
  // Real path: the released modules import each other by it (one instance each).
  released = realpathSync(mkdtempSync(join(tmpdir(), "mu-released-src-")));
  symlinkSync(join(repo, "node_modules"), join(released, "node_modules"));
  const tar = join(released, "src.tar");
  execFileSync("git", ["-C", repo, "archive", "-o", tar, RELEASE, "src"]);
  execFileSync("tar", ["-x", "-f", tar, "-C", released]);
  tmp = mkdtempSync(join(tmpdir(), "mu-released-"));
});
afterAll(() => {
  try {
    rmSync(released, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

describe(`mu ${RELEASE.slice(1)} (schema 13) and a v14 DB`, () => {
  it("refuses it with SchemaTooNewError, exit 4, and leaves the file byte-for-byte untouched", async () => {
    const path = join(tmp, "v14", "mu.db");
    mkdirSync(join(tmp, "v14"));
    const mine = openDb({ path });
    addTask(mine, { localId: "t1", title: "written by mu 5", workstream: "w" });
    mine.close();
    expect(CURRENT_SCHEMA_VERSION).toBe(14);

    const db = (await import(pathToFileURL(join(released, "src", "db.ts")).href)) as ReleasedDb;
    const handle = (await import(
      pathToFileURL(join(released, "src", "cli", "handle.ts")).href
    )) as ReleasedHandle;
    expect(db.CURRENT_SCHEMA_VERSION).toBe(13);

    const before = readFileSync(path);
    let thrown: unknown;
    try {
      db.openDb({ path });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(db.SchemaTooNewError);
    expect(thrown).toMatchObject({ detectedVersion: 14, supportedVersion: 13, stamp: "schema" });
    expect(handle.classifyError(thrown)).toEqual({ label: "conflict", exitCode: 4 });
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
