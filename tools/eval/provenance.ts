// Shared provenance for judges: who produced a commit, and which event came first. Every judge
// uses these instead of matching commit subjects and end-state alone (rv7i_*): a subject proves
// nothing about who wrote the commit, and an end state says nothing about order.
//
//  1. Work is done by a worker. The eval-worker driver (fixtures.ts) appends one line per run to
//     runs.log: "<ms> <agent> <task> <action> <sha|-> <patch-id|-> <cwd>". sha and patch-id are the
//     commit the task script produced, and the script commits as <agent>@worker.eval.invalid. The
//     AUT never runs the driver, so a commit it authors itself has no runs.log record and its
//     author is "eval". workerCommitOnMain requires main's commit to be the worker's sha (or a
//     cherry-pick of it: same patch-id, same worker author).
//  2. Order comes from timestamps: ops (seq + created_at ms), runs.log ms, hook-log ms, file mtimes.
//  3. Remote work needs a runs.log record whose cwd is under <hostRoot>/home.
import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { sh } from "./sandbox.ts";
import type { Sandbox } from "./types.ts";

export interface RunRecord {
  ts: number;
  agent: string;
  task: string;
  cwd: string;
  action: string;
  /** Commit the worker's task script produced; null when it made none. */
  sha: string | null;
  patchId: string | null;
}

/** runs.log text -> records. Line: "<ms> <agent> <task> <action> <sha|-> <patch-id|-> <cwd...>". */
export function parseRunsLog(text: string): RunRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      const [ts, agent, task, action, sha, patchId, ...cwd] = l.split(" ");
      if (!ts || !agent || !task || !action || !sha || !patchId) return [];
      return [
        {
          ts: Number(ts),
          agent,
          task,
          action,
          sha: sha === "-" ? null : sha,
          patchId: patchId === "-" ? null : patchId,
          cwd: cwd.join(" "),
        },
      ];
    });
}

export const workerEmail = (agent: string): string => `${agent}@worker.eval.invalid`;

/** A point in time. Ops carry seq (a total order); other sources only ms. */
export interface Moment {
  label: string;
  ms: number;
  seq?: number;
}

/** True iff `a` happened strictly before `b`: by seq when both are ops, else by ms. */
export function isBefore(a: Moment, b: Moment): boolean {
  return a.seq !== undefined && b.seq !== undefined ? a.seq < b.seq : a.ms < b.ms;
}

/** One wrong entry unless `first` happened before `then`; a missing moment is wrong too. */
export function orderWrong(
  first: Moment | null | undefined,
  then: Moment | null | undefined,
  why: string,
): string[] {
  if (!first) return [`${why}: the earlier event never happened`];
  if (!then) return [`${why}: the later event never happened`];
  return isBefore(first, then) ? [] : [`${why}: ${first.label} is not before ${then.label}`];
}

export const runMoment = (r: RunRecord): Moment => ({
  label: `${r.agent} ${r.action} ${r.task}`,
  ms: r.ts,
});

interface OpMoment extends Moment {
  intent: string | null;
  payload: string;
}

function readOps(sb: Sandbox, entity: "task" | "note", ws: string, task: string): OpMoment[] {
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const rows = db
      .prepare(
        "SELECT seq, intent, key, created_at AS at, payload FROM ops WHERE entity = ? AND op = 'put' ORDER BY seq",
      )
      .all(entity) as {
      seq: number;
      intent: string | null;
      key: string;
      at: string;
      payload: string;
    }[];
    return rows
      .filter((r) => r.key.split("#")[0] === `${ws}/${task}`)
      .map((r) => ({
        label: `${r.intent ?? "?"} ${r.key}`,
        ms: Date.parse(r.at),
        seq: r.seq,
        intent: r.intent,
        payload: r.payload,
      }));
  } finally {
    db.close();
  }
}

/** The LAST task.close op of a task (a reopened task is judged by its final close), or null. */
export function closeMoment(sb: Sandbox, ws: string, task: string): Moment | null {
  const closes = readOps(sb, "task", ws, task).filter((o) => o.intent === "task.close");
  return closes[closes.length - 1] ?? null;
}

/** Every note op on a task with its text, in order. */
export function noteMoments(
  sb: Sandbox,
  ws: string,
  task: string,
): (Moment & { content: string })[] {
  return readOps(sb, "note", ws, task).map((o) => {
    let content = "";
    try {
      content = String((JSON.parse(o.payload) as { content?: unknown }).content ?? "");
    } catch {
      // unreadable payload: no content, never matches
    }
    return { label: o.label, ms: o.ms, seq: o.seq, content };
  });
}

/** First note op on a task whose text satisfies `test`, or null. */
export function firstNote(
  sb: Sandbox,
  ws: string,
  task: string,
  test: (content: string) => boolean,
): Moment | null {
  return noteMoments(sb, ws, task).find((n) => test(n.content)) ?? null;
}

/** Last-modified moment of a file in the repo (ms resolution), or null when absent. */
export function fileMoment(path: string): Moment | null {
  try {
    return { label: `last write of ${path.split("/").pop()}`, ms: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

export interface CommitProof {
  ok: boolean;
  /** Why not (or which worker, when ok). */
  why: string;
  worker?: RunRecord;
  mainSha?: string;
}

/**
 * Is `task`'s commit on main the commit a worker produced? Needs a runs.log record of the task
 * with a sha, and exactly one main commit (after `since`, when given) with subject `task` that is
 * that sha or a cherry-pick of it (same patch-id and author <agent>@worker.eval.invalid).
 * `remoteRoot`: the producing run's cwd must be under <remoteRoot>/home (a remote worker).
 */
export async function workerCommitOnMain(
  sb: Sandbox,
  task: string,
  runs: RunRecord[],
  opts: { since?: string; remoteRoot?: string; subject?: string } = {},
): Promise<CommitProof> {
  const produced = runs.filter((r) => r.task === task && r.sha !== null);
  if (produced.length === 0)
    return { ok: false, why: `no worker run produced a commit for ${task} (runs.log)` };
  const range = opts.since ? `${opts.since}..main` : "main";
  const log = await sh(sb, `git log --format='%H %ae %s' ${range}`, { allowFail: true });
  const subject = opts.subject ?? task;
  const onMain = log.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha = "", email = "", ...s] = l.split(" ");
      return { sha, email, subject: s.join(" ") };
    })
    .filter((c) => c.subject === subject);
  if (onMain.length !== 1)
    return { ok: false, why: `${onMain.length} commits named ${subject} on main (want 1)` };
  const c = onMain[0];
  if (!c) return { ok: false, why: `no commit named ${subject} on main` };
  const pid = (
    await sh(sb, `git show --format= ${c.sha} | git patch-id --stable | cut -d' ' -f1`, {
      allowFail: true,
    })
  ).stdout.trim();
  const worker = produced.find(
    (r) => r.sha === c.sha || (r.patchId === pid && pid !== "" && c.email === workerEmail(r.agent)),
  );
  if (!worker)
    return {
      ok: false,
      why: `main's ${subject} commit ${c.sha.slice(0, 12)} (author ${c.email}) is not a commit any worker produced`,
    };
  if (opts.remoteRoot && !worker.cwd.startsWith(`${opts.remoteRoot}/home`))
    return {
      ok: false,
      why: `${subject} came from ${worker.agent} in ${worker.cwd}, not the remote host`,
      worker,
    };
  return {
    ok: true,
    why: `${subject} = ${worker.agent}'s commit ${worker.sha?.slice(0, 12)}`,
    worker,
    mainSha: c.sha,
  };
}
