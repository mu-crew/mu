// Shared setup and judge rules of the hook-harness cases E1-E7 (scenarios/e*_*.ts; spec "Every
// harness first-class", U24). A worker's job is deterministic and cheap on every harness: its task
// says to run `eval-worker` and reply with the output, which commits the task's file as the
// worker (provenance.ts) and prints the CLOSE block. What a case measures is the orchestrator and
// mu's harness integration, real or fake, never a worker's coding.
//
// Judges read effects only: the ops log and DB (who claimed, closed, checked; which cli an agent
// was spawned with), runs.log (where the work ran and which commit it made), the observer's
// hooks.log (which harness reported for an agent, its prompts, stops and interrupts), git, and the
// main-commit log below. None of them reads a fake harness's own logs, so a judge holds live.
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeRepo, runsLog, seedViaMu, workerTask, writeWorkerDriver } from "./fixtures.ts";
import { type HookRec, harnessFamily, harnessOf, modelFamily } from "./harness-observe.ts";
import { CLOSE_INTENTS, closedAgents } from "./observe.ts";
import { opsAfter } from "./ops.ts";
import { type RunRecord, workerCommitOnMain } from "./provenance.ts";
import { sh } from "./sandbox.ts";
import type { Sandbox } from "./types.ts";

export const WS = "eval";

/** A worker task's title: the job every harness does the same way. */
export const workTitle = (id: string): string =>
  `${id}: run eval-worker in your working directory and reply with its output verbatim`;

/**
 * The script eval-worker runs for a task: one file, committed as the worker. The pause keeps a
 * fake worker's report a few seconds after its prompt, as a real one's is, so an AUT that acts
 * before the report is seen to.
 */
export const commitScript = (id: string): string =>
  `sleep 3; echo ${id} >> ${id}.txt && git add ${id}.txt && git commit -qm ${id}`;

export interface CaseTask {
  id: string;
  /** Default: workTitle(id). */
  title?: string;
  /** What eval-worker runs; default commitScript(id). null: nothing (a task no worker runs). */
  sh?: string | null;
  /** Tasks that block this one (an umbrella's). */
  blockedBy?: string[];
}

const mainLog = (sb: Sandbox): string => join(sb.dir, "main-commits.log");

/** Repo hooks: "<ms> <branch> <subject>" for every commit and merge, so a judge orders a merge. */
function installMainLog(sb: Sandbox): void {
  const body = (cmd: string): string =>
    [
      "#!/bin/sh",
      `ms() { t=$(date +%s%3N); case "$t" in *[!0-9]*) perl -MTime::HiRes=time -e 'printf("%d\\n", time()*1000)' ;; *) echo "$t" ;; esac; }`,
      "b=$(git rev-parse --abbrev-ref HEAD)",
      `${cmd} | while IFS= read -r s; do echo "$(ms) $b $s" >> '${mainLog(sb)}'; done`,
      "",
    ].join("\n");
  for (const [name, cmd] of [
    ["post-commit", "git log -n1 --format=%s"],
    ["post-merge", "git log --format=%s ORIG_HEAD..HEAD"],
  ] as const) {
    const f = join(sb.repoDir, ".git", "hooks", name);
    writeFileSync(f, body(cmd));
    chmodSync(f, 0o755);
  }
}

/** When a commit with this subject first landed on main (the main-commit log), else null. */
export function mainCommitMs(sb: Sandbox, subject: string): number | null {
  if (!existsSync(mainLog(sb))) return null;
  for (const l of readFileSync(mainLog(sb), "utf8").split("\n")) {
    const m = /^(\d+) (\S+) (.*)$/.exec(l);
    if (m && m[2] === "main" && m[3] === subject) return Number(m[1]);
  }
  return null;
}

/** The repo, the worker driver (CLOSE block mode on next), workstream eval and its tasks. */
export async function seedCase(
  sb: Sandbox,
  tasks: CaseTask[],
  extra: string[][] = [],
): Promise<void> {
  await makeRepo(sb, { "notes.txt": "start\n" });
  await writeWorkerDriver(sb);
  installMainLog(sb);
  await seedViaMu(sb, [
    ["workstream", "init", WS],
    ...tasks.map((t) => [
      "task",
      "add",
      t.id,
      "-w",
      WS,
      "-t",
      t.title ?? workTitle(t.id),
      "-i",
      "50",
      "-e",
      "0.1",
      ...(t.blockedBy ?? []).flatMap((b) => ["-b", b]),
    ]),
    ...extra,
  ]);
  for (const t of tasks) {
    if (t.sh === null) continue;
    await workerTask(sb, t.id, { sh: t.sh ?? commitScript(t.id) });
  }
  writeFileSync(join(sb.dir, "setup-head"), (await sh(sb, "git rev-parse HEAD")).stdout.trim());
}

export function setupHead(sb: Sandbox): string {
  const f = join(sb.dir, "setup-head");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

export interface SpawnRec {
  name: string;
  cli: string;
  host: string | null;
  ms: number;
}

/** Every agent spawn in the ops log: the name and the cli it was spawned with (`agent.spawn`). */
export function spawns(sb: Sandbox): SpawnRec[] {
  return opsAfter(sb, 0)
    .filter((o) => o.intent === "agent.spawn")
    .flatMap((o) => {
      const m = /agent spawn (\S+) \(([^)]*)\)/.exec(o.payload);
      if (!m?.[1]) return [];
      const kv = new Map(
        (m[2] ?? "").split(/,\s*/).map((p) => p.split("=") as [string, string | undefined]),
      );
      return [{ name: m[1], cli: kv.get("cli") ?? "", host: kv.get("host") ?? null, ms: o.ms }];
    });
}

/** The harness of a spawned cli key: `claude-big` is claude (D17, harness from key). */
export const cliHarness = (cli: string): string =>
  ["claude", "codex", "cursor-agent", "muse", "pi"].find(
    (h) => cli === h || cli.startsWith(`${h}-`) || cli.startsWith(`${h}_`),
  ) ?? cli;

export interface Want {
  harness: string;
  /** The eval ssh host the worker must run on; absent: this machine. */
  host?: string;
}

export interface TaskProof {
  ok: boolean;
  wrong: string[];
  note: string;
  agent: string | null;
}

/**
 * The written pass rule for one worker task, shared by every case:
 *  1. main holds exactly one commit named after the task, and it is the commit a worker produced
 *     (or a cherry-pick of it) after setup;
 *  2. that worker ran on the requested host (runs.log cwd under <hostRoot>/home) or locally;
 *  3. it ran the requested harness: spawned with that cli (ops), and for a hook harness its own
 *     hooks reported as that harness (hooks.log); a pi worker reports through ctl, never hooks;
 *  4. the task was closed by its worker's CLOSE block or after its first report, never before.
 */
export async function taskProof(
  sb: Sandbox,
  task: string,
  want: Want,
  runs: RunRecord[],
  recs: HookRec[],
): Promise<TaskProof> {
  const wrong: string[] = [];
  const proof = await workerCommitOnMain(sb, task, runs, { since: setupHead(sb) || undefined });
  if (!proof.ok) wrong.push(proof.why);
  const agent = proof.worker?.agent ?? null;
  if (proof.worker) {
    const cwd = proof.worker.cwd;
    if (want.host === undefined && under(cwd, join(sb.dir, "hosts")))
      wrong.push(`${task} ran on a remote host (${cwd}), not here`);
    if (want.host !== undefined && !under(cwd, join(sb.dir, "hosts", want.host, "home")))
      wrong.push(`${task} came from ${proof.worker.agent} in ${cwd}, not the host ${want.host}`);
  }
  if (agent !== null) {
    const sp = spawns(sb).filter((s) => s.name === agent);
    const cli = sp[sp.length - 1]?.cli;
    if (cli === undefined) wrong.push(`${task}: no spawn of ${agent} in the ops log`);
    else if (cliHarness(cli) !== want.harness)
      wrong.push(`${task} ran on ${agent}, spawned as ${cli}, not ${want.harness}`);
    const reported = harnessOf(recs, agent);
    if (want.harness === "pi") {
      if (reported !== null)
        wrong.push(`${task}: pi worker ${agent} reported through ${reported} hooks`);
    } else if (reported !== want.harness)
      wrong.push(
        `${task}: ${agent}'s hooks reported as ${reported ?? "nothing"}, not ${want.harness}`,
      );
    if (want.host !== undefined && want.harness !== "pi") {
      const hosted = recs.some((r) => r.agent === agent && r.host === want.host);
      if (!hosted) wrong.push(`${task}: no hook of ${agent} fired on ${want.host}`);
    }
  }
  wrong.push(...closeAfterReportWrong(sb, task, runs));
  return {
    ok: proof.ok && wrong.length === 0,
    wrong,
    note: `${task}: ${proof.why}`,
    agent,
  };
}

/**
 * A task may be closed only after its worker's first report (its CLOSE block, or its own close),
 * and never before it, even when a later close follows: mu re-applies a CLOSE block to a task the
 * AUT already closed, and a worker nudged by mu's Stop hook reports twice, so neither the last
 * close nor the last report alone tells the order.
 */
export function closeAfterReportWrong(sb: Sandbox, task: string, runs: RunRecord[]): string[] {
  const first = opsAfter(sb, 0).find(
    (o) =>
      CLOSE_INTENTS.includes(o.intent ?? "") && o.entity === "task" && o.key === `${WS}/${task}`,
  );
  if (first === undefined) return [];
  const out: string[] = [];
  const under = runs.find((r) => r.task === task && r.action === "already-closed");
  if (under) out.push(`${task} was closed under ${under.agent} before it ran (already-closed)`);
  const report = runs.find((r) => r.task === task && REPORT_ACTIONS.includes(r.action));
  if (report === undefined) out.push(`${task} was closed but no worker ran it to completion`);
  else if (first.ms + 5 < report.ts)
    out.push(
      `${task} was first closed (${first.intent} by ${first.actor ?? "?"}) before its worker reported`,
    );
  return out;
}

const REPORT_ACTIONS = ["block", "close", "done"];

/** `path` is `root` or inside it, comparing real paths too (macOS: /tmp is /private/tmp). */
export function under(path: string, root: string): boolean {
  const forms = (p: string): string[] => {
    try {
      return [p, realpathSync(p)];
    } catch {
      return [p, p.replace(/^\/private(?=\/)/, "")];
    }
  };
  const ps = [path, path.replace(/^\/private(?=\/)/, "")];
  return forms(root).some((r) => ps.some((p) => p === r || p.startsWith(`${r}/`)));
}

/** Wrong entries for workers left running: every one must have been closed (agent.close ops). */
export function workersClosedWrong(sb: Sandbox, agents: (string | null)[]): string[] {
  const closed = new Set(closedAgents(sb).map((a) => a.name));
  return agents
    .filter((a): a is string => a !== null && !closed.has(a))
    .map((a) => `worker ${a} was not closed`);
}

/** Wrong entries for remote working copies left on the eval host (mu's remote worktrees). */
export async function remoteLeftovers(
  sb: Sandbox,
  host: string,
  runs: RunRecord[],
): Promise<string[]> {
  const root = join(sb.dir, "hosts", host);
  const repo = join(root, "home", "repo");
  const out: string[] = [];
  for (const cwd of new Set(runs.filter((r) => under(r.cwd, root)).map((r) => r.cwd))) {
    if (under(cwd, repo)) continue;
    if (existsSync(cwd)) out.push(`remote working copy not removed: ${cwd}`);
  }
  return out;
}

/** The AUT's model family: its harness's, or for pi its model's. */
export function autFamily(sb: Sandbox): string {
  const h = sb.env.EVAL_AUT_HARNESS ?? "pi";
  const model = sb.env.EVAL_AUT_MODEL ?? "";
  return h === "pi" ? modelFamily(model) : harnessFamily(h, model);
}

export interface CheckRec {
  id: string;
  checker: string;
  verdict: string | null;
  issuedMs: number;
  /** When the verdict was (last) recorded, from its op; null: none. */
  verdictMs: number | null;
}

/** The checks recorded on a task, with when each was issued and answered. */
export function checksOn(sb: Sandbox, task: string): CheckRec[] {
  let rows: { id: string; checker: string; verdict: string | null; created_at: string }[] = [];
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    rows = db
      .prepare(
        `SELECT c.id, c.checker, c.verdict, c.created_at FROM checks c
           JOIN tasks t ON t.id = c.task_id JOIN workstreams w ON w.id = t.workstream_id
          WHERE w.name = ? AND t.local_id = ? ORDER BY c.created_at`,
      )
      .all(WS, task) as typeof rows;
  } catch {
    rows = [];
  } finally {
    db.close();
  }
  const verdictOps = opsAfter(sb, 0).filter((o) => o.intent === "check.verdict");
  return rows.map((r) => {
    const mine = verdictOps.filter((o) => o.key.includes(r.id) || o.payload.includes(r.id));
    const last = mine[mine.length - 1];
    return {
      id: r.id,
      checker: r.checker,
      verdict: r.verdict,
      issuedMs: Date.parse(r.created_at),
      verdictMs: last?.ms ?? null,
    };
  });
}

/** The VERDICT label of a recorded verdict (CONFIRMED, REFUTED, UNVERIFIED), else null. */
export function verdictLabel(text: string | null): string | null {
  // the label word on the VERDICT line, however the AUT words the rest ("VERDICT: f1 REFUTED by
  // codex" is REFUTED): judges assert effects, not spellings
  return (
    /^\s*VERDICT:[^\n]*?\b(CONFIRMED|REFUTED|UNVERIFIED)\b/im
      .exec(text ?? "")?.[1]
      ?.toUpperCase() ?? null
  );
}

/**
 * When a checker answered: its report note (applied from its CLOSE block) or, earlier, the run of
 * its task script in runs.log, which printed the verdict. An orchestrator on the hooks channel may
 * read the answer off the pane and close the task itself later, so the note alone can postdate
 * the verdict it informed.
 */
export function answeredMs(
  runs: RunRecord[],
  task: string,
  noteMs: number | undefined,
): number | undefined {
  const runMs = reportRun(runs, task)?.ts;
  const all = [noteMs, runMs].filter((x): x is number => x !== undefined);
  return all.length === 0 ? undefined : Math.min(...all);
}

/** The finishing run of a task in runs.log (its worker's report), or undefined. */
export function reportRun(runs: RunRecord[], task: string): RunRecord | undefined {
  return [...runs].reverse().find((r) => r.task === task && REPORT_ACTIONS.includes(r.action));
}

export { runsLog };
