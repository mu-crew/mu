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

describe("--help states the quoting rule", () => {
  it("task add, task note and agent send name `-` and the quoted heredoc", async () => {
    const add = await runCli(["task", "add", "--help"], dbPath);
    expect(add.stdout.replace(/\s+/g, " ")).toContain(
      "`-` reads it from stdin (prose: --note - <<'EOF')",
    );
    const note = await runCli(["task", "note", "--help"], dbPath);
    const noteHelp = note.stdout.replace(/\s+/g, " ");
    expect(noteHelp).toContain("an apostrophe ends '...'");
    expect(noteHelp).toContain("mu task note <id> - <<'EOF'");
    expect(noteHelp).toContain("`-` reads stdin");
    expect(noteHelp).toContain("a bare `-` or empty note warns");
    const send = await runCli(["agent", "send", "--help"], dbPath);
    const sendHelp = send.stdout.replace(/\s+/g, " ");
    expect(sendHelp).toContain("Text `-` reads stdin");
    expect(sendHelp).toContain("mu agent send <name> - <<'EOF'");
  });
});

describe("a note that is only `-`, empty or whitespace is loud", () => {
  // How it happens: an older mu (no stdin form) stored `-` literally, a
  // variable was empty, or stdin itself held only `-`. The checks run on
  // the text after the stdin step, i.e. on what would be stored.
  const BARE_DASH = /warning: note text is a bare "-"/;
  const EMPTY = /warning: note text is empty or whitespace only/;

  it("task note with empty or whitespace text warns on stderr and in --json", async () => {
    await runCli(["task", "add", "a", "-t", "A", "-i", "5", "-e", "1", "-w", "ws"], dbPath);
    const empty = await runCli(["task", "note", "a", "", "-w", "ws"], dbPath);
    expect(empty.exitCode).toBeNull();
    expect(empty.stderr).toMatch(EMPTY);
    const ws = await runCli(["task", "note", "a", "   ", "-w", "ws", "--json"], dbPath);
    expect((JSON.parse(ws.stdout) as { warnings?: string[] }).warnings?.[0]).toMatch(
      /empty or whitespace/,
    );
    const ok = await runCli(["task", "note", "a", "fine", "-w", "ws", "--json"], dbPath);
    expect(ok.stderr).not.toMatch(/warning:/);
    expect(JSON.parse(ok.stdout)).not.toHaveProperty("warnings");
  });

  it("stdin that is itself just `-` warns instead of storing it silently", async () => {
    setStdinReaderForTests(async () => "-\n");
    await runCli(["task", "add", "a", "-t", "A", "-i", "5", "-e", "1", "-w", "ws"], dbPath);
    const r = await runCli(["task", "note", "a", "-", "-w", "ws", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toMatch(BARE_DASH);
    expect((JSON.parse(r.stdout) as { warnings?: string[] }).warnings?.[0]).toMatch(/bare "-"/);
    expect(await noteContents("a")).toEqual(["-"]);
  });

  it("task add --note with a bare `-` from stdin or whitespace warns", async () => {
    setStdinReaderForTests(async () => " - \n");
    const r = await runCli(
      ["task", "add", "a", "-t", "A", "-i", "5", "-e", "1", "-w", "ws", "--note", "-", "--json"],
      dbPath,
    );
    expect(r.stderr).toMatch(BARE_DASH);
    expect((JSON.parse(r.stdout) as { warnings?: string[] }).warnings).toHaveLength(1);
    const b = await runCli(
      ["task", "add", "b", "-t", "B", "-i", "5", "-e", "1", "-w", "ws", "--note", " "],
      dbPath,
    );
    expect(b.stderr).toMatch(EMPTY);
  });
});
