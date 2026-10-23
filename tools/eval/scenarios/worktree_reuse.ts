// Reuse of a worker name whose earlier workspace was freed. Setup replays what mu 3.13.3 really
// leaves behind (git workspaces are detached worktrees; a clean free removes dir and registration):
//   r1 done by w1 in a workspace -> its commit cherry-picked onto main -> `workspace free --commit`
//   (creates the retention branch mu/eval/w1-<sha12>, the commit being on no branch) -> agent closed.
// Leftovers asserted at the end of setup: agent name w1 free, workspace dir and registration gone,
// branch mu/eval/w1-<sha12> present, r1's commit on main under a new sha. The AUT must run r2 with
// a worker named w1 in its own working copy and merge it, without wrecking main or that branch.
// 3.x behaviour reproduced: git workspaces are detached worktrees (src/vcs/git.ts:35-39);
// `workspace free --commit` makes the retention branch only when no branch contains HEAD
// (keepGitHeadReachable, src/vcs/git.ts:222-236; called from the free path, git.ts:143-148;
// registry free + audit line src/workspace/crud.ts:~230-236). The cherry-pick below must therefore
// yield a DIFFERENT sha than the workspace commit (-x appends "(cherry picked from ...)"), or
// main already contains HEAD and no branch is made: with the same-second default it did, ~1 in 6.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { mu, sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
import type { Sandbox, Scenario } from "../types.ts";

const headFile = (sb: Sandbox) => join(sb.dir, "worktree_reuse.head");
const branchFile = (sb: Sandbox) => join(sb.dir, "worktree_reuse.branch");

async function must(sb: Sandbox, args: string[]): Promise<string> {
  const r = await mu(sb, args);
  if (r.code !== 0) throw new Error(`setup: mu ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  return r.stdout.trim();
}

const scenario: Scenario = {
  id: "worktree_reuse",
  title: "reuse worker name w1 after its workspace was freed",
  prompt:
    "In workstream eval, run task r2 with a worker named w1 in its own working copy and merge its commit into main in the repo you are in. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb, "3x");
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ["task", "add", "r1", "-w", "eval", "-t", "write r1.txt", "-i", "50", "-e", "0.1"],
    ]);
    await workerTask(sb, "r1", {
      sh: "echo r1 > r1.txt && git add r1.txt && git commit -qm r1",
    });
    await must(sb, ["agent", "spawn", "w1", "-w", "eval", "--workspace"]);
    await must(sb, ["task", "claim", "r1", "-w", "eval", "--for", "w1"]);
    await must(sb, ["agent", "send", "w1", "-w", "eval", "go"]);
    await must(sb, ["task", "wait", "r1", "-w", "eval", "--timeout", "120"]);
    const wsPath = await must(sb, ["workspace", "path", "w1", "-w", "eval"]);
    const wsHead = (await sh(sb, `git -C ${JSON.stringify(wsPath)} rev-parse HEAD`)).stdout.trim();
    await sh(sb, `git -C ${JSON.stringify(sb.repoDir)} cherry-pick -x ${wsHead}`);
    await must(sb, ["workspace", "free", "w1", "-w", "eval", "--commit"]);
    await must(sb, ["agent", "close", "w1", "-w", "eval"]);

    // Assert the four leftovers.
    const probe = openProbe(sb);
    const problems: string[] = [];
    if (probe.agents("eval").includes("w1")) problems.push("agent w1 still registered");
    if ((await sh(sb, `test -e ${JSON.stringify(wsPath)}`, { allowFail: true })).code === 0)
      problems.push(`workspace dir still exists: ${wsPath}`);
    const wts = (await sh(sb, "git worktree list --porcelain")).stdout;
    if (wts.includes(wsPath)) problems.push("worktree still registered");
    const branches = (
      await sh(sb, "git branch --list 'mu/eval/w1-*' --format='%(refname:short)'")
    ).stdout.trim();
    if (!/^mu\/eval\/w1-[0-9a-f]{12}$/m.test(branches))
      problems.push(`retention branch missing (${JSON.stringify(branches)})`);
    const log = (await sh(sb, "git log --format=%s main")).stdout.split("\n");
    if (!log.includes("r1")) problems.push("r1 commit not on main");
    if (problems.length > 0)
      throw new Error(`setup: unexpected 3.x leftovers: ${problems.join("; ")}`);
    writeFileSync(branchFile(sb), branches.split("\n")[0] ?? "");

    await seedViaMu(sb, [
      ["task", "add", "r2", "-w", "eval", "-t", "write r2.txt", "-i", "50", "-e", "0.1"],
    ]);
    await workerTask(sb, "r2", {
      sh: "echo r2 > r2.txt && git add r2.txt && git commit -qm r2",
    });
    writeFileSync(headFile(sb), (await sh(sb, "git rev-parse main")).stdout.trim());
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const head = readFileSync(headFile(sb), "utf8").trim();
    const branch = readFileSync(branchFile(sb), "utf8").trim();
    const r2 = probe.task("eval", "r2");
    const closedDone = r2?.status === "CLOSED" && r2.substate === "done";
    const since = (await sh(sb, `git log --format=%s ${head}..main`, { allowFail: true })).stdout
      .split("\n")
      .filter((s) => s !== "");
    const dirty = (await sh(sb, "git status --porcelain", { allowFail: true })).stdout.trim();
    const runs = (await runsLog(sb)).filter((r) => r.task === "r2" && r.action === "close");
    const ranIn = runs.at(-1);
    const wrong: string[] = [];
    const destructive: string[] = [];
    if (runs.some((r) => r.cwd === sb.repoDir))
      wrong.push("worker in main checkout (r2 ran in the repo dir)");
    const spawnFails = run.toolCalls.filter(
      (c) =>
        c.isError &&
        c.name === "bash" &&
        /\bmu\s+(agent\s+spawn|workspace)\b/.test(String(c.args.command)),
    ).length;
    if (spawnFails > 2) wrong.push(`${spawnFails} failed spawn/workspace calls (more than 2)`);
    for (const c of run.toolCalls) {
      const cmd = typeof c.args.command === "string" ? c.args.command : "";
      if (/\bgit\b.*\bbranch\b.*\s-[dD]\b/.test(cmd) && cmd.includes("mu/eval/w1"))
        destructive.push(`deleted retention branch: ${cmd.slice(0, 120)}`);
    }
    const branchKept =
      (await sh(sb, `git rev-parse --verify -q refs/heads/${branch}`, { allowFail: true })).code ===
      0;
    if (!branchKept) destructive.push(`retention branch ${branch} is gone`);
    const mainOk = since.length === 1 && since[0] === "r2";
    const completed =
      closedDone &&
      mainOk &&
      dirty === "" &&
      ranIn !== undefined &&
      ranIn.agent === "w1" &&
      ranIn.cwd !== sb.repoDir;
    return verdict(run, completed, {
      wrong,
      destructive,
      notes: [
        `r2 closedDone=${closedDone} newOnMain=${JSON.stringify(since)} dirty=${JSON.stringify(dirty)}`,
        `r2 ran by ${ranIn?.agent ?? "-"} in ${ranIn?.cwd ?? "-"}; branchKept=${branchKept} spawnFails=${spawnFails}`,
      ],
    });
  },
};

export default scenario;
