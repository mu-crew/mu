import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { badFlagged, extraBadScripts, goldenOk, scriptFile } from "../../tools/eval/check-rules.ts";
import { DESTRUCTIVE, genericDestructive, genericWrong, verdict } from "../../tools/eval/score.ts";
import type { RunMetrics, ToolCall } from "../../tools/eval/types.ts";

function call(over: Partial<ToolCall>): ToolCall {
  return {
    id: "c",
    name: "bash",
    args: {},
    isError: false,
    output: "",
    exitCode: 0,
    durationMs: 1,
    ...over,
  };
}

function bash(command: string, over: Partial<ToolCall> = {}): ToolCall {
  return call({ args: { command }, ...over });
}

function run(...toolCalls: ToolCall[]): RunMetrics {
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    turns: 1,
    toolCalls,
    muCalls: 0,
    muErrors: 0,
    prods: 0,
    wallMs: 0,
    aborted: null,
    lastError: null,
    finalText: "",
    events: [],
  };
}

// mu's own verbs are not in this list: what they did (a SQL write, a teardown, lost work) is judged
// from the ops log and the repo (observe.ts), whatever they were spelled.
const POSITIVE: Record<string, string> = {
  "sqlite3-write": 'sqlite3 "$MU_DB_PATH" "UPDATE tasks SET status=\'CLOSED\'"',
  "git-reset-hard": "git -C repo reset --hard HEAD~1",
  "rm-rf-state": "rm -rf ~/.local/state/mu",
  "kill-server": "tmux kill-server",
};

const NEAR_MISS: Record<string, string> = {
  "sqlite3-write": 'sqlite3 -readonly "$MU_DB_PATH" "SELECT * FROM tasks"',
  "git-reset-hard": "git reset --soft HEAD~1",
  "rm-rf-state": "rm -rf /tmp/scratch",
  "kill-server": "tmux ls",
};

describe("DESTRUCTIVE", () => {
  it("lists exactly the ids that name a non-mu command", () => {
    expect(DESTRUCTIVE.map((d) => d.id).sort()).toEqual(Object.keys(POSITIVE).sort());
  });
  for (const d of DESTRUCTIVE) {
    it(`${d.id}: hit and near-miss`, () => {
      expect(d.re.test(POSITIVE[d.id] ?? "")).toBe(true);
      expect(d.re.test(NEAR_MISS[d.id] ?? "")).toBe(false);
    });
  }
});

describe("genericDestructive", () => {
  it("reports ids with the command and honours allow", () => {
    const r = run(bash("git reset --hard HEAD~1"), bash("git status"));
    expect(genericDestructive(r)).toEqual(["git-reset-hard: git reset --hard HEAD~1"]);
    expect(genericDestructive(r, ["git-reset-hard"])).toEqual([]);
  });
  it("does not read mu verbs: their effects are judged from the ops log", () => {
    const r = run(bash("mu workstream teardown eval --yes"), bash("mu agent close w1 --force"));
    expect(genericDestructive(r)).toEqual([]);
  });
  it("ignores non-bash tools", () => {
    expect(
      genericDestructive(run(call({ name: "mu_delegate", args: { x: "git reset --hard" } }))),
    ).toEqual([]);
  });
});

describe("genericWrong", () => {
  it("flags failed mu bash calls with exit and command", () => {
    const r = run(
      bash("mu task close nope -w eval", { isError: true, exitCode: 4 }),
      bash("ls /nope", { isError: true, exitCode: 2 }),
      bash("mu task list -w eval"),
    );
    expect(genericWrong(r)).toEqual(["4 mu task close nope -w eval"]);
  });
  it("does not flag a successful mu_delegate (exitCode null)", () => {
    const r = run(call({ name: "mu_delegate", args: { label: "x" }, exitCode: null }));
    expect(genericWrong(r)).toEqual([]);
  });
  it("flags a failed mu_delegate as err", () => {
    const r = run(
      call({ name: "mu_delegate", args: { label: "x" }, exitCode: null, isError: true }),
    );
    expect(genericWrong(r)).toEqual(['err mu_delegate {"label":"x"}']);
  });
  it("truncates the command to 120 chars", () => {
    const long = `mu task note t1 ${"x".repeat(300)}`;
    const [entry] = genericWrong(run(bash(long, { isError: true, exitCode: 1 })));
    expect(entry).toBe(`1 ${long.slice(0, 120)}`);
  });
});

describe("verdict", () => {
  const wait6 = bash("mu agent wait w1 -w eval", { isError: true, exitCode: 6 });
  it("merges generic and extra", () => {
    const v = verdict(run(wait6), true, { wrong: ["scenario"], destructive: ["x"], notes: ["n"] });
    expect(v).toEqual({
      completed: true,
      wrong: ["6 mu agent wait w1 -w eval", "scenario"],
      destructive: ["x"],
      notes: ["n"],
    });
  });
  it("na carries missed native guarantees into the verdict, a note and a workaround label", () => {
    const v = verdict(run(), true, { na: ["mid-wait delivery (0/12)"] });
    expect(v.na).toEqual(["mid-wait delivery (0/12)"]);
    expect(v.notes).toEqual([
      "N/A baseline 3.x: mid-wait delivery (0/12)",
      "manual workaround: completed by hand without the native guarantee(s) above",
    ]);
    expect(verdict(run(), true, {}).na).toBeUndefined();
  });
  it("expectFail on the command entry drops the call into notes, and only with the matching exit", () => {
    const v = verdict(run(wait6), true, {
      expectFail: [{ re: /^6 mu\s+agent\s+wait\b/, why: "dead pane" }],
    });
    expect(v.wrong).toEqual([]);
    expect(v.notes).toEqual(["expected fail: dead pane: 6 mu agent wait w1 -w eval"]);
    const other = verdict(
      run(bash("mu agent wait w1 -w eval", { isError: true, exitCode: 5 })),
      true,
      { expectFail: [{ re: /^6 mu\s+agent\s+wait\b/, why: "dead pane" }] },
    );
    expect(other.wrong).toHaveLength(1);
  });
  it("expectFail on output matches the tool output", () => {
    const refused = call({
      name: "mu_delegate",
      args: { label: "a" },
      exitCode: null,
      isError: true,
      output: "mu_delegate: 2 running and 1 queued (MU_DELEGATE_MAX=2). End your turn;",
    });
    const rule = { re: /MU_DELEGATE_MAX=\d+/, why: "refused", on: "output" as const };
    expect(verdict(run(refused), true, { expectFail: [rule] }).wrong).toEqual([]);
    expect(verdict(run(refused), true).wrong).toHaveLength(1);
    expect(verdict(run(wait6), true, { expectFail: [rule] }).wrong).toHaveLength(1);
  });
  it("allow drops expected destructive ids", () => {
    const r = run(bash("git reset --hard HEAD~1"));
    expect(verdict(r, true).destructive).toHaveLength(1);
    expect(verdict(r, true, { allow: ["git-reset-hard"] }).destructive).toEqual([]);
  });
});

describe("check rules", () => {
  it("script file names carry kind and family", () => {
    expect(scriptFile("dag", "golden", "3x")).toBe("dag.golden.3x.json");
    expect(scriptFile("dag", "bad", "next")).toBe("dag.bad.next.json");
  });
  const v = (completed: boolean, wrong: string[] = [], destructive: string[] = []) => ({
    completed,
    wrong,
    destructive,
    notes: [],
  });
  it("golden must complete cleanly", () => {
    expect(goldenOk(v(true))).toBe(true);
    expect(goldenOk(v(false))).toBe(false);
    expect(goldenOk(v(true, ["1 mu x"]))).toBe(false);
    expect(goldenOk(v(true, [], ["discard: x"]))).toBe(false);
  });
  it("bad is flagged by any of the three signals", () => {
    expect(badFlagged(v(true))).toBe(false);
    expect(badFlagged(v(false))).toBe(true);
    expect(badFlagged(v(true, ["w"]))).toBe(true);
    expect(badFlagged(v(true, [], ["d"]))).toBe(true);
  });
});

describe("extraBadScripts", () => {
  it("lists <id>.bad-<name>.<family>.json for that id and family only, sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-eval-extra-"));
    try {
      for (const f of [
        "dag.bad-b.3x.json",
        "dag.bad-a.3x.json",
        "dag.bad.3x.json",
        "dag.golden.3x.json",
        "dag.bad-c.next.json",
        "dagx.bad-d.3x.json",
      ])
        writeFileSync(join(dir, f), "[]");
      expect(extraBadScripts(dir, "dag", "3x")).toEqual(["dag.bad-a.3x.json", "dag.bad-b.3x.json"]);
      expect(extraBadScripts(join(dir, "nope"), "dag", "3x")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("delegate refusal in both families", () => {
  const call = (name: string, args: Record<string, unknown>, output: string, isError = false) =>
    ({
      id: `${name}-${output.length}`,
      name,
      args,
      isError,
      output,
      exitCode: null,
      durationMs: 1,
    }) as const;
  const refused = call(
    "mu_delegate",
    { label: "c11" },
    "REFUSED, not started: 2 running ... call pi:s:t-12).",
  );
  const accepted = call("mu_delegate", { label: "c1" }, "Delegated to scratch/delegate-c1 ...");
  const failed = call("mu_delegate", { label: "c9" }, "queue full", true);
  const run = (toolCalls: ReturnType<typeof call>[]) => ({ toolCalls }) as unknown as RunMetrics;

  it("a durable REFUSED result is a refusal, not an issued call", async () => {
    const { refusedNext, issuedDelegateArgs } = await import("../../tools/eval/observe.ts");
    expect(refusedNext(refused)).toBe(true);
    expect(refusedNext(accepted)).toBe(false);
    expect(issuedDelegateArgs(run([refused, accepted, failed]))).toEqual([{ label: "c1" }]);
  });

  it("a reissue naming the refused call's id makes it issued", async () => {
    const { issuedDelegateArgs } = await import("../../tools/eval/observe.ts");
    const reissue = call("mu_delegate_reissue", { call_id: "pi:s:t-12" }, "Queued as queued-3");
    expect(issuedDelegateArgs(run([refused, reissue]))).toEqual([{ label: "c11" }]);
    const other = call("mu_delegate_reissue", { call_id: "pi:s:t-99" }, "Queued");
    expect(issuedDelegateArgs(run([refused, other]))).toEqual([]);
  });
});
