// prose-quoting: long prose reaches mu intact. `-` reads the text from
// stdin (a quoted heredoc needs no shell quoting at all), and a
// "too many arguments" parse error on the text-carrying verbs hints
// that an apostrophe probably ended a single-quoted string early.
//
// Fast tier: in-process runCli, per-test temp DB, stdin via the seam.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStdinReaderForTests } from "../src/cli/stdin.js";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

// What a quoted heredoc delivers: real newlines, a trailing newline,
// and characters a shell would mangle inside '...' or "...".
const PROSE = "it's the worker's job\n$HOME and `pwd` and \\n stay literal\n";
const STORED = "it's the worker's job\n$HOME and `pwd` and \\n stay literal";
const HINT = /apostrophe inside '\.\.\.'/;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-prose-"));
  dbPath = join(dir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "ws");
  db.close();
  setStdinReaderForTests(async () => PROSE);
});

afterEach(() => {
  setStdinReaderForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

async function noteContents(id: string): Promise<string[]> {
  const r = await runCli(["task", "notes", id, "-w", "ws", "--json"], dbPath);
  return (JSON.parse(r.stdout) as { items: { content: string }[] }).items.map((n) => n.content);
}

describe("`-` reads note text from stdin, verbatim", () => {
  it("mu task add --note - stores the stdin text", async () => {
    const r = await runCli(
      ["task", "add", "a", "-t", "A", "-i", "5", "-e", "1", "-w", "ws", "--note", "-"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    expect(await noteContents("a")).toEqual([STORED]);
  });

  it("mu task note <id> - and --text - store the stdin text", async () => {
    await runCli(["task", "add", "a", "-t", "A", "-i", "5", "-e", "1", "-w", "ws"], dbPath);
    const pos = await runCli(["task", "note", "a", "-", "-w", "ws"], dbPath);
    expect(pos.exitCode).toBeNull();
    const flag = await runCli(["task", "note", "a", "--text", "-", "-w", "ws"], dbPath);
    expect(flag.exitCode).toBeNull();
    expect(await noteContents("a")).toEqual([STORED, STORED]);
  });

  it("empty stdin is a usage error, not an empty note", async () => {
    setStdinReaderForTests(async () => "\n");
    await runCli(["task", "add", "a", "-t", "A", "-i", "5", "-e", "1", "-w", "ws"], dbPath);
    const r = await runCli(["task", "note", "a", "-", "-w", "ws"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/stdin/);
    expect(await noteContents("a")).toEqual([]);
  });
});

describe("too-many-arguments quoting hint", () => {
  it("task add carries the heredoc hint", async () => {
    // What bash hands mu after an apostrophe ends '...' early.
    const r = await runCli(
      [
        "task",
        "add",
        "a",
        "-t",
        "A",
        "-i",
        "5",
        "-e",
        "1",
        "-w",
        "ws",
        "--note",
        "the",
        "delegate",
        "s",
      ],
      dbPath,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/too many arguments/);
    expect(r.stderr).toMatch(HINT);
    expect(r.stderr).toContain("--note - <<'EOF'");
  });

  it("task note and agent send carry it too", async () => {
    const note = await runCli(["task", "note", "a", "it", "s", "broken", "-w", "ws"], dbPath);
    expect(note.stderr).toMatch(HINT);
    expect(note.stderr).toContain("mu task note a - <<'EOF'");
    const send = await runCli(["agent", "send", "w1", "it", "s", "-w", "ws"], dbPath);
    expect(send.stderr).toMatch(HINT);
    expect(send.stderr).toContain("mu agent send w1 - <<'EOF'");
  });

  it("other verbs' parse errors do not", async () => {
    const r = await runCli(["task", "show", "a", "extra", "-w", "ws"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/too many arguments/);
    expect(r.stderr).not.toMatch(HINT);
    const missing = await runCli(["task", "add", "a", "-w", "ws"], dbPath);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).not.toMatch(HINT);
  });
});
