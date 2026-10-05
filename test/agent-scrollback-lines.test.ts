// `scrollbackLines` in `mu agent read --json` and `mu agent show --json`
// is the number of lines in the returned scrollback, counted the same way
// in both verbs: a final newline ends the last line rather than starting
// an empty one, and empty scrollback has 0 lines. (f_agentcli_scrollbacklines_inconsistent:
// read counted the trailing "" as a line; show echoed the requested -n.)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-sbl-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "claude" });
});

afterEach(() => {
  mux?.restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function paneShows(text: string): void {
  mux = installMux("tmux", async (args) => ({
    stdout: args[0] === "capture-pane" ? text : "",
    stderr: "",
    exitCode: 0,
  }));
}

async function scrollbackLines(verb: "read" | "show"): Promise<unknown> {
  const r = await runCli(["agent", verb, "worker-1", "-n", "20", "--json", "-w", "auth"], dbPath);
  expect(r.exitCode).toBeNull();
  const out = JSON.parse(r.stdout) as { scrollback: string; scrollbackLines: unknown };
  return out.scrollbackLines;
}

describe("scrollbackLines", () => {
  it.each([
    ["a\nb\nc\n", 3],
    ["a\nb\nc", 3],
    ["", 0],
  ])("%j: read and show both report %i", async (text, expected) => {
    paneShows(text);
    expect(await scrollbackLines("read")).toBe(expected);
    expect(await scrollbackLines("show")).toBe(expected);
  });
});
