// Next-step cases of group c1 (reading a wait) and c6's sleep_poll (spec §2, cases 3, 4, 5, 12).
// Workers are faux pis on the CLOSE block (close-mode block): a wait that sees the owner settle
// applies the block, so the task closes with the worker's report note and the close evidence.
import { WS } from "./cold-intents.ts";
import { workerTask, writeWorkerDriver } from "./fixtures.ts";
import type { NextCase, NextCtx } from "./nextstep.ts";
import {
  addTask,
  hintOf,
  namesState,
  nonce,
  paras,
  phrase,
  ranTask,
  seedMu,
  spawnWorker,
  until,
} from "./nextstep-cases-lib.ts";
import { shown, shownLine } from "./nextstep-exec.ts";
import type { OpRow } from "./ops.ts";
import { openProbe } from "./probe.ts";
import type { Sandbox } from "./types.ts";

const stillOpen =
  (...ids: string[]) =>
  async (sb: Sandbox): Promise<string | null> => {
    const p = openProbe(sb);
    const done = ids.filter((id) => p.task(WS, id)?.status === "CLOSED");
    return done.length === 0 ? null : `${done.join(", ")} already CLOSED`;
  };

/** A wait that sees the owner settle applies its CLOSE block: the close.apply ops are the answer's. */
const applies = (o: OpRow): boolean => o.intent === "close.apply";

/** An answer command that read a pi session file instead of asking mu. */
const readsSession = (c: NextCtx): boolean =>
  c.runs.some((r) => /\bsessions\b|\.jsonl\b/.test(r.cmd));

// ---- case 3: wait_result_read -------------------------------------------------------------------

const waitResultRead: NextCase = {
  id: "wait_result_read",
  group: "c1_wait",
  role: "headline",
  arms: ["none", "skill", "recipe:orchestrator-loop"],
  shell: "bash",
  expectedRowMs: 25_000,
  paraphrases: paras([
    "What did worker-1 come back with? Print its result sentence.",
    "worker-1 is finished; I want to see exactly what it said at the end.",
    "Give us the final words worker-1 produced, verbatim.",
    "Which result did worker-1 hand in? Quote it.",
    "Let us see worker-1's closing summary, word for word.",
    "worker-1 wrapped up. Print the reply it gave.",
    "Find out what worker-1 told us when it ended, and quote it exactly.",
    "I need worker-1's concluding remark, the exact sentence.",
    "Display the result worker-1 delivered, as it wrote it.",
    "worker-1 has stopped. What was its result sentence? Print it whole.",
  ]),
  allow: applies,
  leadInVerbs: ["wait"],
  async seed(sb) {
    const n = nonce();
    const marker = `REPORT-${n}`;
    await writeWorkerDriver(sb, { closeMode: "block" });
    await seedMu(sb, ["workstream", "init", WS]);
    await seedMu(sb, addTask("t1", "fix the login form"));
    await workerTask(sb, "t1", { sh: `echo "${marker}: ${phrase(n)}"` });
    await spawnWorker(sb, "worker-1", "t1");
    await until("worker-1's run", () => ranTask(sb, "t1", "block"));
    return { marker };
  },
  leadIn: () => [
    {
      cmd: `mu wait agent:${WS}/worker-1@0 --json | jq -c '{exit:.data.exit, firing:.data.firing}'`,
      expect: async (sb) => ((await ranTask(sb, "t1", "block")) ? null : "worker-1 never ran t1"),
    },
  ],
  async judge(c) {
    const ok = shown(c, c.state.marker ?? "");
    const why: string[] = [];
    if (!ok) why.push("worker-1's result line not shown");
    if (readsSession(c)) why.push("read a session file");
    const state = shownLine(c, (l) => /\bworker-1\b|\bt1\b/.test(l));
    return { hit: why.length === 0, partial: !ok && state, why };
  },
  golden: () => [`mu wait agent:${WS}/worker-1@0`],
  bad: () => [
    `mu wait agent:${WS}/worker-1@0 --json | jq -c '{exit:.data.exit, firing:.data.firing}'`,
  ],
  extras: () => [
    // §2.3 lists `task show t1` as a miss; on base it prints t1's report note (the CLOSE block's
    // REPORT), which is the result line: a right answer, so it is an alt here.
    { label: "alt", cmds: [`mu task show t1 -w ${WS}`], expect: "hit" },
    { label: "lucky", cmds: [`mu task list -w ${WS}`], expect: "miss" },
    {
      label: "alt",
      cmds: [`mu wait agent:${WS}/worker-1@0 --json | jq -r '.data.snapshots[].lastText // empty'`],
      expect: "hit",
    },
  ],
};

// ---- case 4: wait_heartbeat_merge ---------------------------------------------------------------

const PY = `python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["data"]["firing"])'`;

const waitHeartbeatMerge: NextCase = {
  id: "wait_heartbeat_merge",
  group: "c1_wait",
  role: "headline",
  arms: ["none", "skill", "recipe:orchestrator-loop"],
  shell: "bash",
  timed: true,
  expectedRowMs: 170_000,
  paraphrases: paras([
    "Find out how t1 ended.",
    "Tell us how t1 turned out.",
    "What became of t1 in the end?",
    "I want to know where t1 ends up, once it gets there.",
    "Did t1 succeed? Get us its result when it is there.",
    "Learn how t1 concluded and print it.",
    "See t1 through to its end and say how it went.",
    "How did t1 wrap up? Find out.",
    "Get the final word on t1.",
    "Where did t1 land? I want its ending.",
  ]),
  allow: applies,
  leadInVerbs: ["wait"],
  async seed(sb) {
    const n = nonce();
    const marker = `END-${n}`;
    await writeWorkerDriver(sb, { closeMode: "block" });
    await seedMu(sb, ["workstream", "init", WS]);
    await seedMu(sb, addTask("t1", "fix the login form"));
    // the heartbeat comes at 60 s (src/cli/wait.ts HEARTBEAT_MS); t1 closes 75 s after the answer starts
    await workerTask(sb, "t1", { sh: `echo "${marker}: ${phrase(n)}"`, gate: { delayMs: 75_000 } });
    await spawnWorker(sb, "worker-1", "t1");
    return { marker };
  },
  leadIn: () => [
    { cmd: `mu wait task:${WS}/t1 --json --timeout 70 2>&1 | ${PY}`, expect: stillOpen("t1") },
  ],
  async judge(c) {
    // the report line (a per-row nonce: shown, so a jq rendering of the JSON counts), or a mu line naming t1 CLOSED
    const report = shown(c, c.state.marker ?? "");
    const closed = shownLine(c, namesState("t1", "CLOSED"));
    const state = shownLine(c, (l) => /\bt1\b/.test(l));
    return {
      hit: report || closed,
      partial: !report && !closed && state,
      why: report || closed ? [] : ["t1's ending not shown"],
    };
  },
  golden: () => [`mu wait task:${WS}/t1 2>/dev/null; mu task show t1 -w ${WS}`],
  bad: () => [`mu wait task:${WS}/t1 --json 2>&1 | ${PY}`],
  extras: () => [
    { label: "lucky", cmds: [`mu task show t1 -w ${WS}`], expect: "miss" },
    { label: "sleep", cmds: [`sleep 80; mu task show t1 -w ${WS}`], expect: "miss" },
    // the same sleep, then a wait that applies the CLOSE block at once: CLOSED shown, missed by idleCalls alone
    {
      label: "sleep",
      cmds: [`sleep 80; mu wait task:${WS}/t1 2>/dev/null; mu task show t1 -w ${WS}`],
      expect: "miss",
    },
    { label: "alt", cmds: [`mu wait task:${WS}/t1 --timeout 110`], expect: "hit" },
    // the JSON answer this case's friction calls for: the heartbeat kept off the pipe
    {
      label: "alt",
      cmds: [
        `mu wait task:${WS}/t1 --json 2>/dev/null | jq -r '.data.snapshots[].lastText // empty'`,
      ],
      expect: "hit",
    },
  ],
};

// ---- case 5: wait_shell_limit -------------------------------------------------------------------

const waitShellLimit: NextCase = {
  id: "wait_shell_limit",
  group: "c1_wait",
  role: "headline",
  arms: ["none", "skill", "recipe:orchestrator-loop"],
  shell: "bash",
  timed: true,
  expectedRowMs: 340_000,
  paraphrases: paras([
    "Get worker-1's result once it is finished.",
    "When worker-1 is through, bring us what it produced.",
    "Stay on worker-1 till it completes, then give us its result sentence.",
    "I want worker-1's reply as soon as it has one.",
    "Let worker-1 complete its work and then print what it came back with.",
    "Stick with it till worker-1 is through and quote its result.",
    "Bring us worker-1's final words when they arrive.",
    "Stay with worker-1 till it completes; I need its conclusion.",
    "Once worker-1 wraps up, tell us what it said.",
    "Get worker-1's result when it is over.",
  ]),
  allow: applies,
  leadInVerbs: ["agent spawn", "wait"],
  async seed(sb) {
    const n = nonce();
    const marker = `REPORT-${n}`;
    await writeWorkerDriver(sb, { closeMode: "block" });
    await seedMu(sb, ["workstream", "init", WS]);
    await seedMu(sb, addTask("t1", "fix the login form"));
    // 200 s after the answer starts: no single 120 s call on the default timeout sees it
    await workerTask(sb, "t1", {
      sh: `echo "${marker}: ${phrase(n)}"`,
      gate: { delayMs: 200_000 },
    });
    return { marker };
  },
  leadIn: (sb) => [
    { cmd: `mu agent spawn worker-1 -w ${WS} --task t1 --send 'do t1'` },
    {
      // the spawn's own `next:` hint, run as printed
      get cmd(): string {
        return hintOf(sb, "spawn worker-1") ?? `mu wait agent:${WS}/worker-1@0`;
      },
      killAfterMs: 120_000,
      expect: stillOpen("t1"),
    },
  ],
  async judge(c) {
    const ok = shown(c, c.state.marker ?? "");
    const why = ok ? [] : ["worker-1's result not shown"];
    // every blocking mu call ended on its own (a kill is a miss in decideHit too)
    for (const m of c.calls) if (m.exit >= 128) why.push(`a mu call was killed (exit ${m.exit})`);
    return { hit: why.length === 0, partial: !ok && c.runs.every((r) => !r.killed), why };
  },
  golden: () => [1, 2, 3].map(() => `mu wait agent:${WS}/worker-1@0 --timeout 110`),
  bad: () => [`mu wait agent:${WS}/worker-1@0`],
  extras: () => [
    { label: "lucky", cmds: [`mu wait agent:${WS}/worker-1@0 --timeout 110`], expect: "miss" },
    {
      label: "sleep",
      cmds: ["sleep 115", "sleep 115", `mu wait agent:${WS}/worker-1@0`],
      expect: "miss",
    },
  ],
};

// ---- case 12: sleep_poll ------------------------------------------------------------------------

const TRIO = ["t1", "t2", "t3"] as const;

const sleepPoll: NextCase = {
  id: "sleep_poll",
  group: "c6_skill",
  role: "headline",
  arms: ["none", "skill", "recipe:orchestrator-loop"],
  shell: "bash",
  timed: true,
  expectedRowMs: 110_000,
  paraphrases: paras([
    "Tell us when all three are finished, and how each one ended.",
    "Let us know once the three of them are through, with how each went.",
    "When every one of the three is complete, say how each went.",
    "I want word when t1, t2 and t3 have all wrapped up, plus each ending.",
    "Get back to us once all three are finished: how did each turn out?",
    "Once the trio is through, give us the ending of each.",
    "Stay on it till t1, t2 and t3 are all complete, then say how each went.",
    "Ping us when the three pieces of work are over, with what became of each.",
    "Once all three are finished, tell us how every one of them ended.",
    "Get us the final word on t1, t2 and t3 once all of them are over.",
  ]),
  allow: applies,
  leadInVerbs: ["agent spawn"],
  async seed(sb) {
    await writeWorkerDriver(sb, { closeMode: "block" });
    await seedMu(sb, ["workstream", "init", WS]);
    for (const [i, t] of TRIO.entries()) {
      await seedMu(sb, addTask(t, `fix part ${i + 1}`));
      await workerTask(sb, t, { sh: `echo ${t} ok`, gate: { delayMs: 20_000 * (i + 1) } });
    }
    return {};
  },
  leadIn: () =>
    TRIO.map((t, i) => ({
      cmd: `mu agent spawn worker-${i + 1} -w ${WS} --task ${t} --send 'do ${t}'`,
      ...(i === 2 ? { expect: stillOpen(...TRIO) } : {}),
    })),
  async judge(c) {
    const seen = TRIO.filter((t) => shownLine(c, namesState(t, "CLOSED")));
    const missing = TRIO.filter((t) => !seen.includes(t));
    return {
      hit: missing.length === 0,
      partial: missing.length === 0,
      why: missing.map((t) => `${t} not shown CLOSED`),
    };
  },
  golden: () => [
    `mu wait task:${WS}/t1 task:${WS}/t2 task:${WS}/t3 --all`,
    `mu task list -w ${WS}`,
  ],
  bad: () => [
    `for t in t1 t2 t3; do until mu task show $t -w ${WS} | grep -q CLOSED; do sleep 5; done; done`,
  ],
  extras: () => [
    { label: "lucky", cmds: [`mu wait --wave w1 -w ${WS}`], expect: "miss" },
    { label: "sleep", cmds: [`sleep 70; mu task list -w ${WS}`], expect: "miss" },
    {
      label: "sleep",
      cmds: [
        `sleep 70; mu wait task:${WS}/t1 task:${WS}/t2 task:${WS}/t3 --all; mu task list -w ${WS}`,
      ],
      expect: "miss",
    },
    // §2.3 adds `then the list` as a fourth block (more than three runs nothing); each wait's own line names its task CLOSED
    { label: "alt", cmds: TRIO.map((t) => `mu wait task:${WS}/${t}`), expect: "hit" },
  ],
};

export const WAIT_CASES: NextCase[] = [
  waitResultRead,
  waitHeartbeatMerge,
  waitShellLimit,
  sleepPoll,
];
