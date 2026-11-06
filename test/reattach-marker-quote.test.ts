// The marker's printed cleanup command, pasted into a real /bin/sh: the DB directory is the
// operator's (MU_DB_PATH, XDG_STATE_HOME) and may hold a space or an apostrophe, so the
// command must remove exactly its marker (finding reattach_marker_cleanup_quote).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { markerPath, readMarker } from "../src/agents/reattach-marker.js";
import { type Db, openDb } from "../src/db.js";
import { installMux, type MuxHarness } from "./_mux.js";

let root: string;
let db: Db | undefined;
let mux: MuxHarness | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mu-marker-quote-"));
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  db?.close();
  db = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A marker with `contents` under a DB in `<root>/<stateDir>`; the command its refusal prints. */
async function printed(
  stateDir: string,
  contents: string,
): Promise<{ marker: string; cmd: string }> {
  const state = join(root, stateDir);
  mkdirSync(state);
  db = openDb({ path: join(state, "mu.db") });
  const marker = markerPath(db, "auth", "worker-1");
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, contents);
  const detail = await readMarker(db, "auth", "worker-1");
  const cmd = /once no carrier of its job runs: (.*)$/.exec(detail)?.[1];
  if (cmd === undefined) throw new Error(`no cleanup command in: ${detail}`);
  return { marker, cmd };
}

const sh = (cmd: string) => spawnSync("/bin/sh", ["-c", cmd], { cwd: root, encoding: "utf8" });

it("the printed cleanup removes only its marker under a DB directory with a space", async () => {
  const innocent = join(root, "safe");
  writeFileSync(innocent, "unrelated data");
  const { marker, cmd } = await printed("safe file", "{"); // no carrier exists
  const res = sh(cmd);
  expect(existsSync(innocent)).toBe(true);
  expect(existsSync(marker)).toBe(false);
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
});

it.each([
  ["malformed", "{"],
  ["pane never named", JSON.stringify({ job: "job-1", pid: 1 })],
  ["pane named, may run", JSON.stringify({ job: "job-1", pid: 1, pane: "%7" })],
])(
  "every refusal's cleanup pastes as one rm of its marker (%s; space and apostrophe)",
  async (_, body) => {
    // The pane probe fails: the named pane's state is unknown, so the refusal stands.
    mux = installMux("tmux", async () => ({ stdout: "", stderr: "no server", exitCode: 1 }));
    const { marker, cmd } = await printed("it's a dir", body);
    const locks = dirname(marker);
    writeFileSync(join(locks, "sibling"), "kept");
    writeFileSync(join(root, "it"), "kept");
    const res = sh(cmd);
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(locks)).toContain("sibling");
    expect(existsSync(join(root, "it"))).toBe(true);
  },
);
