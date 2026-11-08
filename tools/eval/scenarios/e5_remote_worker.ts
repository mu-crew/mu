// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// E5 remote worker (spec "Every harness first-class", U24, D11): r1 runs on a claude worker on the
// ssh host dev (the eval ssh shim: a directory on this machine), reporting through the remote
// path (its hooks write the remote area on dev; mu reads it through the host's exec template);
// its commit is collected and merged here and the remote working copy is removed.
//
// Pass criterion (written): r1 passes taskProof for claude on dev (main's r1 commit is the remote
// worker's, its eval-worker ran under <hostRoot>/home, its hooks fired on dev as claude, r1 closed
// after its report); no remote working copy of a worker is left; the worker was closed; nothing
// destructive. Fails: running r1 here, closing before the report, leaving the remote copy.
import { join } from "node:path";
import { hostProfile, sshShim } from "../fixtures.ts";
import {
  caseVerdict,
  remoteLeftovers,
  runsLog,
  seedCase,
  taskProof,
  WS,
  workersClosedWrong,
} from "../harness-cases.ts";
import { hookRecords } from "../harness-observe.ts";
import { openProbe } from "../probe.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "e5_remote_worker",
  title: "a claude worker on a remote host; its commit collected, merged, remote copy removed",
  families: ["next"],
  hookHarnesses: { workers: ["claude@dev"] },
  tokenCap: 600_000,
  check: { quietMs: 4000 },
  prompt:
    "In workstream eval, run task r1 with a claude worker on the remote host dev (a host profile named dev exists; use its repo) in a worktree there. When it has reported, collect its commit, merge it into main in the repo you are in, make sure r1 is closed, and close the worker so its remote working copy is removed. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await seedCase(sb, [{ id: "r1" }]);
    const { hostRoot } = await sshShim(sb, { host: "dev" });
    await hostProfile(sb, "dev", { repo: join(hostRoot, "home", "repo") });
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const recs = hookRecords(sb);
    const closed = probe.task(WS, "r1")?.status === "CLOSED";
    const p = await taskProof(sb, "r1", { harness: "claude", host: "dev" }, runs, recs);
    const wrong = [
      ...p.wrong,
      ...(await remoteLeftovers(sb, "dev", runs)),
      ...workersClosedWrong(sb, [p.agent]),
    ];
    return await caseVerdict(sb, run, closed && p.ok && wrong.length === 0, {
      wrong,
      notes: [`${p.note} closed=${closed}`],
    });
  },
};

export default scenario;
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
