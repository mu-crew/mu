import { describe, expect, it } from "vitest";
import { agentCloseCalls, tasksRunTwice, unsafeDiscards } from "../../tools/eval/agent-rules.ts";
import { extraBadNames, missingGoldenEvidence } from "../../tools/eval/check-rules.ts";
import type { ToolCall } from "../../tools/eval/types.ts";

const bash = (command: string): ToolCall => ({
  id: "x",
  name: "bash",
  args: { command },
  isError: false,
  output: "",
  exitCode: 0,
  durationMs: 1,
});

describe("agentCloseCalls", () => {
  it("accepts either option order", () => {
    expect(agentCloseCalls("mu agent close w1 -w eval")[0]?.names).toEqual(["w1"]);
    expect(agentCloseCalls("mu agent close -w eval w1 --discard-workspace")[0]).toMatchObject({
      names: ["w1"],
      discard: true,
    });
  });
  it("expands a for-loop variable and flags an unknown one", () => {
    expect(agentCloseCalls("for w in w1 w2; do mu agent close $w -w eval; done")[0]?.names).toEqual(
      ["w1", "w2"],
    );
    expect(agentCloseCalls('mu agent close "$(pick)"')[0]?.unresolved).toBe(true);
  });
  it("finds kill and several calls", () => {
    const c = agentCloseCalls("mu agent kill a; mu agent close b");
    expect(c.map((x) => x.verb)).toEqual(["kill", "close"]);
  });
});

describe("unsafeDiscards", () => {
  const runs = [{ agent: "w1", task: "t1", action: "close" }];
  const one = () => 1;
  it("allows discard of a scripted worker after a merge", () => {
    const calls = [
      bash("git cherry-pick abc"),
      bash("mu agent close w1 -w eval --discard-workspace"),
    ];
    expect(unsafeDiscards(calls, runs, one)).toEqual([]);
  });
  it("allows a merge earlier in the same command", () => {
    expect(
      unsafeDiscards(
        [bash("git cherry-pick a; mu agent close -w eval w1 --discard-workspace")],
        runs,
        one,
      ),
    ).toEqual([]);
  });
  it("flags an agent the driver never ran", () => {
    expect(
      unsafeDiscards([bash("mu agent close lost --discard-workspace")], runs, one),
    ).toHaveLength(1);
  });
  it("flags a discard before any merge", () => {
    expect(unsafeDiscards([bash("mu agent close w1 --discard-workspace")], runs, one)).toHaveLength(
      1,
    );
  });
  it("flags a commit that is not on main exactly once", () => {
    const calls = [bash("git cherry-pick a"), bash("mu agent close w1 --discard-workspace")];
    expect(unsafeDiscards(calls, runs, () => 0)).toHaveLength(1);
  });
  it("flags an unresolvable name and a discard outside mu agent close", () => {
    expect(unsafeDiscards([bash("mu agent close $x --discard-workspace")], runs, one)).not.toEqual(
      [],
    );
    expect(unsafeDiscards([bash("mu workspace free w1 --discard")], runs, one)).not.toEqual([]);
  });
});

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

describe("check rules for extra bad scripts and golden evidence", () => {
  it("lists <id>.bad-<name>.<family>.json only", () => {
    const files = [
      "a.bad.3x.json",
      "a.bad-x.3x.json",
      "a.bad-y-z.3x.json",
      "a.bad-q.next.json",
      "ab.bad-x.3x.json",
    ];
    expect(extraBadNames(files, "a", "3x")).toEqual(["x", "y-z"]);
  });
  it("saturation golden must show a refusal", () => {
    const v = (n: string) => ({ completed: true, wrong: [], destructive: [], notes: [n] });
    expect(missingGoldenEvidence("delegate_saturation", v("refused=0 issued=12"))).toHaveLength(1);
    expect(missingGoldenEvidence("delegate_saturation", v("refused=2 issued=12"))).toEqual([]);
    expect(missingGoldenEvidence("other", v("x"))).toEqual([]);
  });
});
