// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// E1 dispatch and merge (spec "Every harness first-class", U24): the orchestrator runs two tasks
// on workers of two hook harnesses, each in its own worktree, merges both commits and closes the
// workers. Workers: d1 on claude, d2 on codex, unless the run picks the mix (`--workers d1,d2`,
// mix.ts): the prompt, title and judge name the bound harnesses.
//
// Pass criterion (written): d1 and d2 are CLOSED; for each, main holds exactly one commit named
// after it and it is the commit its worker produced (or a cherry-pick of it); that worker ran
// locally in a worktree of its own, was spawned with the requested cli and its hooks reported as
// that harness; neither task was closed before its worker's report; both workers were closed; and
// nothing destructive happened (caseVerdict). Fails: the AUT doing a task itself, the wrong harness
// for a task, a close before the report, a worker left running.
import {
  caseVerdict,
  runsLog,
  seedCase,
  taskProof,
  under,
  WS,
  workersClosedWrong,
} from "../harness-cases.ts";
import { hookRecords } from "../harness-observe.ts";
import { openProbe } from "../probe.ts";
import type { Scenario } from "../types.ts";

const DEFAULT = ["claude", "codex"] as const;

function e1(workers: readonly string[]): Scenario {
  const [w1 = DEFAULT[0], w2 = DEFAULT[1]] = workers;
  const WANT: Record<string, string> = { d1: w1, d2: w2 };
  return {
    id: "e1_dispatch_merge",
    title: `two tasks on a ${w1} and a ${w2} worker, both merged, workers closed`,
    families: ["next"],
    hookHarnesses: { workers: [w1, w2], mix: { roles: ["d1", "d2"], harnesses: [w1, w2] } },
    bind: (o) => e1(o.workers ?? DEFAULT),
    tokenCap: 600_000,
    check: { quietMs: 3000 },
    prompt: `In workstream eval, tasks d1 and d2 are ready. Run d1 with a ${w1} worker and d2 with a ${w2} worker (mu agent spawn --cli), each in its own worktree. When each worker has reported, merge its commit into main in the repo you are in, make sure d1 and d2 are closed, and close both workers. Work until it is done; do not ask me questions.`,
    async setup(sb) {
      await seedCase(sb, [{ id: "d1" }, { id: "d2" }]);
    },
    async judge(sb, run) {
      const probe = openProbe(sb);
      const runs = await runsLog(sb);
      const recs = hookRecords(sb);
      const wrong: string[] = [];
      const notes: string[] = [];
      const agents: (string | null)[] = [];
      let ok = true;
      for (const [task, harness] of Object.entries(WANT)) {
        const closed = probe.task(WS, task)?.status === "CLOSED";
        const p = await taskProof(sb, task, { harness }, runs, recs);
        wrong.push(...p.wrong);
        notes.push(`${p.note} closed=${closed}`);
        agents.push(p.agent);
        ok = ok && closed && p.ok;
      }
      const cwds = runs.filter((r) => r.task in WANT).map((r) => r.cwd);
      if (cwds.some((c) => under(c, sb.repoDir)))
        wrong.push("a worker ran in the main checkout, not its own worktree");
      if (agents[0] !== null && agents[0] === agents[1]) wrong.push("one worker ran both tasks");
      wrong.push(...workersClosedWrong(sb, agents));
      return await caseVerdict(sb, run, ok && wrong.length === 0, { wrong, notes });
    },
  };
}

export default e1(DEFAULT);
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
