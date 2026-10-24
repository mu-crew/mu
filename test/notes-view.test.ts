// The default notes view (selectTaskNotes) and its rendering (planNotes,
// `mu task notes`, `mu task show --note`): the brief, the report and the
// verdicts are content and never cut; ordinary notes get their own 4 KB;
// every cut names the command that brings it back. Real temp SQLite.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noteRecord, planNotes, type ShownNote } from "../src/cli/format.js";
import { type Db, type NoteKind, openDb } from "../src/db.js";
import {
  addNote,
  addTask,
  closeTask,
  getTaskNote,
  listNotes,
  selectTaskNotes,
  TaskNoteRangeError,
} from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

const WS = "w";
let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-notes-view-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, WS);
  addTask(db, { localId: "t", workstream: WS, title: "T", impact: 50, effortDays: 1 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function note(text: string, kind: NoteKind = "note", author: string | null = "a"): void {
  addNote(db, "t", text, { workstream: WS, kind, ...(author === null ? {} : { author }) });
}
const select = (o: { all?: boolean; from?: number } = {}) =>
  selectTaskNotes(db, "t", { workstream: WS, ...o });
const texts = (o: { all?: boolean; from?: number } = {}) => select(o).notes.map((n) => n.content);

describe("selectTaskNotes", () => {
  it("shows a short history whole and reports nothing omitted", () => {
    note("one");
    note("two");
    const r = select();
    expect(r.notes.map((n) => [n.n, n.content])).toEqual([
      [1, "one"],
      [2, "two"],
    ]);
    expect(r.more).toBe(0);
    expect(r.total).toBe(2);
  });

  it("--all on an existing task with no notes is an empty result; an explicit --from 1 is still a miss", () => {
    expect(select({ all: true })).toMatchObject({ notes: [], more: 0, total: 0 });
    expect(() => select({ from: 1 })).toThrow(TaskNoteRangeError);
  });

  it("an empty task selects nothing", () => {
    expect(select()).toEqual({ notes: [], more: 0, total: 0, pinned: [] });
  });

  it("pins the first brief, the last report and every verdict; ordinary notes after the report: last 3", () => {
    note("BRIEF", "brief");
    for (let i = 1; i <= 4; i++) note(`early ${i}`);
    note("VERDICT: yes", "verdict");
    note("report v1", "report");
    note("report v2", "report");
    note("VERDICT: later", "verdict");
    for (let i = 1; i <= 5; i++) note(`after ${i}`);
    const r = select();
    expect(r.notes.map((n) => n.content)).toEqual([
      "BRIEF",
      "VERDICT: yes",
      "report v2",
      "VERDICT: later",
      "after 3",
      "after 4",
      "after 5",
    ]);
    expect(r.pinned).toEqual([1, 6, 8, 9]);
    expect(r.more).toBe(r.total - 7);
  });

  it("keeps fewer than 3 ordinary notes when fewer follow the report, never older ones", () => {
    note("BRIEF", "brief");
    note("old");
    note("rep", "report");
    note("new 1");
    expect(texts()).toEqual(["BRIEF", "rep", "new 1"]);
  });

  it("without a report the closer's last note stands in, chosen at read time", () => {
    note("BRIEF", "brief");
    note("worker progress", "note", "worker");
    note("worker FINAL words", "note", "worker");
    closeTask(db, "t", { workstream: WS, evidence: "ran it", author: "worker" });
    const r = select();
    expect(r.notes.map((n) => n.content)).toEqual(["BRIEF", "worker FINAL words", "CLOSE: ran it"]);
    expect(r.pinned).toEqual([1, 3]);
  });

  it("closer fallback follows the close author, not the newest note", () => {
    note("BRIEF", "brief");
    note("worker FINAL", "note", "worker");
    note("orchestrator chatter 1", "note", "orch");
    note("orchestrator chatter 2", "note", "orch");
    note("orchestrator chatter 3", "note", "orch");
    note("orchestrator chatter 4", "note", "orch");
    note("CLOSE: ran it", "close", "worker");
    note("late instructions", "note", "orch");
    const r = select();
    expect(r.pinned).toEqual([1, 2]);
    expect(r.notes.map((n) => n.content)).toEqual([
      "BRIEF",
      "worker FINAL",
      "orchestrator chatter 4",
      "CLOSE: ran it",
      "late instructions",
    ]);
  });

  it("a close with no author matches the author-less note; other authors stay ordinary", () => {
    note("BRIEF", "brief");
    note("anonymous result", "note", null);
    note("by someone", "note", "x");
    note("CLOSE: ok", "close", null);
    expect(select().pinned).toEqual([1, 2]);
  });

  it("a report outranks the closer fallback, and a close note is never the report", () => {
    note("BRIEF", "brief");
    note("r", "report");
    note("worker last", "note", "w");
    note("CLOSE: x", "close", "w");
    const r = select();
    expect(r.pinned).toEqual([1, 2]);
    expect(r.notes.map((n) => n.kind)).toEqual(["brief", "report", "note", "close"]);
  });

  it("no brief note: the first note is not promoted", () => {
    note("first, plain");
    for (let i = 0; i < 5; i++) note(`n${i}`);
    expect(texts()).toEqual(["n2", "n3", "n4"]);
  });

  it("a note in two categories appears once", () => {
    note("BRIEF", "brief");
    note("VERDICT: x", "verdict");
    const r = select();
    expect(r.notes).toHaveLength(2);
  });

  it("--all and --from return exactly the suffix, whole, with the pinned ones not added again", () => {
    note("BRIEF", "brief");
    for (let i = 1; i <= 6; i++) note(`n${i}`);
    note("rep", "report");
    expect(texts({ all: true })).toHaveLength(8);
    expect(texts({ from: 6 })).toEqual(["n5", "n6", "rep"]);
    expect(select({ from: 6 }).more).toBe(5);
  });

  it("rejects a note number that is not one of this task's notes", () => {
    note("one");
    for (const from of [0, 2, -1, 1.5, Number.NaN]) {
      expect(() => select({ from })).toThrow(TaskNoteRangeError);
    }
    // ordinals are per task: another task's notes do not extend this range
    addTask(db, { localId: "u", workstream: WS, title: "U", impact: 50, effortDays: 1 });
    addNote(db, "u", "u1", { workstream: WS });
    addNote(db, "u", "u2", { workstream: WS });
    expect(() => select({ from: 2 })).toThrow(/1\.\.1/);
    expect(selectTaskNotes(db, "u", { workstream: WS, from: 2 }).notes.map((n) => n.n)).toEqual([
      2,
    ]);
  });

  it("returns whole pinned bodies independent of any cap, and reads only chosen content", () => {
    const brief = `${"x".repeat(4800)}\nSCOPE GUARD: tail`;
    note(brief, "brief");
    for (let i = 0; i < 300; i++) note(`filler ${i} ${"y".repeat(200)}`);
    const r = select();
    expect(r.notes[0]?.content).toBe(brief);
    expect(r.notes).toHaveLength(4);
    expect(r.more).toBe(297);
    expect(listNotes(db, "t", WS)).toHaveLength(301); // full history untouched
  });

  it("every note carries its kind and 1-based task-bound number", () => {
    note("b", "brief");
    note("n");
    expect(listNotes(db, "t", WS).map((n) => [n.n, n.kind])).toEqual([
      [1, "brief"],
      [2, "note"],
    ]);
  });
});

describe("getTaskNote", () => {
  it("returns one whole note by number and refuses others", () => {
    note("a");
    note("b".repeat(10_000));
    expect(getTaskNote(db, "t", WS, 2).content).toHaveLength(10_000);
    expect(() => getTaskNote(db, "t", WS, 3)).toThrow(TaskNoteRangeError);
    expect(() => getTaskNote(db, "nope", WS, 1)).toThrow(TaskNoteRangeError);
  });
});

describe("planNotes (ordinary byte budget)", () => {
  const mk = (n: number, content: string, kind: NoteKind = "note") => ({
    n,
    kind,
    author: "a",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  // Text wire size: records, newline-joined, plus a worst-case footer.
  const size = (ordinary: readonly ShownNote[], footer: boolean): number =>
    Buffer.byteLength(
      [
        ...ordinary.map((s) =>
          s.cutBytes === undefined
            ? noteRecord(s.note)
            : noteRecord(s.note, { cutBytes: s.cutBytes, command: `show ${s.note.n}` }),
        ),
        ...(footer ? ["more=99 next=mu task notes t -w w --from 99"] : []),
      ].join("\n"),
    ) + 1;

  it("never charges pinned bytes against the ordinary budget", () => {
    const pinned = mk(1, "p".repeat(4800), "brief");
    const small = mk(2, "tiny");
    const r = planNotes([pinned, small], new Set([1]), "newest", size);
    expect(r.shown.map((s) => s.note.n)).toEqual([1, 2]);
    expect(r.omitted).toEqual([]);
  });

  it("pinned bytes are free whichever end of the page they sit at", () => {
    const small = (n: number) => mk(n, "tiny");
    const head = mk(1, "p".repeat(4800), "brief");
    const tail = mk(4, "r".repeat(4800), "report");
    const notes = [head, small(2), small(3), tail];
    for (const fill of ["newest", "page"] as const) {
      const r = planNotes(notes, new Set([1, 4]), fill, size);
      expect(r.shown.map((s) => s.note.n)).toEqual([1, 2, 3, 4]);
    }
  });

  it("a page always makes progress: the first ordinary note is kept (as a stub) even when the budget is tiny", () => {
    const r = planNotes([mk(1, "z".repeat(500))], new Set(), "page", size, { budget: 10 });
    expect(r.shown.map((s) => s.note.n)).toEqual([1]);
    expect(r.shown[0]?.cutBytes).toBeGreaterThan(500);
  });

  it("budgets ordinary notes in UTF-8 bytes, not characters", () => {
    const five = (ch: string) => [1, 2, 3, 4, 5].map((n) => mk(n, ch.repeat(700)));
    // 700 ASCII chars ~ 760 bytes a record: all five fit; 700 'é' ~ 1460 bytes: two fit.
    expect(planNotes(five("e"), new Set(), "newest", size).omitted).toEqual([]);
    const wide = planNotes(five("é"), new Set(), "newest", size);
    expect(wide.shown.map((s) => s.note.n)).toEqual([4, 5]);
    expect(wide.omitted).toEqual([1, 2, 3]);
  });

  it("an oversize ordinary note becomes a stub, never a silent 5 KB record", () => {
    const big = mk(1, "z".repeat(5000));
    const r = planNotes([big], new Set(), "page", size);
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]?.cutBytes).toBeGreaterThan(5000);
    expect(r.omitted).toEqual([]);
  });

  it("a page fills oldest-first and stops at the first note that does not fit", () => {
    const notes = [1, 2, 3, 4, 5].map((n) => mk(n, "e".repeat(1500)));
    const r = planNotes(notes, new Set(), "page", size);
    expect(r.shown.map((s) => s.note.n)).toEqual([1, 2]);
    expect(r.omitted).toEqual([3, 4, 5]);
  });
});

describe("mu task notes / show --note (CLI)", () => {
  it("one escaped record per line; pinned whole beside a capped tail; exact way back", async () => {
    const brief = `line1\nline2\ttab\\back ${"b".repeat(4800)}\nSCOPE GUARD`;
    note(brief, "brief");
    for (let i = 1; i <= 4; i++) note(`mid ${i}`);
    note("the report", "report");
    note(`${"é".repeat(3000)}`, "note");
    note("tail 2");
    const r = await runCli(["task", "notes", "t", "-w", WS], dbPath);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]?.startsWith("brief\t1\tby=a\tat=")).toBe(true);
    expect(lines[0]).toContain("line1\\nline2\\ttab\\\\back");
    expect(lines[0]?.endsWith("\\nSCOPE GUARD")).toBe(true);
    expect(lines.some((l) => l.startsWith("report\t6\t"))).toBe(true);
    const footer = lines.at(-1) ?? "";
    expect(footer).toMatch(/^more=\d+ next=mu task notes t -w w --from \d+$/);
    // ordinary part (everything but pinned) fits its own 4 KB
    const ordinary = lines.filter((l) => l.startsWith("note\t"));
    expect(ordinary.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)).toBeLessThanOrEqual(4096);
    // the oversize note is a stub naming its whole-note command
    expect(
      ordinary.some((l) => l.includes("cut=") && l.includes("next=mu task show t -w w --note 7")),
    ).toBe(true);
    const whole = await runCli(["task", "show", "t", "-w", WS, "--note", "7"], dbPath);
    expect(whole.stdout.trimEnd().endsWith("é".repeat(3000))).toBe(true);
    const one = await runCliJson(["task", "show", "t", "-w", WS, "--note", "1", "--json"], dbPath);
    expect((one.data as { content: string }).content).toBe(brief);
  });

  it("--all pages with --from until every omitted note was seen whole", async () => {
    for (let i = 1; i <= 40; i++) note(`n${i} ${"w".repeat(300)}`);
    const seen: number[] = [];
    let next: string | undefined = "--all";
    for (let guard = 0; next !== undefined && guard < 20; guard++) {
      const args: string[] = next === "--all" ? ["--all"] : ["--from", next];
      const r = await runCliJson(["task", "notes", "t", "-w", WS, ...args, "--json"], dbPath);
      const d = r.data as { items: { n: number; cut?: number }[]; more: number; retrieve?: string };
      expect(d.items.every((x) => x.cut === undefined)).toBe(true);
      seen.push(...d.items.map((x) => x.n));
      next = d.retrieve?.match(/--from (\d+)$/)?.[1];
      if (d.more === 0) next = undefined;
    }
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("JSON default view: SQL keys, count/more/retrieve, one envelope", async () => {
    note("BRIEF", "brief");
    for (let i = 1; i <= 5; i++) note(`n${i}`);
    const r = await runCliJson(["task", "notes", "t", "-w", WS, "--json"], dbPath);
    const d = r.data as {
      items: Record<string, unknown>[];
      count: number;
      more: number;
      retrieve: string;
    };
    expect(Object.keys(d.items[0] ?? {}).sort()).toEqual(
      ["author", "content", "created_at", "kind", "n"].sort(),
    );
    expect(d.count).toBe(4);
    expect(d.more).toBe(2);
    expect(d.retrieve).toBe("mu task notes t -w w --from 2");
  });

  it("show uses the same view; its JSON carries notes + more/retrieve beside task/blockers", async () => {
    note("BRIEF", "brief");
    for (let i = 1; i <= 5; i++) note(`n${i}`);
    const r = await runCliJson(["task", "show", "t", "-w", WS, "--json"], dbPath);
    const d = r.data as { notes: { n: number }[]; notes_more: number; notes_retrieve: string };
    expect(d.notes.map((n) => n.n)).toEqual([1, 4, 5, 6]);
    expect(d.notes_more).toBe(2);
    expect(d.notes_retrieve).toBe("mu task notes t -w w --from 2");
    const text = await runCli(["task", "show", "t", "-w", WS], dbPath);
    expect(text.stdout).toContain("Notes (6)");
    expect(text.stdout).toContain("more=2 next=mu task notes t -w w --from 2");
  });

  it("--from / --note outside the task's notes is exit 3 with the valid range; --all rejects filters", async () => {
    note("one");
    const a = await runCli(["task", "notes", "t", "-w", WS, "--from", "5"], dbPath);
    expect(a.exitCode).toBe(3);
    expect(a.stdout + a.stderr).toContain("1..1");
    const b = await runCli(["task", "show", "t", "-w", WS, "--note", "2"], dbPath);
    expect(b.exitCode).toBe(3);
    const c = await runCli(["task", "notes", "t", "-w", WS, "--all", "--tail", "1"], dbPath);
    expect(c.exitCode).toBe(2);
  });

  it("--tail keeps its meaning (last N of the history) and still prints records", async () => {
    for (let i = 1; i <= 5; i++) note(`n${i}`);
    const r = await runCli(["task", "notes", "t", "-w", WS, "--tail", "2"], dbPath);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(2);
    expect(r.stdout).toContain("\tn5");
  });
});

describe("the 4 KB cap is measured on the emitted bytes (CLI)", () => {
  const bytes = (s: string): number => Buffer.byteLength(s);

  it("JSON: envelope, record keys and footer count; paging --from still covers every note", async () => {
    for (let i = 1; i <= 20; i++) note(`row-${i} ${"a".repeat(300)}`);
    const seen: number[] = [];
    let args = ["--all"];
    for (let guard = 0; guard < 30; guard++) {
      const r = await runCli(["task", "notes", "t", "-w", WS, ...args, "--json"], dbPath);
      expect(bytes(r.stdout)).toBeLessThanOrEqual(4096);
      const d = (JSON.parse(r.stdout) as { data: { items: { n: number }[]; retrieve?: string } })
        .data;
      seen.push(...d.items.map((x) => x.n));
      const from = d.retrieve?.match(/--from (\d+)$/)?.[1];
      if (from === undefined) break;
      args = ["--from", from];
    }
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("JSON: the more/retrieve fields are inside the cap at every boundary", async () => {
    // Sweep the body length so some size lands just under 4096 without the footer.
    for (let pad = 0; pad < 40; pad++) {
      const id = `s${pad}`;
      addTask(db, { localId: id, workstream: WS, title: id, impact: 50, effortDays: 1 });
      for (let i = 1; i <= 6; i++) {
        addNote(db, id, `row-${i} ${"a".repeat(880 + pad)}`, { workstream: WS, author: "a" });
      }
      const r = await runCli(["task", "notes", id, "-w", WS, "--all", "--json"], dbPath);
      expect(bytes(r.stdout)).toBeLessThanOrEqual(4096);
    }
  });

  it("text: the more=/next= footer is inside the cap", async () => {
    for (let i = 1; i <= 4; i++) note(`row-${i} ${"a".repeat(1312)}`);
    const r = await runCli(["task", "notes", "t", "-w", WS], dbPath);
    expect(r.stdout).toContain("more=");
    expect(bytes(r.stdout)).toBeLessThanOrEqual(4096);
  });

  it("an oversized author is clipped in a stub; show --note prints it whole", async () => {
    const author = "author-".repeat(800);
    note("some body", "note", author);
    for (const extra of [[], ["--json"]]) {
      const r = await runCli(["task", "notes", "t", "-w", WS, ...extra], dbPath);
      expect(bytes(r.stdout)).toBeLessThanOrEqual(4096);
    }
    const stub = await runCli(["task", "notes", "t", "-w", WS], dbPath);
    expect(stub.stdout).toContain("cut=");
    const whole = await runCli(["task", "show", "t", "-w", WS, "--note", "1"], dbPath);
    expect(whole.stdout).toContain(author);
  });

  it("pinned content is exempt: everything but the pinned records fits 4 KB, in text and JSON", async () => {
    const brief = `B${"b".repeat(4800)}`;
    note(brief, "brief");
    for (let i = 1; i <= 12; i++) note(`mid-${i} ${"m".repeat(500)}`);
    note("R".repeat(4500), "report");
    for (let i = 1; i <= 6; i++) note(`late-${i} ${"l".repeat(900)}`);
    const text = await runCli(["task", "notes", "t", "-w", WS], dbPath);
    const lines = text.stdout.trimEnd().split("\n");
    expect(lines[0]).toContain(brief);
    expect(lines.some((l) => l.startsWith("report\t14\t") && l.includes("R".repeat(4500)))).toBe(
      true,
    );
    const rest = lines.filter((l) => !/^(brief|report|verdict)\t/.test(l));
    expect(bytes(`${rest.join("\n")}\n`)).toBeLessThanOrEqual(4096);
    const json = await runCliJson(["task", "notes", "t", "-w", WS, "--json"], dbPath);
    const d = json.data as { items: { kind: string }[]; more: number; retrieve?: string };
    const ordinary = d.items.filter((i) => i.kind === "note");
    const { items: _i, count: _c, ...fields } = d as Record<string, unknown>;
    expect(
      bytes(
        JSON.stringify({ ok: true, data: { items: ordinary, count: 0, ...fields }, next: null }),
      ),
    ).toBeLessThanOrEqual(4096);
    expect(d.more).toBeGreaterThan(0);
  });

  it("show: the notes block honours the same cap in text", async () => {
    for (let i = 1; i <= 4; i++) note(`row-${i} ${"a".repeat(1300)}`);
    const r = await runCli(["task", "show", "t", "-w", WS], dbPath);
    const block = r.stdout.slice(r.stdout.indexOf("Notes ("));
    expect(bytes(block)).toBeLessThanOrEqual(4096 + 16);
  });
});

describe("notes --all on a task with no notes (CLI)", () => {
  it("is success with an empty result; --from 1 and --note 1 stay exit 3", async () => {
    const j = await runCli(["task", "notes", "t", "-w", WS, "--all", "--json"], dbPath);
    expect(j.exitCode).toBe(null);
    expect((JSON.parse(j.stdout) as { data: unknown }).data).toEqual({
      items: [],
      count: 0,
      more: 0,
    });
    const t = await runCli(["task", "notes", "t", "-w", WS, "--all"], dbPath);
    expect(t.exitCode).toBe(null);
    expect(t.stdout).toContain("no notes");
    for (const argv of [
      ["task", "notes", "t", "-w", WS, "--from", "1"],
      ["task", "show", "t", "-w", WS, "--note", "1"],
    ]) {
      expect((await runCli(argv, dbPath)).exitCode).toBe(3);
    }
  });
});
