// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Next-step cases of groups c3 (notes) and c4 (agent read), and the guards (spec §2, cases 6, 8,
// 13, 14). Nothing is pending at t0 in any of them: no worker runs.
import { WS } from "./cold-intents.ts";
import { chromePane, seedDelegate, seedNotes, writeWorkerDriver } from "./fixtures.ts";
import type { NextCase } from "./nextstep.ts";
import { addTask, namesState, nonce, paras, phrase, seedMu, word } from "./nextstep-cases-lib.ts";
import { ownOutput, shown, shownLine } from "./nextstep-exec.ts";
import { muCalls } from "./observe.ts";

// ---- case 6: notes_report_read ------------------------------------------------------------------

const RL_LINES = 40;

const notesReportRead: NextCase = {
  id: "notes_report_read",
  group: "c3_notes",
  role: "headline",
  arms: ["none", "skill", "recipe:tasks-or-calls"],
  shell: "bash",
  expectedRowMs: 12_000,
  paraphrases: paras([
    "Give us only the reviewer's findings, readable, each point on its own.",
    "I only want what the reviewer found, every point separate, nothing else.",
    "Print just the reviewer's findings, properly broken up point by point.",
    "Strip everything but the reviewer's findings and lay them out one beneath another.",
    "Only the reviewer's conclusions please, legible, one point at a time, each separate.",
    "What did the reviewer find? Just that part, with real breaks between points.",
    "Extract the reviewer's findings alone and make them readable point by point.",
    "Leave out the instructions; give us the reviewer's findings, neatly split apart.",
    "I need the reviewer's points by themselves, each one separate.",
    "Display solely what the reviewer came back with, one point beneath the other.",
  ]),
  leadInVerbs: ["task notes"],
  async seed(sb) {
    const n = nonce();
    await writeWorkerDriver(sb, { closeMode: "block" });
    await seedMu(sb, ["workstream", "init", WS]);
    const lines = Array.from(
      { length: RL_LINES },
      (_, k) => `RL-${n}-${k + 1} ${phrase(n, k + 1)}`,
    );
    const { task } = await seedDelegate(sb, {
      callId: `rev-${n}`,
      caller: "pi:nextstep-orch",
      label: "rev",
      brief: `BRIEF-${n} Review the login change and list what you find.\nOne finding per line.`,
      agent: "delegate-rev",
      answer: lines.join("\n"),
    });
    return { dtask: task, n, ...Object.fromEntries(lines.map((l, k) => [`rl${k + 1}`, l])) };
  },
  leadIn: (_sb, st) => [{ cmd: `mu task notes ${st.dtask} -w ${WS}` }],
  async judge(c) {
    const n = c.state.n ?? "\0";
    const lines = Array.from({ length: RL_LINES }, (_, k) => c.state[`rl${k + 1}`] ?? "\0");
    const missing = lines.filter((l) => !shown(c, l)).length;
    const glued = new RegExp(`RL-${n}-\\d+.*RL-${n}-\\d+`);
    const last = c.runs[c.runs.length - 1];
    const lastOut = last ? ownOutput(last) : "";
    const why: string[] = [];
    if (missing > 0) why.push(`${missing} of ${RL_LINES} findings not shown`);
    if (c.output.split("\n").some((l) => glued.test(l)))
      why.push("two findings on one line (escaped newlines)");
    if (lastOut.includes(`BRIEF-${n}`)) why.push("the brief is shown too");
    return { hit: why.length === 0, partial: missing === 0 && why.length > 0, why };
  },
  golden: (st) => [
    `mu task notes ${st.dtask} -w ${WS} --json | jq -r '.data.items[] | select(.kind=="report") | .content'`,
  ],
  bad: (st) => [`mu task notes ${st.dtask} -w ${WS} | sed 's/\\\\n/\\n/g'`],
  badPartial: true,
  extras: (st) => [
    {
      label: "lucky",
      cmds: [`mu task notes ${st.dtask} -w ${WS} --json | jq -r '.data.items[].content'`],
      expect: "miss",
      partial: true,
    },
    {
      label: "lucky",
      cmds: [
        `mu task notes ${st.dtask} -w ${WS} >/dev/null; printf '%s\\n' ${Array.from(
          { length: RL_LINES },
          (_, k) => `'${st[`rl${k + 1}`] ?? ""}'`,
        ).join(" ")}`,
      ],
      expect: "miss",
    },
  ],
};

// ---- case 8: agent_read_text --------------------------------------------------------------------

/** A line that is blank or only box-drawing, block or arrow glyphs: pane chrome. */
const CHROME = /^[\s\u2500-\u259f\u2190-\u21ff]*$/;

const agentReadText: NextCase = {
  id: "agent_read_text",
  group: "c4_read",
  role: "headline",
  arms: ["none", "skill"],
  shell: "bash",
  expectedRowMs: 10_000,
  paraphrases: paras([
    "What did worker-1 say most recently? Just its words.",
    "Give us worker-1's latest words without the screen clutter.",
    "Print what worker-1 is saying right now, words only.",
    "I want worker-1's most recent output as plain words, no decoration.",
    "Display what worker-1 just wrote, minus the blank space and rules.",
    "What is worker-1's newest statement? Only the words it produced.",
    "Strip the screen furniture and give us worker-1's latest words.",
    "Let us see worker-1's current words alone, no blank padding.",
    "Tell us what worker-1 most recently printed, just the sentence.",
    "worker-1's latest words, please: no frame, no gaps.",
  ]),
  leadInVerbs: ["agent read"],
  async seed(sb) {
    const n = nonce();
    const line = `PANE-${n}: tests 41 passed, ${phrase(n)}`;
    await seedMu(sb, ["workstream", "init", WS]);
    await chromePane(sb, "worker-1", [line]);
    return { line };
  },
  leadIn: () => [{ cmd: `mu agent read worker-1 -w ${WS}` }],
  async judge(c) {
    const ok = shown(c, c.state.line ?? "");
    const last = c.runs[c.runs.length - 1];
    const chrome = (last ? ownOutput(last) : "")
      .replace(/\n$/, "")
      .split("\n")
      .filter((l) => CHROME.test(l)).length;
    const why: string[] = [];
    if (!ok) why.push("worker-1's line not shown");
    if (chrome > 3) why.push(`${chrome} blank or chrome lines`);
    return { hit: why.length === 0, partial: ok && chrome > 3, why };
  },
  golden: () => [`mu agent read worker-1 -w ${WS} | grep -vE '^[[:space:]─━│↑↓]*$'`],
  bad: () => [`mu agent read worker-1 -w ${WS}`],
  badPartial: true,
  extras: (st) => [
    {
      label: "lucky",
      cmds: [`mu agent read worker-1 -w ${WS} | grep -v '^$'`],
      expect: "miss",
      partial: true,
    },
    {
      label: "lucky",
      cmds: [`mu agent read worker-1 -w ${WS} >/dev/null; echo '${st.line}'`],
      expect: "miss",
    },
    // §2.3's `| tail -1` alt prints a blank line on base (the pane's trailing rows): drop blanks first
    {
      label: "alt",
      cmds: [`mu agent read worker-1 -w ${WS} | grep -v '^[[:space:]]*$' | tail -1`],
      expect: "hit",
    },
  ],
};

// ---- case 13: sql_name_guess (guard) ------------------------------------------------------------

const AUTH_TASKS = [
  { id: "t1", state: "OPEN" },
  { id: "t2", state: "CLOSED" },
  { id: "t3", state: "OPEN" },
] as const;
const OTHER = ["x1", "x2", "x3"] as const;

const sqlNameGuess: NextCase = {
  id: "sql_name_guess",
  group: "guard",
  role: "guard",
  arms: ["none", "skill"],
  shell: "bash",
  expectedRowMs: 8_000,
  paraphrases: paras([
    ["Give us every item in auth with where each one stands.", "a"],
    ["Which items does auth have, and is each finished or not?", "a"],
    ["Enumerate auth's items together with the progress of each.", "a"],
    ["What is written on t1? Print the whole of it.", "b"],
    ["Give us the comments attached to t1, all of them.", "b"],
    ["I need the remarks recorded on t1, word for word.", "b"],
  ]),
  leadInVerbs: ["sql"],
  async seed(sb) {
    const n = nonce();
    await seedMu(sb, ["workstream", "init", WS]);
    for (const t of AUTH_TASKS) await seedMu(sb, addTask(t.id, `auth item ${t.id}`));
    await seedMu(sb, ["task", "close", "t2", "-w", WS, "--evidence", "done in the seed"]);
    await seedMu(sb, ["workstream", "init", "billing"]);
    for (const x of OTHER) await seedMu(sb, addTask(x, `billing item ${x}`, "billing"));
    const note = `SN-${n}`;
    await seedNotes(sb, WS, "t1", [`${note} ${phrase(n)}`]);
    return { note };
  },
  leadIn: (_sb, _st, v) => [
    {
      cmd:
        v === "a"
          ? `mu sql "SELECT name, status FROM tasks WHERE workstream='${WS}'"`
          : `mu sql "SELECT body FROM notes WHERE task='t1'"`,
    },
  ],
  async judge(c) {
    const why: string[] = [];
    // the lead-in variant of this row (its sql call is in the shim's log): a asks for the list, b for t1's text
    const b = muCalls(c.sb).some((m) => m.start < c.t0 && m.argv.includes("FROM notes"));
    if (b) {
      if (!shown(c, c.state.note ?? "")) why.push("t1's note not shown");
    } else {
      for (const t of AUTH_TASKS)
        if (!shownLine(c, namesState(t.id, t.state))) why.push(`${t.id} ${t.state} not shown`);
      for (const x of OTHER) if (word(c.output, x)) why.push(`billing's ${x} listed too`);
    }
    return { hit: why.length === 0, why };
  },
  golden: (_st, v) => (v === "a" ? [`mu task list -w ${WS}`] : [`mu task notes t1 -w ${WS}`]),
  bad: (_st, v) =>
    v === "a"
      ? [`mu sql "SELECT name, status FROM tasks WHERE workstream='${WS}'"`]
      : [`mu sql "SELECT body FROM notes WHERE task='t1'"`],
  extras: (_st, v) =>
    v === "a"
      ? [
          { label: "lucky", cmds: [`mu sql "SELECT local_id, status FROM tasks"`], expect: "miss" },
          {
            label: "alt",
            cmds: [
              `mu sql "SELECT t.local_id, t.status FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = '${WS}'"`,
            ],
            expect: "hit",
          },
        ]
      : [
          { label: "lucky", cmds: [`mu sql "SELECT body FROM task_notes"`], expect: "miss" },
          {
            label: "alt",
            cmds: [
              `mu sql "SELECT n.content FROM task_notes n JOIN tasks t ON t.id = n.task_id JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = '${WS}' AND t.local_id = 't1'"`,
            ],
            expect: "hit",
          },
        ],
};

// ---- case 14: finding_guess (guard) -------------------------------------------------------------

const findingGuess: NextCase = {
  id: "finding_guess",
  group: "guard",
  role: "guard",
  arms: ["none", "skill", "recipe:findings"],
  shell: "bash",
  expectedRowMs: 8_000,
  paraphrases: paras([
    "Let us see that finding, all of it.",
    "Print the whole finding, heading and body.",
    "I want to go through that finding, everything about it.",
    "Display the finding high_x completely.",
    "Pull up high_x, with what was written about it.",
    "What does the finding say? Give us all of it.",
  ]),
  leadInVerbs: ["finding"],
  async seed(sb) {
    const n = nonce();
    await seedMu(sb, ["workstream", "init", WS]);
    await seedMu(sb, [...addTask("high_x", `HX-${n} ${phrase(n, 1)}`), "--triage"]);
    await seedNotes(sb, WS, "high_x", [`HN-${n} ${phrase(n, 2)}`]);
    return { hx: `HX-${n}`, hn: `HN-${n}` };
  },
  leadIn: () => [{ cmd: `mu finding show high_x -w ${WS}` }],
  async judge(c) {
    const hx = shown(c, c.state.hx ?? "");
    const hn = shown(c, c.state.hn ?? "");
    const why: string[] = [];
    if (!hx) why.push("the finding's title not shown");
    if (!hn) why.push("the finding's note not shown");
    return { hit: why.length === 0, partial: hx !== hn, why };
  },
  golden: () => [`mu task show high_x -w ${WS}`, `mu task notes high_x -w ${WS}`],
  bad: () => [`mu finding show high_x -w ${WS}`],
  extras: () => [
    // §2.3 has `task show` alone as a miss; on base it prints the notes too, so it is an alt
    { label: "alt", cmds: [`mu task show high_x -w ${WS}`], expect: "hit" },
    { label: "lucky", cmds: [`mu task list -w ${WS}`], expect: "miss" },
  ],
};

export const READ_CASES: NextCase[] = [notesReportRead, agentReadText, sqlNameGuess, findingGuess];
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
