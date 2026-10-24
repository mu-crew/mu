// src/fold.ts is pure: ops in, row state out. The property test
// (apply-fold) proves live == rebuild for every arrival order, which holds
// for ANY fold; these pin what the fold says, with exact values.

import { describe, expect, it } from "vitest";
import {
  foldEdge,
  foldNotes,
  foldTask,
  foldWorkstream,
  isoOfHlc,
  type LogOp,
  noteIdentity,
} from "../src/fold.js";
import { formatHlc } from "../src/hlc.js";

const M = "9f1c8a2e-0000-4000-8000-0000000000aa";
const BASE = 2_000_000_000_000;
const h = (n: number): string => formatHlc({ wallMs: BASE + n, counter: 0, machineId: M });
const put = (n: number, payload: Record<string, unknown>, key = "k"): LogOp => ({
  hlc: h(n),
  op: "put",
  key,
  payload: JSON.stringify(payload),
});
const del = (n: number, payload: Record<string, unknown> = {}, key = "k"): LogOp => ({
  hlc: h(n),
  op: "del",
  key,
  payload: JSON.stringify(payload),
});

describe("foldTask", () => {
  it("is dead with no put newer than the horizon", () => {
    expect(foldTask([put(1, { title: "a" })], h(2), "a")).toBeNull();
    expect(foldTask([put(2, { title: "a" })], h(2), "a")).toBeNull();
    expect(foldTask([put(3, { title: "a" })], h(2), "a")).not.toBeNull();
    expect(foldTask([], null, "a")).toBeNull();
  });

  it("per field, the newest put that carries the field wins", () => {
    const t = foldTask(
      [put(1, { title: "old", impact: 10 }), put(3, { title: "new" }), put(2, { impact: 70 })],
      null,
      "a",
    );
    expect(t).toMatchObject({ title: "new", impact: 70 });
  });

  it("a set-to-null is a write: it beats an older value", () => {
    const t = foldTask(
      [put(1, { dispatch_host: "h1" }), put(2, { dispatch_host: null })],
      null,
      "a",
    );
    expect(t?.dispatchHost).toBeNull();
  });

  it("a dead life's fields never leak into the next life", () => {
    const t = foldTask([put(1, { title: "dead", impact: 90 }), put(3, { impact: 20 })], h(2), "a");
    expect(t).toMatchObject({ title: "a", impact: 20 });
  });

  it("defaults: title is the local id; timestamps are the first live put's wall clock", () => {
    const t = foldTask([put(5, {}), put(7, {})], null, "the-id");
    expect(t).toMatchObject({
      title: "the-id",
      status: "OPEN",
      substate: "todo",
      impact: 50,
      effortDays: 1,
      scored: 0,
      dispatchHost: null,
      createdAt: isoOfHlc(h(5)),
      updatedAt: isoOfHlc(h(5)),
    });
  });

  it("substate comes from the NEWEST op that writes one, resolved against the folded status", () => {
    const t = foldTask(
      [
        put(1, { status: "OPEN", substate: "triage" }),
        put(2, { status: "OPEN", substate: "parked" }),
        put(3, { title: "x" }),
      ],
      null,
      "a",
    );
    expect(t?.substate).toBe("parked");
  });

  it("a status-only put writes the status default; an illegal pair falls back to it", () => {
    expect(
      foldTask([put(1, { substate: "triage" }), put(2, { status: "CLOSED" })], null, "a"),
    ).toMatchObject({ status: "CLOSED", substate: "done" });
    expect(
      foldTask(
        [put(1, { status: "OPEN", substate: "triage" }), put(2, { status: "IN_PROGRESS" })],
        null,
        "a",
      ),
    ).toMatchObject({ status: "IN_PROGRESS", substate: "active" });
  });

  it("drops values the schema refuses instead of failing: they do not shadow older good ones", () => {
    const t = foldTask(
      [
        put(1, { impact: 40, effort_days: 2, scored: 1, status: "CLOSED" }),
        put(2, { impact: 0, effort_days: -1, scored: 7, status: "BOGUS", title: 5 }),
      ],
      null,
      "a",
    );
    expect(t).toMatchObject({ impact: 40, effortDays: 2, scored: 1, status: "CLOSED", title: "a" });
  });

  it("maps a legacy status onto its pair", () => {
    expect(foldTask([put(1, { status: "DEFERRED" })], null, "a")).toMatchObject({
      status: "OPEN",
      substate: "parked",
    });
  });
});

describe("foldWorkstream", () => {
  const noTask = (): string | null => null;

  it("exists from its first live put, or from a task put under it", () => {
    expect(foldWorkstream([], noTask)).toBeNull();
    expect(foldWorkstream([], () => h(4))).toMatchObject({ createdAt: isoOfHlc(h(4)) });
    expect(foldWorkstream([put(2, { created_at: "S" })], noTask)).toMatchObject({ createdAt: "S" });
  });

  it("a del ends the life; only what comes after it counts", () => {
    const ops = [
      put(1, { created_at: "S", torn_down_at: "T" }),
      del(2),
      put(3, { torn_down_at: null }),
    ];
    expect(foldWorkstream(ops, noTask)).toEqual({ createdAt: isoOfHlc(h(3)), tornDownAt: null });
    expect(foldWorkstream([put(1, {}), del(2)], noTask)).toBeNull();
  });

  it("the task-put scan sees the horizon, so an older task cannot keep a dead workstream", () => {
    let seen: string | null | undefined;
    foldWorkstream([put(1, {}), del(2)], (after) => {
      seen = after;
      return null;
    });
    expect(seen).toBe(h(2));
  });

  it("creation default is the earlier of its own first put and the first task put", () => {
    expect(foldWorkstream([put(5, {})], () => h(3))?.createdAt).toBe(isoOfHlc(h(3)));
    expect(foldWorkstream([put(2, {})], () => h(3))?.createdAt).toBe(isoOfHlc(h(2)));
  });
});

describe("foldNotes", () => {
  const note = (
    n: number,
    content: string,
    at = "t1",
    extra: Record<string, unknown> = {},
    key = "w/a#1",
  ) => put(n, { author: "p", content, created_at: at, ...extra }, key);
  const id = (content: string, at = "t1") => noteIdentity("p", content, at);

  it("is a set by identity: a repeat is one note, the same text at another time is another", () => {
    const m = foldNotes([note(1, "x"), note(2, "x"), note(3, "x", "t2")], null);
    expect([...m.keys()].sort()).toEqual([id("x", "t1"), id("x", "t2")].sort());
  });

  it("a del kills only the puts of its identity that are OLDER than it", () => {
    const ops = [
      note(1, "x"),
      del(2, { author: "p", content: "x", created_at: "t1" }),
      note(3, "x"),
    ];
    expect(foldNotes(ops, null).has(id("x"))).toBe(true);
    expect(foldNotes(ops.slice(0, 2), null).has(id("x"))).toBe(false);
    // …and a put newer than the del is not touched by it, whatever the arrival order.
    expect(foldNotes([ops[2] as LogOp, ops[1] as LogOp], null).has(id("x"))).toBe(true);
  });

  it("a bare del names its note by the newest older put under its key", () => {
    const ops = [
      note(1, "x", "t1", {}, "w/a#1"),
      note(2, "y", "t1", {}, "w/a#2"),
      del(3, {}, "w/a#1"),
    ];
    expect([...foldNotes(ops, null).keys()]).toEqual([id("y")]);
  });

  it("puts at or below the horizon are dead; an unknown kind lands as note; first put sets kind", () => {
    const m = foldNotes(
      [
        note(1, "dead"),
        note(3, "a", "t1", { kind: "verdict" }),
        note(4, "a", "t1", { kind: "brief" }),
        note(5, "b", "t1", { kind: "telemetry" }),
      ],
      h(2),
    );
    expect(m.get(id("dead"))).toBeUndefined();
    expect(m.get(id("a"))?.kind).toBe("verdict");
    expect(m.get(id("b"))?.kind).toBe("note");
  });
});

describe("foldEdge", () => {
  it("is present iff a put is newer than its own del and both endpoint horizons", () => {
    expect(foldEdge([put(1, { created_at: "S" })], [null, null])).toEqual({ createdAt: "S" });
    expect(foldEdge([put(1, {}), del(2)], [null, null])).toBeNull();
    expect(foldEdge([put(1, {}), del(2), put(3, {})], [null, null])).not.toBeNull();
    expect(foldEdge([put(3, {})], [null, h(3)])).toBeNull();
    expect(foldEdge([put(3, {})], [h(1), h(2)])).not.toBeNull();
  });

  it("created_at is the first LIVE put's: a re-add after a del restamps it, a plain re-put does not", () => {
    expect(
      foldEdge([put(1, { created_at: "S" }), del(2), put(3, { created_at: "N" })], [null, null]),
    ).toEqual({ createdAt: "N" });
    expect(
      foldEdge([put(1, { created_at: "S" }), put(2, { created_at: "N" })], [null, null]),
    ).toEqual({
      createdAt: "S",
    });
  });
});
