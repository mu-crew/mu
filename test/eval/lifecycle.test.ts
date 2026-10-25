import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MetricsCollector } from "../../tools/eval/events.ts";
import {
  deliveries,
  inside,
  lastJson,
  native,
  prodWrong,
  snapshotStates,
  stops,
  stopsWhileWorking,
  waitWindows,
} from "../../tools/eval/lifecycle.ts";
import {
  idleCalls,
  observedClosed,
  parseMuCalls,
  pollingCalls,
  sessions,
  showsClosed,
  timedOut,
} from "../../tools/eval/observe.ts";
import type { RunMetrics, Sandbox } from "../../tools/eval/types.ts";

/** A sandbox whose workers dir holds a mu-call log (and tee'd outputs) and an empty ops DB. */
function sandbox(calls: string[], outs: Record<string, string> = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  const workerDir = join(dir, "workers");
  mkdirSync(join(workerDir, "mu-out"), { recursive: true });
  writeFileSync(join(workerDir, "mu-calls.log"), `${calls.join("\n")}\n`);
  for (const [pid, out] of Object.entries(outs)) writeFileSync(join(workerDir, "mu-out", pid), out);
  const dbPath = join(dir, "mu.db");
  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE ops (seq INTEGER PRIMARY KEY, actor TEXT, intent TEXT, entity TEXT, key TEXT, op TEXT, payload TEXT, created_at TEXT)",
  );
  db.close();
  return { dir, workerDir, dbPath, env: {} } as unknown as Sandbox;
}

function observe(events: unknown[], clock: number[]): RunMetrics {
  let i = 0;
  const c = new MetricsCollector(() => clock[Math.min(i, clock.length - 1)] ?? 0);
  for (const e of events) {
    c.push(e);
    i++;
  }
  return c.result({ wallMs: 0, prods: 0, aborted: null });
}

const start = (id: string, command: string) => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: "bash",
  args: { command },
});
const end = (id: string, text = "ok", isError = false) => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "bash",
  isError,
  result: { content: [{ type: "text", text }] },
});
describe("lifecycle observer", () => {
  const run = observe(
    [
      { type: "agent_start" },
      start("w", "mu task wait t1 -w eval --first"),
      {
        type: "message_start",
        message: { role: "custom", customType: "mu-delegate", content: "VERDICT: REFUTED claim-1" },
      },
      end("w"),
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Waiting." }] },
      },
      { type: "agent_end" },
      { type: "agent_settled" },
    ],
    [1, 2, 3, 4, 5, 6, 7, 8],
  );

  it("records timestamped events and custom deliveries", () => {
    expect(run.events.map((e) => [e.t, e.kind])).toEqual([
      [1, "agent_start"],
      [2, "tool_start"],
      [3, "delegate_msg"],
      [4, "tool_end"],
      [5, "assistant_text"],
      [6, "agent_end"],
      [7, "agent_settled"],
    ]);
    expect(deliveries(run, /claim-1/)).toHaveLength(1);
  });

  it("a wait window is a mu call that blocked, whatever its verb", () => {
    const sb = sandbox([
      "1000 1100 0 - 11 task show a -w eval",
      "2000 6000 0 - 12 whatever verb the surface calls it",
      "7000 9500 5 - 13 wait x --timeout 2",
      "7100 12000 0 w1 14 task wait z",
    ]);
    const ws = waitWindows(sb);
    expect(ws.map((w) => [w.start, w.end])).toEqual([
      [2000, 6000],
      [7000, 9500],
    ]);
    expect(inside(3000, ws)).toBe(true);
    expect(inside(6500, ws)).toBe(false);
  });

  it("a stop window opens when work was handed out (a delegate or an owned task), whatever the verb", () => {
    const sb = sandbox([]);
    const afterDelegate = observe(
      [
        { type: "agent_start" },
        { type: "tool_execution_start", toolCallId: "d", toolName: "mu_delegate", args: {} },
        {
          type: "tool_execution_end",
          toolCallId: "d",
          toolName: "mu_delegate",
          isError: false,
          result: { content: [] },
        },
        { type: "agent_end" },
      ],
      [1, 2, 3, 4],
    );
    expect(stopsWhileWorking(sb, afterDelegate, 100)).toHaveLength(1);
    // nothing handed out: a stop is not a stop
    const noWork = observe([{ type: "agent_start" }, { type: "agent_end" }], [1, 2]);
    expect(stopsWhileWorking(sb, noWork, 100)).toHaveLength(0);
    // an owner op after the run began is a hand-out, spelled any way
    const dbh = new Database(sb.dbPath);
    dbh
      .prepare("INSERT INTO ops VALUES (1,'w1','task.claim','task','eval/t','put',?,?)")
      .run('{"owner_id":3}', new Date(2).toISOString());
    dbh.close();
    const claimed = observe(
      [{ type: "prompt" }, { type: "agent_start" }, { type: "agent_end" }],
      [1, 3, 4],
    );
    expect(stopsWhileWorking(sb, claimed, 100)).toHaveLength(1);
  });

  it("a stop is an agent_end before the work was done", () => {
    expect(stops(run, 100)).toHaveLength(1);
    expect(stops(run, 5)).toHaveLength(0);
    // work never finished: the last agent_end is the run's own end, not a stop
    expect(stops(run, Number.POSITIVE_INFINITY)).toHaveLength(0);
  });

  it("timeout is an observed outcome, text or field, whatever the exit code", () => {
    expect(timedOut("Timed out after 2007ms\n  • a (OPEN)")).toBe(true);
    expect(timedOut('{"ok":true,"data":{"timedOut":true}}')).toBe(true);
    expect(timedOut('{"ok":true,"data":{"timedOut":[{"name":"a"}]}}')).toBe(true);
    expect(timedOut('{"ok":true,"data":{"timedOut":[]}}')).toBe(false);
    expect(timedOut("a (CLOSED)")).toBe(false);
  });

  it("native guarantees: note on 3x, wrong on next", () => {
    const sb = (family: string) => ({ env: { EVAL_SURFACE_FAMILY: family } }) as unknown as Sandbox;
    expect(native(sb("3x"), "mid-wait delivery", false, "0/12").wrong).toEqual([]);
    expect(native(sb("3x"), "mid-wait delivery", false, "0/12").na).toEqual([
      "mid-wait delivery (0/12)",
    ]);
    expect(native(sb("next"), "mid-wait delivery", false, "0/12").na).toEqual([]);
    expect(native(sb("3x"), "mid-wait delivery", true, "12/12").na).toEqual([]);
    expect(native(sb("next"), "mid-wait delivery", false, "0/12").wrong).toHaveLength(1);
    expect(native(sb("next"), "mid-wait delivery", true, "12/12").wrong).toEqual([]);
  });

  it("prodWrong and lastJson", () => {
    expect(prodWrong({ ...run, prods: 1 })).toHaveLength(1);
    expect(prodWrong(run)).toEqual([]);
    expect(lastJson('noise {bad\n{"a":1,"b":{"c":2}}')).toEqual({ a: 1, b: { c: 2 } });
    expect(lastJson("")).toBeNull();
  });

  it("observedClosed reads mu's own output, not the AUT's words", () => {
    const sb = sandbox(
      [
        "1000 1100 0 - 21 task wait mx-fast -w eval --first",
        "2000 2100 1 - 22 task wait mx-race -w eval",
        "3000 3100 0 - 23 task show gate",
        "4000 9000 0 - 24 wait",
      ],
      {
        "21": '{"all":[{"name":"mx-fast","status":"CLOSED"}]}',
        "22": "mx-race (CLOSED)",
        "23": "gate  IN_PROGRESS",
        "24": '{"all":[{"name":"mx-slow","status":"CLOSED"}]}',
      },
    );
    const aut = {} as RunMetrics;
    expect(observedClosed(sb, aut, "mx-fast")).toBe(true);
    expect(observedClosed(sb, aut, "mx-fast", 5000)).toBe(false);
    expect(observedClosed(sb, aut, "mx-race")).toBe(false); // the call failed
    expect(observedClosed(sb, aut, "gate")).toBe(false);
    // a workstream-wide wait names no ref: a blocking call whose own output shows it is enough
    expect(observedClosed(sb, aut, "mx-slow")).toBe(true);
    expect(showsClosed("echo 'mx-fast (CLOSED)'", "mx")).toBe(false);
  });

  it("parseMuCalls reads the shim's lines", () => {
    expect(parseMuCalls("1 2 0 - 77 task note a hello\nbad\n3 4 5 w1 78 x")).toEqual([
      { start: 1, end: 2, exit: 0, agent: "-", pid: "77", argv: "task note a hello" },
      { start: 3, end: 4, exit: 5, agent: "w1", pid: "78", argv: "x" },
    ]);
  });

  it("a sleep or a repeated state read stands in for a wait; a blocked mu call does not", () => {
    const clock = [100, 4500, 5000, 9000, 9500, 14000];
    const aut = observe(
      [
        start("sleeper", "sleep 4"),
        end("sleeper"),
        start("poll", "loop"),
        end("poll"),
        start("blocker", "mu wait"),
        end("blocker"),
      ],
      clock,
    );
    const sb = sandbox(
      [
        "5100 5200 0 - 31 task show a",
        "6000 6100 0 - 32 task show a",
        "6200 6300 0 - 33 task show a",
        "9600 13900 0 - 34 anything",
      ],
      { "31": "a OPEN", "32": "a OPEN", "33": "a OPEN", "34": "x" },
    );
    expect(idleCalls(sb, aut).map((c) => c.id)).toEqual(["sleeper", "poll"]);
    expect(pollingCalls(sb, aut).map((c) => c.id)).toEqual(["poll"]);
  });

  it("sessions.log: an END closes the session its pid opened; REFUSED is never open", () => {
    const ss = sessions(
      "100 41 pane=%3 ssh remote-gate\n200 REFUSED git-upload-pack\n300 42 pane=- cat x\n350 END 42\n900 END 41",
    );
    expect(ss.map((s) => [s.pid, s.start, s.end, s.pane, s.refused])).toEqual([
      ["41", 100, 900, "%3", false],
      ["", 200, 200, "-", true],
      ["42", 300, 350, "-", false],
    ]);
  });

  it("snapshotStates finds task states anywhere in a snapshot", () => {
    const st = snapshotStates({
      interrupted: true,
      tasks: {
        items: [
          { name: "i1", status: "IN_PROGRESS" },
          { name: "i2", status: "CLOSED" },
        ],
      },
    });
    expect([...st]).toEqual([
      ["i1", "IN_PROGRESS"],
      ["i2", "CLOSED"],
    ]);
    expect(snapshotStates({ tasks: "i1 i2" }).size).toBe(0);
  });
});
