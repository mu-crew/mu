// Pure tests for src/output-contract.ts: the wire envelope and the cap helper.

import { describe, expect, it } from "vitest";
import {
  capRecords,
  type Envelope,
  encodeEnvelope,
  isEnvelope,
  okEnvelope,
} from "../src/output-contract.js";

describe("encodeEnvelope", () => {
  it("encodes a success as one line {ok,data,next}", () => {
    const s = encodeEnvelope({ ok: true, data: { n: 1 }, next: null });
    expect(s.includes("\n")).toBe(false);
    expect(JSON.parse(s)).toEqual({ ok: true, data: { n: 1 }, next: null });
  });

  it("encodes an error as {ok:false,error,message,next,exit} with the key order fixed", () => {
    const s = encodeEnvelope({
      ok: false,
      error: "TaskNotFoundError",
      message: "no such task",
      next: null,
      exit: 3,
    });
    expect(Object.keys(JSON.parse(s))).toEqual(["ok", "error", "message", "next", "exit"]);
  });

  it("keeps a seq plan whole, however long", () => {
    const commands = Array.from({ length: 200 }, (_, i) => `mu task show t${i}`);
    const parsed = JSON.parse(
      encodeEnvelope({ ok: true, data: null, next: { mode: "seq", commands } }),
    );
    expect(parsed.next.commands).toHaveLength(200);
    expect(parsed.next.mode).toBe("seq");
  });

  it("strips ANSI from an error message and error name", () => {
    const s = encodeEnvelope({
      ok: false,
      error: "\u001b[31mBoom\u001b[0m",
      message: "\u001b[1mbad\u001b[22m thing \u001b[2m(dim)\u001b[0m",
      next: null,
      exit: 1,
    });
    expect(s).not.toContain("\u001b");
    expect(JSON.parse(s).message).toBe("bad thing (dim)");
    expect(JSON.parse(s).error).toBe("Boom");
  });

  it("carries extra fields on an error after the fixed ones (receipts, data)", () => {
    const env: Envelope<{ agent: string }> = {
      ok: false,
      error: "AgentSendIndeterminateError",
      message: "no reply",
      next: null,
      exit: 1,
      extra: { msgId: "m1", delivery: "unknown" },
      data: { agent: "w1" },
    };
    const parsed = JSON.parse(encodeEnvelope(env));
    expect(parsed).toMatchObject({ msgId: "m1", delivery: "unknown", data: { agent: "w1" } });
    expect(Object.keys(parsed).slice(0, 5)).toEqual(["ok", "error", "message", "next", "exit"]);
  });

  it("lets extra never overwrite a fixed key", () => {
    const parsed = JSON.parse(
      encodeEnvelope({
        ok: false,
        error: "E",
        message: "m",
        next: null,
        exit: 2,
        extra: { exit: 99, ok: true },
      }),
    );
    expect(parsed.exit).toBe(2);
    expect(parsed.ok).toBe(false);
  });
});

describe("isEnvelope / okEnvelope", () => {
  it("recognises only an explicit success envelope, not arbitrary data with an ok key", () => {
    expect(isEnvelope(okEnvelope({ a: 1 }))).toBe(true);
    expect(isEnvelope({ ok: true, count: 1 })).toBe(false);
    expect(isEnvelope({ ok: true, data: 1 })).toBe(false);
    expect(isEnvelope({ ok: true, data: 1, next: null, extra: 1 })).toBe(false);
    expect(isEnvelope([{ ok: true, data: 1, next: null }])).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });

  it("wraps an old payload once: data.ok is data, not a transport flag", () => {
    const inner = { ok: false, error: "x" };
    const env = okEnvelope(inner);
    expect(env).toEqual({ ok: true, data: inner, next: null });
    expect(okEnvelope(env)).toBe(env);
  });
});

describe("capRecords", () => {
  const rec = (n: number) => `r${n} ${"x".repeat(8)}`; // 11 bytes + newline

  it("returns everything when it fits", () => {
    expect(capRecords([rec(1), rec(2)], 100)).toEqual({ records: [rec(1), rec(2)], cut: 0 });
  });

  it("cuts the tail on a record boundary and counts what it dropped", () => {
    const r = capRecords([rec(1), rec(2), rec(3), rec(4)], 30);
    expect(r.records).toEqual([rec(1), rec(2)]);
    expect(r.cut).toBe(2);
  });

  it("counts UTF-8 bytes, not characters", () => {
    const wide = "é".repeat(10); // 20 bytes
    const r = capRecords([wide, wide, wide], 45);
    expect(r.records).toHaveLength(2);
    expect(r.cut).toBe(1);
  });

  it("always keeps the first record, even when it alone is over the budget", () => {
    const big = "y".repeat(500);
    expect(capRecords([big, "z"], 10)).toEqual({ records: [big], cut: 1 });
  });

  it("never cuts a pinned record and keeps the order", () => {
    const records = [`pinned-brief ${"b".repeat(100)}`, rec(1), rec(2), "pinned-report"];
    const r = capRecords(records, 30, (s) => s.startsWith("pinned"));
    expect(r.records).toEqual([records[0], records[3]]);
    expect(r.cut).toBe(2);
  });

  it("defaults to a 4 KB budget", () => {
    const many = Array.from({ length: 1000 }, (_, i) => rec(i));
    const r = capRecords(many);
    const bytes = r.records.reduce((n, s) => n + Buffer.byteLength(s) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(r.cut).toBe(1000 - r.records.length);
    expect(r.cut).toBeGreaterThan(0);
  });
});
