// The wire contract end to end (src/output-contract.ts): one JSON document per
// `--json` invocation on STDOUT, success or failure, so `2>/dev/null` loses
// nothing. Raw captures (runCliWire), because the envelope itself is the subject.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitJson, emitJsonCollection, emitJsonRow } from "../src/cli.js";
import { rmFixtureDir } from "./_fs.js";
import { runCliJson, runCliWire } from "./_runCli.js";

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-envelope-"));
  dbPath = join(dir, "mu.db");
});
afterEach(() => rmFixtureDir(dir));

const oneDoc = (stdout: string) => {
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
};

describe("emitJson", () => {
  const capture = (fn: () => void): string => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      fn();
      return String(spy.mock.calls[0]?.[0]);
    } finally {
      spy.mockRestore();
    }
  };

  it("wraps a payload as {ok:true,data,next:null}", () => {
    expect(JSON.parse(capture(() => emitJson({ a: 1 })))).toEqual({
      ok: true,
      data: { a: 1 },
      next: null,
    });
  });

  it("treats a payload's own ok key as data, never as the transport flag", () => {
    const doc = JSON.parse(capture(() => emitJson({ ok: false, error: "x" })));
    expect(doc).toEqual({ ok: true, data: { ok: false, error: "x" }, next: null });
  });

  it("does not wrap an explicit envelope twice", () => {
    const env = { ok: true, data: { a: 1 }, next: null };
    expect(JSON.parse(capture(() => emitJson(env)))).toEqual(env);
  });

  it("emitJsonCollection keeps {items,count} as the data", () => {
    expect(JSON.parse(capture(() => emitJsonCollection(["a", "b"])))).toEqual({
      ok: true,
      data: { items: ["a", "b"], count: 2 },
      next: null,
    });
  });

  it("emitJsonRow (NDJSON stream rows) stays raw, not enveloped", () => {
    expect(JSON.parse(capture(() => emitJsonRow({ seq: 7, kind: "x" })))).toEqual({
      seq: 7,
      kind: "x",
    });
  });
});

describe("the wire, through the real program", () => {
  it("a success is one envelope on stdout, stderr empty", async () => {
    const r = await runCliWire(["workstream", "init", "wire-ws", "--json"], dbPath);
    expect(r.stderr).toBe("");
    expect(oneDoc(r.stdout)).toMatchObject({ ok: true, next: null });
    expect(oneDoc(r.stdout)).toHaveProperty("data");
  });

  it("a typed failure is one document on stdout with the real exit, nothing on stderr", async () => {
    await runCliWire(["workstream", "init", "wire-ws"], dbPath);
    const r = await runCliWire(["task", "show", "ghost", "-w", "wire-ws", "--json"], dbPath);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe("");
    expect(oneDoc(r.stdout)).toMatchObject({
      ok: false,
      error: "TaskNotFoundError",
      next: null,
      exit: 3,
    });
  });

  it("2>/dev/null loses nothing: a bad id still leaves a parseable stdout and a non-zero exit", async () => {
    const r = await runCliWire(["task", "add", "Bad Id!", "-t", "x", "--json"], dbPath);
    expect(r.exitCode).not.toBeNull();
    expect(r.exitCode).not.toBe(0);
    const doc = oneDoc(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.exit).toBe(r.exitCode);
  });

  it("a commander parse failure takes the same path: root and leaf --json", async () => {
    const leaf = await runCliWire(["task", "list", "--bogus", "--json"], dbPath);
    expect(leaf.exitCode).toBe(2);
    expect(leaf.stderr).toBe("");
    expect(oneDoc(leaf.stdout)).toMatchObject({ ok: false, error: "CommanderError", exit: 2 });
    const root = await runCliWire(["--json", "nonsense"], dbPath);
    expect(root.exitCode).toBe(2);
    expect(root.stderr).toBe("");
    expect(oneDoc(root.stdout)).toMatchObject({ ok: false, exit: 2 });
  });

  it("the usage on an unknown flag is at most 3 short lines, not the whole help", async () => {
    const r = await runCliWire(["task", "list", "--bogus", "--json"], dbPath);
    const usage = oneDoc(r.stdout).usage as string[];
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.length).toBeLessThanOrEqual(3);
    expect(usage[0]).toMatch(/^mu task list/);
    for (const line of usage) expect(line.length).toBeLessThanOrEqual(200);
  });

  it("carries no ANSI even when colour is forced", async () => {
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const r = await runCliWire(["task", "show", "ghost", "-w", "nope", "--json"], dbPath);
      expect(`${r.stdout}${r.stderr}`).not.toContain("\u001b");
    } finally {
      if (saved === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved;
    }
  });

  it("runCliJson unwraps data for a success and keeps the doc for a failure", async () => {
    const ok = await runCliJson<{ items: unknown[]; count: number }>(
      ["workstream", "list", "--json"],
      dbPath,
    );
    expect(ok.doc.ok).toBe(true);
    expect(ok.data.count).toBe(ok.data.items.length);
    const bad = await runCliJson(["task", "show", "ghost", "-w", "nope", "--json"], dbPath);
    expect(bad.doc.ok).toBe(false);
  });

  it("human mode is untouched: the error stays one line on stderr", async () => {
    const r = await runCliWire(["task", "show", "ghost", "-w", "nope"], dbPath);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/not found|ghost/);
  });
});
