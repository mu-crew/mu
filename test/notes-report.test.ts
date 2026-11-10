// `mu task notes <id> --report`: the latest kind=report note, raw (no \n
// escaping), its JSON fields, the no-report exit 1, and the refusals.
// Real temp SQLite through the CLI wiring.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, type NoteKind, openDb } from "../src/db.js";
import { addNote, addTask, closeTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

const WS = "w";
let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-notes-report-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, WS);
  addTask(db, { localId: "t", workstream: WS, title: "T", impact: 50, effortDays: 1 });
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function note(text: string, kind: NoteKind = "note", author = "a", ws = WS): void {
  addNote(db, "t", text, { workstream: ws, kind, author });
}
const notes = (...args: string[]) => runCli(["task", "notes", "t", "-w", WS, ...args], dbPath);

describe("mu task notes --report", () => {
  it("prints the latest report raw, from any author, on a closed task; other workstreams stay out", async () => {
    ensureWorkstream(db, "other");
    addTask(db, { localId: "t", workstream: "other", title: "T", impact: 50, effortDays: 1 });
    note("old report", "report", "a");
    const body = "## Result\nline 2\ttab \\n kept\n\nend";
    note(body, "report", "b");
    note("later plain note");
    note("other ws report", "report", "a", "other");
    closeTask(db, "t", { workstream: WS, evidence: "test" });
    const r = await notes("--report");
    expect(r.error).toBeUndefined();
    expect(r.stdout).toBe(`${body}\n`);
    expect(r.stderr).toBe("");
    expect(process.exitCode).toBeUndefined();
  });

  it("--json carries n, kind, author, created_at, content", async () => {
    note("BRIEF", "brief");
    note("r\nmulti", "report", "b");
    const r = await notes("--report", "--json");
    const env = JSON.parse(r.stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(env.ok).toBe(true);
    expect(Object.keys(env.data).sort()).toEqual(["author", "content", "created_at", "kind", "n"]);
    expect(env.data).toMatchObject({ n: 2, kind: "report", author: "b", content: "r\nmulti" });
  });

  it("no report note: exit 1, the text on stderr (a plain note is not a report)", async () => {
    note("only plain");
    const r = await notes("--report");
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("(no report note on t)\n");
    expect(process.exitCode).toBe(1);
  });

  it("no report note under --json: exit 1, an error field", async () => {
    const r = await notes("--report", "--json");
    expect(JSON.parse(r.stdout).data).toEqual({ error: "no report found" });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [["--tail", "2"], "Cannot combine --report with --tail, --since, or --since-claim"],
    [["--last", "2"], "Cannot combine --report with --tail, --since, or --since-claim"],
    [["--since", "2020-01-01"], "Cannot combine --report with --tail, --since, or --since-claim"],
    [["--since-claim"], "Cannot combine --report with --tail, --since, or --since-claim"],
    [
      ["--all"],
      "--all/--from pick a page of the whole history; they do not combine with --tail/--since/--since-claim",
    ],
    [
      ["--from", "1"],
      "--all/--from pick a page of the whole history; they do not combine with --tail/--since/--since-claim",
    ],
  ])("refuses --report %j", async (extra, msg) => {
    note("r", "report");
    const r = await notes("--report", ...extra);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.split("\n")[0]).toBe(`error: ${msg}`);
  });
});
