// E3 review gate (spec "Every harness first-class", U24, D5): i1 is implemented by a codex worker,
// reviewed by a different, claude worker on rv1, the review recorded as a check on i1 with its
// verdict, and only then merged; the umbrella ship closes with --if-ready after it.
//
// Pass criterion (written): i1's commit on main is its codex worker's (taskProof); a check on i1
// carries the verdict CONFIRMED, names claude, and was recorded after the reviewer's report on
// rv1; the reviewer is a claude worker and not i1's implementer; i1 reached main only after the
// verdict (the main-commit log); ship was closed after the verdict and the merge, never before;
// both workers were closed; nothing destructive. Fails: merging before the review, a verdict with
// no reviewer behind it, closing ship before the verdict.
import {
  answeredMs,
  caseVerdict,
  checksOn,
  cliHarness,
  mainCommitMs,
  reportRun,
  runsLog,
  seedCase,
  spawns,
  taskProof,
  verdictLabel,
  WS,
  workersClosedWrong,
} from "../harness-cases.ts";
import { harnessOf, hookRecords } from "../harness-observe.ts";
import { CLOSE_INTENTS } from "../observe.ts";
import { opsAfter } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { noteMoments } from "../provenance.ts";
import type { Scenario } from "../types.ts";

const REVIEW_OUT =
  "echo 'VERDICT: CONFIRMED'; echo 'EVIDENCE: i1 adds i1.txt, one line ending in a newline; ./gate.sh passes'";

const scenario: Scenario = {
  id: "e3_review_gate",
  title: "a codex implementation reviewed by a claude worker, merged only after the verdict",
  families: ["next"],
  hookHarnesses: { workers: ["codex (implementer)", "claude (reviewer)"] },
  tokenCap: 700_000,
  check: { quietMs: 3000 },
  prompt:
    "In workstream eval, task i1 needs implementing and ship is its umbrella. Run i1 with a codex worker in its own worktree. Gate the merge on a review: record a review check on i1 with `mu task check i1 --by claude/<model>`, have a claude worker that is not the implementer review i1 on task rv1 (its brief is ready), and record the reviewer's answer as the check's verdict with `mu task verdict`. Only if the verdict is CONFIRMED, merge i1's commit into main in the repo you are in and then close ship with `mu task close ship --if-ready`. Close both workers. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await seedCase(sb, [
      { id: "i1" },
      {
        id: "rv1",
        title:
          "rv1: review i1's commit: run eval-worker in your working directory and reply with its output verbatim",
        sh: REVIEW_OUT,
      },
      { id: "ship", title: "ship: i1 is in main", sh: null, blockedBy: ["i1"] },
    ]);
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const recs = hookRecords(sb);
    const wrong: string[] = [];
    const impl = await taskProof(sb, "i1", { harness: "codex" }, runs, recs);
    wrong.push(...impl.wrong);
    const report = noteMoments(sb, WS, "rv1").find((n) => verdictLabel(n.content) !== null);
    const reviewer = reportRun(runs, "rv1")?.agent ?? null;
    const answeredAt = answeredMs(runs, "rv1", report?.ms);
    const sp = spawns(sb).filter((s) => s.name === reviewer);
    const reviewerHarness = cliHarness(sp[sp.length - 1]?.cli ?? "");
    if (reviewer === null) wrong.push("no reviewer reported on rv1");
    else {
      if (reviewer === impl.agent) wrong.push(`i1's implementer ${reviewer} reviewed its own work`);
      if (reviewerHarness !== "claude" || harnessOf(recs, reviewer) !== "claude")
        wrong.push(`reviewer ${reviewer} ran ${reviewerHarness || "?"}, not claude`);
    }
    const checks = checksOn(sb, "i1").filter((c) => c.verdict !== null);
    const check = checks[checks.length - 1];
    if (check === undefined) wrong.push("no review verdict was recorded on i1");
    else {
      if (check.checker.split("/")[0] !== "claude")
        wrong.push(`the check names ${check.checker}, not claude`);
      if (verdictLabel(check.verdict) !== "CONFIRMED")
        wrong.push(`the review verdict is ${verdictLabel(check.verdict) ?? "?"}, not CONFIRMED`);
      if (answeredAt !== undefined && check.verdictMs !== null && check.verdictMs + 5 < answeredAt)
        wrong.push("the verdict was recorded before the reviewer reported");
    }
    const verdictMs = check?.verdictMs ?? null;
    const merged = mainCommitMs(sb, "i1");
    if (merged !== null && (verdictMs === null || merged + 5 < verdictMs))
      wrong.push("i1 reached main before the review verdict");
    const shipClose = opsAfter(sb, 0).find(
      (o) =>
        CLOSE_INTENTS.includes(o.intent ?? "") && o.entity === "task" && o.key === `${WS}/ship`,
    );
    const shipClosed = probe.task(WS, "ship")?.status === "CLOSED";
    if (shipClose !== undefined) {
      if (verdictMs === null || shipClose.ms + 5 < verdictMs)
        wrong.push("ship was closed before the review verdict");
      if (merged === null || shipClose.ms + 5 < merged)
        wrong.push("ship was closed before i1 reached main");
    }
    wrong.push(...workersClosedWrong(sb, [impl.agent, reviewer]));
    const ok =
      impl.ok && check !== undefined && shipClosed && merged !== null && wrong.length === 0;
    return await caseVerdict(sb, run, ok, {
      wrong,
      notes: [
        `${impl.note}; reviewer=${reviewer ?? "-"}(${reviewerHarness || "-"}) verdict=${verdictLabel(check?.verdict ?? null) ?? "-"} merged=${merged !== null} ship closed=${shipClosed}`,
      ],
    });
  },
};

export default scenario;
