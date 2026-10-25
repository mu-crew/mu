// Fan-out with gates: three fixes (f1-f3), each with a review task (r1-r3), all in parallel.
//
// Who did what: 3.x claim ops carry no owner names in their payload (status/substate/updated_at
// only), and CLAIM notes exist only with --evidence. So "who did f<n> / r<n>" is the agent in
// runsLog(sb) with task <id> and action "close" (works on any surface). ops.actor on intent
// 'task.claim', key 'eval/<id>' is the claimer; it is read privately below as a cross-check and
// reported in notes only.
//
// Worker identity is required: every one of the six tasks must have a worker "close" record in
// runsLog (the driver wrote it). A task closed by the AUT directly has none, which is wrong, not
// "unknown but fine"; the same agent may not close f<n> and r<n>.
//
// Order uses ms evidence: ops created_at (ms) for closes, and for main's merge moment a
// post-commit/post-merge hook in the repo that logs "<ms> <branch> <subject>" (git's reflog has
// one-second resolution, so a same-second merge-before-review could not be told apart). Only the
// current attempt counts: the LAST close of f<n> and of r<n>, so a reopened task is judged by its
// final close.
//
// Review-before-merge: r<n>.sh checks f<n>'s commit wherever it lives (rev-list --all includes
// other worktrees' HEADs), not main, so a correct review that precedes the merge passes.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, orderWrong, workerCommitOnMain } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import type { Sandbox, Scenario } from "../types.ts";

const N = [1, 2, 3];
const FILE: Record<number, string> = { 1: "a.txt", 2: "b.txt", 3: "c.txt" };

function ops(
  sb: Sandbox,
  key: string,
  intent: string,
): { seq: number; at: string; actor: string | null }[] {
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return db
      .prepare(
        "SELECT seq, created_at AS at, actor FROM ops WHERE entity = 'task' AND key = ? AND intent = ? ORDER BY seq",
      )
      .all(key, intent) as { seq: number; at: string; actor: string | null }[];
  } finally {
    db.close();
  }
}

const hookLog = (sb: Sandbox): string => `${sb.dir}/main-commits.log`;

/** Repo hooks: log "<ms> <branch> <subject>" for every commit and merged-in commit. */
function installHooks(sb: Sandbox): void {
  const body = (cmd: string): string =>
    `#!/bin/sh\nb=$(git rev-parse --abbrev-ref HEAD)\n${cmd} | while IFS= read -r s; do echo "$(date +%s%3N) $b $s" >> '${hookLog(sb)}'; done\n`;
  for (const [name, cmd] of [
    ["post-commit", "git log -n1 --format=%s"],
    ["post-merge", "git log --format=%s ORIG_HEAD..HEAD"],
  ] as const) {
    const f = `${sb.repoDir}/.git/hooks/${name}`;
    writeFileSync(f, body(cmd));
    chmodSync(f, 0o755);
  }
}

/** Ms timestamp at which a commit with this subject first landed on main (hook log), else null. */
function mergeMs(sb: Sandbox, subject: string): number | null {
  if (!existsSync(hookLog(sb))) return null;
  for (const l of readFileSync(hookLog(sb), "utf8").split("\n")) {
    const m = /^(\d+) (\S+) (.*)$/.exec(l);
    if (m && m[2] === "main" && m[3] === subject) return Number(m[1]);
  }
  return null;
}

const scenario: Scenario = {
  id: "fanout_gates",
  title: "three fixes, each reviewed by a different agent, merged after review",
  prompt:
    "Workstream eval has three fixes (f1-f3), each with a review task (r1-r3), and an umbrella task that stands for all of them. Run them with workers in parallel, have each fix reviewed by a different agent, merge accepted commits into main in the repo you are in, make ./gate.sh pass on main, and close the umbrella task when everything is in. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "a.txt": "a", "b.txt": "b", "c.txt": "c" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    const cmds: string[][] = [["workstream", "init", "eval"]];
    for (const n of N) {
      cmds.push([
        "task",
        "add",
        `f${n}`,
        "-w",
        "eval",
        "-t",
        `add a trailing newline to ${FILE[n]}`,
        "-i",
        "50",
        "-e",
        "0.1",
      ]);
    }
    for (const n of N) {
      cmds.push([
        "task",
        "add",
        `r${n}`,
        "-w",
        "eval",
        "-t",
        `review f${n}`,
        "-i",
        "50",
        "-e",
        "0.1",
        "-b",
        `f${n}`,
      ]);
    }
    cmds.push([
      "task",
      "add",
      "umbrella",
      "-w",
      "eval",
      "-t",
      "all fixes in",
      "-i",
      "50",
      "-e",
      "0.1",
      "-b",
      "f1,f2,f3,r1,r2,r3",
    ]);
    await seedViaMu(sb, cmds);
    installHooks(sb);
    const repo = sb.repoDir;
    for (const n of N) {
      const x = FILE[n];
      await workerTask(sb, `f${n}`, { sh: `printf '\\n' >> ${x} && git commit -qam f${n}` });
      await workerTask(sb, `r${n}`, {
        sh: `sha=$(git -C '${repo}' rev-list --all --grep='^f${n}$' -n1) && test -n "$sha" && test "$(git -C '${repo}' show "$sha:${x}" | tail -c1 | od -An -c | tr -d ' ')" = '\\n'`,
      });
    }
    // The bad script has one worker do all six tasks: give w1 enough scripted turns.
    const turns = [] as object[];
    for (let i = 0; i < 6; i++)
      turns.push({ calls: [{ bash: "eval-worker" }] }, { textFromLastResult: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${sb.workerDir}/w1.json`, JSON.stringify(turns));
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const wrong: string[] = [];
    const notes: string[] = [];
    let allClosed = true;
    for (const id of ["f1", "f2", "f3", "r1", "r2", "r3", "umbrella"]) {
      const t = probe.task("eval", id);
      if (t?.status !== "CLOSED" || t.substate !== "done") allClosed = false;
    }
    const log = await sh(sb, "git log --format='%ct %s' main", { allowFail: true });
    const commits = log.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(" ");
        return { ct: Number(l.slice(0, i)), subject: l.slice(i + 1) };
      });
    const runs = await runsLog(sb);
    // main's f<n> must be the commit a worker produced for f<n> (or its cherry-pick), not a subject match.
    let mainOk = true;
    for (const n of N) {
      const c = commits.filter((x) => x.subject === `f${n}`);
      const proof = await workerCommitOnMain(sb, `f${n}`, runs);
      if (c.length !== 1 || !proof.ok) {
        mainOk = false;
        wrong.push(proof.why);
      }
    }
    const clone = `${sb.dir}/gate-clone`;
    await sh(sb, `rm -rf '${clone}' && git clone -q -b main '${sb.repoDir}' '${clone}'`, {
      allowFail: true,
    });
    const gate = await sh(sb, "./gate.sh", { cwd: clone, allowFail: true });
    const gateOk = gate.code === 0;

    const closer = (id: string): string | undefined =>
      runs.find((r) => r.task === id && ["close", "block"].includes(r.action))?.agent;
    for (const n of N) {
      const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];
      const fc = last(ops(sb, `eval/f${n}`, "task.close"));
      const rc = last(ops(sb, `eval/r${n}`, "task.close"));
      if (fc && rc) {
        if (rc.seq < fc.seq) wrong.push(`r${n} closed before f${n} (final) closed`);
        const reviewedAt = Date.parse(rc.at);
        const mergedAt = mergeMs(sb, `f${n}`);
        if (mergedAt !== null && mergedAt < reviewedAt)
          wrong.push(`f${n} merged into main ${reviewedAt - mergedAt} ms before r${n} was closed`);
      }
      const fa = closer(`f${n}`);
      const ra = closer(`r${n}`);
      if (!fa) wrong.push(`f${n} has no worker execution record (not done by a worker)`);
      if (!ra) wrong.push(`r${n} has no worker execution record (not reviewed by a worker)`);
      if (fa && ra && fa === ra) wrong.push(`same agent ${fa} did f${n} and reviewed it (r${n})`);
      const claimers = ["f", "r"].map(
        (p) =>
          `${p}${n}:${ops(sb, `eval/${p}${n}`, "task.claim")
            .map((o) => o.actor)
            .join("|")}`,
      );
      notes.push(`closers f${n}=${fa} r${n}=${ra}; claim actors ${claimers.join(" ")}`);
    }
    // Umbrella last: after every f/r close and after the moment f1-f3 landed on main.
    const umbrella = closeMoment(sb, "eval", "umbrella");
    const wrongBefore = wrong.length;
    for (const id of ["f1", "f2", "f3", "r1", "r2", "r3"])
      wrong.push(
        ...orderWrong(closeMoment(sb, "eval", id), umbrella, `umbrella must close after ${id}`),
      );
    for (const n of N) {
      const at = mergeMs(sb, `f${n}`);
      wrong.push(
        ...orderWrong(
          at === null ? null : { label: `f${n} merged`, ms: at },
          umbrella,
          `umbrella must close after f${n} was merged`,
        ),
      );
    }
    const ordered = wrong.length === wrongBefore;
    notes.push(`allClosed=${allClosed} mainOk=${mainOk} gateOk=${gateOk}`);
    return await verdictFx(sb, run, allClosed && mainOk && gateOk && ordered, {
      wrong,
      notes,
      // Work must survive any cleanup: a worker commit on no ref and not on main is destructive.
    });
  },
};

export default scenario;
