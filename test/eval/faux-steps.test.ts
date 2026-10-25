import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FauxScript,
  type FauxStep,
  loadAutScript,
  loadWorkerScript,
} from "../../tools/eval/faux-steps.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "faux-steps-"));
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (lastResult: string | null = null, lastUser = "hi") => ({ lastUser, lastResult });
const put = (name: string, steps: FauxStep[]) =>
  writeFileSync(join(dir, name), JSON.stringify(steps));

describe("loadWorkerScript", () => {
  it("picks <agent>.<n>.json, then <agent>.json, then default.json, counting attempts", () => {
    put("default.json", [{ text: "default" }]);
    put("w.json", [{ text: "agent" }]);
    put("w.2.json", [{ text: "second" }]);
    expect(loadWorkerScript(dir, "w")).toEqual([{ text: "agent" }]);
    expect(loadWorkerScript(dir, "w")).toEqual([{ text: "second" }]);
    expect(loadWorkerScript(dir, "w")).toEqual([{ text: "agent" }]);
    expect(readFileSync(join(dir, "w.attempts"), "utf8")).toBe("3");
    expect(loadWorkerScript(dir, "other")).toEqual([{ text: "default" }]);
  });

  it("falls back to a text step when nothing exists", () => {
    expect(loadWorkerScript(dir, "w")[0]).toEqual({ text: "(no script)" });
    expect(loadAutScript(undefined)[0]).toEqual({ text: "(no script)" });
  });
});

describe("FauxScript", () => {
  const worker: FauxStep[] = [{ calls: [{ bash: "eval-worker" }] }, { textFromLastResult: true }];

  it("maps steps to actions, then reports exhaustion and unknown steps", () => {
    const s = new FauxScript(
      [
        { calls: [{ bash: "echo a" }, { tool: "mu_delegate", args: { x: 1 } }] },
        { textFromLastResult: true },
        { text: "t" },
        { error: "e" },
        { nope: 1 } as unknown as FauxStep,
      ],
      null,
      "aut",
    );
    expect(s.next(ctx())).toEqual({
      kind: "calls",
      calls: [
        { name: "bash", args: { command: "echo a" } },
        { name: "mu_delegate", args: { x: 1 } },
      ],
    });
    expect(s.next(ctx("  result \n"))).toEqual({ kind: "text", text: "result" });
    expect(s.next(ctx())).toEqual({ kind: "text", text: "t" });
    expect(s.next(ctx())).toEqual({ kind: "error", message: "e" });
    expect(s.next(ctx())).toEqual({ kind: "text", text: "(bad step)" });
    expect(s.next(ctx())).toEqual({ kind: "text", text: "(script exhausted)" });
  });

  it("argsFromResults fills an arg from the nth match over every earlier tool result", () => {
    const step: FauxStep = {
      calls: [
        {
          tool: "mu_delegate_reissue",
          argsFromResults: { call_id: { re: "REFUSED call (\\S+)", nth: 1 } },
        },
      ],
    };
    const s = new FauxScript([step, step], null, "aut");
    const results = ["ok", "REFUSED call a-1", "REFUSED call b-2"];
    expect(s.next({ ...ctx(), results })).toEqual({
      kind: "calls",
      calls: [{ name: "mu_delegate_reissue", args: { call_id: "b-2" } }],
    });
    // no such match: a text step naming the miss, never a call with a guessed id
    expect(s.next({ ...ctx(), results: ["ok"] })).toMatchObject({ kind: "text" });
  });

  it("writes last-prompt.<agent> before every step", () => {
    const s = new FauxScript(worker, dir, "w1");
    s.next(ctx(null, "claim-12 please"));
    expect(readFileSync(join(dir, "last-prompt.w1"), "utf8")).toBe("claim-12 please");
  });

  it("die-next yields the die action and is consumed", () => {
    const s = new FauxScript(worker, dir, "w1");
    writeFileSync(join(dir, "die-next.w1"), "");
    expect(s.next(ctx())).toEqual({ kind: "die" });
    expect(existsSync(join(dir, "die-next.w1"))).toBe(false);
    expect(s.position).toBe(0);
  });

  it("die-next is checked before error-next", () => {
    const s = new FauxScript(worker, dir, "w1");
    writeFileSync(join(dir, "die-next.w1"), "");
    writeFileSync(join(dir, "error-next.w1"), "");
    expect(s.next(ctx()).kind).toBe("die");
    expect(existsSync(join(dir, "error-next.w1"))).toBe(true);
  });

  it("error-next created by the tool call: error after the result, rewind, rerun calls", () => {
    const s = new FauxScript(worker, dir, "w1");
    expect(s.next(ctx()).kind).toBe("calls");
    writeFileSync(join(dir, "error-next.w1"), ""); // eval-worker touched it
    expect(s.next(ctx("tool out"))).toEqual({ kind: "error", message: "529 overloaded_error" });
    expect(existsSync(join(dir, "error-next.w1"))).toBe(false);
    expect(s.position).toBe(0);
    expect(s.next(ctx(null, "again")).kind).toBe("calls");
    expect(s.next(ctx("done"))).toEqual({ kind: "text", text: "done" });
  });

  it("error-next before any calls step errors without advancing", () => {
    const s = new FauxScript(worker, dir, "w1");
    writeFileSync(join(dir, "error-next.w1"), "");
    expect(s.next(ctx()).kind).toBe("error");
    expect(s.position).toBe(0);
    expect(s.next(ctx()).kind).toBe("calls");
  });
});
