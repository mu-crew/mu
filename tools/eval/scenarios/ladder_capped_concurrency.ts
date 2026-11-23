// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import {
  fixtureLines,
  ladderHome,
  ladderHost,
  ladderLease,
  ladderRows,
} from "../ladder-fixtures.ts";
import { verdictFx } from "../observe.ts";
import { sh } from "../sandbox.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "ladder_capped_concurrency",
  title: "two live lease workers and one synchronous check over a capped host",
  families: ["next"],
  prompt:
    "Host build can run pi but has just one practical connection and one session slot. Its profile is already set up; leave it and its limit intact. In workstream eval, start two idle pi workers, worker-1 and worker-2, and leave both running. This is a transport exercise: don't send a prompt, make a worktree or probe ctl. With both workers live, run `sh check.sh` once in build's ~/repo and report the result.",
  async setup(sb) {
    await ladderLease(sb, await ladderHost(sb));
  },
  async judge(sb, run) {
    const jobs = ladderRows<{ job: string; name: string; pane_id: string }>(
      sb,
      `SELECT j.job, a.name, a.pane_id FROM agents a JOIN carrier_jobs j ON j.agent_id = a.id
       WHERE a.host = 'build' AND a.host_transport = 'lease' AND a.cli = 'pi' ORDER BY a.name`,
    );
    const panes = (
      await sh(sb, "tmux list-panes -a -F '#{pane_id}'", { allowFail: true })
    ).stdout.split("\n");
    const crew =
      jobs.map((j) => j.name).join(",") === "worker-1,worker-2" &&
      jobs.every((j) => j.job && panes.includes(j.pane_id)) &&
      new Set(jobs.map((j) => j.job)).size === 2 &&
      ladderRows(sb, "SELECT 1 FROM agents").length === 2;
    const events = fixtureLines(sb, "job-events");
    const overlapped =
      events[2] === "check" &&
      events.length === 3 &&
      jobs.every((j) => events.slice(0, 2).includes(`start ${j.job}`));
    const checked =
      fixtureLines(sb, "check-runs").join("\n") === ladderHome(sb) &&
      ladderRows(sb, "SELECT 1 FROM ops WHERE intent = 'host.exec'").length === 1;
    const cap =
      ladderRows(
        sb,
        "SELECT 1 FROM host_profiles WHERE name = 'build' AND max_sessions = 1 AND transport = 'lease'",
      ).length === 1 &&
      ladderRows(sb, "SELECT 1 FROM host_channels WHERE host = 'build'").length === 0;
    const wrong: string[] = [];
    if (!crew || !overlapped)
      wrong.push("both lease workers must span the workspace check and remain live");
    if (!cap) wrong.push("changed the host limit or left a channel held");
    if (!checked)
      wrong.push("expected one synchronous host check, not a command gate or raw connection");
    const reported =
      /workspace-check-ok|\b(?:check|test)\b[^.!?\n]*(?:pass|succeed|success|exit(?:ed)? (?:with )?0)/i.test(
        run.finalText,
      );
    return verdictFx(sb, run, reported && wrong.length === 0, {
      wrong,
      notes: [
        `live lease crew=${crew}; checked alongside crew=${overlapped && checked}; one-slot profile preserved=${cap}; reported result=${reported}`,
      ],
    });
  },
};

export default scenario;
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
