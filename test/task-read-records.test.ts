// Task reads as bounded records (README Interface: per-verb format, output caps).
// list / next / owned-by / me tasks / show / tree print one record per line (or one
// JSON item) with SQL column names, every result capped on its FINAL bytes, every
// cut naming the exact command that resumes. Real temp SQLite, in-process CLI.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import {
  escapeRecordText,
  jsonDocument,
  RECORD_CHARS,
  taskPage,
  taskRecordCut,
  taskToOutput,
} from "../src/cli/tasks/records.js";
import {
  FRONTIER_CLOSED_PER_NODE,
  FRONTIER_MAX_DEPTH,
  FRONTIER_MAX_NODES,
  loadOpenTaskFrontier,
} from "../src/dag.js";
import { type Db, openDb } from "../src/db.js";
import { RESULT_BYTES } from "../src/output-contract.js";
import {
  addBlockEdge,
  addNote,
  addTask,
  claimTask,
  closeTask,
  getTask,
  listTasks,
} from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { runCli, runCliJson } from "./_runCli.js";

const WS = "w";
let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-task-reads-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, WS);
});
afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

/** Split one shell command line the way a shell would (single/double quotes, no expansion). */
function shellSplit(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null = re.exec(line);
  while (m !== null) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3] ?? ""));
    m = re.exec(line);
  }
  return out;
}

/** The command a cut result prints (`next=` of the footer, or `retrieve` of the JSON data), as CLI argv. */
function printedArgv(stdout: string): string[] {
  const line = plain(stdout).trimEnd().split("\n").at(-1) ?? "";
  const m = /^(?:more=\d+ ?)?(?:cut=\d+ ?)?next=(mu .*)$/.exec(line);
  expect(m, `no footer in: ${line}`).not.toBeNull();
  const argv = shellSplit(m?.[1] ?? "");
  expect(argv[0]).toBe("mu");
  return argv.slice(1);
}
const retrieveArgv = (data: { retrieve?: string }): string[] => {
  expect(data.retrieve).toBeDefined();
  return shellSplit(data.retrieve ?? "").slice(1);
};

const bytes = (s: string): number => Buffer.byteLength(s);
const add = (id: string, title = id, extra: Record<string, unknown> = {}, ws = WS) =>
  addTask(db, { localId: id, workstream: ws, title, impact: 50, effortDays: 1, ...extra });
const rowOf = (id: string, ws = WS) => {
  const t = getTask(db, id, ws);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR strip
const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

const taskRecord = (...a: Parameters<typeof taskRecordCut>): string => taskRecordCut(...a).line;

describe("taskToOutput: the SQL-keyed boundary", () => {
  it("emits exactly the SQL columns; id is the local_id; FKs are the real numbers", () => {
    const task = (() => {
      add("alpha", "Alpha");
      return rowOf("alpha");
    })();
    const out = taskToOutput(task);
    expect(Object.keys(out).sort()).toEqual(
      [
        "id",
        "local_id",
        "workstream_id",
        "title",
        "status",
        "substate",
        "impact",
        "effort_days",
        "scored",
        "dispatch_host",
        "owner_id",
        "created_at",
        "updated_at",
        "kind",
        "wave",
      ].sort(),
    );
    expect(out.id).toBe("alpha");
    expect(out.local_id).toBe("alpha");
    const sql = db
      .prepare("SELECT id, workstream_id, owner_id FROM tasks WHERE local_id = 'alpha'")
      .get() as { id: number; workstream_id: number; owner_id: number | null };
    expect(out.workstream_id).toBe(sql.workstream_id);
    expect(out.owner_id).toBeNull();
    // The integer primary key is never output as `id` (distinguishable: ws id 1, task id 1 would collide).
    expect(typeof out.id).toBe("string");
    expect(out.scored).toBe(1);
  });

  it("owner is visible only while IN_PROGRESS; owner_id stays the real FK after close (history)", async () => {
    insertAgent(db, { name: "w1", workstream: WS, paneId: "%1" });
    add("t");
    await claimTask(db, "t", { agentName: "w1", workstream: WS });
    const agentId = (db.prepare("SELECT id FROM agents WHERE name='w1'").get() as { id: number })
      .id;
    const live = taskToOutput(rowOf("t"));
    expect(live).toMatchObject({ status: "IN_PROGRESS", owner: "w1", owner_id: agentId });
    closeTask(db, "t", { workstream: WS, evidence: "x" });
    const closed = taskToOutput(rowOf("t"));
    expect(closed.status).toBe("CLOSED");
    expect(closed).not.toHaveProperty("owner");
    expect(closed.owner_id).toBe(agentId);
    // The SDK keeps full-history attribution.
    expect(rowOf("t").ownerName).toBe("w1");
    const text = taskRecord(rowOf("t"));
    expect(text).not.toContain("owner=");
    expect(
      taskRecord(
        live === undefined
          ? rowOf("t")
          : { ...rowOf("t"), status: "IN_PROGRESS", substate: "active" },
      ),
    ).toContain("owner=w1");
  });
});

describe("escaping: one record is one inert line", () => {
  const nasty = "a\nb\tc\rd\\e\u001b[31mred\u0007\u0085\u2028\u202eevil\u0000";
  it("escapes line, tab, escape and bidi characters; records stay one line", () => {
    add("t", "plain");
    const r = taskRecord({ ...rowOf("t"), title: nasty });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(r).not.toMatch(/[\n\r\u001b\u0007\u0085\u2028\u202e\u0000]/);
    expect(r.split("\t")).toHaveLength(5);
    expect(r).toContain("a\\nb\\tc\\rd\\\\e");
    expect(r).toContain("\\u{1b}");
    expect(escapeRecordText("plain text")).toBe("plain text");
  });

  it("JSON stays one valid line with the terminal-active characters escaped", async () => {
    add("t");
    db.prepare("UPDATE tasks SET title = ? WHERE local_id = 't'").run(nasty);
    const r = await runCli(["task", "list", "-w", WS, "--json"], dbPath);
    const line = r.stdout.trimEnd();
    expect(line.split("\n")).toHaveLength(1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(line).not.toMatch(/[\u0085\u2028\u202e\u001b]/);
    const doc = JSON.parse(line) as { data: { items: { title: string }[] } };
    expect(doc.data.items[0]?.title).toBe(nasty);
  });
});

describe("list / next / owned-by records", () => {
  it("one record per task: kind id STATE key=value title, ready order from the kernel", async () => {
    add("lo", "Lo", {}, WS);
    db.prepare("UPDATE tasks SET impact = 10, scored = 1 WHERE local_id = 'lo'").run();
    add("hi", "Hi");
    db.prepare("UPDATE tasks SET impact = 90, scored = 1 WHERE local_id = 'hi'").run();
    const next = await runCli(["task", "next", "-w", WS, "-n", "0"], dbPath);
    expect(
      plain(next.stdout)
        .trimEnd()
        .split("\n")
        .map((l) => l.split("\t")[1]),
    ).toEqual(["hi", "lo"]);
    const list = await runCli(["task", "list", "-w", WS], dbPath);
    expect(plain(list.stdout).trimEnd().split("\n")[0]).toBe(
      "task\thi\tOPEN\timpact=90 effort_days=1\tHi",
    );
  });

  it("list accepts --all, --owner and --mine; --owner/--mine pick by the agent's real id", async () => {
    insertAgent(db, { name: "w1", workstream: WS, paneId: "%1" });
    ensureWorkstream(db, "other");
    insertAgent(db, { name: "w1", workstream: "other", paneId: "%2" });
    add("mine", "m");
    add("theirs", "t", {}, "other");
    add("free", "f");
    await claimTask(db, "mine", { agentName: "w1", workstream: WS });
    await claimTask(db, "theirs", { agentName: "w1", workstream: "other" });
    const ids = async (...argv: string[]) =>
      (await runCliJson(["task", "list", "--json", ...argv], dbPath)).data as {
        items: { id: string }[];
      };
    expect((await ids("-w", WS, "--all")).items.map((t) => t.id).sort()).toEqual(["free", "mine"]);
    expect((await ids("-w", WS, "--owner", "w1")).items.map((t) => t.id)).toEqual(["mine"]);
    // A qualified owner names the other workstream's same-named agent.
    expect((await ids("-w", "other", "--owner", "other/w1")).items.map((t) => t.id)).toEqual([
      "theirs",
    ]);
    // The owner's workstream is the qualified prefix, not the scope: a task of `w` owned by
    // other/w1 (task claim --for other/w1) is found by `-w w --owner other/w1`, not by `w1`.
    add("cross", "x");
    const otherW1 = db
      .prepare(
        "SELECT a.id FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.name = 'w1' AND ws.name = 'other'",
      )
      .get() as { id: number };
    db.prepare(
      "UPDATE tasks SET owner_id = ?, status = 'IN_PROGRESS', substate = 'active' WHERE local_id = 'cross' AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)",
    ).run(otherW1.id, WS);
    expect((await ids("-w", WS, "--owner", "other/w1")).items.map((t) => t.id)).toEqual(["cross"]);
    expect((await ids("-w", WS, "--owner", "w1")).items.map((t) => t.id)).toEqual(["mine"]);
    // --mine is the calling agent (spawn-injected identity), by its real id.
    await withEnv("MU_MANAGED_AGENT", "1", () =>
      withEnv("MU_AGENT_NAME", "w1", () =>
        withEnv("MU_WORKSTREAM", "other", async () => {
          expect((await ids("-w", "other", "--mine")).items.map((t) => t.id)).toEqual(["theirs"]);
        }),
      ),
    );
    const missing = await runCli(["task", "list", "-w", WS, "--owner", "ghost"], dbPath);
    expect(missing.exitCode).toBe(3);
    const both = await runCli(["task", "list", "-w", WS, "--owner", "w1", "--mine"], dbPath);
    expect(both.exitCode).toBe(2);
  });

  it("owned-by --all names the workstream of each record; same-named agents stay distinct", async () => {
    insertAgent(db, { name: "w1", workstream: WS, paneId: "%1" });
    ensureWorkstream(db, "other");
    insertAgent(db, { name: "w1", workstream: "other", paneId: "%2" });
    add("a1");
    add("b1", "b1", {}, "other");
    await claimTask(db, "a1", { agentName: "w1", workstream: WS });
    await claimTask(db, "b1", { agentName: "w1", workstream: "other" });
    const scoped = await runCli(["task", "owned-by", "w1", "-w", WS], dbPath);
    expect(plain(scoped.stdout)).toContain("task\ta1\t");
    expect(plain(scoped.stdout)).not.toContain("b1");
    const all = await runCli(["task", "owned-by", "w1", "--all"], dbPath);
    expect(plain(all.stdout)).toMatch(/task\ta1\tIN_PROGRESS\t.*ws=w\b/);
    expect(plain(all.stdout)).toMatch(/task\tb1\tIN_PROGRESS\t.*ws=other\b/);
    const json = (await runCliJson(["task", "owned-by", "w1", "--all", "--json"], dbPath)).data as {
      items: { id: string; workstream: string; owner_id: number }[];
    };
    expect(json.items.map((i) => `${i.workstream}/${i.id}`)).toEqual(["other/b1", "w/a1"]);
    expect(new Set(json.items.map((i) => i.owner_id)).size).toBe(2);
  });
});

describe("caps: the FINAL output is <= 4 KB, a record <= 400 characters, a cut names its way back", () => {
  it("a long list is cut to 4 KB; the printed next command (--all) returns every task whole", async () => {
    for (let i = 0; i < 90; i++)
      add(`t${String(i).padStart(3, "0")}`, `Title ${i} ${"w".repeat(80)}`);
    const r = await runCli(["task", "list", "-w", WS], dbPath);
    const lines = plain(r.stdout).trimEnd().split("\n");
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const records = lines.filter((l) => l.startsWith("task\t"));
    for (const l of records) expect([...l].length).toBeLessThanOrEqual(RECORD_CHARS);
    expect(lines.at(-1)).toBe(`more=${90 - records.length} next=mu task list -w w --all`);
    const all = await runCli(printedArgv(r.stdout), dbPath);
    const whole = plain(all.stdout).trimEnd().split("\n");
    expect(whole).toHaveLength(90);
    expect(whole.map((l) => l.split("\t")[1])).toEqual(
      Array.from({ length: 90 }, (_, i) => `t${String(i).padStart(3, "0")}`),
    );
    expect(whole.every((l, i) => l.endsWith(`Title ${i} ${"w".repeat(80)}`))).toBe(true);
  });

  it("--json: the document is <= 4 KB with more and retrieve; retrieve (--json --all) returns everything", async () => {
    for (let i = 0; i < 60; i++)
      add(`j${String(i).padStart(2, "0")}`, `Json ${i} ${"y".repeat(100)}`);
    const first = await runCli(["task", "list", "-w", WS, "--json"], dbPath);
    expect(bytes(first.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const d = (
      JSON.parse(first.stdout) as {
        data: { items: { id: string }[]; count: number; more: number; retrieve: string };
      }
    ).data;
    expect(d.count).toBe(d.items.length);
    expect(d.more).toBe(60 - d.count);
    expect(d.retrieve).toBe("mu task list -w w --json --all");
    const all = (await runCliJson(retrieveArgv(d), dbPath)).data as {
      items: { id: string; title: string }[];
      more: number;
      retrieve?: string;
    };
    expect(all.items).toHaveLength(60);
    expect(all.more).toBe(0);
    expect(all.retrieve).toBeUndefined();
    expect(all.items[59]?.title).toBe(`Json 59 ${"y".repeat(100)}`);
  });

  it("an oversized title is clipped inside the record cap; footer cut=N and --all print it whole", async () => {
    add("big", "q".repeat(2000));
    const r = await runCli(["task", "list", "-w", WS], dbPath);
    const lines = plain(r.stdout).trimEnd().split("\n");
    const line = lines[0] ?? "";
    expect([...line].length).toBeLessThanOrEqual(RECORD_CHARS);
    expect(line.endsWith("…")).toBe(true);
    const foot = /^cut=(\d+) next=mu task list -w w --all$/.exec(lines[1] ?? "");
    expect(foot).not.toBeNull();
    const shownTitle = line.split("\t")[4] ?? "";
    expect([...shownTitle].length - 1 + Number(foot?.[1])).toBe(2000);
    const all = await runCli(printedArgv(r.stdout), dbPath);
    expect(plain(all.stdout).trimEnd()).toMatch(/\tq{2000}$/);
    expect(plain(all.stdout)).not.toContain("cut=");
  });

  it("--json clips a long title the same way: bounded item, data.cut and retrieve (--json --all) returns it whole", async () => {
    add("bigj", "q".repeat(2000));
    const r = await runCli(["task", "list", "-w", WS, "--json"], dbPath);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const data = (
      JSON.parse(r.stdout) as {
        data: { items: { title: string }[]; cut: number; retrieve: string };
      }
    ).data;
    const title = data.items[0]?.title ?? "";
    expect([...title].length).toBeLessThan(200);
    expect(data.cut + [...title].length - 1).toBe(2000);
    expect(data.retrieve).toBe("mu task list -w w --json --all");
    const whole = (await runCliJson(retrieveArgv(data), dbPath)).data as {
      items: { title: string }[];
      cut?: number;
    };
    expect(whole.items[0]?.title).toBe("q".repeat(2000));
    expect(whole.cut).toBeUndefined();
  });

  it("a title too long even for show: show stays <= 4 KB and its --all returns the title whole", async () => {
    const title = "z".repeat(5000);
    add("huge", title);
    const show = await runCli(["task", "show", "huge", "-w", WS], dbPath);
    expect(bytes(show.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(plain(show.stdout).trimEnd()).toMatch(/\ncut=\d+ next=mu task show huge -w w --all$/);
    const whole = await runCli(printedArgv(show.stdout), dbPath);
    expect(plain(whole.stdout).split("\n")[0]).toMatch(/\tz{5000}$/);
  });

  it("property: any mix of titles and modes stays within the caps; --all returns every row whole", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            len: fc.oneof(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 1500 })),
            ch: fc.constantFrom("a", "é", "😀", "\n", "\\", "\t", "\u202e", "\u001b", "\u0085"),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        fc.boolean(),
        (specs, json) => {
          const base = rowOf(ensure());
          const rows = specs.map((s, i) => ({
            ...base,
            name: `p${i}`,
            title: s.ch.repeat(s.len),
          }));
          const out = taskPage(rows, { all: false, json, next: "mu task list --all" });
          const text = json ? jsonDocument(out.data) : out.lines.join("\n");
          expect(out.shown).toBeGreaterThan(0);
          expect(out.shown + out.more).toBe(rows.length);
          // The cap is on the printed bytes; the one exception is a single (bounded) record.
          if (out.shown > 1) expect(bytes(text) + 1).toBeLessThanOrEqual(RESULT_BYTES);
          // The footer (the way back) is never sliced.
          if (!json && (out.more > 0 || out.lines.some((l) => l.startsWith("cut=")))) {
            expect(out.lines.some((l) => /next=mu task list --all$/.test(l))).toBe(true);
          }
          if (!json) {
            for (const l of out.lines.filter((x) => x.startsWith("task\t"))) {
              expect([...l].length).toBeLessThanOrEqual(RECORD_CHARS);
              // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
              expect(l).not.toMatch(/[\n\r\u202e\u001b\u0085]/);
            }
          }
          const everything = taskPage(rows, { all: true, json, next: "x" });
          expect(everything.shown).toBe(rows.length);
          expect(everything.more).toBe(0);
          if (json) {
            expect(everything.data?.items.map((i) => i.title)).toEqual(rows.map((r) => r.title));
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

function ensure(): string {
  const have = db
    .prepare(
      "SELECT 1 FROM tasks WHERE local_id = 'x' AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)",
    )
    .get(WS);
  if (!have) add("x");
  return "x";
}

describe("show: one record, edges, notes, all under 4 KB", () => {
  it("whole-output cap: task record, edges and ordinary notes together; pinned notes are exempt; --all returns everything", async () => {
    add("hub", "Hub");
    for (let i = 0; i < 80; i++) {
      add(`dep${String(i).padStart(2, "0")}`, `Dependent ${i} ${"d".repeat(60)}`);
      addBlockEdge(db, WS, `dep${String(i).padStart(2, "0")}`, "hub");
    }
    addNote(db, "hub", `BRIEF ${"B".repeat(3000)}`, { workstream: WS, kind: "brief", author: "o" });
    for (let i = 0; i < 6; i++)
      addNote(db, "hub", `note ${i} ${"n".repeat(900)}`, { workstream: WS, author: "a" });
    const r = await runCli(["task", "show", "hub", "-w", WS], dbPath);
    const lines = plain(r.stdout).trimEnd().split("\n");
    const rest = lines.filter((l) => !/^brief\t/.test(l));
    expect(bytes(`${rest.join("\n")}\n`)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(lines[0]).toMatch(/^task\thub\tOPEN\t/);
    expect(lines.some((l) => /^brief\t.*B{3000}/.test(l))).toBe(true);
    expect(lines.filter((l) => /^dependent\t/.test(l)).length).toBeLessThan(80);
    expect(lines.some((l) => /^more=\d+ next=mu task show hub -w w --all$/.test(l))).toBe(true);
    // The printed command returns every neighbour and every note whole.
    const all = await runCli(printedArgv(r.stdout), dbPath);
    const whole = plain(all.stdout).trimEnd().split("\n");
    expect(whole.filter((l) => /^dependent\t/.test(l))).toHaveLength(80);
    expect(whole.filter((l) => /^(brief|note)\t/.test(l))).toHaveLength(7);
    expect(whole.some((l) => l.startsWith("more="))).toBe(false);
  });

  it("--json: the document is <= 4 KB (task, edges, retrieve, envelope), keeps task.revision; retrieve (--json --all) returns everything", async () => {
    add("hub", "Hub");
    for (let i = 0; i < 80; i++) {
      add(`d${String(i).padStart(2, "0")}`, `D${i}`);
      addBlockEdge(db, WS, `d${String(i).padStart(2, "0")}`, "hub");
    }
    for (let i = 0; i < 6; i++)
      addNote(db, "hub", `n${i} ${"n".repeat(900)}`, { workstream: WS, author: "a" });
    const r = await runCli(["task", "show", "hub", "-w", WS, "--json"], dbPath);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const d = (JSON.parse(r.stdout) as { data: Record<string, unknown> }).data as {
      task: { revision: number; id: string; workstream: string };
      dependents: unknown[];
      edges_more: number;
      retrieve: string;
    };
    expect(d.task).toMatchObject({ id: "hub", workstream: "w" });
    expect(typeof d.task.revision).toBe("number");
    expect(d.edges_more).toBe(80 - d.dependents.length);
    expect(d.retrieve).toBe("mu task show hub -w w --json --all");
    const all = (await runCliJson(retrieveArgv(d), dbPath)).data as {
      dependents: unknown[];
      edges_more: number;
      notes: unknown[];
    };
    expect(all.dependents).toHaveLength(80);
    expect(all.edges_more).toBe(0);
    expect(all.notes).toHaveLength(6);
  });

  it("a long title is clipped inside show; footer cut=N and --all return it whole; JSON agrees", async () => {
    add("longt", "L".repeat(3000));
    const t = await runCli(["task", "show", "longt", "-w", WS], dbPath);
    expect(bytes(t.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(plain(t.stdout).trimEnd().split("\n").at(-1)).toMatch(
      /^cut=\d+ next=mu task show longt -w w --all$/,
    );
    const whole = await runCli(printedArgv(t.stdout), dbPath);
    expect(plain(whole.stdout).split("\n")[0]).toMatch(/\tL{3000}$/);
    const j = await runCli(["task", "show", "longt", "-w", WS, "--json"], dbPath);
    expect(bytes(j.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const d = (JSON.parse(j.stdout) as { data: { cut: number; retrieve: string } }).data;
    expect(d.cut).toBeGreaterThan(0);
    const all = (await runCliJson(retrieveArgv(d), dbPath)).data as {
      task: { title: string };
      cut?: number;
    };
    expect(all.task.title).toBe("L".repeat(3000));
    expect(all.cut).toBeUndefined();
  });
});

describe("tree: the open DAG, bounded", () => {
  it("one umbrella with many CLOSED children costs a few lines, not the whole history", () => {
    add("umbrella", "U");
    for (let i = 0; i < 300; i++) {
      add(`done${i}`, `Done ${i}`);
      addBlockEdge(db, WS, "umbrella", `done${i}`);
    }
    for (let i = 0; i < 300; i++) closeTask(db, `done${i}`, { workstream: WS, evidence: "x" });
    for (let i = 0; i < 3; i++) {
      add(`open${i}`, `Open ${i}`);
      addBlockEdge(db, WS, "umbrella", `open${i}`);
    }
    const f = loadOpenTaskFrontier(db, WS, "umbrella", "blockers");
    const ids = f.entries.map((e) => e.task.name);
    expect(ids.filter((id) => id.startsWith("open"))).toHaveLength(3);
    expect(ids.filter((id) => id.startsWith("done"))).toHaveLength(FRONTIER_CLOSED_PER_NODE);
    expect(f.entries[0]?.closed).toBe(300 - FRONTIER_CLOSED_PER_NODE);
  });

  it("CLI: --down from a root lists the open dependents; the footer's --all returns the closed ones", async () => {
    add("root", "R");
    for (let i = 0; i < 6; i++) {
      add(`c${i}`, `C${i}`);
      addBlockEdge(db, WS, `c${i}`, "root");
      closeTask(db, `c${i}`, { workstream: WS, as: "wontfix", why: "n/a" });
    }
    add("live", "Live");
    addBlockEdge(db, WS, "live", "root");
    const r = await runCli(["task", "tree", "root", "--down", "-w", WS], dbPath);
    const out = plain(r.stdout);
    expect(out).toContain("task\tlive\tOPEN\t");
    expect(out).toMatch(
      new RegExp(`^task\\troot\\t.*\\bclosed=${6 - FRONTIER_CLOSED_PER_NODE}\\b`, "m"),
    );
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      `more=${6 - FRONTIER_CLOSED_PER_NODE} next=mu task tree root -w w --down --all`,
    );
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const all = await runCli(printedArgv(r.stdout), dbPath);
    expect(plain(all.stdout).match(/^task\tc\d\tCLOSED/gm)).toHaveLength(6);
    expect(plain(all.stdout)).not.toMatch(/^more=/m);
  });

  it("a CLOSED root still expands; CLOSED neighbours are leaves", () => {
    add("r");
    add("m");
    add("leaf");
    addBlockEdge(db, WS, "m", "r");
    addBlockEdge(db, WS, "leaf", "m");
    for (const id of ["leaf", "m", "r"]) {
      closeTask(db, id, { workstream: WS, as: "wontfix", why: "n/a" });
    }
    const f = loadOpenTaskFrontier(db, WS, "r", "dependents");
    // r expands to m (CLOSED leaf); m does not expand to leaf.
    expect(f.entries.map((e) => e.task.name)).toEqual(["r", "m"]);
    expect(f.entries[1]?.kids).toBe(0);
    const all = loadOpenTaskFrontier(db, WS, "r", "dependents", { includeClosed: true });
    expect(all.entries.map((e) => e.task.name)).toEqual(["r", "m", "leaf"]);
  });

  it("without a root: the starts are open tasks no open task blocks; CLOSED history is out", () => {
    add("old");
    add("a");
    add("b");
    addBlockEdge(db, WS, "a", "old");
    addBlockEdge(db, WS, "b", "a");
    closeTask(db, "old", { workstream: WS, evidence: "x" });
    const f = loadOpenTaskFrontier(db, WS, undefined, "dependents");
    expect(f.entries.map((e) => [e.task.name, e.depth])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("depth cap: the node at the cap says how many open tasks hang below it", () => {
    for (let i = 0; i < FRONTIER_MAX_DEPTH + 5; i++) {
      add(`n${i}`);
      if (i > 0) addBlockEdge(db, WS, `n${i}`, `n${i - 1}`);
    }
    const f = loadOpenTaskFrontier(db, WS, "n0", "dependents");
    expect(f.entries).toHaveLength(FRONTIER_MAX_DEPTH + 1);
    expect(f.entries.at(-1)).toMatchObject({ depth: FRONTIER_MAX_DEPTH, kids: 1 });
    const shallow = loadOpenTaskFrontier(db, WS, "n0", "dependents", { maxDepth: 3 });
    expect(shallow.entries).toHaveLength(4);
  });

  it("node cap: breadth beyond it is counted on the parent, never listed", () => {
    add("hub");
    const n = 40;
    for (let i = 0; i < n; i++) {
      add(`k${String(i).padStart(2, "0")}`);
      addBlockEdge(db, WS, `k${String(i).padStart(2, "0")}`, "hub");
    }
    // Cap by listing: FRONTIER_MAX_NODES is far above this, so everything is listed.
    const f = loadOpenTaskFrontier(db, WS, "hub", "dependents");
    expect(f.entries).toHaveLength(n + 1);
    expect(FRONTIER_MAX_NODES).toBeGreaterThan(n);
  });

  it("diamonds list once then recur; a cycle (sync can create one) terminates", () => {
    add("a");
    add("d");
    add("e");
    add("f");
    for (const [x, y] of [
      ["d", "a"],
      ["e", "a"],
      ["f", "d"],
      ["f", "e"],
    ] as const)
      addBlockEdge(db, WS, x, y);
    const f = loadOpenTaskFrontier(db, WS, "a", "dependents");
    expect(f.entries.filter((e) => e.task.name === "f")).toHaveLength(2);
    expect(f.entries.filter((e) => e.again)).toHaveLength(1);
    // Force a cycle f -> a past the guard.
    const ids = (n: string) =>
      (db.prepare("SELECT id FROM tasks WHERE local_id = ?").get(n) as { id: number }).id;
    db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    ).run(ids("f"), ids("a"), new Date().toISOString());
    const cyc = loadOpenTaskFrontier(db, WS, "a", "dependents");
    expect(cyc.entries.length).toBeLessThan(20);
    expect(cyc.entries.some((e) => e.again && e.task.name === "a")).toBe(true);
  });

  it("bounded SQL: the reads per tree do not grow with the task count (fixture shape: 1781 roots / 57 open)", () => {
    // 1781 closed history roots, 57 open chained tasks.
    const insert = db.prepare(
      `INSERT INTO tasks (workstream_id, local_id, title, status, substate, impact, effort_days, created_at, updated_at)
       VALUES ((SELECT id FROM workstreams WHERE name = ?), ?, ?, ?, ?, 50, 1, ?, ?)`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (let i = 0; i < 1781; i++) insert.run(WS, `h${i}`, `H${i}`, "CLOSED", "done", now, now);
      for (let i = 0; i < 57; i++) insert.run(WS, `o${i}`, `O${i}`, "OPEN", "todo", now, now);
    })();
    // Six chains of ~10 (the open work of a real umbrella), depth under the cap.
    for (let i = 0; i < 57; i++) if (i % 10 !== 0) addBlockEdge(db, WS, `o${i}`, `o${i - 1}`);
    let prepares = 0;
    const counted = new Proxy(db, {
      get(target, p) {
        const v = Reflect.get(target, p);
        if (p === "prepare")
          return (...a: Parameters<Db["prepare"]>) => {
            prepares++;
            return target.prepare(...a);
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const f = loadOpenTaskFrontier(counted, WS, undefined, "dependents");
    expect(f.entries.map((e) => e.task.name)).toEqual(
      Array.from({ length: 57 }, (_, i) => `o${i}`),
    );
    expect(prepares).toBeLessThanOrEqual(FRONTIER_MAX_DEPTH + 6);
    expect(listTasks(db, WS)).toHaveLength(1838);
  });

  it("cross-workstream edges never leak into a tree (workstream isolation)", () => {
    ensureWorkstream(db, "other");
    add("mine");
    add("foreign", "F", {}, "other");
    const id = (n: string) =>
      (db.prepare("SELECT id FROM tasks WHERE local_id = ?").get(n) as { id: number }).id;
    db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    ).run(id("mine"), id("foreign"), new Date().toISOString());
    expect(
      loadOpenTaskFrontier(db, WS, "mine", "dependents").entries.map((e) => e.task.name),
    ).toEqual(["mine"]);
  });

  it("CLI tree: a wide tree is cut to 4 KB; the printed next command (--all) lists every entry", async () => {
    add("hub", "H");
    for (let i = 0; i < 150; i++) {
      add(`s${String(i).padStart(3, "0")}`, `Spoke ${i} ${"s".repeat(60)}`);
      addBlockEdge(db, WS, `s${String(i).padStart(3, "0")}`, "hub");
    }
    const r = await runCli(["task", "tree", "hub", "--down", "-w", WS], dbPath);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const lines = plain(r.stdout).trimEnd().split("\n");
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(RECORD_CHARS);
    expect(lines.at(-1)).toMatch(/^more=\d+ next=mu task tree hub -w w --down --all$/);
    const all = await runCli(printedArgv(r.stdout), dbPath);
    const ids = plain(all.stdout)
      .trimEnd()
      .split("\n")
      .filter((l) => l.startsWith("task\t"))
      .map((l) => l.split("\t")[1]);
    expect(ids).toHaveLength(151);
    expect(new Set(ids).size).toBe(151);
  });
});

describe("tree --json is cut like the text form", () => {
  it("the document is <= 4 KB; retrieve (--json --all) is the whole tree", async () => {
    add("hub", "H");
    for (let i = 0; i < 90; i++) {
      add(`s${String(i).padStart(2, "0")}`, `Spoke ${i} ${"s".repeat(80)}`);
      addBlockEdge(db, WS, `s${String(i).padStart(2, "0")}`, "hub");
    }
    const r = await runCli(["task", "tree", "hub", "--down", "-w", WS, "--json"], dbPath);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const d = (
      JSON.parse(r.stdout) as {
        data: { items: { id: string }[]; count: number; more: number; retrieve?: string };
      }
    ).data;
    expect(d.more).toBe(91 - d.count);
    expect(d.retrieve).toBe("mu task tree hub -w w --down --json --all");
    const all = (await runCliJson(retrieveArgv(d), dbPath)).data as {
      items: { id: string }[];
      more: number;
      retrieve?: string;
    };
    expect(all.items).toHaveLength(91);
    expect(new Set(all.items.map((i) => i.id)).size).toBe(91);
    expect(all.more).toBe(0);
    expect(all.retrieve).toBeUndefined();
  });
});

describe("show keeps the revision metadata and the owner of an anonymous claim", () => {
  it("record carries rev=; an anonymous claim shows self=<actor>", async () => {
    add("t");
    const r = await runCli(["task", "show", "t", "-w", WS], dbPath);
    expect(plain(r.stdout).split("\n")[0]).toMatch(/ rev=\d+\t/);
  });
});

// ─── Round 2: the seven reviewer repros (every cut has a working way back) ───

const longLit = (n: number, ch = "w") => ch.repeat(n);
const rawTask = (id: string, title: string, status = "OPEN", ws = WS): number => {
  const now = new Date().toISOString();
  const substate = status === "CLOSED" ? "done" : "todo";
  return Number(
    db
      .prepare(
        `INSERT INTO tasks (workstream_id, local_id, title, status, substate, impact, effort_days, created_at, updated_at)
         VALUES ((SELECT id FROM workstreams WHERE name = ?), ?, ?, ?, ?, 50, 1, ?, ?)`,
      )
      .run(ws, id, title, status, substate, now, now).lastInsertRowid,
  );
};

describe("round 2 (simplified): every cut's one way back is the same command with --all", () => {
  it("list: a 2000-char title is whole under the printed command, in text and JSON", async () => {
    add("long", "t".repeat(2000));
    const text = await runCli(["task", "list", "-w", WS], dbPath);
    const all = await runCli(printedArgv(text.stdout), dbPath);
    expect(plain(all.stdout).trimEnd()).toMatch(/\tt{2000}$/);
    const json = await runCliJson(["task", "list", "-w", WS, "--json"], dbPath);
    const whole = (await runCliJson(retrieveArgv(json.data as { retrieve?: string }), dbPath))
      .data as { items: { title: string }[] };
    expect(whole.items[0]?.title).toBe("t".repeat(2000));
    const show = await runCliJson(["task", "show", "long", "-w", WS, "--json"], dbPath);
    const sd = (await runCliJson(retrieveArgv(show.data as { retrieve?: string }), dbPath))
      .data as {
      task: { title: string };
    };
    expect(sd.task.title).toBe("t".repeat(2000));
  });

  it("wave / dispatch_host clipped under a short title: cut counts them, --all returns them whole (text and JSON, list and show)", async () => {
    add("fields", "Short");
    db.prepare("UPDATE tasks SET wave = ?, dispatch_host = ? WHERE local_id = 'fields'").run(
      longLit(300, "w"),
      longLit(300, "h"),
    );
    // text: list and show
    for (const argv of [
      ["task", "list", "-w", WS],
      ["task", "show", "fields", "-w", WS],
    ]) {
      const r = await runCli(argv, dbPath);
      const lines = plain(r.stdout).trimEnd().split("\n");
      expect(lines[0]?.endsWith("\tShort"), argv.join(" ")).toBe(true);
      expect(lines.at(-1)).toMatch(/^cut=520 next=mu task (list|show fields) -w w( --all)?$/);
      expect(Number(/cut=(\d+)/.exec(lines.at(-1) ?? "")?.[1])).toBe(2 * (300 - 40));
      const all = plain((await runCli(printedArgv(r.stdout), dbPath)).stdout);
      expect(all).toContain(`wave=${longLit(300, "w")} host=${longLit(300, "h")}`);
      expect(all).not.toContain("cut=");
    }
    // JSON: list and show
    for (const argv of [
      ["task", "list", "-w", WS, "--json"],
      ["task", "show", "fields", "-w", WS, "--json"],
    ]) {
      const d = (await runCliJson(argv, dbPath)).data as { cut: number; retrieve: string };
      expect(d.cut).toBe(2 * (300 - 79));
      const all = (await runCliJson(retrieveArgv(d), dbPath)).data as {
        items?: { wave: string; dispatch_host: string }[];
        task?: { wave: string; dispatch_host: string };
        cut?: number;
      };
      const t = all.items?.[0] ?? all.task;
      expect(t?.wave).toBe(longLit(300, "w"));
      expect(t?.dispatch_host).toBe(longLit(300, "h"));
      expect(all.cut).toBeUndefined();
    }
  });
});

describe("round 2: tree text is the record grammar", () => {
  it("every line is `tree|task|more<TAB>id...`; entries carry depth= and parent=; DAG order and recurrences stay", async () => {
    add("a");
    add("d");
    add("e");
    add("f");
    for (const [x, y] of [
      ["d", "a"],
      ["e", "a"],
      ["f", "d"],
      ["f", "e"],
    ] as const)
      addBlockEdge(db, WS, x, y);
    const r = await runCli(["task", "tree", "a", "--down", "-w", WS], dbPath);
    const lines = r.stdout.trimEnd().split("\n");
    for (const l of lines) expect(l).toMatch(/^(tree|task|more)\t[^\t]+\t/);
    const tasks = lines.filter((l) => l.startsWith("task\t")).map((l) => l.split("\t"));
    for (const t of tasks) {
      expect(t[2]).toMatch(/^(OPEN|IN_PROGRESS|CLOSED)/);
      expect(t[3]).toMatch(/\bdepth=\d+\b/);
    }
    expect(tasks.map((t) => t[1])).toEqual(["a", "d", "f", "e", "f"]);
    expect(tasks[4]?.[3]).toMatch(/again=1/);
    expect(tasks[2]?.[3]).toMatch(/depth=2 parent=d/);
    expect(r.stdout).not.toMatch(/[├└│]/);
  });
});

describe("round 2: node-capped tree: --all is the way back", () => {
  it("a parent with more children than the node cap says capped=K; --all lists every child", async () => {
    const hub = rawTask("hub", "H");
    const n = FRONTIER_MAX_NODES + 50;
    const edge = db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const id = rawTask(`s${String(i).padStart(4, "0")}`, "x");
        edge.run(hub, id, now);
      }
    })();
    const f = loadOpenTaskFrontier(db, WS, "hub", "dependents");
    expect(f.entries[0]?.capCut).toBeGreaterThan(0);
    const r = await runCliJson(["task", "tree", "hub", "--down", "-w", WS, "--json"], dbPath);
    const d = r.data as { items: Record<string, unknown>[]; more: number; retrieve: string };
    expect(d.items[0]?.capped).toBe(f.entries[0]?.capCut);
    expect(d.retrieve).toBe("mu task tree hub -w w --down --json --all");
    const t = await runCli(["task", "tree", "hub", "--down", "-w", WS], dbPath);
    expect(t.stdout).toMatch(
      new RegExp(`^task\\thub\\t.*\\bcapped=${f.entries[0]?.capCut}\\b`, "m"),
    );
    const all = (await runCliJson(retrieveArgv(d), dbPath)).data as {
      items: { id: string }[];
      more: number;
    };
    expect(all.items).toHaveLength(n + 1);
    expect(new Set(all.items.map((i) => i.id)).size).toBe(n + 1);
    expect(all.more).toBe(0);
    const allText = await runCli(printedArgv(t.stdout), dbPath);
    expect(plain(allText.stdout).match(/^task\t/gm)).toHaveLength(n + 1);
  });
});

describe("round 2: tree depth cap holds for the shared DAG's preorder walk", () => {
  it("a chain every node of which is also a direct child never lists past FRONTIER_MAX_DEPTH; --all lists the rest", async () => {
    add("depthroot");
    const n = 30;
    const name = (i: number) => `d${String(i).padStart(2, "0")}`;
    for (let i = 0; i < n; i++) {
      add(name(i));
      addBlockEdge(db, WS, name(i), "depthroot");
      if (i > 0) addBlockEdge(db, WS, name(i), name(i - 1));
    }
    const f = loadOpenTaskFrontier(db, WS, "depthroot", "dependents");
    expect(Math.max(...f.entries.map((e) => e.depth))).toBeLessThanOrEqual(FRONTIER_MAX_DEPTH);
    const deepest = f.entries.filter((e) => e.depth === FRONTIER_MAX_DEPTH);
    expect(deepest.length).toBeGreaterThan(0);
    expect(deepest.every((e) => e.kids > 0)).toBe(true);
    const r = await runCliJson(["task", "tree", "depthroot", "--down", "-w", WS, "--json"], dbPath);
    const d = r.data as { items: { depth: number }[]; retrieve: string };
    expect(Math.max(...d.items.map((i) => i.depth))).toBeLessThanOrEqual(FRONTIER_MAX_DEPTH);
    // The way back is uncapped: every level, no node left under a cap.
    const all = (await runCliJson(retrieveArgv(d), dbPath)).data as {
      items: { id: string; depth: number; kids?: number }[];
      more: number;
    };
    expect(Math.max(...all.items.map((i) => i.depth))).toBe(n);
    expect(all.items.some((i) => (i.kids ?? 0) > 0)).toBe(false);
    expect(all.more).toBe(0);
  });
});

describe("round 2: a tree's one way back is --all, in either direction and either mode", () => {
  it("a 22-deep chain: the depth-capped read names --all (--json kept); the --all read reaches the tail", async () => {
    const name = (i: number) => `chain${String(i).padStart(2, "0")}`;
    add("chainroot");
    for (let i = 0; i < 22; i++) {
      add(name(i));
      addBlockEdge(db, WS, name(i), i === 0 ? "chainroot" : name(i - 1));
    }
    for (const dir of [[], ["--json"]]) {
      const capped = await runCli(
        ["task", "tree", "chainroot", "--down", "-w", WS, ...dir],
        dbPath,
      );
      const cmd = shellSplit(
        /next=(mu .*)$/m.exec(plain(capped.stdout))?.[1] ??
          (JSON.parse(capped.stdout) as { data: { retrieve: string } }).data.retrieve,
      ).slice(1);
      expect(cmd).toEqual(["task", "tree", "chainroot", "-w", WS, "--down", ...dir, "--all"]);
      const all = await runCli(cmd, dbPath);
      expect(all.stdout).toContain(name(21));
      expect(all.stdout).not.toMatch(/more=/);
    }
  });

  it("an all-CLOSED chain: --all walks it to the tail, blockers and dependents, text and JSON", async () => {
    const name = (i: number) => `chain${String(i).padStart(2, "0")}`;
    add("chainroot");
    for (let i = 0; i < 22; i++) {
      add(name(i));
      addBlockEdge(db, WS, name(i), i === 0 ? "chainroot" : name(i - 1));
    }
    for (const id of ["chainroot", ...Array.from({ length: 22 }, (_, i) => name(i))])
      closeTask(db, id, { workstream: WS, evidence: "x" });
    for (const dir of [[], ["--json"]]) {
      const down = await runCli(
        ["task", "tree", "chainroot", "--down", "--all", "-w", WS, ...dir],
        dbPath,
      );
      expect(down.stdout).toContain(name(21));
      const up = await runCli(["task", "tree", name(21), "--all", "-w", WS, ...dir], dbPath);
      expect(up.stdout).toContain("chainroot");
    }
  });
});

describe("round 3: the four round-2 reviewer repros; each printed next command is run and returns the full content", () => {
  it("tree_command_cut: maximum names and long metadata: the footer is whole and runs (text)", async () => {
    const wsName = "x".repeat(32);
    const rootId = `y${"y".repeat(63)}`;
    const depId = `z${"z".repeat(63)}`;
    ensureWorkstream(db, wsName);
    add(rootId, "Z".repeat(5000), {}, wsName);
    add(depId, "Q".repeat(5000), {}, wsName);
    db.prepare(
      "UPDATE tasks SET status = 'IN_PROGRESS', substate = 'active', dispatch_host = ?, wave = ? WHERE local_id = ?",
    ).run("h".repeat(300), "w".repeat(300), rootId);
    addBlockEdge(db, wsName, depId, rootId);
    const r = await runCli(["task", "tree", rootId, "--down", "-w", wsName], dbPath);
    expect(r.exitCode).toBeNull();
    const lines = plain(r.stdout).trimEnd().split("\n");
    for (const l of lines.slice(1, -1)) expect([...l].length).toBeLessThanOrEqual(RECORD_CHARS);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(lines.at(-1)).toMatch(
      new RegExp(
        `^(more=\\d+ )?(cut=\\d+ )?next=mu task tree ${rootId} -w ${wsName} --down --all$`,
      ),
    );
    const all = await runCli(printedArgv(r.stdout), dbPath);
    expect(all.exitCode).toBeNull();
    const whole = plain(all.stdout);
    expect(whole).toContain(`\t${"Z".repeat(5000)}`);
    expect(whole).toContain(`\t${"Q".repeat(5000)}`);
    expect(whole).toContain(`wave=${"w".repeat(300)}`);
    expect(whole).toContain(`host=${"h".repeat(300)}`);
    // JSON mode: the same command with --json --all.
    const j = await runCli(["task", "tree", rootId, "--down", "-w", wsName, "--json"], dbPath);
    expect(bytes(j.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const jd = (JSON.parse(j.stdout) as { data: { retrieve: string } }).data;
    const jall = (await runCliJson(retrieveArgv(jd), dbPath)).data as {
      items: { title: string; wave: string | null; dispatch_host: string | null }[];
    };
    expect(jall.items.map((i) => i.title)).toEqual(["Z".repeat(5000), "Q".repeat(5000)]);
    expect(jall.items[0]?.dispatch_host).toBe("h".repeat(300));
  });

  it("edge_json_bytes: 150 IN_PROGRESS neighbours: show --json <= 4096 bytes (kind, retrieve, newline counted); --all has all 150", async () => {
    ensureWorkstream(db, "probe");
    add("hub", "hub", {}, "probe");
    for (let i = 0; i < 150; i++) {
      const id = `s${String(i).padStart(3, "0")}`;
      add(id, "xxx", {}, "probe");
      addBlockEdge(db, "probe", id, "hub");
      db.prepare(
        "UPDATE tasks SET status = 'IN_PROGRESS', substate = 'active' WHERE local_id = ?",
      ).run(id);
    }
    const j = await runCli(["task", "show", "hub", "-w", "probe", "--json"], dbPath);
    expect(bytes(j.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const d = (JSON.parse(j.stdout) as { data: { dependents: unknown[]; retrieve: string } }).data;
    expect(d.dependents.length).toBeLessThan(150);
    const all = (await runCliJson(retrieveArgv(d), dbPath)).data as {
      dependents: { id: string }[];
    };
    expect(all.dependents.map((e) => e.id)).toEqual(
      Array.from({ length: 150 }, (_, i) => `s${String(i).padStart(3, "0")}`),
    );
    const t = await runCli(["task", "show", "hub", "-w", "probe"], dbPath);
    expect(bytes(t.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const tall = await runCli(printedArgv(t.stdout), dbPath);
    expect(plain(tall.stdout).match(/^dependent\t/gm)).toHaveLength(150);
  });

  it("show_json_bytes: an escape-heavy title, wave and host with 50 neighbours: JSON and text <= 4096; --all is whole", async () => {
    ensureWorkstream(db, "cuts");
    const title = "\u0085".repeat(600);
    add("escaped", title, {}, "cuts");
    db.prepare("UPDATE tasks SET dispatch_host = ?, wave = ? WHERE local_id = 'escaped'").run(
      "\u202e".repeat(300),
      "\u2028".repeat(300),
    );
    for (let i = 0; i < 50; i++) {
      add(`edge${String(i).padStart(2, "0")}`, "e", {}, "cuts");
      addBlockEdge(db, "cuts", `edge${String(i).padStart(2, "0")}`, "escaped");
    }
    const j = await runCli(["task", "show", "escaped", "-w", "cuts", "--json"], dbPath);
    expect(bytes(j.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const d = (JSON.parse(j.stdout) as { data: { retrieve: string; cut: number } }).data;
    expect(d.cut).toBeGreaterThan(0);
    const all = (await runCliJson(retrieveArgv(d), dbPath)).data as {
      task: { title: string; wave: string; dispatch_host: string };
      dependents: unknown[];
    };
    expect(all.task.title).toBe(title);
    expect(all.task.wave).toBe("\u2028".repeat(300));
    expect(all.task.dispatch_host).toBe("\u202e".repeat(300));
    expect(all.dependents).toHaveLength(50);
    const t = await runCli(["task", "show", "escaped", "-w", "cuts"], dbPath);
    expect(bytes(t.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const tall = plain((await runCli(printedArgv(t.stdout), dbPath)).stdout);
    expect(tall).toContain("\\u{85}".repeat(600));
    expect(tall.match(/^dependent\t/gm)).toHaveLength(50);
  });
});

describe("round 2: records are cut whole, in preorder, and bytes are the emitted bytes", () => {
  it("a wide two-level tree: the page is a preorder prefix (the root path first), <= 4 KB; --all lists all", async () => {
    add("hub");
    for (let i = 0; i < 12; i++) {
      const s = `s${String(i).padStart(2, "0")}`;
      add(s, `Spoke ${"p".repeat(60)}`);
      addBlockEdge(db, WS, s, "hub");
      for (let j = 0; j < 3; j++) {
        add(`${s}k${j}`, `Kid ${"k".repeat(60)}`);
        addBlockEdge(db, WS, `${s}k${j}`, s);
      }
    }
    const r = await runCli(["task", "tree", "hub", "--down", "-w", WS], dbPath);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const lines = r.stdout.trimEnd().split("\n");
    const tasks = lines.filter((l) => l.startsWith("task\t")).map((l) => l.split("\t"));
    expect(tasks[0]?.[1]).toBe("hub");
    for (const t of tasks.slice(1)) {
      const parent = /parent=(\S+)/.exec(t[3] ?? "")?.[1];
      expect(tasks.some((x) => x[1] === parent)).toBe(true);
    }
    expect(lines.at(-1)).toMatch(/^more=\d+ next=mu task tree hub -w w --down --all$/);
    const all = await runCli(printedArgv(r.stdout), dbPath);
    expect(plain(all.stdout).match(/^task\t/gm)).toHaveLength(1 + 12 * 4);
  });

  it("no ANSI escape is ever emitted by a tree read, and the byte cap holds on the raw output", async () => {
    add("hub");
    for (let i = 0; i < 150; i++) {
      const s = `s${String(i).padStart(3, "0")}`;
      add(s, "xxx");
      addBlockEdge(db, WS, s, "hub");
      db.prepare(
        "UPDATE tasks SET status = 'IN_PROGRESS', substate = 'active' WHERE local_id = ?",
      ).run(s);
    }
    await withEnv("MU_FORCE_COLOR", "1", async () => {
      const r = await runCli(["task", "tree", "hub", "--down", "-w", WS], dbPath);
      expect(r.stdout).not.toContain("\u001b");
      expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    });
  });
});

describe("round 2: show --json is inert like every other JSON read", () => {
  it("U+0085, U+2028 and U+202E never appear raw; JSON.parse still returns the exact title", async () => {
    add("hostile");
    const title = "before\u0085\u2028\u202eafter";
    db.prepare("UPDATE tasks SET title = ? WHERE local_id = 'hostile'").run(title);
    const r = await runCli(["task", "show", "hostile", "-w", WS, "--json"], dbPath);
    expect(r.stdout.match(/[\u0085\u2028\u202e]/g)).toBeNull();
    expect((JSON.parse(r.stdout) as { data: { task: { title: string } } }).data.task.title).toBe(
      title,
    );
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});
