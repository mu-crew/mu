import { describe, expect, it } from "vitest";
import { isBefore, orderWrong, parseRunsLog } from "../../tools/eval/provenance.ts";

describe("parseRunsLog", () => {
  it("reads sha, patch-id and a cwd with spaces", () => {
    const r = parseRunsLog("1700 w1 r2 close abc123 def456 /tmp/a b/c\n1701 w2 t1 die - - /x\n");
    expect(r[0]).toMatchObject({
      agent: "w1",
      sha: "abc123",
      patchId: "def456",
      cwd: "/tmp/a b/c",
    });
    expect(r[1]).toMatchObject({ action: "die", sha: null, patchId: null });
  });
  it("skips short lines", () => {
    expect(parseRunsLog("1700 w1 r2 close\n")).toEqual([]);
  });
});

describe("order", () => {
  it("compares ops by seq, others by ms", () => {
    expect(isBefore({ label: "a", ms: 5, seq: 1 }, { label: "b", ms: 5, seq: 2 })).toBe(true);
    expect(isBefore({ label: "a", ms: 5 }, { label: "b", ms: 5 })).toBe(false);
  });
  it("a missing event is wrong", () => {
    expect(orderWrong(null, { label: "b", ms: 1 }, "x")).toHaveLength(1);
    expect(orderWrong({ label: "a", ms: 1 }, { label: "b", ms: 2 }, "x")).toEqual([]);
  });
});
