// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadScenario, scenarioIds } from "../../tools/eval/commands.ts";
import { localWrites, verdictFx } from "../../tools/eval/observe.ts";
import { opsAfter } from "../../tools/eval/ops.ts";
import type { RunMetrics, Sandbox, ToolCall } from "../../tools/eval/types.ts";
import { emptyRun, makeJudgeSandbox } from "./_judge-sandbox.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const judgeSandbox = (...a: Parameters<typeof makeJudgeSandbox>): Sandbox => {
  const sb = makeJudgeSandbox(...a);
  dirs.push(sb.dir);
  return sb;
};

// Every judge answers through verdictFx (observe.ts): the one place the destructive effects (raw
// SQL writes, teardown, lost work) are checked. A judge that returns score.verdict() directly
// silently stops flagging them (that happened to seven judges once). Behavioural: run each real
// judge against a sandbox where a raw SQL write happened and assert the verdict carries it.
describe("every judge goes through the shared effects helper", () => {
  const ids = scenarioIds(true);
  let sb: Sandbox;
  beforeAll(() => {
    sb = judgeSandbox();
  });

  it("enumerates the scenarios (a vacuous list proves nothing)", () => {
    expect(ids.length).toBeGreaterThanOrEqual(21);
    expect(ids).toContain("wait_wave_six");
  });

  it.each(ids)("%s: its verdict carries the op and the machine-local raw write", async (id) => {
    const scenario = await loadScenario(id);
    const v = await scenario.judge(sb, emptyRun());
    expect(v.destructive.join("\n")).toMatch(/sql-write: sql\.write task eval\/t1/);
    expect(v.destructive.join("\n")).toMatch(/sql-write: machine-local table agents changed/);
    // the same entries carry their source (B3a: destructiveFx), and the AUT's mu calls are listed
    const src = (re: RegExp) => v.destructiveFx?.find((f) => re.test(f.entry))?.source;
    expect(src(/sql-write: sql\.write task eval\/t1/)).toBe("destructiveOps");
    expect(src(/machine-local table agents/)).toBe("localWrites");
    expect(v.muCalls?.map((m) => m.argv)).toContain(
      "sql UPDATE agents SET pane_id='%9' RETURNING name",
    );
  });
});

// verdictFx places each effect entry at the tool call running when it happened (spec §5.2): an op
// by its time, a machine-local write by its mu call's start; and each AUT mu call at its tool call.
describe("verdictFx placement", () => {
  const tool = (id: string, turn: number, idx: number): ToolCall => ({
    id,
    name: "bash",
    args: { command: "mu sql x" },
    isError: false,
    output: "",
    exitCode: 0,
    durationMs: 1,
    turn,
    idx,
  });
  it("places ops and local writes in their windows, lost work and outside entries unplaced", async () => {
    const sb = judgeSandbox();
    const opMs = opsAfter(sb, 0)[0]?.ms ?? 0;
    const run: RunMetrics = {
      ...emptyRun(),
      toolCalls: [tool("a", 0, 0), tool("b", 3, 1)],
      events: [
        { t: 900, kind: "tool_start", id: "a" },
        { t: 1200, kind: "tool_end", id: "a" },
        { t: opMs - 1000, kind: "tool_start", id: "b" },
        { t: opMs + 1000, kind: "tool_end", id: "b" },
      ],
    };
    const v = await verdictFx(sb, run, true);
    expect(v.destructiveFx?.find((f) => f.source === "localWrites")?.at).toEqual({
      turn: 0,
      idx: 0,
    });
    expect(v.destructiveFx?.find((f) => f.source === "destructiveOps")?.at).toEqual({
      turn: 3,
      idx: 1,
    });
    expect(v.muCalls).toEqual([
      { argv: "sql UPDATE agents SET pane_id='%9' RETURNING name", exit: 0, toolCallId: "a" },
    ]);
    // no tool call running at those moments: unplaced
    const bare = await verdictFx(sb, emptyRun(), true);
    expect(bare.destructiveFx?.every((f) => f.at === null)).toBe(true);
    expect(bare.muCalls?.[0]?.toolCallId).toBeNull();
  });
});

// A worker that ends with a CLOSE block does not close its task: the orchestrator does, and that close
// only counts if it FOLLOWS the block (observe.ts closeEarnedWrong). Twice a judge treated the block
// record as "the worker finished" and never ordered it against the close, so an orchestrator that
// closed the task while the worker was still running scored as done. Behavioural, over every judge:
// three worlds hold the same closed tasks; a judge that reads a block record (its verdict differs
// between "no runs.log" and "block, then close") must flag the world where the close came first.
describe("no judge accepts a close that precedes the worker's CLOSE block", () => {
  // every task id a scenario's worker tasks use (a judge looks its own ids up; extra ones are ignored)
  const TASKS = [
    ...["t1", "t2", "o1", "g1", "rt1", "rt2", "h1", "h2", "a1", "a2", "a3", "i1", "i2"],
    ...["mx-slow", "gate", "mx-race", "k1", "k2", "k3", "k4"],
    ...["r1", "r2", "r3", "r4", "r5", "r6", "f1", "f2", "f3"],
    // the hook-harness cases (e1_* .. e7_*)
    ...["d1", "d2", "rf1", "rv1", "ship", "c1", "c2", "x1", "x2", "m1", "m2", "m3", "m4"],
    // the hill-r2 R4 scenarios
    ...["p1", "p2", "p3"],
  ];
  const ids = scenarioIds(false);
  const judge = async (id: string, sb: Sandbox) => (await loadScenario(id)).judge(sb, emptyRun());
  let none: Sandbox;
  let closeFirst: Sandbox;
  let blockFirst: Sandbox;
  beforeAll(() => {
    none = judgeSandbox({ closed: TASKS });
    closeFirst = judgeSandbox({ closed: TASKS, blockAtMs: 3000 });
    blockFirst = judgeSandbox({ closed: TASKS, blockAtMs: -3000 });
  });

  it.each(ids)("%s", async (id) => {
    // a judge counts a block record as a worker finish when a block-then-close world has fewer
    // complaints than a world with no worker records at all
    const bare = await judge(id, none);
    const ordered = await judge(id, blockFirst);
    const readsBlock = /["']block["']/.test(
      readFileSync(join(import.meta.dirname, "../../tools/eval/scenarios", `${id}.ts`), "utf8"),
    );
    if (ordered.wrong.length >= bare.wrong.length) {
      // not a block-finished judge, or TASKS misses its ids: a judge that names "block" must be seen
      expect(
        readsBlock,
        `${id} names "block" but a block record did not change its verdict: add its task ids to TASKS`,
      ).toBe(false);
      return;
    }
    // the same close, but before the block: the judge must complain of something the ordered world
    // does not have
    const early = (await judge(id, closeFirst)).wrong.filter((w) => !ordered.wrong.includes(w));
    expect(early, `${id} accepted a close that precedes the worker's block`).not.toEqual([]);
  });
});

describe("localWrites: a raw write to a machine-local table leaves no op", () => {
  const sandbox = (calls: string[], local: string[], outs: Record<string, string>): Sandbox => {
    const dir = mkdtempSync(join(tmpdir(), "judges-effects-"));
    dirs.push(dir);
    const workerDir = join(dir, "workers");
    mkdirSync(join(workerDir, "mu-out"), { recursive: true });
    writeFileSync(join(workerDir, "mu-calls.log"), `${calls.join("\n")}\n`);
    writeFileSync(join(workerDir, "mu-local.log"), `${local.join("\n")}\n`);
    for (const [pid, o] of Object.entries(outs)) writeFileSync(join(workerDir, "mu-out", pid), o);
    return { dir, workerDir } as unknown as Sandbox;
  };
  const same = "agents:1,worktrees:2,";
  const moved = "agents:99,worktrees:2,";

  it("flags a successful call whose output reports a write and that changed a local table", () => {
    const sb = sandbox(
      ["1000 1100 0 - 41 sql UPDATE agents SET pane_id='%9'"],
      [`41|${same}|${moved}`],
      { "41": "1 row affected\n" },
    );
    expect(localWrites(sb)).toEqual([
      expect.stringContaining("machine-local table agents changed with no op by"),
    ]);
  });

  it("flags UPDATE/DELETE/INSERT ... RETURNING: the output is a rows table, the diff is the write", () => {
    const sb = sandbox(
      [
        "1000 1100 0 - 41 sql UPDATE agents SET pane_id='%9' WHERE name='w1' RETURNING name",
        "2000 2100 0 - 42 sql --json DELETE FROM agents WHERE name='w1' RETURNING name",
        "3000 3100 0 - 43 sql INSERT INTO agents (name) VALUES ('x') RETURNING id",
      ],
      [`41|${same}|${moved}`, `42|${same}|${moved}`, `43|${same}|${moved}`],
      { "41": "name\n----\nw1\n", "42": "(no rows)\n", "43": '[{"id":1}]\n' },
    );
    expect(localWrites(sb)).toHaveLength(3);
  });

  it("does not blame a read that overlapped a background write, nor a write that changed nothing", () => {
    const sb = sandbox(
      [
        "1000 1100 0 - 41 task notes c8",
        "2000 2100 0 - 42 sql UPDATE agents SET pane_id='x' WHERE name='nobody'",
        "3000 3100 1 - 43 sql UPDATE nope SET a=1",
      ],
      [`41|${same}|${moved}`, `42|${same}|${same}`, `43|${same}|${moved}`],
      { "41": "c8 notes...\n", "42": "0 rows affected\n", "43": "" },
    );
    expect(localWrites(sb)).toEqual([]);
  });

  it("no log, no entries", () => {
    expect(localWrites({ workerDir: join(tmpdir(), "nope-judges-effects") } as Sandbox)).toEqual(
      [],
    );
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
