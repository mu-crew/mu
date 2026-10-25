// The output contract of `mu log` and `mu workstream list`: one escaped record
// per visible op, a result bounded on its FINAL bytes, every cut counted and
// recoverable, SQL column names at the CLI edge, and `--tail` as an NDJSON stream.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdLogTail } from "../src/cli/log.js";
import { logRecord } from "../src/cli/log-records.js";
import { type Db, openDb } from "../src/db.js";
import { renderOpLine } from "../src/log-render.js";
import { appendLog, latestSeq, listLogs } from "../src/logs.js";
import { RESULT_BYTES } from "../src/output-contract.js";
import { addNote, addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";
import { legacyHardTeardown } from "./_teardown.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;

const noPanes = (): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  Promise.resolve({ stdout: "", stderr: "no session", exitCode: 1 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-logout-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "demo");
  mux = installMux("tmux", noPanes);
});

afterEach(() => {
  mux.restore();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const say = (payload: string, kind = "message"): void => {
  appendLog(db, { workstream: "demo", source: "user", kind, payload });
};

interface Item {
  seq: number;
  key: string;
  actor: string;
  intent: string | null;
  group_id: string;
  op: string;
  entity: string;
  payload: string;
  created_at: string;
  rendered: string;
  cut?: number;
}
interface Page {
  items: Item[];
  count: number;
  more: number;
  cut?: number;
  resume?: string;
  retrieve?: string;
}

const bytesOf = (s: string): number => Buffer.byteLength(s);

describe("text: one record per visible op", () => {
  it("a multiline payload is ONE physical line, escaped, at most 400 characters", async () => {
    say("first line\nsecond\tcol\r\nthird \u001b[31mred\u001b[0m");
    say(`${"x".repeat(900)}`);
    const r = await runCli(["log", "-w", "demo"], dbPath);
    const lines = r.stdout.trimEnd().split("\n");
    const records = lines.filter((l) => l.startsWith("log\t"));
    expect(records).toHaveLength(3); // workstream init + the two says
    for (const l of records) expect([...l].length).toBeLessThanOrEqual(400);
    const first = records.find((l) => l.includes("first line"));
    expect(first).toContain("first line\\nsecond\\tcol\\r\\nthird \\u{1b}[31mred");
    expect(r.stdout).not.toContain("\u001b");
  });

  it("a clipped record says what it cut and names the lossless read, which works", async () => {
    say(`${"y".repeat(900)}`);
    const r = await runCli(["log", "-w", "demo", "-n", "1"], dbPath);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const m = /^cut=(\d+) next=(.+)$/.exec(lines[1] ?? "");
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(400);
    expect(lines[0]).toMatch(/…$/);
    // The retrieval is a real command: run it and get the payload whole.
    const q = /mu db query '(.+)' --all/.exec(m?.[2] ?? "");
    const rows = await runCliJson<{ items: { payload: string }[] }>(
      ["db", "query", q?.[1] ?? "", "--all"],
      dbPath,
    );
    expect(rows.data.items[0]?.payload).toBe("y".repeat(900));
  });

  it("the parent-row touch of a note is not a second record (visible ops only)", async () => {
    addTask(db, { localId: "a", workstream: "demo", title: "A", impact: 50, effortDays: 1 });
    addNote(db, "a", "context", { workstream: "demo" });
    const r = await runCli(["log", "-w", "demo", "--intent", "task.note"], dbPath);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    const raw = db
      .prepare("SELECT COUNT(*) AS n FROM ops WHERE intent IS NOT NULL AND key LIKE 'demo/a%'")
      .get() as { n: number };
    const visible = listLogs(db, { workstream: "demo" }).filter((x) =>
      (x.workstreamName ?? "").startsWith("demo/a"),
    );
    expect(raw.n).toBeGreaterThan(visible.length); // the touch stays in ops, hidden from the log
  });
});

describe("json: canonical keys and a bounded final envelope", () => {
  it("items carry the ops column names, never the legacy aliases", async () => {
    say("hello");
    const r = await runCliJson<Page>(["log", "-w", "demo", "--json"], dbPath);
    const item = r.data.items[r.data.items.length - 1];
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        "actor",
        "created_at",
        "entity",
        "group_id",
        "intent",
        "key",
        "op",
        "payload",
        "rendered",
        "seq",
      ].sort(),
    );
    expect(item).toMatchObject({ key: "demo", actor: "user", entity: "message", payload: "hello" });
    expect(r.data.items[0]).toMatchObject({ intent: "workstream.init", op: "put" });
  });

  it("a machine-wide entry keeps key '' and a null actor reads 'system'", async () => {
    appendLog(db, { workstream: null, source: "user", payload: "global" });
    db.prepare("UPDATE ops SET actor = NULL WHERE payload = 'global'").run();
    const r = await runCliJson<Page>(["log", "--all", "--json"], dbPath);
    const g = r.data.items.find((i) => i.payload === "global");
    expect(g).toMatchObject({ key: "", actor: "system" });
  });

  it.each([
    ["ascii", "z"],
    ["multibyte", "日本語🙂"],
    ["control", "\u0001\u007f\u0085\u2028"],
  ])(
    "the FINAL document stays <= 4096 bytes with %s records (and says what it left out)",
    async (_n, unit) => {
      for (let i = 0; i < 40; i++) say(unit.repeat(300));
      const r = await runCli(["log", "-w", "demo", "-n", "40", "--json"], dbPath);
      const line = r.stdout.trimEnd();
      expect(line.split("\n")).toHaveLength(1);
      expect(bytesOf(line) + 1).toBeLessThanOrEqual(RESULT_BYTES);
      const doc = JSON.parse(line) as { data: Page };
      expect(doc.data.more).toBeGreaterThan(0);
      expect(doc.data.count + doc.data.more).toBe(40);
      expect(doc.data.resume).toMatch(/^mu log -w demo --since \d+ -n \d+ --json$/);
      expect(doc.data.cut).toBeGreaterThan(0);
      expect(doc.data.retrieve).toMatch(/^mu db query 'SELECT seq, key, payload FROM ops/);
    },
  );

  it("one enormous record still fits: its fields are cut, counted, and the lossless read is named", async () => {
    say("🙂".repeat(5000));
    const r = await runCli(["log", "-w", "demo", "-n", "1", "--json"], dbPath);
    expect(bytesOf(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const doc = JSON.parse(r.stdout) as { data: Page };
    expect(doc.data.items).toHaveLength(1);
    expect(doc.data.items[0]?.cut).toBeGreaterThan(4000);
    expect(doc.data.retrieve).toContain(`seq IN (${doc.data.items[0]?.seq})`);
  });

  it("the resume command continues exactly where the page stopped (latest-N and cursor reads)", async () => {
    for (let i = 0; i < 30; i++) say(`${i}:${"w".repeat(300)}`);
    const first = await runCliJson<Page>(["log", "-w", "demo", "-n", "30", "--json"], dbPath);
    expect(first.data.more).toBeGreaterThan(0);
    const next = await runCliJson<Page>(
      (first.data.resume ?? "").replace(/^mu /, "").split(" "),
      dbPath,
    );
    // latest-N window: the page holds the NEWEST; resume reads the displaced older ones,
    // oldest first, with no overlap and none skipped at the seam.
    const window = listLogs(db, { workstream: "demo", limit: 30 }).map((x) => x.seq);
    expect(first.data.items.map((i) => i.seq)).toEqual(window.slice(-first.data.count));
    expect(next.data.items.map((i) => i.seq)).toEqual(window.slice(0, next.data.count));
    expect(first.data.more).toBe(30 - first.data.count);

    const cursor = await runCliJson<Page>(["log", "-w", "demo", "--since", "0", "--json"], dbPath);
    expect(cursor.data.items[0]?.seq).toBe(1);
    expect(cursor.data.resume).toContain(`--since ${cursor.data.items.at(-1)?.seq} `);
  });

  it("filters survive in the resume command", async () => {
    for (let i = 0; i < 30; i++) say("k".repeat(300), "ledger");
    const r = await runCliJson<Page>(
      ["log", "-w", "demo", "--kind", "ledger", "-n", "30", "--json"],
      dbPath,
    );
    expect(r.data.resume).toContain("--kind ledger");
  });

  it("a log write answers with one canonical, bounded item", async () => {
    const r = await runCliJson<Item>(["log", "x".repeat(6000), "-w", "demo", "--json"], dbPath);
    expect(r.data).toMatchObject({ key: "demo", entity: "message", actor: "user" });
    expect(r.data.payload.length).toBeLessThan(300);
    expect(r.data.cut).toBeGreaterThan(5000);
  });
});

describe("history is never rewritten", () => {
  it("an op of an intent this build does not know prints generically and stays raw in ops", async () => {
    db.prepare(
      `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
       SELECT hlc || 'z', machine_id, 'g-old', 'old', 'workstream.delete', 'workstream', 'demo', 'put', '{"name":"demo"}', created_at FROM ops LIMIT 1`,
    ).run();
    const r = await runCli(["log", "-w", "demo", "--intent", "workstream.delete"], dbPath);
    expect(r.stdout).toContain("op put demo intent=workstream.delete kind=workstream patch=name");
    expect(r.stdout).not.toMatch(/workstream delete/);
    const raw = db.prepare("SELECT intent, op, payload FROM ops WHERE group_id = 'g-old'").get();
    expect(raw).toEqual({ intent: "workstream.delete", op: "put", payload: '{"name":"demo"}' });
  });
});

describe("--tail is an NDJSON stream", () => {
  const rows = (calls: string[]): Item[] => calls.map((c) => JSON.parse(c) as Item);

  /** Run a tail with a controllable poll: `steps[i]` runs before poll i+1. */
  async function tail(opts: { since?: number }, steps: (() => void)[]): Promise<string[]> {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    const ctl = new AbortController();
    let i = 0;
    try {
      await cmdLogTail(
        db,
        { workstream: "demo" },
        {
          workstream: "demo",
          tail: true,
          ...(opts.since === undefined ? {} : { since: opts.since }),
        },
        {
          signal: ctl.signal,
          sleep: async () => {
            const step = steps[i++];
            if (step === undefined) ctl.abort();
            else step();
          },
        },
      );
    } finally {
      spy.mockRestore();
    }
    return out;
  }

  it("prints only NDJSON items, no header, no envelope, without --json", async () => {
    const out = await tail({}, [() => say("one"), () => say("two")]);
    expect(out).toHaveLength(2);
    const items = rows(out);
    expect(items.map((r) => r.payload)).toEqual(["one", "two"]);
    for (const r of items) {
      expect(r).toHaveProperty("key", "demo");
      expect(r).toHaveProperty("entity", "message");
      expect(r).not.toHaveProperty("ok");
    }
  });

  it("starts at 'now'; --since 0 replays; the cursor advances only past emitted rows", async () => {
    say("before");
    expect(await tail({}, [])).toEqual([]);
    const replay = rows(await tail({ since: 0 }, [() => say("after")]));
    expect(replay.map((r) => r.payload)).toEqual([
      expect.stringContaining("demo"),
      "before",
      "after",
    ]);
    expect(replay.map((r) => r.seq)).toEqual([...replay.map((r) => r.seq)].sort((a, b) => a - b));
  });

  it("an interrupt after a batch loses none of it: the whole batch is on stdout, then it stops", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    const ctl = new AbortController();
    const start = latestSeq(db);
    say("a");
    say("b");
    say("c");
    try {
      await cmdLogTail(
        db,
        { workstream: "demo" },
        { workstream: "demo", tail: true, since: start },
        {
          signal: ctl.signal,
          sleep: async () => ctl.abort(),
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(rows(out).map((r) => r.payload)).toEqual(["a", "b", "c"]);
  });

  it("each line is bounded like a --json item, and a clipped one names its lossless read", async () => {
    const out = await tail({}, [() => say("🙂".repeat(3000))]);
    expect(out).toHaveLength(1);
    expect(bytesOf(out[0] ?? "")).toBeLessThanOrEqual(RESULT_BYTES / 2);
    const item = JSON.parse(out[0] ?? "") as Item & { retrieve?: string };
    expect(item.cut).toBeGreaterThan(2000);
    expect(item.retrieve).toContain(`seq IN (${item.seq})`);
  });

  it("a line is one inert line: no raw newline, DEL, C1 or separator characters", async () => {
    const out = await tail({}, [() => say("a\nb\u007f\u0085\u2028c")]);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/[\n\u007f\u0085\u2028]/);
    expect((JSON.parse(out[0] ?? "") as Item).payload).toBe("a\nb\u007f\u0085\u2028c");
  });
});

describe("the boundary leaves the SDK shapes alone", () => {
  it("listLogs still returns LogRow names and renderOpLine its prose", () => {
    say("sdk");
    const row = listLogs(db, { workstream: "demo" }).at(-1);
    expect(row).toMatchObject({ workstreamName: "demo", source: "user", kind: "message" });
    if (row === undefined) return;
    expect(renderOpLine(row)).toBe("sdk");
    expect(logRecord(row).line.startsWith(`log\t${row.seq}\t`)).toBe(true);
  });
});

describe("workstream list is capped, live and torn down", () => {
  const seed = (n: number): void => {
    for (let i = 0; i < n; i++) ensureWorkstream(db, `crew-${String(i).padStart(3, "0")}`);
  };

  it("live: one record per workstream, a 4 KB page, and --all prints every one whole", async () => {
    seed(120);
    const r = await runCli(["workstream", "list"], dbPath);
    const lines = r.stdout.trimEnd().split("\n");
    expect(bytesOf(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const last = lines.at(-1) ?? "";
    expect(last).toMatch(/^more=\d+ next=mu workstream list --all$/);
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/^workstream\tcrew-\d+\t-\tagents=0 /);

    const all = await runCli(["workstream", "list", "--all"], dbPath);
    expect(all.stdout.trimEnd().split("\n")).toHaveLength(121); // 120 + demo
    expect(all.stdout).not.toContain("more=");
  });

  it("live json: {items,count,more,retrieve} within 4 KB; --all is whole", async () => {
    seed(120);
    const r = await runCli(["workstream", "list", "--json"], dbPath);
    expect(bytesOf(r.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
    const doc = JSON.parse(r.stdout) as { data: Page };
    expect(doc.data.more).toBeGreaterThan(0);
    expect(doc.data.count + doc.data.more).toBe(121);
    expect(doc.data.retrieve).toBe("mu workstream list --all --json");
    const all = await runCliJson<Page>(["workstream", "list", "--all", "--json"], dbPath);
    expect(all.data.count).toBe(121);
    expect(all.data.more).toBe(0);
  });

  it("torn down: capped the same way, the group id intact, --all whole", async () => {
    for (let i = 0; i < 90; i++) {
      const name = `old-${String(i).padStart(3, "0")}`;
      ensureWorkstream(db, name);
      legacyHardTeardown(db, name);
    }
    const r = await runCli(["workstream", "list", "--torn-down"], dbPath);
    const lines = r.stdout.split("\n");
    const records = lines.filter((l) => l.startsWith("torn-down\t"));
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(90);
    for (const l of records) expect(l.split("\t")[2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.stdout).toMatch(/more=\d+ next=mu workstream list --torn-down --all/);

    const all = await runCli(["workstream", "list", "--torn-down", "--all"], dbPath);
    expect(all.stdout.split("\n").filter((l) => l.startsWith("torn-down\t"))).toHaveLength(90);
    const json = await runCli(["workstream", "list", "--torn-down", "--json"], dbPath);
    expect(bytesOf(json.stdout)).toBeLessThanOrEqual(RESULT_BYTES);
  });

  it("a long name is clipped and counted, and keeps the record <= 400 characters", async () => {
    // Names are <= 32 chars today; a synced peer's name is not trusted.
    db.prepare("INSERT INTO workstreams (name, created_at) VALUES (?, ?)").run(
      `x${"n".repeat(500)}`,
      "2026-01-01T00:00:00Z",
    );
    const r = await runCli(["workstream", "list", "--all"], dbPath);
    for (const l of r.stdout.trimEnd().split("\n")) expect([...l].length).toBeLessThanOrEqual(400);
    expect(r.stdout).toMatch(/cut=\d+/);
  });
});
