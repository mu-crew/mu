// Dispatch through a shell helper (function + variable), then summarise: the turn must not end
// while the workers run, and the summary must carry what the workers actually reported.
//
// h1 (6s) and h2 (9s) are worker tasks. The AUT must get both done by workers, then write
// summary.md containing each worker's close evidence (it carries "run=<nonce>", visible only in
// the task after the worker closed it). Judged from runs.log, ops, file mtimes and the harness
// lifecycle record, never from the AUT's words:
//  - h1/h2 each ran once in a worker and closed done; summary.md has both nonces-evidence lines;
//  - the work was handed out through mu to two workers (each worker's prompt was carried by an
//    AUT mu invocation, however it was spelled: a function, a variable, spawn --send), once each;
//  - summary.md was last written after BOTH worker runs and after both closes;
//  - no agent_end between the dispatch and the last worker finishing (a stop), prods == 0.
// The bad stops with prose after dispatch ("I will summarise when they finish") and only goes on
// after a prod: check runs prod-enabled so that recovery path is exercised and flagged.
import { join } from "node:path";
import {
  gateScript,
  makeRepo,
  nonce,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { prodWrong, stopsWhileWorking } from "../lifecycle.ts";
import { claimCount, deliveries, verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, fileMoment, orderWrong, runMoment } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import type { Scenario } from "../types.ts";

const IDS = ["h1", "h2"];

const scenario: Scenario = {
  id: "wait_helper_summary",
  title: "dispatch through a shell helper, then summarise: do not stop while workers run",
  prompt:
    "Workstream eval has worker tasks h1 and h2 (each takes a pi worker several seconds). Define a small shell function dispatch() { ... } that claims a task for a worker and sends it the work, keep the task ids in a shell variable, and use them to dispatch h1 and h2 to two workers. When both are done, write summary.md in the repo root with one line per task quoting the evidence the worker closed it with, then tell me it is done. Work until it is done; do not ask me questions, and do not stop while the workers are running.",
  timeoutMs: 600_000,
  check: { quietMs: 3000, maxProds: 1 },
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...IDS.map((t) => [
        "task",
        "add",
        t,
        "-w",
        "eval",
        "-t",
        `work ${t}`,
        "-i",
        "50",
        "-e",
        "0.1",
      ]),
    ]);
    await workerTask(sb, "h1", { sh: "sleep 6; echo ok" });
    await workerTask(sb, "h2", { sh: "sleep 9; echo ok" });
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const n = await nonce(sb);
    const runs = await runsLog(sb);
    const wrong: string[] = [];
    let completed = true;
    const summary = await sh(sb, "cat summary.md", { allowFail: true });
    let lastRun = 0;
    let lastClose = 0;
    for (const id of IDS) {
      const t = probe.task("eval", id);
      const rs = runs.filter(
        (r) => r.task === id && (r.action === "close" || r.action === "block"),
      );
      if (rs.length !== 1) wrong.push(`${id}: ${rs.length} worker run(s) to completion (want 1)`);
      const r = rs[0];
      if (r) lastRun = Math.max(lastRun, r.ts);
      lastClose = Math.max(lastClose, closeMoment(sb, "eval", id)?.ms ?? 0);
      const done = t?.status === "CLOSED" && t.substate === "done";
      const quoted = new RegExp(`${id}\\.sh exit 0 run=${n}`).test(summary.stdout);
      if (!quoted) wrong.push(`summary.md lacks ${id}'s worker evidence (run=${n})`);
      if (!(done && r && quoted)) completed = false;
    }
    // "two workers": h1 and h2 were run by different agents (runs.log), not both by one.
    const agents = IDS.map((id) => runs.find((r) => r.task === id && r.action !== "lost")?.agent);
    if (agents.some((a) => a === undefined) || new Set(agents).size !== IDS.length) {
      completed = false;
      wrong.push(`h1 and h2 must run on two workers, got ${agents.join(" and ")}`);
    }
    // the summary is written after both workers finished and closed
    const file = fileMoment(join(sb.repoDir, "summary.md"));
    const done = { label: "both workers finished", ms: Math.max(lastRun, lastClose) };
    if (file && completed) wrong.push(...orderWrong(done, file, "summary.md must be written last"));
    // never stop: no agent_end from the first dispatch (send or spawn --send) until the last worker finishes.
    const stops = stopsWhileWorking(sb, run, Math.max(lastRun, lastClose));
    // the work really reached the workers through mu: each worker got a prompt that an AUT mu
    // invocation carried (a hand-typed prompt or a hidden channel has no such call), one per task.
    // How the call was spelled (a function, a variable, `send`, `spawn --send`) is not judged.
    const ds = deliveries(sb);
    const handed = IDS.filter((id) =>
      ds.some((d) => d.call !== undefined && d.p.agent === agents[IDS.indexOf(id)]),
    );
    if (handed.length !== IDS.length) {
      completed = false;
      wrong.push(
        `work was not handed to both workers through mu (delivered: ${ds.map((d) => `${d.p.agent}${d.call ? "" : "?"}`).join(",") || "none"})`,
      );
    }
    for (const id of IDS)
      if (claimCount(sb, "eval", id) !== 1)
        wrong.push(`${id} was claimed ${claimCount(sb, "eval", id)} times (want 1)`);
    if (stops.length > 0) wrong.push(`${stops.length} turn end(s) while the workers were running`);
    wrong.push(...prodWrong(run));
    return await verdictFx(sb, run, completed && stops.length === 0, {
      wrong,
      notes: [
        `runs=${runs.map((r) => `${r.task}:${r.action}`).join(",")} stops=${stops.length} summary=${summary.stdout.split("\n").length - 1} lines${runs[0] ? ` first=${runMoment(runs[0]).label}` : ""}`,
      ],
    });
  },
};

export default scenario;
