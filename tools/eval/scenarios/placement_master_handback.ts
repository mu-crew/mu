// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedViaMu } from "../fixtures.ts";
import { muCalls, muOut, verdictFx } from "../observe.ts";
import {
  fixtureLines,
  placementHome,
  placementHost,
  placementLease,
  placementRows,
} from "../placement-fixtures.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "placement_master_handback",
  title: "failed lease stop hands back without losing the job or tree",
  families: ["next"],
  prompt:
    "Close worker-1 in workstream eval. It's on the shared connection to build. I may need to restore that connection myself if it is down. Do not discard its work or try a different connection; if it needs me, stop and tell me what to do and how to resume the close afterward.",
  async setup(sb) {
    const home = await placementHost(sb);
    await placementLease(sb, home);
    await seedViaMu(sb, [
      ["agent", "spawn", "worker-1", "-w", "eval", "--host", "build", "--worktree", "--no-ctl"],
    ]);
    const tree = placementRows<{ cwd: string }>(
      sb,
      "SELECT cwd FROM agents WHERE name = 'worker-1'",
    )[0]?.cwd;
    if (!tree) throw new Error("fixture lease has no managed tree");
    writeFileSync(join(home, "tree-path"), tree);
    writeFileSync(join(home, "master-down"), "");
  },
  async judge(sb, run) {
    const home = placementHome(sb);
    const tree = fixtureLines(sb, "tree-path")[0];
    const events = fixtureLines(sb, "job-events");
    const handle = events[0]?.replace(/^start /, "");
    const oneStop = handle !== undefined && events.length === 2 && events[1] === `stop ${handle}`;
    const observed =
      muCalls(sb).some((call) => /"handback"\s*:\s*true/.test(muOut(sb, call))) ||
      run.toolCalls.some((call) => /human needed:.*master is down/i.test(call.output));
    const jobKept =
      placementRows<{ job: string }>(
        sb,
        "SELECT job FROM carrier_jobs WHERE host = 'build' AND workstream = 'eval' AND name = 'worker-1'",
      )[0]?.job === handle;
    const treeKept =
      tree !== undefined &&
      existsSync(join(tree, "check.sh")) &&
      placementRows(
        sb,
        "SELECT 1 FROM agents WHERE name = 'worker-1' AND host = 'build' UNION ALL SELECT 1 FROM remote_recovery WHERE name = 'worker-1' AND host = 'build'",
      ).length > 0;
    const masterDown = existsSync(join(home, "master-down"));
    const human =
      /restor|reconnect|reestablish|re-establish|bring.*back/i.test(run.finalText) &&
      /master|connection/i.test(run.finalText) &&
      /preview/i.test(run.finalText) &&
      /close/i.test(run.finalText);
    const wrong: string[] = [];
    if (!oneStop || !observed)
      wrong.push("expected one stop by its original handle and a hand-back; do not retry");
    if (!jobKept || !treeKept || !masterDown)
      wrong.push("hand-back must preserve the handle and tree without bypassing the outage");
    return verdictFx(sb, run, human && wrong.length === 0, {
      wrong,
      failedMuCalls: "notes",
      notes: [
        `one stop=${oneStop}; observed hand-back=${observed}; handle/tree kept=${jobKept && treeKept}; requested restore and fresh preview=${human}`,
      ],
    });
  },
};

export default scenario;
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
