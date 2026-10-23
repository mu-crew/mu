// Fan-out with gates: three fixes (f1-f3), each with a review task (r1-r3), all in parallel.
//
// Who did what: 3.x claim ops carry no owner names in their payload (status/substate/updated_at
// only), and CLAIM notes exist only with --evidence. So "who did f<n> / r<n>" is the agent in
// runsLog(sb) with task <id> and action "close" (works on any surface). ops.actor on intent
// 'task.claim', key 'eval/<id>' is the claimer; it is read privately below as a cross-check and
// reported in notes only.
//
// Review-before-merge: r<n>.sh checks f<n>'s commit wherever it lives (rev-list --all includes
// other worktrees' HEADs), not main, so a correct review that precedes the merge passes.
import Database from "better-sqlite3";
import {
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
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

/**
 * Unix seconds at which main first contained a commit with this subject, from main's reflog.
 * Not the commit's %ct: a fast-forward keeps the worker's original commit time, while a
 * cherry-pick stamps the merge time. The reflog gives the merge moment either way.
 */
async function mergeTime(sb: Sandbox, subject: string): Promise<number | null> {
  const rl = await sh(sb, "git reflog show --date=unix main --format='%H %gd'", {
    allowFail: true,
  });
  // newest first; walk oldest to newest and stop at the first state of main that has the subject
  for (const l of rl.stdout.split("\n").filter(Boolean).reverse()) {
    const [h, gd] = l.split(" ");
    if (!h) continue;
    const at = Number(/@\{(\d+)\}/.exec(gd ?? "")?.[1]);
    const r = await sh(sb, `git log --format=%s --grep='^${subject}$' -n1 ${h}`, {
      allowFail: true,
    });
    if (r.stdout.trim() === subject) return at;
  }
  return null;
}

const scenario: Scenario = {
  id: "fanout_gates",
  title: "three fixes, each reviewed by a different agent, merged after review",
  prompt:
    "Workstream eval has three fixes (f1-f3), each with a review task (r1-r3). Run them with workers in parallel, have each fix reviewed by a different agent, merge accepted commits into main in the repo you are in, and make ./gate.sh pass on main. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "a.txt": "a", "b.txt": "b", "c.txt": "c" });
    await gateScript(sb);
    await writeWorkerDriver(sb, "3x");
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
    for (const id of ["f1", "f2", "f3", "r1", "r2", "r3"]) {
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
    let mainOk = true;
    for (const n of N) {
      const c = commits.filter((x) => x.subject === `f${n}`);
      if (c.length !== 1) mainOk = false;
    }
    const clone = `${sb.dir}/gate-clone`;
    await sh(sb, `rm -rf '${clone}' && git clone -q -b main '${sb.repoDir}' '${clone}'`, {
      allowFail: true,
    });
    const gate = await sh(sb, "./gate.sh", { cwd: clone, allowFail: true });
    const gateOk = gate.code === 0;

    const runs = await runsLog(sb);
    const closer = (id: string): string | undefined =>
      runs.find((r) => r.task === id && r.action === "close")?.agent;
    for (const n of N) {
      const fc = ops(sb, `eval/f${n}`, "task.close")[0];
      const rc = ops(sb, `eval/r${n}`, "task.close")[0];
      if (fc && rc) {
        if (rc.seq < fc.seq) wrong.push(`r${n} closed before f${n} closed`);
        const reviewedAt = Math.floor(Date.parse(rc.at) / 1000);
        const mergedAt = await mergeTime(sb, `f${n}`);
        if (mergedAt !== null && mergedAt < reviewedAt)
          wrong.push(`f${n} merged into main before r${n} was closed (review)`);
      }
      const fa = closer(`f${n}`);
      const ra = closer(`r${n}`);
      if (fa && ra && fa === ra) wrong.push(`same agent ${fa} did f${n} and reviewed it (r${n})`);
      const claimers = ["f", "r"].map(
        (p) =>
          `${p}${n}:${ops(sb, `eval/${p}${n}`, "task.claim")
            .map((o) => o.actor)
            .join("|")}`,
      );
      notes.push(`closers f${n}=${fa} r${n}=${ra}; claim actors ${claimers.join(" ")}`);
    }
    notes.push(`allClosed=${allClosed} mainOk=${mainOk} gateOk=${gateOk}`);
    return verdict(run, allClosed && mainOk && gateOk, { wrong, notes });
  },
};

export default scenario;
