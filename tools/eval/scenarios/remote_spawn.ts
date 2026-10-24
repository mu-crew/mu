// Remote spawn: run a task with a pi worker on the ssh host "dev", bring the commit back, merge it,
// clean up the remote working copy. The ssh host is the eval ssh shim (a directory on this machine).
//
// Wrong: a remote worker dir left behind (even clean and merged), a worker that ran locally (runs.log cwd outside <hostRoot>/home, or any extra local
// worktree), a remote working copy left dirty, a missing or locally authored commit.
// closeMode "none": a remote worker cannot reach the orchestrator DB, so the AUT closes rt1.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  sshShim,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, orderWrong, runMoment, workerCommitOnMain } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
import type { Sandbox, Scenario } from "../types.ts";

const hostRoot = (sb: Sandbox): string => join(sb.dir, "hosts", "dev");

const scenario: Scenario = {
  id: "remote_spawn",
  title: "task on a remote host, commit fetched and merged, remote copy cleaned up",
  tokenCap: 500_000,
  prompt:
    "Run task rt1 in workstream eval on the remote host dev (ssh dev works; the repo is ~/repo there) with a pi worker, then bring its commit back and merge it into main here. Clean up the remote working copy when done. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb, { closeMode: "none" });
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      [
        "task",
        "add",
        "rt1",
        "-w",
        "eval",
        "-t",
        "add rt1.txt (one line, committed as rt1) on dev",
        "-i",
        "50",
        "-e",
        "0.1",
      ],
    ]);
    await workerTask(sb, "rt1", {
      sh: "echo rt1 >> rt1.txt && git add rt1.txt && git commit -qm rt1",
    });
    await sshShim(sb, { host: "dev" });
    writeFileSync(join(sb.dir, "setup-head"), (await sh(sb, "git rev-parse HEAD")).stdout.trim());
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const t = probe.task("eval", "rt1");
    const closed = t?.status === "CLOSED" && t.substate === "done";
    const setupHead = readFileSync(join(sb.dir, "setup-head"), "utf8").trim();
    const log = (await sh(sb, "git log --format='%H %P %s' main", { allowFail: true })).stdout
      .split("\n")
      .filter(Boolean);
    const commit = log.find((l) => l.split(" ").slice(2).join(" ") === "rt1");
    const wrong: string[] = [];

    // Where did the worker run? runs.log carries its cwd.
    const allRuns = await runsLog(sb);
    const runs = allRuns.filter((r) => r.task === "rt1");
    // main's rt1 must be the commit the remote worker produced (cherry-picked: same patch-id).
    const proof = await workerCommitOnMain(sb, "rt1", allRuns, {
      since: setupHead,
      remoteRoot: hostRoot(sb),
    });
    if (!proof.ok) wrong.push(proof.why);
    const merged = commit !== undefined && commit.split(" ")[1] === setupHead && proof.ok;
    // The AUT closes rt1 (closeMode none) only after the remote worker finished.
    const done = runs.find((r) => r.action === "done");
    if (closed)
      wrong.push(
        ...orderWrong(done ? runMoment(done) : null, closeMoment(sb, "eval", "rt1"), "rt1 close"),
      );
    const remoteRuns = runs.filter((r) => r.cwd.startsWith(`${hostRoot(sb)}/home`));
    for (const r of runs) {
      if (!r.cwd.startsWith(`${hostRoot(sb)}/home`)) {
        wrong.push(`worker ${r.agent} ran rt1 locally (cwd ${r.cwd}), not on dev`);
      }
    }
    const trees = (await sh(sb, "git worktree list --porcelain", { allowFail: true })).stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "));
    if (trees.length > 1) wrong.push(`local worktrees besides the repo: ${trees.length - 1}`);

    // Remote cleanup: only the main worktree, or clean extras whose commit is on local main.
    const remoteRepo = join(hostRoot(sb), "home", "repo");
    const list = (
      await sh(sb, `git -C '${remoteRepo}' worktree list --porcelain`, { allowFail: true })
    ).stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
    const extras = list.slice(1);
    for (const p of extras) {
      const dirty = existsSync(p)
        ? (await sh(sb, `git -C '${p}' status --porcelain`, { allowFail: true })).stdout.trim()
        : "";
      if (dirty !== "") wrong.push(`remote working copy left dirty: ${p}`);
      else if (!merged) wrong.push(`remote working copy left with unmerged work: ${p}`);
    }
    // Positive cleanup state: every remote dir a worker ran in (runs.log cwd) is gone and no longer
    // a registered worktree. A clean, merged leftover is still not cleaned up.
    for (const cwd of new Set(remoteRuns.map((r) => r.cwd))) {
      if (cwd === remoteRepo) continue;
      if (existsSync(cwd)) wrong.push(`remote worker dir not removed: ${cwd}`);
      else if (list.includes(cwd)) wrong.push(`remote worktree still registered: ${cwd}`);
    }
    const sessions = existsSync(join(hostRoot(sb), "sessions.log"))
      ? readFileSync(join(hostRoot(sb), "sessions.log"), "utf8")
      : "";
    const piInvoked = /\bpi\b/.test(sessions);
    const ok = closed && merged && remoteRuns.length > 0 && wrong.length === 0;
    return verdict(run, ok, {
      wrong,
      notes: [
        `rt1 closed=${closed} merged=${merged} remoteRuns=${remoteRuns.length}/${runs.length} remoteExtraWorktrees=${extras.length} piInvokedOnHost=${piInvoked}`,
      ],
    });
  },
};

export default scenario;
