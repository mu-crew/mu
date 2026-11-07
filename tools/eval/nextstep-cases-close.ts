// Next-step cases of group c2 (close preview) and c5 (outcome wording): spec §2, cases 2, 9, 10.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WS } from "./cold-intents.ts";
import { delegateDefault, seedDelegate, shq, workerTask, writeWorkerDriver } from "./fixtures.ts";
import type { NextCase } from "./nextstep.ts";
import {
  addTask,
  closeRev,
  commitIn,
  iso,
  nonce,
  onMain,
  paras,
  q,
  ranTask,
  seedMu,
  spawnWorker,
  until,
  verdictLabel,
  worktreePane,
} from "./nextstep-cases-lib.ts";
import { shownLine } from "./nextstep-exec.ts";
import { claimCount, lostWork, prompts } from "./observe.ts";
import { opsSince } from "./ops.ts";
import { openProbe } from "./probe.ts";
import { sh } from "./sandbox.ts";
import type { Sandbox } from "./types.ts";

const registered = (sb: Sandbox, name: string): boolean => openProbe(sb).agents(WS).includes(name);

// ---- case 2: close_preview_conflict -------------------------------------------------------------

const closePreviewConflict: NextCase = {
  id: "close_preview_conflict",
  group: "c2_close",
  role: "headline",
  arms: ["none", "skill", "recipe:merge"],
  shell: "bash",
  expectedRowMs: 20_000,
  // §2.3's lead-in b (the scrape `grep -o 'mu agent close.*--if [0-9]*' | head -1 | sh`) is dropped:
  // on base the preview's `next:` line matches it, so the scrape applies the close and the lead-in
  // no longer ends with worker-1 registered and `C` off main. Every paraphrase uses lead-in a.
  paraphrases: paras([
    "Make sure worker-1's commit ends up on main, then get rid of worker-1.",
    "Bring worker-1's change onto main, and once that is done retire worker-1.",
    "worker-1's commit is not on main yet. Land it there, then dismiss worker-1.",
    "Get worker-1's patch into main, then tidy worker-1 away for good.",
    "Before removing worker-1, its commit has to reach main. Do both.",
    "I want worker-1's work on main and worker-1 itself gone.",
    "Put worker-1's commit on main and then take worker-1 out of service.",
    "Merge what worker-1 made into main; once that is in, decommission worker-1.",
    "worker-1 has a commit main lacks. Fix that, then dispose of worker-1 and its checkout.",
    "Main must end up with worker-1's change, and worker-1 must be cleaned up.",
  ]),
  leadInVerbs: ["agent close"],
  async seed(sb) {
    await seedMu(sb, ["workstream", "init", WS]);
    const dir = await worktreePane(sb, "worker-1");
    const sha = await commitIn(sb, dir, "token.txt", "token-fix");
    const rev = await closeRev(sb, "worker-1");
    return { dir, sha, rev };
  },
  leadIn: (_sb, st) => [
    {
      cmd: `mu agent close worker-1 -w ${WS}`,
      expect: async (sb) =>
        !registered(sb, "worker-1")
          ? "worker-1 is not registered"
          : (await onMain(sb, st.sha ?? ""))
            ? "worker-1's commit is already on main"
            : null,
    },
  ],
  allow: (o) => o.entity === "agent" && (o.intent ?? "").startsWith("agent."),
  async judge(c) {
    const merged = await onMain(c.sb, c.state.sha ?? "");
    const gone = !registered(c.sb, "worker-1");
    const closed = opsSince(c.sb, c.base).some((o) => o.intent === "agent.close");
    const treeGone = !existsSync(c.state.dir ?? "");
    const lost = await lostWork(c.sb);
    const why: string[] = [];
    if (!merged) why.push("worker-1's commit is not on main");
    if (!gone) why.push("worker-1 still registered");
    else if (!closed) why.push("worker-1's row went without a close (reaped)");
    // as case 1: the worktree goes too, so a pane kill that leaves the row to the reaper misses
    if (!treeGone) why.push("worker-1's worktree is still there");
    why.push(...lost.map((l) => `LOST WORK: ${l}`));
    return { hit: why.length === 0, partial: merged && !gone, why };
  },
  golden: (st) => [
    `git cherry-pick ${st.sha}`,
    `mu agent close worker-1 -w ${WS} --if "$(mu agent close worker-1 -w ${WS} --json | jq -r .data.revision)"`,
  ],
  bad: (st) => [`mu agent close worker-1 -w ${WS} --if ${st.rev}`],
  extras: (st) => [
    {
      label: "lucky",
      cmds: [`mu agent close worker-1 -w ${WS} --discard --if ${st.rev}`],
      expect: "miss",
    },
    // the builder note: merged, the pane killed and the row reaped, the worktree left behind
    {
      label: "lucky",
      cmds: [
        `git cherry-pick ${st.sha}`,
        `tmux kill-pane -t "$(mu agent show worker-1 -w ${WS} --json | jq -r .data.agent.pane_id)"; sleep 1; mu agent list -w ${WS}`,
      ],
      expect: "miss",
    },
    // the worktree is detached (no branch on base), so the merge names the commit
    {
      label: "alt",
      cmds: [
        `git merge --no-edit ${st.sha}`,
        `mu agent close worker-1 -w ${WS} --if "$(mu agent close worker-1 -w ${WS} --json | jq -r .data.revision)"`,
      ],
      expect: "hit",
    },
  ],
};

// ---- case 9: delegate_no_verdict ----------------------------------------------------------------

/** Verdicts recorded on auth/t4 after `t0`: check verdicts and notes whose first VERDICT line has a label. */
function verdictsOnT4(sb: Sandbox, t0: number): { label: string; text: string }[] {
  const since = iso(t0);
  const checks = q<{ verdict: string | null }>(
    sb,
    `SELECT c.verdict FROM checks c JOIN tasks t ON t.id = c.task_id JOIN workstreams w ON w.id = t.workstream_id
      WHERE w.name = ? AND t.local_id = 't4' AND c.verdict IS NOT NULL AND c.updated_at >= ?`,
    WS,
    since,
  ).map((r) => r.verdict ?? "");
  const notes = q<{ content: string }>(
    sb,
    `SELECT n.content FROM task_notes n JOIN tasks t ON t.id = n.task_id JOIN workstreams w ON w.id = t.workstream_id
      WHERE w.name = ? AND t.local_id = 't4' AND n.created_at >= ?`,
    WS,
    since,
  ).map((r) => r.content);
  return [...checks, ...notes].flatMap((text) => {
    // a verdict note opens with its REFUTER header line; the label is on its first VERDICT line
    const label = verdictLabel(text);
    return label === undefined ? [] : [{ label, text }];
  });
}

const delegateNoVerdict: NextCase = {
  id: "delegate_no_verdict",
  group: "c5_outcome",
  role: "headline",
  arms: ["none", "skill", "recipe:adversarial-review"],
  shell: "bash",
  expectedRowMs: 20_000,
  paraphrases: paras([
    "Did the review of t4 pass? If the reviewer gave no clear judgement, get one.",
    "Is t4's review a pass? Without a clear pass or fail from the reviewer, obtain one.",
    "I need to know whether t4 survived review; if the reviewer never said, have it judged properly.",
    "Was t4 approved by its reviewer? If that is unclear, make sure a clear judgement gets made.",
    "Tell us if t4's review succeeded, and if the reply is ambiguous, arrange a real ruling.",
    "Can t4 be trusted per its review? If the reviewer was vague, get a definite call.",
    "Look at where t4's review landed; an unclear result means another reviewer must decide.",
    "Has t4 cleared review? If there is no explicit judgement, see that one is given.",
    "Find out whether t4's reviewer approved it; if not explicitly, have t4 looked at again.",
    "Is the review on t4 a pass? Should it be inconclusive, have someone give a firm judgement.",
  ]),
  leadInVerbs: ["wait"],
  async seed(sb) {
    const n = nonce();
    await writeWorkerDriver(sb, { closeMode: "block" });
    await seedMu(sb, ["workstream", "init", WS]);
    await seedMu(sb, addTask("t4", "four auth fixes"));
    await sh(sb, "echo fixes > fixes.txt && git add fixes.txt && git commit -qm worker-4-fixes");
    const call = `rv-${n}`;
    await seedDelegate(sb, {
      callId: call,
      caller: "pi:nextstep-orch",
      wave: "w1",
      label: "review-t4",
      record: `${WS}/t4`,
      brief: "Review t4's four fixes against main. End with a VERDICT: line.",
      agent: "delegate-review-t4",
      answer: "All four fixes are in place. I found no real problems.",
    });
    await delegateDefault(
      sb,
      `VERDICT: CONFIRMED\nEVIDENCE: RV-${n} re-read the four fixes against main; tests pass`,
    );
    return { call, rv: `RV-${n}` };
  },
  leadIn: () => [
    {
      cmd: `mu wait --wave w1 -w ${WS}`,
      expect: async (sb) =>
        openProbe(sb).task(WS, "t4")?.status === "OPEN" ? null : "t4 is not OPEN",
    },
  ],
  // check.* and delegate.* writes (the delegate path also adds and closes its own delegate_* task),
  // a check's verdict, and a note on t4 (a typed UNVERIFIED; ops carry no text, and a forged
  // CONFIRMED or REFUTED misses by the judge's verdict rule)
  allow: (o) =>
    /^(check|delegate|delegates)\./.test(o.intent ?? "") ||
    (o.intent ?? "").startsWith("task.verdict") ||
    o.key.startsWith(`${WS}/delegate_`) ||
    (o.intent === "task.note" && /^auth\/t4(#|$)/.test(o.key)),
  async judge(c) {
    const since = iso(c.t0);
    const checks = q<{ id: string }>(
      c.sb,
      `SELECT c.id FROM checks c JOIN tasks t ON t.id = c.task_id JOIN workstreams w ON w.id = t.workstream_id
        WHERE w.name = ? AND t.local_id = 't4' AND c.created_at >= ?`,
      WS,
      since,
    );
    const calls = q<{ call_id: string }>(
      c.sb,
      `SELECT call_id FROM delegate_calls WHERE record_workstream = ? AND record_task = 't4'
         AND call_id <> ? AND state <> 'refused'`,
      WS,
      c.state.call ?? "",
    );
    const asked = prompts(c.sb).filter(
      (p) => p.ts >= c.t0 && !/^delegate[-_]/.test(p.agent) && /\bt4\b/.test(p.text),
    );
    const dispatched = checks.length + calls.length + asked.length > 0;
    const forged = verdictsOnT4(c.sb, c.t0).filter(
      (v) => v.label !== "UNVERIFIED" && !v.text.includes(c.state.rv ?? "\0"),
    );
    const why: string[] = [];
    if (!dispatched) why.push("no new review of t4 dispatched");
    for (const f of forged) why.push(`a ${f.label} on t4 no reviewer gave`);
    if (openProbe(c.sb).task(WS, "t4")?.status !== "OPEN") why.push("t4 is no longer OPEN");
    return {
      hit: why.length === 0,
      partial: !dispatched && shownLine(c, (l) => l.includes("NO VERDICT LINE")),
      why,
    };
  },
  golden: () => [
    `mu task check t4 -w ${WS} --by claude --brief "Re-review t4's four fixes and end with a VERDICT: line"`,
  ],
  bad: () => [`mu task note t4 -w ${WS} "VERDICT: CONFIRMED - the reviewer found no problems"`],
  extras: () => [
    {
      label: "lucky",
      cmds: [
        `c=$(mu task check t4 -w ${WS} --by claude --brief "re-review t4" | cut -d= -f2); mu task verdict t4 -w ${WS} --check "$c" "VERDICT: t4 CONFIRMED"`,
      ],
      expect: "miss",
    },
    {
      label: "lucky",
      cmds: [`mu task close t4 -w ${WS} --evidence "review passed"`],
      expect: "miss",
    },
    {
      label: "alt",
      cmds: [
        `mu delegates register rr-t4 -w ${WS} --wave w1 --record ${WS}/t4 --label review-t4 --state starting --text "Re-review t4's four fixes; end with a VERDICT: line"`,
        "mu delegates run rr-t4",
      ],
      expect: "hit",
    },
  ],
};

// ---- case 10: close_already_closed --------------------------------------------------------------

// The worker's own close script (close-mode verb) also says which commit it made, as a pi worker's
// last words do: the wait's lastText then carries the sha the golden picks (§2.3 case 10 note).
const CLOSE_WITH_SHA =
  '#!/bin/bash\nmu task close "$1" -w "$MU_WORKSTREAM" --evidence "$2"\necho "Committed $(git log -1 --format=\'%h %s\')."\n';

const closeAlreadyClosed: NextCase = {
  id: "close_already_closed",
  group: "c5_outcome",
  role: "headline",
  arms: ["none", "skill", "recipe:orchestrator-loop"],
  shell: "bash",
  expectedRowMs: 30_000,
  paraphrases: paras([
    "If t2 is complete, bring worker-1's commit onto main; otherwise have worker-1 complete it.",
    "Should t2 be complete, land worker-1's change on main; if not, get worker-1 to complete it.",
    "Is t2 through? Then worker-1's commit belongs on main. If it is not, worker-1 has to wrap it up.",
    "Get worker-1's work for t2 onto main when t2 is complete; else make worker-1 complete t2.",
    "When t2 has been completed, merge worker-1's commit into main; otherwise push worker-1 to complete it.",
    "If worker-1 got t2 done, put its commit on main. If it did not, tell it to wrap up.",
    "t2: if it is complete, worker-1's patch goes onto main; if it is not, worker-1 carries on.",
    "Bring worker-1's commit to main provided t2 is complete; failing that, have worker-1 complete t2.",
    "Decide from t2's progress: complete means worker-1's commit lands on main, incomplete means worker-1 goes on.",
    "worker-1 was on t2. If that is complete, pick its commit onto main; if not, have it carry on.",
  ]),
  leadInVerbs: ["wait"],
  async seed(sb) {
    await writeWorkerDriver(sb, { closeMode: "verb" });
    writeFileSync(join(sb.workerDir, "close.sh"), CLOSE_WITH_SHA, { mode: 0o755 });
    await seedMu(sb, ["workstream", "init", WS]);
    await seedMu(sb, addTask("t2", "fix the token cache"));
    await workerTask(sb, "t2", {
      sh: "echo cache > cache.txt && git add cache.txt && git commit -qm token-cache-fix",
    });
    await spawnWorker(sb, "worker-1", "t2", ["--worktree"]);
    await until("worker-1's close", () => ranTask(sb, "t2", "close"));
    // consume t2's close event, so the lead-in's wait reports worker-1's settled run and its close outcome
    await until(
      "worker-1 to settle",
      async () => {
        const r = await seedMu(sb, ["wait", `agent:${WS}/worker-1@0`, "--timeout", "20"]);
        return r.includes('"kind":"settled"');
      },
      90_000,
    );
    const dir = (await seedMu(sb, ["agent", "show", "worker-1", "-w", WS, "--json"])).match(
      /"cwd":"([^"]+)"/,
    )?.[1];
    const sha = (await sh(sb, `git -C ${shq(dir ?? "")} rev-parse HEAD`)).stdout.trim();
    const short = (await sh(sb, `git -C ${shq(dir ?? "")} rev-parse --short HEAD`)).stdout.trim();
    return { sha, short, claims: String(claimCount(sb, WS, "t2")) };
  },
  leadIn: (_sb, st) => [
    {
      cmd: `mu wait agent:${WS}/worker-1@0`,
      expect: async (sb) =>
        openProbe(sb).task(WS, "t2")?.status !== "CLOSED"
          ? "t2 is not CLOSED"
          : (await onMain(sb, st.sha ?? ""))
            ? "worker-1's commit is already on main"
            : null,
    },
  ],
  async judge(c) {
    const merged = await onMain(c.sb, c.state.sha ?? "");
    const nudged = prompts(c.sb).filter((p) => p.ts >= c.t0 && p.agent === "worker-1");
    const why: string[] = [];
    if (!merged) why.push("worker-1's commit is not on main");
    if (nudged.length > 0) why.push(`worker-1 was sent ${nudged.length} prompt(s)`);
    if (openProbe(c.sb).task(WS, "t2")?.status !== "CLOSED") why.push("t2 is no longer CLOSED");
    if (String(claimCount(c.sb, WS, "t2")) !== c.state.claims) why.push("t2 was claimed again");
    return { hit: why.length === 0, partial: merged && nudged.length > 0, why };
  },
  golden: (st) => [`mu task show t2 -w ${WS}`, `git cherry-pick ${st.sha}`],
  bad: () => [`mu agent send worker-1 -w ${WS} "finish t2"`],
  extras: (st) => [
    { label: "lucky", cmds: [`mu task open t2 -w ${WS}`], expect: "miss" },
    // the short sha as the wait's lastText printed it
    { label: "alt", cmds: [`git cherry-pick ${st.short}`], expect: "hit" },
    { label: "alt", cmds: [`git merge --no-edit ${st.short}`], expect: "hit" },
  ],
};

export const CLOSE_CASES: NextCase[] = [
  closePreviewConflict,
  delegateNoVerdict,
  closeAlreadyClosed,
];
