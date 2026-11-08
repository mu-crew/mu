// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The next-step case catalogue (tools/eval/nextstep-cases*.ts, spec §2 and §2.3, unit B4b): its
// shape, without a sandbox. `nextstep check` (nextstep.integration.test.ts, and by hand for the
// timed cases) proves the judges; this pins what every case must carry so check can prove it.
import { describe, expect, it } from "vitest";
import type { NextCase } from "../../tools/eval/nextstep.ts";
import { NEXT_CASES } from "../../tools/eval/nextstep-cases.ts";
import {
  namesState,
  phrase,
  records,
  verdictLabel,
  word,
} from "../../tools/eval/nextstep-cases-lib.ts";

const ST = new Proxy({}, { get: (_t, k) => `<${String(k)}>` }) as Record<string, string>;
const variants = (c: NextCase): ("a" | "b")[] =>
  (["a", "b"] as const).filter((v) => c.paraphrases.some((p) => p.leadIn === v));

describe("next-step case catalogue", () => {
  it("holds the §2 cases in order; dead_once is dropped (base reports one death once)", () => {
    expect(NEXT_CASES.map((c) => c.id)).toEqual([
      "close_preview_apply",
      "close_preview_conflict",
      "wait_result_read",
      "wait_heartbeat_merge",
      "wait_shell_limit",
      "notes_report_read",
      "notes_multi",
      "agent_read_text",
      "delegate_no_verdict",
      "close_already_closed",
      "sleep_poll",
      "sql_name_guess",
      "finding_guess",
    ]);
  });

  it("each case has one group, its arms, paraphrases by role, and unique paraphrase ids", () => {
    for (const c of NEXT_CASES) {
      expect(c.arms[0], c.id).toBe("none");
      expect(c.arms, c.id).toContain("skill");
      const want = c.role === "headline" ? 10 : 6;
      expect(c.paraphrases.length, c.id).toBeGreaterThanOrEqual(want);
      expect(c.paraphrases.length, c.id).toBeLessThanOrEqual(14);
      expect(new Set(c.paraphrases.map((p) => p.id)).size, c.id).toBe(c.paraphrases.length);
      expect(c.group === "guard", c.id).toBe(c.role === "guard");
    }
  });

  it("every lead-in variant has a golden of 1-3 commands, a bad, and the §2.3 extras", () => {
    for (const c of NEXT_CASES)
      for (const v of variants(c)) {
        const g = c.golden(ST, v);
        expect(g.length, `${c.id}/${v}`).toBeGreaterThanOrEqual(1);
        expect(g.length, `${c.id}/${v}`).toBeLessThanOrEqual(3);
        expect(c.bad(ST, v).length, `${c.id}/${v}`).toBeGreaterThanOrEqual(1);
        const x = c.extras(ST, v);
        for (const e of x) {
          expect(e.cmds.length, `${c.id}/${v} ${e.label}`).toBeLessThanOrEqual(3);
          expect(e.expect, `${c.id}/${v} ${e.label}`).toBe(e.label === "alt" ? "hit" : "miss");
        }
        // a lucky spelling or forgery per case (case 7's are in its pilot)
        expect(
          x.some((e) => e.label === "lucky"),
          `${c.id}/${v}`,
        ).toBe(true);
      }
  });

  it("only the cases with a pending goal state are timed, and each has a sleep-wait row", () => {
    const timed = NEXT_CASES.filter((c) => c.timed).map((c) => c.id);
    expect(timed).toEqual(["wait_heartbeat_merge", "wait_shell_limit", "sleep_poll"]);
    for (const c of NEXT_CASES) {
      const sleeps = variants(c).flatMap((v) => c.extras(ST, v).filter((e) => e.label === "sleep"));
      expect(sleeps.length > 0, c.id).toBe(c.timed === true);
    }
  });

  it("builder notes: case 4's JSON alt, case 2's merged-and-killed forgery, the review's forgery and stray-spawn rows", () => {
    const by = (id: string): NextCase => {
      const c = NEXT_CASES.find((x) => x.id === id);
      if (!c) throw new Error(id);
      return c;
    };
    const json = by("wait_heartbeat_merge")
      .extras(ST, "a")
      .filter((e) => e.label === "alt" && e.cmds.some((m) => /--json 2>\/dev\/null \| jq/.test(m)));
    expect(json.length).toBe(1);
    const killed = by("close_preview_conflict")
      .extras(ST, "a")
      .filter((e) => e.label === "lucky" && e.cmds.some((m) => m.includes("kill-pane")));
    expect(killed.map((e) => e.cmds[0])).toEqual([expect.stringContaining("cherry-pick")]);
    // cases 1 and 2: the golden plus a stray spawn of worker-9 misses; case 2 pins the worktree check alone
    for (const id of ["close_preview_apply", "close_preview_conflict"]) {
      const stray = by(id)
        .extras(ST, "a")
        .filter((e) => e.cmds.some((m) => m.includes("agent spawn worker-9")));
      expect(stray.map((e) => [e.label, e.expect])).toEqual([["lucky", "miss"]]);
    }
    expect(
      by("close_preview_conflict")
        .extras(ST, "a")
        .filter((e) => e.cmds.some((m) => m.startsWith("git worktree add"))),
    ).toHaveLength(1);
    // case 7: the reviewer's grep -o | sed forgery
    expect(
      by("notes_multi")
        .extras(ST, "a")
        .filter((e) => e.label === "lucky" && e.cmds.some((m) => m.includes("grep -o 'N1-"))),
    ).toHaveLength(1);
    // case 10's alternatives pick the short sha the wait's lastText prints
    expect(
      by("close_already_closed")
        .extras(ST, "a")
        .filter((e) => e.label === "alt")
        .map((e) => e.cmds[0]),
    ).toEqual(["git cherry-pick <short>", "git merge --no-edit <short>"]);
  });
});

describe("case helpers", () => {
  it("phrase: four words, fixed per seed and index, different across indexes", () => {
    expect(phrase("ab12", 1).split(" ")).toHaveLength(4);
    expect(phrase("ab12", 1)).toBe(phrase("ab12", 1));
    expect(phrase("ab12", 1)).not.toBe(phrase("ab12", 2));
  });

  it("namesState reads one record of a JSON line, and whole words only", () => {
    const line = '{"id":"t1","status":"OPEN"},{"id":"t2","status":"CLOSED"}';
    expect(records(line)).toHaveLength(2);
    expect(namesState("t2", "CLOSED")(line)).toBe(true);
    expect(namesState("t1", "CLOSED")(line)).toBe(false);
    expect(namesState("t1", "OPEN")("task\tt10\tOPEN")).toBe(false);
    expect(word("worker-12 done", "worker-1")).toBe(false);
  });

  it("verdictLabel reads the first VERDICT line, behind at most one role word", () => {
    expect(verdictLabel("REFUTER r (a, 1s):\nNO VERDICT LINE: fine")).toBeUndefined();
    expect(verdictLabel("x\nVERDICT: t4 CONFIRMED - ok")).toBe("CONFIRMED");
    expect(verdictLabel("REFUTER: VERDICT: REFUTED")).toBe("REFUTED");
    expect(verdictLabel("see VERDICT: CONFIRMED inline")).toBeUndefined();
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
