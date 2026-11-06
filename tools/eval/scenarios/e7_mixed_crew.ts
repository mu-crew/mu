// E7 a mixed crew (spec "Every harness first-class", U24, D17): one orchestrator, a local codex
// and a local pi worker, a claude and a pi worker on the ssh host dev. Each runs one task in its
// own worktree; the remote commits are collected; everything is merged and every worker closed.
//
// Pass criterion (written): m1 passes taskProof as codex here, m2 as pi here, m3 as claude on dev,
// m4 as pi on dev (main's commit is that worker's; it ran where asked; spawned with that cli; a
// hook harness's hooks reported as it and on that host; a pi worker reported through no hooks;
// closed after its report); no remote working copy is left; all four workers were closed; nothing
// destructive. Fails: a remote task run here, the wrong harness for a task, a worker left running.
import { join } from "node:path";
import { hostProfile, sshShim } from "../fixtures.ts";
import {
  caseVerdict,
  remoteLeftovers,
  runsLog,
  seedCase,
  taskProof,
  type Want,
  WS,
  workersClosedWrong,
} from "../harness-cases.ts";
import { hookRecords } from "../harness-observe.ts";
import { openProbe } from "../probe.ts";
import type { Scenario } from "../types.ts";

const WANT: Record<string, Want> = {
  m1: { harness: "codex" },
  m2: { harness: "pi" },
  m3: { harness: "claude", host: "dev" },
  m4: { harness: "pi", host: "dev" },
};

const scenario: Scenario = {
  id: "e7_mixed_crew",
  title: "local codex and pi workers, remote claude and pi workers, one orchestrator",
  families: ["next"],
  hookHarnesses: { workers: ["codex", "pi", "claude@dev", "pi@dev"] },
  tokenCap: 900_000,
  timeoutMs: 1_200_000,
  check: { quietMs: 4000 },
  prompt:
    "In workstream eval, run m1 with a codex worker and m2 with a pi worker here, and m3 with a claude worker and m4 with a pi worker on the remote host dev (a host profile named dev exists; use its repo), each in its own worktree. When each worker has reported, merge its commit into main in the repo you are in (collect the remote ones first), make sure m1-m4 are closed, and close all four workers so no remote working copy is left. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await seedCase(sb, [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }]);
    const { hostRoot } = await sshShim(sb, { host: "dev" });
    await hostProfile(sb, "dev", { repo: join(hostRoot, "home", "repo") });
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const recs = hookRecords(sb);
    const wrong: string[] = [];
    const notes: string[] = [];
    const agents: (string | null)[] = [];
    let ok = true;
    for (const [task, want] of Object.entries(WANT)) {
      const closed = probe.task(WS, task)?.status === "CLOSED";
      const p = await taskProof(sb, task, want, runs, recs);
      wrong.push(...p.wrong);
      agents.push(p.agent);
      notes.push(`${p.note} closed=${closed}`);
      ok = ok && closed && p.ok;
    }
    if (new Set(agents.filter((a) => a !== null)).size < agents.filter((a) => a !== null).length)
      wrong.push("one worker ran more than one task");
    wrong.push(...(await remoteLeftovers(sb, "dev", runs)), ...workersClosedWrong(sb, agents));
    return await caseVerdict(sb, run, ok && wrong.length === 0, { wrong, notes });
  },
};

export default scenario;
