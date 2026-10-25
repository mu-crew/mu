import { describe, expect, it } from "vitest";
import { tasksRunTwice } from "../../tools/eval/agent-rules.ts";
import { missingGoldenEvidence } from "../../tools/eval/check-rules.ts";
import { delegateFor } from "../../tools/eval/observe.ts";

describe("tasksRunTwice", () => {
  it("reports a task closed under two agents", () => {
    const r = [
      { agent: "w1", task: "a1", action: "error" },
      { agent: "w4", task: "a1", action: "close" },
      { agent: "w1", task: "a1", action: "close" },
    ];
    expect(tasksRunTwice(r)).toEqual(["a1 ran under w4 and w1"]);
    expect(tasksRunTwice(r.slice(0, 2))).toEqual([]);
  });
});

describe("golden evidence", () => {
  it("saturation golden must show a refusal", () => {
    const v = (n: string) => ({ completed: true, wrong: [], destructive: [], notes: [n] });
    expect(missingGoldenEvidence("delegate_saturation", v("refused=0 issued=12"))).toHaveLength(1);
    expect(missingGoldenEvidence("delegate_saturation", v("refused=2 issued=12"))).toEqual([]);
    expect(missingGoldenEvidence("other", v("x"))).toEqual([]);
  });
});

describe("delegateFor", () => {
  it("takes the claim token in the task, the label, or record.task", () => {
    expect(delegateFor({ task: "CLAIM claim-3: x" }, 3)).toBe(true);
    expect(delegateFor({ task: "check it", label: "c3" }, 3)).toBe(true);
    expect(delegateFor({ task: "check it", record: { task: "eval/c3" } }, 3)).toBe(true);
  });
  it("does not confuse claim-1 with claim-12", () => {
    expect(delegateFor({ task: "claim-12", label: "c12", record: { task: "eval/c12" } }, 1)).toBe(
      false,
    );
  });
});
