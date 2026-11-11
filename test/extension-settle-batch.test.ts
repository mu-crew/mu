// The pi settle over a `mu wait --ready` result (extension/settle-events.ts via registerNudge):
// one line per consumed event, the answer blocks, the owed line, the superseded paths, and the
// single-event text kept byte for byte. The wait and the delegate reads are faked; the real
// engine and CLI are covered in wait-settle-drain and wait-drain-r3.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MuResult } from "../extension/mu-run.js";
import { keepDrivingRule, type MuNudgeCtx, registerNudge } from "../extension/nudge.js";
import { REPORT_CAP, SUPERSEDED_LINE, WAVE_REPORT_CAP } from "../extension/settle-events.js";

const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", "mu", "SKILL.md"), "utf8");
const RULE = keepDrivingRule(SKILL) ?? "unreachable";
const RAN =
  "Work you own is still running, so the settle ran `mu wait --ready --on-stall exit --json` for you.";

const out = (v: unknown, code = 0): MuResult => ({ code, stdout: JSON.stringify(v), stderr: "" });
const okWait = (data: Record<string, unknown>) =>
  out({ ok: true, data: { exit: 0, ...data }, next: null });
const NOTHING = out({ ok: false, error: "WaitNothingError", message: "nothing", next: null }, 1);
const SESSION: MuNudgeCtx = { sessionManager: { getSessionId: () => "s1" } };

type Row = { callId: string; task: string; workstream: string; state: string; wave?: string };
const row = (id: string, wave?: string): Row => ({
  callId: id,
  task: `t_${id}`,
  workstream: "scratch",
  state: "done",
  ...(wave !== undefined ? { wave } : {}),
});

/** A settle whose waits answer from `waits` in order; delegate rows from `rows`, reports `report of t_<id>`. */
function harness(waits: MuResult[], rows: Row[] = [], report = (id: string) => `report of ${id}`) {
  const handlers: ((e: unknown, c: MuNudgeCtx) => unknown)[] = [];
  const pi = {
    on(event: string, h: (e: unknown, c: MuNudgeCtx) => unknown) {
      if (event === "agent_before_settle") handlers.push(h);
      return () => {};
    },
  };
  const waitArgs: string[][] = [];
  const delivered: unknown[] = [];
  const run = async (args: readonly string[]): Promise<MuResult> => {
    if (args[0] === "state")
      return out({ ok: true, data: { caller: "pi:s1", workstreams: [] }, next: null });
    if (args[0] === "wait") {
      waitArgs.push([...args]);
      return waits.shift() ?? NOTHING;
    }
    if (args[0] === "delegates" && args[1] === "show") {
      const r = rows.find((x) => x.callId === args[2]);
      return r === undefined
        ? out({ ok: false, error: "NotFound", next: null }, 3)
        : out({ ok: true, data: { call: r }, next: null });
    }
    if (args[0] === "delegates" && args[1] === "list")
      return out({ ok: true, data: { items: rows.filter((x) => x.wave === args[3]) }, next: null });
    if (args[0] === "task" && args[1] === "notes")
      return out({
        ok: true,
        data: { items: [{ kind: "report", content: report(String(args[2])) }] },
        next: null,
      });
    return out({ ok: true, data: {}, next: null });
  };
  registerNudge(pi, run, SKILL, undefined, undefined, (d) => delivered.push(d));
  const emit = async () => {
    let last: unknown;
    for (const h of handlers) last = await h({ outcome: "completed" }, SESSION);
    return last as { continue?: boolean; entries?: { content: string }[] } | undefined;
  };
  const text = async () => (await emit())?.entries?.map((e) => e.content).join("\n") ?? "";
  return { emit, text, waitArgs, delivered };
}

const closeSnap = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: "task",
  ref: `task:w/${id}`,
  status: "CLOSED",
  fired: true,
  ...extra,
});

describe("one event, nothing owed: the single-event text, byte for byte", () => {
  it("a close", async () => {
    const d = {
      firing: { kind: "closed", ref: "task:w/a" },
      exit: 0,
      snapshots: [closeSnap("a", { delivered: true })],
      owed: 0,
    };
    const h = harness([okWait(d)]);
    const data = JSON.parse(okWait(d).stdout).data;
    expect(await h.text()).toBe(`[mu] ${RULE}\n\n${RAN} Its result:\n${JSON.stringify(data)}`);
  });

  it("a delegate answer: the result, then its block at REPORT_CAP", async () => {
    const d = { firing: { kind: "delegate", ref: "delegate:c1" }, exit: 0, owed: 0 };
    const long = "x".repeat(REPORT_CAP + 10);
    const h = harness([okWait(d)], [row("c1")], () => long);
    const data = JSON.parse(okWait(d).stdout).data;
    expect(await h.text()).toBe(
      `[mu] ${RULE}\n\n${RAN} Its result:\n${JSON.stringify(data)}\n\nDelegate answer: call c1, task scratch/t_c1, done.\n${"x".repeat(REPORT_CAP)}\n[... 10 more characters: mu task notes t_c1 -w scratch]`,
    );
    expect(h.delivered).toEqual([["c1"]]);
  });

  it("owed news adds one line naming it", async () => {
    const d = {
      firing: { kind: "closed", ref: "task:w/a" },
      exit: 0,
      snapshots: [closeSnap("a", { delivered: true }), closeSnap("b", { owed: true })],
      owed: 1,
    };
    const text = await harness([okWait(d)]).text();
    expect(
      text.endsWith(
        `}\n\n1 more ready, not yet delivered: task w/b CLOSED (the next settle delivers them; or run mu wait --ready)`,
      ),
    ).toBe(true);
  });
});

describe("a ready batch: one line per event, the answer blocks as before", () => {
  it("2 answers and a close: one entry, 3 lines, 2 blocks at WAVE_REPORT_CAP, both delivered", async () => {
    const d = {
      firing: { kind: "delegate", ref: "delegate:c1" },
      events: [
        { kind: "delegate", ref: "delegate:c1" },
        { kind: "closed", ref: "task:w/a" },
        { kind: "delegate", ref: "delegate:c2" },
      ],
      exit: 0,
      snapshots: [closeSnap("a", { delivered: true })],
      owed: 0,
    };
    const long = "y".repeat(WAVE_REPORT_CAP + 1);
    const h = harness([okWait(d)], [row("c1"), row("c2")], () => long);
    const r = await h.emit();
    expect(r?.continue).toBe(true);
    const text = r?.entries?.[0]?.content ?? "";
    expect(text).toContain(
      `${RAN} 3 events:\n- delegate scratch/t_c1 (call c1) done: answer below\n- task w/a CLOSED\n- delegate scratch/t_c2 (call c2) done: answer below\nIts result:\n{`,
    );
    for (const id of ["c1", "c2"]) {
      expect(text).toContain(`\n\nDelegate answer: call ${id}, task scratch/t_${id}, done.\n`);
      expect(text).toContain(`[... 1 more characters: mu task notes t_${id} -w scratch]`);
    }
    expect(text.indexOf("call c1, task")).toBeLessThan(text.indexOf("call c2, task"));
    expect(h.delivered).toEqual([["c1", "c2"]]);
    expect(h.waitArgs).toHaveLength(1);
  });
});

describe("superseded results (D2)", () => {
  it("nothing consumed: one display line, no continue, no further wait, nothing delivered", async () => {
    const d = {
      firing: { kind: "delegate", ref: "delegate:c1" },
      events: [{ kind: "delegate", ref: "delegate:c1" }],
      superseded: true,
      eventConsumed: false,
      snapshots: [{ kind: "delegate", ref: "delegate:c1", owed: true }],
      owed: 1,
    };
    const h = harness([okWait(d)], [row("c1")]);
    const r = await h.emit();
    expect(r?.continue).toBeUndefined();
    expect(r?.entries?.map((e) => e.content)).toEqual([SUPERSEDED_LINE]);
    expect(h.waitArgs).toHaveLength(1);
    expect(h.delivered).toEqual([]);
  });

  it("partly consumed: only the delivered member is rendered and delivered; the other is owed", async () => {
    const d = {
      firing: { kind: "delegate", ref: "delegate:c1" },
      events: [
        { kind: "delegate", ref: "delegate:c1" },
        { kind: "delegate", ref: "delegate:c2" },
      ],
      superseded: true,
      eventConsumed: false,
      snapshots: [
        { kind: "delegate", ref: "delegate:c1", status: "done", owed: true },
        { kind: "delegate", ref: "delegate:c2", status: "done", delivered: true },
      ],
      owed: 1,
    };
    const h = harness([okWait(d)], [row("c1"), row("c2")]);
    const r = await h.emit();
    expect(r?.continue).toBe(true);
    const text = r?.entries?.[0]?.content ?? "";
    expect(text).toContain(`${RAN} Its result:`);
    expect(text).toContain("Delegate answer: call c2,");
    expect(text).not.toContain("Delegate answer: call c1,");
    expect(text).toContain("1 more ready, not yet delivered: delegate c1 done");
    // The printed result names only what was consumed: the unconsumed firing c1 is left out.
    const json = text.split(`${RAN} Its result:\n`)[1]?.split("\n")[0] ?? "";
    const shown = JSON.parse(json) as { firing?: unknown; events?: unknown };
    expect(shown.firing).toBeUndefined();
    expect(shown.events).toEqual([{ kind: "delegate", ref: "delegate:c2" }]);
    expect(text).toContain(
      "\n\nA newer mu wait of this session began; what is not shown here was not consumed, that wait returns it.",
    );
    expect(h.delivered).toEqual([["c2"]]);
  });

  it("in the wave loop: its consumed sibling folds in, the loop ends with the one line, no re-wait", async () => {
    const first = {
      firing: { kind: "delegate", ref: "delegate:a1" },
      exit: 0,
      snapshots: ["a1", "a2", "a3"].map((id) => ({ kind: "delegate", ref: `delegate:${id}` })),
    };
    const loop = {
      firing: { kind: "delegate", ref: "delegate:a3" },
      events: [
        { kind: "delegate", ref: "delegate:a3" },
        { kind: "delegate", ref: "delegate:a2" },
      ],
      superseded: true,
      eventConsumed: false,
      snapshots: [
        { kind: "delegate", ref: "delegate:a3", owed: true },
        { kind: "delegate", ref: "delegate:a2", delivered: true },
      ],
      owed: 1,
    };
    const rows = [row("a1", "W"), row("a2", "W"), row("a3", "W")];
    const h = harness([okWait(first), okWait(loop)], rows);
    const text = await h.text();
    expect(h.waitArgs).toHaveLength(2);
    expect(text).toContain("It waited for wave W, which is not all in (below):");
    expect(text).toContain("Delegate answer: call a2,");
    expect(text).not.toContain("Delegate answer: call a3,");
    expect(text).toContain(
      "\n\nA newer mu wait of this session began; what is not shown here was not consumed, that wait returns it.",
    );
    expect(h.delivered).toEqual([["a1", "a2"]]);
  });
});

describe("the union wave loop", () => {
  it("a loop result with another wave's answer and a close: siblings fold, the rest shown after", async () => {
    const first = {
      firing: { kind: "delegate", ref: "delegate:a1" },
      exit: 0,
      snapshots: ["a1", "a2"].map((id) => ({ kind: "delegate", ref: `delegate:${id}` })),
    };
    const loop = {
      firing: { kind: "delegate", ref: "delegate:a2" },
      events: [
        { kind: "delegate", ref: "delegate:a2" },
        { kind: "delegate", ref: "delegate:x1" },
        { kind: "closed", ref: "task:w/t" },
      ],
      exit: 0,
      snapshots: [closeSnap("t", { delivered: true })],
      owed: 0,
    };
    const h = harness([okWait(first), okWait(loop)], [row("a1", "W"), row("a2", "W"), row("x1")]);
    const text = await h.text();
    // a2 joined wave W (now all in); x1 and the close ended the loop and are shown after it.
    expect(text).toContain(`${RAN} It waited until wave W was in:`);
    expect(text).toContain("Wave W: 0/2 CONFIRMED, 0 REFUTED, 2 UNVERIFIED");
    expect(text).toContain(
      "Another event came before the rest of wave W:\n- delegate x1 done\n- task w/t CLOSED\n{",
    );
    for (const id of ["a1", "a2", "x1"])
      expect(text.split(`Delegate answer: call ${id},`)).toHaveLength(2);
    expect(text.indexOf("Delegate answer: call a2,")).toBeLessThan(text.indexOf("Another event"));
    expect(text.indexOf("Another event")).toBeLessThan(text.indexOf("Delegate answer: call x1,"));
    expect(h.delivered).toEqual([["a1", "a2", "x1"]]);
    expect(h.waitArgs).toHaveLength(2);
  });
});
