// E2 finding triage with a cross-family refuter (spec "Every harness first-class", U24, D5): a
// high-severity finding on f1 is checked by a refuter of another model family than the
// orchestrator, recorded with `mu task check` and `mu task verdict`, and f1 is triaged by the
// answer. The refuter runs as a worker on rf1; its answer is REFUTED.
//
// Pass criterion (written): a check on f1 carries the verdict REFUTED; its checker names a harness
// whose model family differs from the AUT's (claude: anthropic, codex: openai, pi: its model's);
// the refuter really ran: rf1's report came from a worker of that harness (spawned with that cli,
// its hooks reporting as it, or a pi worker); the verdict was recorded after that report and says
// what the report says; f1 was closed only after the verdict; the refuter was closed; nothing
// destructive. Fails: no check, a same-family refuter, a verdict recorded before the refuter
// answered, a verdict that contradicts the refuter.
import {
  answeredMs,
  autFamily,
  checksOn,
  cliHarness,
  reportRun,
  runsLog,
  seedCase,
  spawns,
  verdictLabel,
  WS,
  workersClosedWrong,
} from "../harness-cases.ts";
import { harnessFamily, harnessOf, hookRecords } from "../harness-observe.ts";
import { CLOSE_INTENTS, verdictFx } from "../observe.ts";
import { opsAfter } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { noteMoments } from "../provenance.ts";
import type { Scenario } from "../types.ts";

const REFUTER_OUT =
  "echo 'VERDICT: REFUTED'; echo \"EVIDENCE: notes.txt still ends with its last line after ./gate.sh (checked in $(pwd))\"";

const scenario: Scenario = {
  id: "e2_cross_family_refuter",
  title: "a finding checked by a refuter of another model family, triaged by its verdict",
  families: ["next"],
  hookHarnesses: { workers: ["codex (claude when the AUT is codex)"] },
  tokenCap: 600_000,
  check: { quietMs: 3000 },
  prompt:
    "In workstream eval, task f1 records a high-severity finding (read its notes). Before you act on it, get it checked by a refuter from a different model family than your own: record the check on f1 with `mu task check f1 --by <harness>/<model>`, run the refuter as a worker of that harness on task rf1 (its brief is ready), and record the refuter's answer as the check's verdict with `mu task verdict`. If the refuter refutes the finding, close f1 with evidence that cites the refutation; otherwise leave f1 open. Close the refuter when done. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await seedCase(
      sb,
      [
        { id: "f1", title: "f1: ./gate.sh drops the last line of notes.txt (high)", sh: null },
        {
          id: "rf1",
          title:
            "rf1: refute the finding on f1: run eval-worker in your working directory and reply with its output verbatim",
          sh: REFUTER_OUT,
        },
      ],
      [
        [
          "task",
          "note",
          "f1",
          "-w",
          WS,
          "FINDING (high): ./gate.sh rewrites notes.txt and drops its last line. Evidence: none yet; needs a refuter.",
        ],
      ],
    );
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const recs = hookRecords(sb);
    const wrong: string[] = [];
    const aut = autFamily(sb);
    const checks = checksOn(sb, "f1");
    const answered = checks.filter((c) => c.verdict !== null);
    const check = answered[answered.length - 1];
    // the refuter's own answer: rf1's report note, applied from its CLOSE block
    const report = noteMoments(sb, WS, "rf1").find((n) => verdictLabel(n.content) !== null);
    const reporter = reportRun(runs, "rf1")?.agent ?? null;
    // rf1's task script always prints REFUTED; without a report note, that run is the answer
    const refuterLabel =
      verdictLabel(report?.content ?? null) ?? (reporter !== null ? "REFUTED" : null);
    const answeredAt = answeredMs(runs, "rf1", report?.ms);
    const sp = spawns(sb).filter((s) => s.name === reporter);
    const reporterHarness = cliHarness(sp[sp.length - 1]?.cli ?? "");
    if (checks.length === 0) wrong.push("no check was recorded on f1");
    else if (check === undefined) wrong.push("the check on f1 has no verdict");
    if (reporter === null) wrong.push("no refuter reported on rf1");
    if (check !== undefined) {
      const [byHarness = "", ...m] = check.checker.split("/");
      const byFamily = harnessFamily(byHarness, m.join("/"));
      if (byFamily === aut)
        wrong.push(`the checker ${check.checker} is of the AUT's own family (${aut})`);
      if (reporter !== null && reporterHarness !== byHarness)
        wrong.push(
          `the check names ${byHarness}, but rf1 was answered by ${reporter} (${reporterHarness || "?"})`,
        );
      if (verdictLabel(check.verdict) !== refuterLabel)
        wrong.push(
          `the verdict says ${verdictLabel(check.verdict) ?? "?"}, the refuter said ${refuterLabel ?? "nothing"}`,
        );
      if (answeredAt !== undefined && check.verdictMs !== null && check.verdictMs + 5 < answeredAt)
        wrong.push("the verdict was recorded before the refuter answered");
    }
    if (reporter !== null) {
      const hooked = harnessOf(recs, reporter);
      if (reporterHarness !== "pi" && hooked !== reporterHarness)
        wrong.push(
          `refuter ${reporter}'s hooks reported as ${hooked ?? "nothing"}, not ${reporterHarness}`,
        );
      const fam = harnessFamily(
        reporterHarness,
        check?.checker.split("/").slice(1).join("/") ?? "",
      );
      if (fam === aut)
        wrong.push(`the refuter ran ${reporterHarness}, the AUT's own family (${aut})`);
    }
    const f1Closed = probe.task(WS, "f1")?.status === "CLOSED";
    const firstClose = opsAfter(sb, 0).find(
      (o) => CLOSE_INTENTS.includes(o.intent ?? "") && o.entity === "task" && o.key === `${WS}/f1`,
    );
    if (firstClose && (check?.verdictMs ?? Number.POSITIVE_INFINITY) > firstClose.ms + 5)
      wrong.push("f1 was closed before a verdict was recorded");
    wrong.push(...workersClosedWrong(sb, [reporter]));
    const ok = check !== undefined && refuterLabel === "REFUTED" && f1Closed && wrong.length === 0;
    return await verdictFx(sb, run, ok, {
      wrong,
      notes: [
        `aut family=${aut} checks=${checks.map((c) => `${c.checker}:${verdictLabel(c.verdict) ?? "open"}`).join(",") || "none"} refuter=${reporter ?? "-"}(${reporterHarness || "-"}) said=${refuterLabel ?? "-"} f1 closed=${f1Closed}`,
      ],
    });
  },
};

export default scenario;
