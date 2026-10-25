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
  RECORD_CHARS,
  taskPage,
  taskRecord,
  taskToOutput,
} from "../src/cli/tasks/records.js";
import {
  FRONTIER_CLOSED_PER_NODE,
  FRONTIER_MAX_DEPTH,
  FRONTIER_MAX_NODES,
  loadFullDag,
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

/** Execute an emitted `mu sql --json ...` command through the CLI; its rows. */
async function runEmitted(cmd: string): Promise<Record<string, unknown>[]> {
  const argv = shellSplit(cmd);
  expect(argv.slice(0, 2)).toEqual(["mu", "sql"]);
  const r = await runCliJson(argv.slice(1), dbPath);
  expect(r.exitCode).toBeNull();
  return r.data as Record<string, unknown>[];
}

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
  it("a long list pages: every page fits, the pages cover every task exactly once, progress is guaranteed", async () => {
    for (let i = 0; i < 90; i++)
      add(`t${String(i).padStart(3, "0")}`, `Title ${i} ${"w".repeat(80)}`);
    const seen: string[] = [];
    let argv = ["task", "list", "-w", WS];
    for (let page = 0; page < 40; page++) {
      const r = await runCli(argv, dbPath);
      const lines = plain(r.stdout).trimEnd().split("\n");
      expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
      const footer = lines.at(-1) ?? "";
      const records = lines.filter((l) => l.startsWith("task\t"));
      for (const l of records) expect([...l].length).toBeLessThanOrEqual(RECORD_CHARS);
      expect(records.length).toBeGreaterThan(0);
      seen.push(...records.map((l) => l.split("\t")[1] ?? ""));
      const m = /^more=(\d+) next=(.*)$/.exec(footer);
      if (m === null) break;
      expect(Number(m[1])).toBe(90 - seen.length);
      // The named command is exactly what to run next.
      argv = (m[2] ?? "").split(" ").slice(1);
    }
    expect(seen).toHaveLength(90);
    expect(new Set(seen).size).toBe(90);
  });

  it("--json caps the whole document, with more and retrieve; the retrieve command resumes", async () => {
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
    expect(d.retrieve).toBe(`mu task list -w w --from ${d.count + 1}`);
    const second = await runCliJson(
      ["task", "list", "-w", WS, "--from", String(d.count + 1), "--json"],
      dbPath,
    );
    const e = second.data as { items: { id: string }[] };
    expect(e.items[0]?.id).toBe(`j${String(d.count).padStart(2, "0")}`);
  });

  it("an oversized title is clipped to the record cap with cut=N and the exact retrieval command", async () => {
    add("big", "q".repeat(2000));
    const r = await runCli(["task", "list", "-w", WS], dbPath);
    const line = plain(r.stdout).trimEnd();
    expect([...line].length).toBeLessThanOrEqual(RECORD_CHARS);
    expect(line).toMatch(
      /…\tcut=(\d+)\tnext=mu sql --json "SELECT t\.title, t\.wave, t\.dispatch_host FROM tasks t WHERE t\.local_id = 'big' AND t\.workstream_id = \d+"$/,
    );
    const cut = Number(/cut=(\d+)/.exec(line)?.[1]);
    const shownTitle = line.split("\t")[4] ?? "";
    expect([...shownTitle].length - 1 + cut).toBe(2000);
    // The retrieval command does return the whole title.
    const whole = await runCliJson(["task", "show", "big", "-w", WS, "--json"], dbPath);
    expect((whole.data as { task: { title: string; cut?: number } }).task.cut).toBeDefined();
  });

  it("--json clips a long title the same way: bounded item, cut and a retrieve command", async () => {
    add("bigj", "q".repeat(2000));
    const r = await runCli(["task", "list", "-w", WS, "--json"], dbPath);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const item = (
      JSON.parse(r.stdout) as {
        data: { items: { title: string; cut: number; retrieve: string }[] };
      }
    ).data.items[0];
    expect([...(item?.title ?? "")].length).toBeLessThan(200);
    expect((item?.cut ?? 0) + [...(item?.title ?? "")].length - 1).toBe(2000);
    expect(item?.retrieve).toMatch(/^mu (task show bigj -w w --json|sql )/);
  });

  it("a title too long even for show names a SQL read that returns it whole (executed through the CLI)", async () => {
    const title = "z".repeat(5000);
    add("huge", title);
    const r = await runCli(["task", "list", "-w", WS], dbPath);
    const next = /next=(mu sql .*)$/.exec(plain(r.stdout).trimEnd())?.[1];
    expect(next).toBeDefined();
    const rows = await runEmitted(next ?? "");
    expect(rows[0]?.title).toBe(title);
    const show = await runCli(["task", "show", "huge", "-w", WS], dbPath);
    expect(bytes(show.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(plain(show.stdout)).toMatch(/cut=\d+\tnext=mu sql /);
  });

  it("property: any mix of titles, pages and modes stays within the caps and covers every task", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            len: fc.oneof(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 1500 })),
            ch: fc.constantFrom("a", "é", "😀", "\n", "\\", "\t", "\u202e", "\u001b"),
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
          let from = 1;
          const covered: string[] = [];
          for (let guard = 0; guard < rows.length + 2 && from <= rows.length; guard++) {
            const out = taskPage(rows, {
              from,
              json,
              nextFor: (k) => `mu task list -w w --from ${k}`,
            });
            const text = json
              ? JSON.stringify({ ok: true, data: out.data, next: null })
              : out.lines.join("\n");
            expect(out.shown).toBeGreaterThan(0);
            // A page is capped unless it is a single (bounded) record.
            if (out.shown > 1) expect(bytes(text) + 1).toBeLessThanOrEqual(RESULT_BYTES);
            if (!json) {
              for (const l of out.lines.filter((x) => x.startsWith("task\t"))) {
                expect([...l].length).toBeLessThanOrEqual(RECORD_CHARS);
                // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
                expect(l).not.toMatch(/[\n\r\u202e\u001b]/);
              }
            }
            const items = json
              ? (out.data?.items.map((i) => i.id) ?? [])
              : out.lines.filter((x) => x.startsWith("task\t")).map((l) => l.split("\t")[1] ?? "");
            covered.push(...items);
            from += out.shown;
          }
          expect(covered).toEqual(rows.map((r) => r.name));
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
  it("whole-output cap: task record, edges and ordinary notes together; pinned notes are exempt", async () => {
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
    const edgeLines = lines.filter((l) => /^dependent\t/.test(l));
    const foot = lines.find((l) =>
      /^more=\d+ next=mu task show hub -w w --edges-from \d+$/.test(l),
    );
    expect(edgeLines.length).toBeLessThan(80);
    expect(foot).toBeDefined();
    // The named command returns the rest, and paging reaches every neighbour exactly once.
    const seen = new Set(edgeLines.map((l) => l.split("\t")[1]));
    let from = edgeLines.length + 1;
    for (let guard = 0; guard < 80 && seen.size < 80; guard++) {
      const p = await runCli(
        ["task", "show", "hub", "-w", WS, "--edges-from", String(from)],
        dbPath,
      );
      expect(bytes(p.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
      const got = plain(p.stdout)
        .trimEnd()
        .split("\n")
        .filter((l) => l.startsWith("dependent\t"));
      expect(got.length).toBeGreaterThan(0);
      for (const l of got) seen.add(l.split("\t")[1]);
      from += got.length;
    }
    expect(seen.size).toBe(80);
  });

  it("--json carries the whole-document cap with edges_more/edges_retrieve and keeps task.revision", async () => {
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
      edges_retrieve: string;
    };
    expect(d.task).toMatchObject({ id: "hub", workstream: "w" });
    expect(typeof d.task.revision).toBe("number");
    expect(d.edges_more).toBe(80 - d.dependents.length);
    expect(d.edges_retrieve).toMatch(/--edges-from \d+$/);
  });

  it("a long title is clipped inside show with cut and a retrieval command; JSON agrees", async () => {
    add("longt", "L".repeat(3000));
    const t = await runCli(["task", "show", "longt", "-w", WS], dbPath);
    const first = plain(t.stdout).split("\n")[0] ?? "";
    expect(first).toMatch(/…\tcut=\d+\tnext=mu sql /);
    const j = await runCli(["task", "show", "longt", "-w", WS, "--json"], dbPath);
    expect(bytes(j.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const task = (JSON.parse(j.stdout) as { data: { task: { cut: number; retrieve: string } } })
      .data.task;
    expect(task.cut).toBeGreaterThan(0);
    expect(task.retrieve).toMatch(/^mu sql /);
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
    // loadFullDag keeps its whole-workstream SDK semantics.
    expect(loadFullDag(db, WS).tasks.size).toBe(304);
  });

  it("CLI: --down from a root lists the open dependents; the omitted closed count names its command", async () => {
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
    expect(out).toContain(
      `more\troot\tclosed=${6 - FRONTIER_CLOSED_PER_NODE}\tnext=mu task tree root -w w --down --all`,
    );
    expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const all = await runCli(["task", "tree", "root", "--down", "--all", "-w", WS], dbPath);
    expect(plain(all.stdout).match(/^task\tc\d\tCLOSED/gm)).toHaveLength(6);
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

  it("CLI tree: paged output covers every entry exactly once and never exceeds 4 KB", async () => {
    add("hub", "H");
    for (let i = 0; i < 150; i++) {
      add(`s${String(i).padStart(3, "0")}`, `Spoke ${i} ${"s".repeat(60)}`);
      addBlockEdge(db, WS, `s${String(i).padStart(3, "0")}`, "hub");
    }
    const seen = new Set<string>();
    let argv = ["task", "tree", "hub", "--down", "-w", WS];
    for (let page = 0; page < 60; page++) {
      const r = await runCli(argv, dbPath);
      expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES + 400);
      const lines = plain(r.stdout).trimEnd().split("\n");
      for (const l of lines) {
        for (const m of l.matchAll(/\b(s\d{3}|hub)\b/g)) seen.add(m[1] ?? "");
        expect([...l].length).toBeLessThanOrEqual(RECORD_CHARS + 60);
      }
      const foot = lines.at(-1) ?? "";
      const m = /^more=\d+ next=(.*)$/.exec(foot);
      if (m === null) break;
      argv = (m[1] ?? "").split(" ").slice(1);
    }
    expect(seen.size).toBe(151);
  });
});

describe("tree --json pages like the text form", () => {
  it("every page is a whole document under 4 KB; the retrieve command resumes; entries are covered once", async () => {
    add("hub", "H");
    for (let i = 0; i < 90; i++) {
      add(`s${String(i).padStart(2, "0")}`, `Spoke ${i} ${"s".repeat(80)}`);
      addBlockEdge(db, WS, `s${String(i).padStart(2, "0")}`, "hub");
    }
    const seen: string[] = [];
    let argv = ["task", "tree", "hub", "--down", "-w", WS, "--json"];
    for (let page = 0; page < 40; page++) {
      const r = await runCli(argv, dbPath);
      expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
      const d = (
        JSON.parse(r.stdout) as {
          data: { items: { id: string }[]; more: number; retrieve?: string };
        }
      ).data;
      expect(d.items.length).toBeGreaterThan(0);
      seen.push(...d.items.map((i) => i.id));
      if (d.retrieve === undefined) break;
      expect(d.more).toBe(91 - seen.length);
      argv = [...d.retrieve.split(" ").slice(1), "--json"];
    }
    expect(seen).toHaveLength(91);
    expect(new Set(seen).size).toBe(91);
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

describe("round 2: title recovery runs through the real CLI", () => {
  it("list text and list --json name a command that, executed, returns the whole 2000-char title", async () => {
    add("long", "t".repeat(2000));
    const text = await runCli(["task", "list", "-w", WS], dbPath);
    const textNext = /next=(mu sql .*)$/.exec(plain(text.stdout).trimEnd())?.[1] ?? "";
    expect((await runEmitted(textNext))[0]?.title).toBe("t".repeat(2000));
    const json = await runCliJson(["task", "list", "-w", WS, "--json"], dbPath);
    const retrieve = (json.data as { items: { retrieve: string }[] }).items[0]?.retrieve ?? "";
    expect((await runEmitted(retrieve))[0]?.title).toBe("t".repeat(2000));
    const show = await runCliJson(["task", "show", "long", "-w", WS, "--json"], dbPath);
    const sr = (show.data as { task: { retrieve: string } }).task.retrieve;
    expect((await runEmitted(sr))[0]?.title).toBe("t".repeat(2000));
  });
});

describe("round 2: clipped wave / dispatch_host recover whole, with exact counts, in both modes", () => {
  it("--json: cut counts every clipped code point and retrieve returns the whole fields", async () => {
    add("fields", "Short");
    db.prepare("UPDATE tasks SET wave = ?, dispatch_host = ? WHERE local_id = 'fields'").run(
      longLit(300, "w"),
      longLit(300, "h"),
    );
    const list = await runCliJson(["task", "list", "-w", WS, "--json"], dbPath);
    const item = (
      list.data as {
        items: {
          title: string;
          wave: string;
          dispatch_host: string;
          cut: number;
          retrieve: string;
        }[];
      }
    ).items[0];
    expect(item?.title).toBe("Short");
    const shown = [...(item?.wave ?? "")].length + [...(item?.dispatch_host ?? "")].length;
    // each clipped field keeps (shown-1) code points plus the ellipsis
    expect(item?.cut).toBe(600 - (shown - 2));
    const row = (await runEmitted(item?.retrieve ?? ""))[0];
    expect(row?.wave).toBe(longLit(300, "w"));
    expect(row?.dispatch_host).toBe(longLit(300, "h"));
    // show's retrieve is no more self-referential than list's.
    const show = await runCliJson(["task", "show", "fields", "-w", WS, "--json"], dbPath);
    const st = (show.data as { task: { retrieve: string; cut: number } }).task;
    expect(st.cut).toBeGreaterThan(0);
    expect((await runEmitted(st.retrieve))[0]?.wave).toBe(longLit(300, "w"));
  });

  it("text: a clipped metadata field raises cut=N next=<command> even when the title fits", async () => {
    add("fieldt", "Short");
    db.prepare("UPDATE tasks SET wave = ?, dispatch_host = ? WHERE local_id = 'fieldt'").run(
      longLit(300, "w"),
      longLit(300, "h"),
    );
    for (const argv of [
      ["task", "list", "-w", WS],
      ["task", "show", "fieldt", "-w", WS],
    ]) {
      const r = await runCli(argv, dbPath);
      const line = plain(r.stdout).split("\n")[0] ?? "";
      expect(line, argv.join(" ")).toMatch(/\tcut=\d+\tnext=mu sql --json /);
      expect(line.endsWith("\tShort") || line.includes("\tShort\t")).toBe(true);
      const next = /next=(mu sql .*)$/.exec(line)?.[1] ?? "";
      const row = (await runEmitted(next))[0];
      expect(row?.wave).toBe(longLit(300, "w"));
      const cut = Number(/cut=(\d+)/.exec(line)?.[1]);
      expect(cut).toBe(2 * (300 - 40));
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

describe("round 2: node-capped tree recovery", () => {
  it("a parent with more children than the node cap names an SQL read that returns exactly the omitted ones", async () => {
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
    const listed = new Set(f.entries.map((e) => e.task.name));
    expect(f.entries[0]?.capCut).toBeGreaterThan(0);
    const r = await runCliJson(["task", "tree", "hub", "--down", "-w", WS, "--json"], dbPath);
    const root = (r.data as { items: Record<string, unknown>[] }).items[0] ?? {};
    expect(root.capped).toBe(f.entries[0]?.capCut);
    const rows = await runEmitted(String(root.capped_retrieve));
    const omitted = rows.map((x) => String(x.local_id));
    expect(omitted).toHaveLength(Number(root.capped));
    expect(omitted.filter((id) => listed.has(id))).toEqual([]);
    expect(listed.size - 1 + omitted.length).toBe(n);
    // The old self-referential retrieval is gone: nothing names the same tree as the way back for the cap.
    expect(root.kids_retrieve).toBeUndefined();
    // Text carries the same way back.
    const t = await runCli(["task", "tree", "hub", "--down", "-w", WS], dbPath);
    expect(t.stdout).toMatch(
      new RegExp(`^more\\thub\\tcapped=${String(root.capped)}\\tnext=mu sql --json `, "m"),
    );
  });
});

describe("round 2: tree depth cap holds for the shared DAG's preorder walk", () => {
  it("a chain every node of which is also a direct child never lists past FRONTIER_MAX_DEPTH; the rest is counted", async () => {
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
    // Paged through the CLI the depth never exceeds the cap either, page by page.
    let argv = ["task", "tree", "depthroot", "--down", "-w", WS, "--json"];
    const seen: string[] = [];
    for (let page = 0; page < 40; page++) {
      const r = await runCliJson(argv, dbPath);
      const d = r.data as { items: { id: string; depth: number }[]; retrieve?: string };
      for (const it of d.items) {
        expect(it.depth).toBeLessThanOrEqual(FRONTIER_MAX_DEPTH);
        seen.push(it.id);
      }
      if (d.retrieve === undefined) break;
      argv = [...shellSplit(d.retrieve).slice(1), "--json"];
    }
    expect(seen.length).toBe(f.entries.length);
    // A diamond on the same level: the omitted work below the cap is counted, not dropped.
    const total = (
      await runCliJson(
        ["task", "tree", "depthroot", "--down", "-w", WS, "--json", "--from", "13"],
        dbPath,
      )
    ).data as {
      items: { depth: number }[];
    };
    expect(Math.max(...total.items.map((i) => i.depth))).toBeLessThanOrEqual(FRONTIER_MAX_DEPTH);
  });
});

describe("round 2: tree pages cut on whole subtrees, and bytes are the emitted bytes", () => {
  it("each page after the first starts at an entry whose parent was listed or is the page's own top; no page splits a subtree it could fit", async () => {
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
    let argv = ["task", "tree", "hub", "--down", "-w", WS];
    const pages: string[][] = [];
    for (let i = 0; i < 20; i++) {
      const r = await runCli(argv, dbPath);
      expect(bytes(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
      const lines = r.stdout.trimEnd().split("\n");
      pages.push(lines.filter((l) => l.startsWith("task\t")));
      const m = /^more=\d+ next=(.*)$/.exec(lines.at(-1) ?? "");
      if (m === null) break;
      argv = shellSplit(m[1] ?? "").slice(1);
    }
    expect(pages.length).toBeGreaterThan(1);
    // A spoke and its three kids are never split across a page.
    for (const page of pages) {
      const ids = page.map((l) => l.split("\t")[1] ?? "");
      for (const id of ids) if (/^s\d\dk\d$/.test(id)) expect(ids).toContain(id.slice(0, 3));
      for (const id of ids)
        if (/^s\d\d$/.test(id)) expect(ids.filter((x) => x.startsWith(`${id}k`))).toHaveLength(3);
    }
    expect(pages.flat()).toHaveLength(1 + 12 * 4);
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
