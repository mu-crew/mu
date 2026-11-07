// Next-step probe cases (spec §2). This file holds the two pilots (B2: one bash, one zsh) and the
// catalogue in §2 order; the other cases live by group in nextstep-cases-{wait,close,read}.ts (B4b).
// Each case: a seed, a live lead-in in base grammar, goals worded with no mu name (`nextstep lint`),
// a judge on state and mu's own output (nextstep-exec.ts `shown`), and the §2.3 rows `check` proves.
//
// Case 11 (`dead_once`) is dropped: §2.3 asks B4b to reproduce the double exit-6 on base first, and
// base reports one death once. A wait on the dead worker's agent ref, on its task ref, or the
// caller's owned refs fires one `dead` event and consumes both cursors (dead|agent and dead|task);
// the next wait, before or after the respawn of t1 with --attempt 2, times out with nothing dead.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { WS } from "./cold-intents.ts";
import { seedNotes, seedViaMu, shq } from "./fixtures.ts";
import type { NextCase, NextCtx } from "./nextstep.ts";
import { CLOSE_CASES } from "./nextstep-cases-close.ts";
import { agentOpsOf } from "./nextstep-cases-lib.ts";
import { READ_CASES } from "./nextstep-cases-read.ts";
import { WAIT_CASES } from "./nextstep-cases-wait.ts";
import { muText, shown } from "./nextstep-exec.ts";
import { lostWork } from "./observe.ts";
import { opsSince } from "./ops.ts";
import { openProbe } from "./probe.ts";
import { mu, sh } from "./sandbox.ts";

const nonce = (): string => randomBytes(4).toString("hex");

const closePreviewApply: NextCase = {
  id: "close_preview_apply",
  group: "c2_close",
  role: "headline",
  arms: ["none", "skill", "recipe:merge"],
  shell: "bash",
  expectedRowMs: 15_000,
  paraphrases: [
    { id: "p1", leadIn: "a", goal: "worker-1's work is on main now; get rid of it." },
    {
      id: "p2",
      leadIn: "b",
      goal: "Everything worker-1 did has landed on main, so retire worker-1.",
    },
    {
      id: "p3",
      leadIn: "a",
      goal: "worker-1's commit is already on main. Tidy worker-1 away for good.",
    },
    {
      id: "p4",
      leadIn: "b",
      goal: "worker-1 has nothing left that is not on main; dismiss it along with its checkout.",
    },
    {
      id: "p5",
      leadIn: "a",
      goal: "Now that worker-1's change sits on main, take worker-1 out of service.",
    },
    {
      id: "p6",
      leadIn: "b",
      goal: "Main already has worker-1's patch. Remove worker-1 completely.",
    },
    { id: "p7", leadIn: "a", goal: "worker-1's commit was picked onto main; clean up worker-1." },
    {
      id: "p8",
      leadIn: "b",
      goal: "We no longer need worker-1: its result is merged into main. Wind it up.",
    },
    {
      id: "p9",
      leadIn: "a",
      goal: "worker-1's changes are on main; dispose of worker-1 and the directory it worked in.",
    },
    { id: "p10", leadIn: "b", goal: "main contains worker-1's work. Decommission worker-1." },
  ],
  leadInVerbs: ["agent close"],
  async seed(sb) {
    await seedViaMu(sb, [["workstream", "init", WS]]);
    const r = await mu(sb, [
      "agent",
      "spawn",
      "worker-1",
      "-w",
      WS,
      "--command",
      "sh -c 'echo W1; exec sleep 3600'",
      "--no-ctl",
      "--worktree",
    ]);
    const dir = /^\s+(?:workspace|cwd): (\S+)/m.exec(r.stdout)?.[1] ?? "";
    if (r.code !== 0 || dir === "") throw new Error(`seed spawn failed: ${r.stderr || r.stdout}`);
    await sh(
      sb,
      `cd ${shq(dir)} && echo login > login.txt && git add login.txt && git commit -qm login-fix`,
    );
    const sha = (await sh(sb, `git -C ${shq(dir)} rev-parse HEAD`)).stdout.trim();
    await sh(sb, `git cherry-pick ${sha} >/dev/null`);
    const j = await mu(sb, ["agent", "close", "worker-1", "-w", WS, "--json"]);
    const rev = String(
      (JSON.parse(j.stdout) as { data?: { revision?: unknown } }).data?.revision ?? "",
    );
    if (rev === "") throw new Error(`seed: no revision in ${j.stdout}`);
    return { dir, sha, rev };
  },
  leadIn(_sb, _st, v) {
    const onMain = async (sb: Parameters<NextCase["seed"]>[0]): Promise<string | null> =>
      (await sh(sb, "git log --format=%s main", { allowFail: true })).stdout.includes("login-fix")
        ? null
        : "worker-1's commit is not on main";
    return [
      {
        cmd:
          v === "a"
            ? `mu agent close worker-1 -w ${WS}`
            : `mu agent close worker-1 -w ${WS} 2>&1 | tail -5`,
        expect: (sb) => onMain(sb),
      },
    ];
  },
  allow: agentOpsOf("worker-1"),
  async judge(c: NextCtx) {
    const gone = !openProbe(c.sb).agents(WS).includes("worker-1");
    const closed = opsSince(c.sb, c.base).some((o) => o.intent === "agent.close");
    const treeGone = !existsSync(c.state.dir ?? "");
    const lost = await lostWork(c.sb);
    const why: string[] = [];
    if (!gone || !closed) why.push("worker-1 still registered");
    if (!treeGone) why.push("worker-1's worktree is still there");
    why.push(...lost.map((l) => `LOST WORK: ${l}`));
    const rev = c.state.rev ?? "";
    const previewed = c.calls.some(
      (m) => m.exit === 0 && rev !== "" && muText(c.sb, m).includes(rev),
    );
    return { hit: why.length === 0, partial: !gone && previewed && lost.length === 0, why };
  },
  golden: (st, v) => [
    v === "a"
      ? `mu agent close worker-1 -w ${WS} --if ${st.rev}`
      : `mu agent close worker-1 -w ${WS} --if "$(mu agent close worker-1 -w ${WS} --json | jq -r .data.revision)"`,
  ],
  bad: () => [`mu agent close worker-1 -w ${WS}`],
  badPartial: true,
  extras: (st, v) => [
    { label: "lucky", cmds: [`git worktree remove --force ${shq(st.dir ?? "")}`], expect: "miss" },
    {
      label: "alt",
      cmds: [`mu agent close worker-1 -w ${WS} --discard --if ${st.rev}`],
      expect: "hit",
    },
    // the golden plus a spawn of an unrelated agent: worker-9's ops are stray
    {
      label: "lucky",
      cmds: [
        ...closePreviewApply.golden(st, v),
        `mu agent spawn worker-9 -w ${WS} --command 'sleep 600' --no-ctl`,
      ],
      expect: "miss",
    },
  ],
};

const NOTE_TEXT: Record<string, string> = {
  t1: "the login form keeps its old copy",
  t2: "the token cache expires too early",
  t3: "the retry budget needs a ceiling",
};

const notesMulti: NextCase = {
  id: "notes_multi",
  group: "c3_notes",
  role: "headline",
  arms: ["none", "skill"],
  shell: "zsh",
  expectedRowMs: 8_000,
  paraphrases: [
    {
      id: "p1",
      leadIn: "a",
      goal: "Now give us what is written on t2 and t3 too, each under its own heading.",
    },
    {
      id: "p2",
      leadIn: "a",
      goal: "Do the same for t2 and t3, and make clear which output belongs to which.",
    },
    { id: "p3", leadIn: "a", goal: "I also need t2's and t3's comments, each one labelled." },
    {
      id: "p4",
      leadIn: "a",
      goal: "Print the annotations of t2 and t3 as well, with a header per item.",
    },
    {
      id: "p5",
      leadIn: "a",
      goal: "Same thing for t2 and for t3 please, separated so I can tell them apart.",
    },
    { id: "p6", leadIn: "a", goal: "What was jotted on t2 and t3? Put a heading above each." },
    {
      id: "p7",
      leadIn: "a",
      goal: "I want to see the remarks left on t2 and t3, one then the other, each labelled.",
    },
    {
      id: "p8",
      leadIn: "a",
      goal: "Pull up the written entries for t2 and t3 too, clearly headed.",
    },
    {
      id: "p9",
      leadIn: "a",
      goal: "Also dump t2 and t3 the same way, with the item id above each part.",
    },
    {
      id: "p10",
      leadIn: "a",
      goal: "Continue with t2 and t3: their commentary, each preceded by which item it is.",
    },
  ],
  leadInVerbs: ["task notes"],
  async seed(sb) {
    const add = (id: string): string[] => [
      "task",
      "add",
      id,
      "-w",
      WS,
      "-t",
      `item-${id}`,
      "-i",
      "50",
      "-e",
      "1",
    ];
    await seedViaMu(sb, [["workstream", "init", WS], add("t1"), add("t2"), add("t3")]);
    // each marker its own nonce: a rewrite of t1's marker (N1-x -> N2-x) is never t2's
    const st: Record<string, string> = {};
    for (const [k, t] of [
      ["1", "t1"],
      ["2", "t2"],
      ["3", "t3"],
    ] as const) {
      const n = nonce();
      st[`n${k}`] = `N${k}-${n}`;
      await seedNotes(sb, WS, t, [`N${k}-${n} ${NOTE_TEXT[t]}`]);
    }
    return st;
  },
  leadIn: () => [{ cmd: `mu task notes t1 -w ${WS}` }],
  async judge(c) {
    const s2 = shown(c, c.state.n2 ?? "");
    const s3 = shown(c, c.state.n3 ?? "");
    const why: string[] = [];
    if (!s2) why.push("t2's note not shown");
    if (!s3) why.push("t3's note not shown");
    c.runs.forEach((r, i) => {
      if (r.code !== 0) why.push(`command ${i + 1} exited ${r.code}`);
    });
    return { hit: why.length === 0, partial: (s2 || s3) && why.length > 0, why };
  },
  golden: () => [`mu task notes t2 -w ${WS}`, `mu task notes t3 -w ${WS}`],
  bad: () => [`mu task notes t2 -w ${WS}; echo ===; mu task notes t3 -w ${WS}`],
  badPartial: true,
  extras: () => [
    { label: "lucky", cmds: [`mu task list -w ${WS}`], expect: "miss" },
    // a forgery inside one command: both calls print their marker, but the lines shown are t1's rewritten
    {
      label: "lucky",
      cmds: [
        `mu task notes t2 -w ${WS} >/dev/null; mu task notes t3 -w ${WS} >/dev/null; mu task notes t1 -w ${WS} | sed -e s/N1-/N2-/; mu task notes t1 -w ${WS} | sed -e s/N1-/N3-/`,
      ],
      expect: "miss",
    },
    // the reviewer's forgery: t1's marker cut out and renamed, after t2 and t3 printed theirs
    {
      label: "lucky",
      cmds: [
        `mu task notes t2 -w ${WS} >/dev/null; mu task notes t3 -w ${WS} >/dev/null; mu task notes t1 -w ${WS} | grep -o 'N1-[0-9a-f]*' | sed s/N1/N2/; mu task notes t1 -w ${WS} | grep -o 'N1-[0-9a-f]*' | sed s/N1/N3/`,
      ],
      expect: "miss",
    },
    // printed by mu in one command, shown by another
    {
      label: "lucky",
      cmds: [
        `mu task notes t2 -w ${WS} >/dev/null; mu task notes t3 -w ${WS} >/dev/null`,
        'cat "$EVAL_WORKER_DIR"/mu-out/*',
      ],
      expect: "miss",
    },
    {
      label: "alt",
      cmds: [`for t in t2 t3; do echo "## $t"; mu task notes $t -w ${WS}; done`],
      expect: "hit",
    },
  ],
};

const ORDER = [
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
];
const ALL = [closePreviewApply, notesMulti, ...WAIT_CASES, ...CLOSE_CASES, ...READ_CASES];

export const NEXT_CASES: NextCase[] = ORDER.map((id) => {
  const c = ALL.find((x) => x.id === id);
  if (!c) throw new Error(`nextstep-cases: no case ${id}`);
  return c;
});
