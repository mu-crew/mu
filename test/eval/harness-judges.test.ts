import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { loadScenario } from "../../tools/eval/commands.ts";
import type { RunMetrics, Sandbox, Verdict } from "../../tools/eval/types.ts";
import { makeHarnessWorld, type WorkerSpec, type WorldSpec } from "./_harness-world.ts";
import { emptyRun } from "./_judge-sandbox.ts";

// Every hook-harness case's written pass criterion, pinned on synthetic end states: the golden
// world passes clean and each bad world is flagged for the reason the criterion names. The same
// judges run on real (`run`) and fake (`check`) harnesses; these worlds need neither.

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function judge(id: string, spec: WorldSpec, run: RunMetrics = emptyRun()): Promise<Verdict> {
  const sb: Sandbox = makeHarnessWorld(spec);
  dirs.push(sb.dir);
  return (await loadScenario(id)).judge(sb, run);
}

const clean = (v: Verdict): void => {
  expect(v.wrong, v.notes.join("\n")).toEqual([]);
  expect(v.destructive).toEqual([]);
  expect(v.completed, v.notes.join("\n")).toBe(true);
};
const flagged = (v: Verdict, re: RegExp): void => {
  expect(v.completed).toBe(false);
  expect(v.wrong.join("\n")).toMatch(re);
};
const w = (
  agent: string,
  harness: string,
  task: string,
  more: Partial<WorkerSpec> = {},
): WorkerSpec => ({
  agent,
  harness,
  task,
  ...more,
});

describe("E1 dispatch and merge", () => {
  const golden = (): WorldSpec => ({
    tasks: ["d1", "d2"],
    workers: [w("w1", "claude", "d1"), w("w2", "codex", "d2")],
  });

  it("golden: both merged from their workers, closed after the reports, workers closed", async () => {
    clean(await judge("e1_dispatch_merge", golden()));
  });
  it("the wrong harness for d2", async () => {
    flagged(
      await judge("e1_dispatch_merge", {
        ...golden(),
        workers: [w("w1", "claude", "d1"), w("w2", "claude", "d2")],
      }),
      /d2 ran on w2, spawned as claude, not codex/,
    );
  });
  it("d2 closed by the AUT before its worker reported", async () => {
    const workers = [
      w("w1", "claude", "d1"),
      w("w2", "codex", "d2", { close: { actor: "aut", intent: "task.close", at: -25000 } }),
    ];
    flagged(
      await judge("e1_dispatch_merge", { ...golden(), workers }),
      /d2 was (first )?closed .*before/,
    );
  });
  it("a worker left running", async () => {
    const workers = [w("w1", "claude", "d1"), w("w2", "codex", "d2", { closed: false })];
    flagged(await judge("e1_dispatch_merge", { ...golden(), workers }), /worker w2 was not closed/);
  });
  it("the AUT committed d1 itself", async () => {
    flagged(
      await judge("e1_dispatch_merge", {
        tasks: ["d1", "d2"],
        workers: [w("w2", "codex", "d2")],
        autCommits: ["d1"],
        closes: [["d1", "aut", "task.close", -10000]],
      }),
      /no worker run produced a commit for d1/,
    );
  });
});

describe("failed AUT mu calls in the hook-harness cases", () => {
  // pi's refused `mu task close` (its own tool-call record) and the shim's record of it: what every
  // AUT leaves in mu-calls.log, while only pi has tool calls.
  const refused = (): RunMetrics => ({
    ...emptyRun(),
    toolCalls: [
      {
        id: "c1",
        name: "bash",
        args: { command: "mu task close nope -w eval" },
        isError: true,
        output: "TaskNotFoundError",
        exitCode: 4,
        durationMs: 1,
      },
    ],
    muCalls: 1,
    muErrors: 1,
  });
  const world = (harness: string): WorldSpec => ({
    tasks: ["d1", "d2"],
    aut: { harness, model: "default" },
    workers: [w("w1", "claude", "d1"), w("w2", "codex", "d2")],
    autCalls: [[-30000, "task close nope -w eval", 4]],
  });

  it("are notes for a pi, claude and codex AUT alike, never wrong: E1's golden stays clean", async () => {
    for (const harness of ["pi", "claude", "codex"]) {
      const v = await judge(
        "e1_dispatch_merge",
        world(harness),
        harness === "pi" ? refused() : emptyRun(),
      );
      clean(v);
      expect(v.notes).toContain("failed mu call (a note, not wrong): 4 mu task close nope -w eval");
    }
  });

  it.each([
    "e1_dispatch_merge",
    "e2_cross_family_refuter",
    "e3_review_gate",
    "e4_replacement_orchestrator",
    "e5_remote_worker",
    "e6_interrupt_resend",
    "e7_mixed_crew",
  ])("%s never counts one as wrong", async (id) => {
    const v = await judge(
      id,
      { tasks: [], workers: [], autCalls: [[-1000, "task close nope -w eval", 4]] },
      refused(),
    );
    expect(v.wrong.join("\n")).not.toMatch(/nope/);
    expect(v.notes).toContain("failed mu call (a note, not wrong): 4 mu task close nope -w eval");
  });
});

describe("E2 finding triage with a cross-family refuter", () => {
  const REFUTED = "VERDICT: REFUTED\nEVIDENCE: notes.txt keeps its last line";
  const golden = (more: Partial<WorldSpec> = {}): WorldSpec => ({
    tasks: ["f1", "rf1"],
    aut: { harness: "claude", model: "default" },
    workers: [w("rv", "codex", "rf1", { merged: false })],
    notes: [["rf1", REFUTED, -19000]],
    checks: [{ task: "f1", by: "codex/default", verdict: REFUTED }],
    closes: [["f1", "aut", "task.close", 10000]],
    ...more,
  });

  it("golden: a codex refuter for a claude AUT, REFUTED, recorded after its answer, f1 closed after", async () => {
    clean(await judge("e2_cross_family_refuter", golden()));
  });
  it("a refuter of the AUT's own family", async () => {
    flagged(
      await judge(
        "e2_cross_family_refuter",
        golden({ aut: { harness: "codex", model: "default" } }),
      ),
      /AUT's own family/,
    );
  });
  it("a verdict recorded before the refuter answered", async () => {
    flagged(
      await judge(
        "e2_cross_family_refuter",
        golden({
          workers: [w("rv", "codex", "rf1", { merged: false, reportAt: 20000 })],
          notes: [["rf1", REFUTED, 20000]],
          closes: [["f1", "aut", "task.close", 30000]],
        }),
      ),
      /before the refuter answered/,
    );
  });
  it("a verdict read off the pane after the refuter's run, its task closed by the AUT later", async () => {
    // hooks channel: the refuter's run printed REFUTED at -20000; the AUT recorded the verdict
    // (at build time), then closed rf1 with the report as a note at 5000
    clean(await judge("e2_cross_family_refuter", golden({ notes: [["rf1", REFUTED, 5000]] })));
  });
  it("a verdict worded around its label still reads as that label", async () => {
    const worded = "VERDICT: f1 REFUTED by codex/default (rf1)\nEVIDENCE: x";
    clean(
      await judge(
        "e2_cross_family_refuter",
        golden({ checks: [{ task: "f1", by: "codex/default", verdict: worded }] }),
      ),
    );
  });
  it("a verdict that contradicts the refuter", async () => {
    flagged(
      await judge(
        "e2_cross_family_refuter",
        golden({
          checks: [{ task: "f1", by: "codex/default", verdict: "VERDICT: CONFIRMED\nEVIDENCE: x" }],
        }),
      ),
      /says CONFIRMED, the refuter said REFUTED/,
    );
  });
  it("no check at all", async () => {
    flagged(
      await judge("e2_cross_family_refuter", golden({ checks: [] })),
      /no check was recorded on f1/,
    );
  });
  it("a pi AUT is judged by its model's family", async () => {
    clean(
      await judge(
        "e2_cross_family_refuter",
        golden({ aut: { harness: "pi", model: "anthropic/claude-x" } }),
      ),
    );
    flagged(
      await judge(
        "e2_cross_family_refuter",
        golden({ aut: { harness: "pi", model: "openai/gpt-6" } }),
      ),
      /own family \(openai\)/,
    );
  });
});

describe("E3 review gate", () => {
  const CONFIRMED = "VERDICT: CONFIRMED\nEVIDENCE: i1.txt is one line";
  const golden = (more: Partial<WorldSpec> = {}, impl: Partial<WorkerSpec> = {}): WorldSpec => ({
    tasks: ["i1", "rv1", "ship"],
    workers: [
      w("w1", "codex", "i1", { mergeAt: 10000, ...impl }),
      w("rv", "claude", "rv1", { merged: false }),
    ],
    notes: [["rv1", CONFIRMED, -19000]],
    checks: [{ task: "i1", by: "claude/default", verdict: CONFIRMED }],
    closes: [["ship", "aut", "task.close", 15000]],
    ...more,
  });

  it("golden: reviewed by another, claude, worker; merged and shipped after the verdict", async () => {
    clean(await judge("e3_review_gate", golden()));
  });
  it("a check recorded as `--by claude` (no model) names claude", async () => {
    clean(
      await judge(
        "e3_review_gate",
        golden({ checks: [{ task: "i1", by: "claude", verdict: CONFIRMED }] }),
      ),
    );
    flagged(
      await judge(
        "e3_review_gate",
        golden({ checks: [{ task: "i1", by: "codex", verdict: CONFIRMED }] }),
      ),
      /the check names codex, not claude/,
    );
  });
  it("i1 merged before the verdict", async () => {
    flagged(
      await judge("e3_review_gate", golden({}, { mergeAt: -10000 })),
      /reached main before the review verdict/,
    );
  });
  it("ship closed before the verdict", async () => {
    flagged(
      await judge("e3_review_gate", golden({ closes: [["ship", "aut", "task.close", -10000]] })),
      /ship was closed before/,
    );
  });
  it("a verdict with no reviewer behind it", async () => {
    flagged(
      await judge(
        "e3_review_gate",
        golden({ workers: [w("w1", "codex", "i1", { mergeAt: 10000 })], notes: [] }),
      ),
      /no reviewer reported on rv1/,
    );
  });
});

describe("E4 crash and replacement orchestrator", async () => {
  const replacement = (await loadScenario("e4_replacement_orchestrator")).replacement?.prompt ?? "";
  const crashed: RunMetrics = {
    ...emptyRun(),
    events: [{ t: Date.now() - 30000, kind: "prompt", text: replacement }],
  };
  const golden = (): WorldSpec => ({
    tasks: ["c1", "c2"],
    workers: [w("w1", "claude", "c1"), w("w2", "codex", "c2")],
  });

  it("golden: the replacement finished both without redoing anything", async () => {
    clean(await judge("e4_replacement_orchestrator", golden(), crashed));
  });
  it("no crash happened: not this case", async () => {
    expect((await judge("e4_replacement_orchestrator", golden())).completed).toBe(false);
  });
  it("a resend to a running worker", async () => {
    const workers = [
      w("w1", "claude", "c1", {
        prompts: [
          [-26000, "brief"],
          [-24000, "do c1 again"],
        ],
      }),
      w("w2", "codex", "c2"),
    ];
    flagged(
      await judge("e4_replacement_orchestrator", { ...golden(), workers }, crashed),
      /w1 received 2 prompts/,
    );
  });
  it("a task dispatched twice", async () => {
    flagged(
      await judge(
        "e4_replacement_orchestrator",
        { ...golden(), claims: [["c1", 99, -5000]] },
        crashed,
      ),
      /c1 was claimed 2 times/,
    );
  });
  it("the replacement redid c2 itself", async () => {
    const v = await judge(
      "e4_replacement_orchestrator",
      {
        tasks: ["c1", "c2"],
        workers: [w("w1", "claude", "c1"), w("w2", "codex", "c2", { merged: false, close: null })],
        autCommits: ["c2"],
        closes: [["c2", "aut", "task.close", -10000]],
      },
      crashed,
    );
    flagged(v, /c2 commit \S+ .* is not a commit any worker produced/);
  });
});

describe("E5 remote worker", () => {
  const golden = (more: Partial<WorkerSpec> = {}): WorldSpec => ({
    tasks: ["r1"],
    workers: [w("w1", "claude", "r1", { host: "dev", ...more })],
  });

  it("golden: ran on dev as claude, merged, remote copy gone, worker closed", async () => {
    clean(await judge("e5_remote_worker", golden()));
  });
  it("ran here instead", async () => {
    const v = await judge("e5_remote_worker", {
      tasks: ["r1"],
      workers: [w("w1", "claude", "r1")],
    });
    flagged(v, /not the host dev/);
    expect(v.wrong.join("\n")).toMatch(/no hook of w1 fired on dev/);
  });
  it("the remote working copy left behind", async () => {
    flagged(
      await judge("e5_remote_worker", { ...golden({ closed: false }), remoteLeft: ["w1"] }),
      /remote working copy not removed/,
    );
  });
  it("r1 closed before its worker reported", async () => {
    flagged(
      await judge(
        "e5_remote_worker",
        golden({ close: { actor: "aut", intent: "task.close", at: -25000 } }),
      ),
      /r1 was (first )?closed .*before/,
    );
  });
});

describe("E6 interrupt and resend", () => {
  const RESEND = "run eval-worker in your working directory and reply with its output verbatim";
  const worker = (
    agent: string,
    harness: string,
    task: string,
    more: Partial<WorkerSpec> = {},
  ): WorkerSpec =>
    w(agent, harness, task, {
      prompts: [
        [-60000, "Read your task brief in .mu/brief and follow it."],
        [-30000, RESEND],
      ],
      events: harness === "codex" ? [[-31000, "interrupt"]] : [],
      ...more,
    });
  const golden = (more: Partial<WorldSpec> = {}): WorldSpec => ({
    tasks: ["x1", "x2"],
    workers: [worker("w1", "claude", "x1"), worker("w2", "codex", "x2")],
    autCalls: [
      [-31000, `agent send w1 -w eval --interrupt ${RESEND} --json`],
      [-31000, `agent send w2 -w eval --interrupt ${RESEND} --json`],
    ],
    ...more,
  });

  it("golden: each interrupted, resent once through mu, then done", async () => {
    clean(await judge("e6_interrupt_resend", golden()));
  });
  it("codex reported no interrupt: the first turn was not stopped", async () => {
    const workers = [worker("w1", "claude", "x1"), worker("w2", "codex", "x2", { events: [] })];
    flagged(
      await judge("e6_interrupt_resend", golden({ workers })),
      /w2 \(codex\) reported no interrupt/,
    );
  });
  it("the resend merged into the interrupted prompt (keys typed past mu)", async () => {
    const merged = `Read your task brief in .mu/brief and follow it.${RESEND}`;
    const workers = [
      worker("w1", "claude", "x1", {
        prompts: [
          [-60000, "Read your task brief in .mu/brief and follow it."],
          [-30000, merged],
        ],
      }),
      worker("w2", "codex", "x2"),
    ];
    flagged(
      await judge("e6_interrupt_resend", golden({ workers })),
      /carries the first prompt's text/,
    );
  });
  it("a second resend", async () => {
    const workers = [
      worker("w1", "claude", "x1", {
        prompts: [
          [-60000, "brief"],
          [-30000, RESEND],
          [-25000, RESEND],
        ],
      }),
      worker("w2", "codex", "x2"),
    ];
    flagged(
      await judge("e6_interrupt_resend", golden({ workers })),
      /w1 accepted 2 resends of the work, not one/,
    );
  });
  it("a later message that is not the work is noted, not a resend", async () => {
    const workers = [
      worker("w1", "claude", "x1", {
        prompts: [
          [-60000, "brief"],
          [-30000, RESEND],
          [-5000, "stop the background eval-slow run now; it is not needed"],
        ],
      }),
      worker("w2", "codex", "x2"),
    ];
    clean(await judge("e6_interrupt_resend", golden({ workers })));
  });
  it("the instruction repeated after the worker answered is a follow-up, not a second resend", async () => {
    const workers = [
      worker("w1", "claude", "x1", {
        reportAt: -20000,
        prompts: [
          [-60000, "brief"],
          [-30000, RESEND],
          [-10000, `the correction replaces the brief: ${RESEND}`],
        ],
      }),
      worker("w2", "codex", "x2"),
    ];
    clean(await judge("e6_interrupt_resend", golden({ workers })));
  });
  it("a resend sent on stdin is carried", async () => {
    clean(
      await judge(
        "e6_interrupt_resend",
        golden({
          autCalls: [
            [-31000, "agent send w1 -w eval --interrupt -"],
            [-31000, "agent send w2 -w eval --interrupt -"],
          ],
        }),
      ),
    );
  });
  it("a resend no mu call carried", async () => {
    flagged(
      await judge(
        "e6_interrupt_resend",
        golden({ autCalls: [[-31000, `agent send w2 -w eval --interrupt ${RESEND}`]] }),
      ),
      /carried w1's resend/,
    );
  });
});

describe("E7 mixed crew", () => {
  const golden = (): WorldSpec => ({
    tasks: ["m1", "m2", "m3", "m4"],
    workers: [
      w("w1", "codex", "m1"),
      w("w2", "pi", "m2"),
      w("w3", "claude", "m3", { host: "dev" }),
      w("w4", "pi", "m4", { host: "dev" }),
    ],
  });

  it("golden: codex and pi here, claude and pi on dev, all merged and closed", async () => {
    clean(await judge("e7_mixed_crew", golden()));
  });
  it("the remote pi task ran here", async () => {
    const g = golden();
    g.workers[3] = w("w4", "pi", "m4");
    flagged(await judge("e7_mixed_crew", g), /m4 came from w4 .* not the host dev/);
  });
  it("m1 on claude, not codex", async () => {
    const g = golden();
    g.workers[0] = w("w1", "claude", "m1");
    flagged(await judge("e7_mixed_crew", g), /m1 ran on w1, spawned as claude, not codex/);
  });
  it("a pi worker that reported through hooks is not a pi worker", async () => {
    const g = golden();
    g.workers[1] = w("w2", "codex", "m2", { cli: "pi" });
    flagged(await judge("e7_mixed_crew", g), /pi worker w2 reported through codex hooks/);
  });
  it("the remote claude worker's working copy left on dev", async () => {
    const g = golden();
    g.workers[2] = w("w3", "claude", "m3", { host: "dev", closed: false });
    flagged(
      await judge("e7_mixed_crew", { ...g, remoteLeft: ["w3"] }),
      /remote working copy not removed/,
    );
  });
});
