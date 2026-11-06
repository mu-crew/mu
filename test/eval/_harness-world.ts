// Synthetic end states for the hook-harness case judges (tools/eval/scenarios/e*_*.ts), so every
// judge's pass criterion is pinned at zero cost and without tmux: a git repo with the workers'
// commits, a DB with the ops a run leaves, runs.log, the observer's hooks.log, the main-commit log
// and the AUT's mu-call record. Times are offsets (ms) from the moment the world is built; a test
// moves one event across another to make a bad world.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueCheck, recordCheckVerdict } from "../../src/checks.ts";
import { type Db, openDb } from "../../src/db.ts";
import { addTask, closeTask } from "../../src/tasks.ts";
import { ensureWorkstream } from "../../src/workstream.ts";
import type { HookRec } from "../../tools/eval/harness-observe.ts";
import type { Sandbox } from "../../tools/eval/types.ts";

export interface WorkerSpec {
  agent: string;
  harness: string;
  task: string;
  host?: string;
  /** The worker's commit is cherry-picked onto main (default true), at this offset in the main-commit log. */
  merged?: boolean;
  mergeAt?: number;
  /** When it reported (runs.log, its stop event); default -20000. */
  reportAt?: number;
  /** An agent.close op for it (default true). */
  closed?: boolean;
  /** Its prompts (hooks.log), oldest first, as [offset, text]; default one brief at reportAt - 5000. */
  prompts?: [number, string][];
  /** Extra hook events of it: [offset, kind]. */
  events?: [number, HookRec["kind"]][];
  /** The cli its spawn op names (default its harness). */
  cli?: string;
  /** The task's close op: by this actor and intent at this offset (default the worker, close.apply, reportAt + 1000); null: not closed. */
  close?: { actor: string; intent: "task.close" | "close.apply"; at: number } | null;
}

export interface WorldSpec {
  tasks: string[];
  workers: WorkerSpec[];
  /** The AUT's harness and model (EVAL_AUT_HARNESS / EVAL_AUT_MODEL). */
  aut?: { harness: string; model: string };
  /** Commits the AUT made on main itself: subjects. */
  autCommits?: string[];
  /** Extra closes: [task, actor, intent, offset]. */
  closes?: [string, string, "task.close" | "close.apply", number][];
  /** Notes as ops: [task, content, offset]. */
  notes?: [string, string, number][];
  /** Checks: issued now; the verdict recorded now (op time) when given. */
  checks?: { task: string; by: string; verdict?: string }[];
  /** Extra claim ops: [task, owner id, offset]. */
  claims?: [string, number, number][];
  /** AUT mu calls: [start offset, argv]. */
  autCalls?: [number, string][];
  /** Remote working copies left on the host: agent names. */
  remoteLeft?: string[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function makeHarnessWorld(spec: WorldSpec): Sandbox {
  const now = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "harness-world-"));
  const repoDir = join(dir, "repo");
  const workerDir = join(dir, "workers");
  mkdirSync(join(workerDir, "mu-out"), { recursive: true });
  mkdirSync(repoDir);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "eval",
    GIT_AUTHOR_EMAIL: "eval@example.invalid",
    GIT_COMMITTER_NAME: "eval",
    GIT_COMMITTER_EMAIL: "eval@example.invalid",
  } as Record<string, string>;
  const git = (args: string[], env: Record<string, string> = gitEnv): string =>
    execFileSync("git", args, { cwd: repoDir, env, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  const head = git(["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "setup-head"), head);

  const dbPath = join(dir, "mu.db");
  const db: Db = openDb({ path: dbPath });
  let hlc = 0;
  const op = (o: {
    actor: string | null;
    intent: string;
    entity: string;
    key: string;
    payload: string;
    at: number;
  }) =>
    db
      .prepare(
        "INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at) VALUES (?, 'm', 'g', ?, ?, ?, ?, 'put', ?, ?)",
      )
      .run(`w${++hlc}`, o.actor, o.intent, o.entity, o.key, o.payload, iso(now + o.at));
  ensureWorkstream(db, "eval");
  for (const t of spec.tasks) addTask(db, { localId: t, workstream: "eval", title: t });
  // A close through the SDK (its trigger wants evidence), then its ops moved to the world's time,
  // actor and intent: what a worker's applied CLOSE block or an AUT's `mu task close` leaves.
  const close = (task: string, actor: string, intent: string, at: number): void => {
    const before = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM ops").get() as { n: number })
      .n;
    closeTask(db, task, { workstream: "eval", author: actor, evidence: "world" });
    db.prepare("UPDATE ops SET created_at = ?, actor = ?, intent = ? WHERE seq > ?").run(
      iso(now + at),
      actor,
      intent,
      before,
    );
  };

  const runs: string[] = [];
  const hooks: string[] = [];
  const mainLog: string[] = [];
  const hookLine = (w: WorkerSpec, at: number, kind: HookRec["kind"], text: string | null) => {
    const rec: HookRec = {
      ms: now + at,
      harness: w.harness,
      event: kind,
      kind,
      agent: w.agent,
      host: w.host ?? null,
      cwd: "/w",
      session: `s-${w.agent}`,
      turn: null,
      text,
      resumed: false,
    };
    hooks.push(JSON.stringify(rec));
  };
  let pane = 1;
  for (const w of spec.workers) {
    const reportAt = w.reportAt ?? -20000;
    op({
      actor: "aut",
      intent: "agent.spawn",
      entity: "agent",
      key: "eval",
      payload: `agent spawn ${w.agent} (cli=${w.cli ?? w.harness}, role=full-access, pane=%${++pane}, ctl=skipped)`,
      at: reportAt - 10000,
    });
    op({
      actor: w.agent,
      intent: "task.claim",
      entity: "task",
      key: `eval/${w.task}`,
      payload: `{"status":"IN_PROGRESS","owner_id":${pane}}`,
      at: reportAt - 9000,
    });
    // the worker's commit on its own branch, as <agent>@worker.eval.invalid
    git(["checkout", "-q", "-b", `wk-${w.agent}`, head]);
    writeFileSync(join(repoDir, `${w.task}.txt`), `${w.task}\n`);
    git(["add", `${w.task}.txt`]);
    git(["commit", "-q", "-m", w.task], {
      ...gitEnv,
      GIT_AUTHOR_NAME: w.agent,
      GIT_AUTHOR_EMAIL: `${w.agent}@worker.eval.invalid`,
    });
    const sha = git(["rev-parse", "HEAD"]);
    const pid = execFileSync(
      "sh",
      ["-c", `git show --format= ${sha} | git patch-id --stable | cut -d' ' -f1`],
      {
        cwd: repoDir,
        encoding: "utf8",
      },
    ).trim();
    git(["checkout", "-q", "main"]);
    if (w.merged !== false) {
      git(["cherry-pick", sha]);
      mainLog.push(`${now + (w.mergeAt ?? reportAt + 2000)} main ${w.task}`);
    }
    const cwd =
      w.host === undefined
        ? join(dir, "state", "worktrees", "eval", w.agent)
        : join(
            dir,
            "hosts",
            w.host,
            "home",
            ".local",
            "state",
            "mu-next",
            "remote-worktrees",
            "eval",
            w.agent,
          );
    runs.push(`${now + reportAt} ${w.agent} ${w.task} block ${sha} ${pid} ${cwd}`);
    if (w.harness !== "pi") {
      hookLine(w, reportAt - 8000, "session_start", null);
      for (const [at, text] of w.prompts ?? [
        [reportAt - 5000, `Read your task brief and follow it (${w.task}).`],
      ])
        hookLine(w, at, "prompt", text);
      for (const [at, kind] of w.events ?? []) hookLine(w, at, kind, null);
      hookLine(
        w,
        reportAt + 50,
        "stop",
        `CLOSE: task=${w.task} evidence="eval"\nREPORT:\n${w.task}.sh exit 0`,
      );
    }
    const c =
      w.close === undefined
        ? { actor: w.agent, intent: "close.apply" as const, at: reportAt + 1000 }
        : w.close;
    if (c !== null) close(w.task, c.actor, c.intent, c.at);
    if (w.closed !== false)
      op({
        actor: "system",
        intent: "agent.close",
        entity: "agent",
        key: "eval",
        payload: `agent close ${w.agent} (pane=%${pane}, worktree removed)`,
        at: -1000,
      });
  }
  for (const s of spec.autCommits ?? []) {
    writeFileSync(join(repoDir, `${s}.txt`), `${s}\n`);
    git(["add", `${s}.txt`]);
    git(["commit", "-q", "-m", s]);
    mainLog.push(`${now - 15000} main ${s}`);
  }
  for (const [task, actor, intent, at] of spec.closes ?? []) close(task, actor, intent, at);
  let note = 100;
  for (const [task, content, at] of spec.notes ?? [])
    op({
      actor: "w",
      intent: "close.apply",
      entity: "note",
      key: `eval/${task}#${++note}`,
      payload: JSON.stringify({ author: "w", content, kind: "report" }),
      at,
    });
  for (const [task, owner, at] of spec.claims ?? [])
    op({
      actor: "aut",
      intent: "task.claim",
      entity: "task",
      key: `eval/${task}`,
      payload: `{"owner_id":${owner}}`,
      at,
    });
  for (const c of spec.checks ?? []) {
    const row = issueCheck(db, c.task, {
      workstream: "eval",
      by: c.by,
      brief: "check it",
      author: "aut",
    });
    if (c.verdict !== undefined)
      recordCheckVerdict(db, c.task, {
        workstream: "eval",
        check: row.id,
        verdict: c.verdict,
        author: "aut",
      });
  }
  db.close();
  for (const a of spec.remoteLeft ?? [])
    mkdirSync(
      join(
        dir,
        "hosts",
        "dev",
        "home",
        ".local",
        "state",
        "mu-next",
        "remote-worktrees",
        "eval",
        a,
      ),
      {
        recursive: true,
      },
    );
  mkdirSync(join(dir, "hosts", "dev", "home", "repo"), { recursive: true });
  writeFileSync(join(workerDir, "runs.log"), runs.length ? `${runs.join("\n")}\n` : "");
  writeFileSync(join(workerDir, "hooks.log"), hooks.length ? `${hooks.join("\n")}\n` : "");
  writeFileSync(join(dir, "main-commits.log"), mainLog.length ? `${mainLog.join("\n")}\n` : "");
  writeFileSync(
    join(workerDir, "mu-calls.log"),
    (spec.autCalls ?? [])
      .map(([at, argv], i) => `${now + at} ${now + at + 200} 0 - ${9000 + i} ${argv}\n`)
      .join(""),
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    EVAL_AUT_HARNESS: spec.aut?.harness ?? "claude",
    EVAL_AUT_MODEL: spec.aut?.model ?? "default",
  };
  return { dir, env, workerDir, repoDir, dbPath, tmuxSocket: "x" } as unknown as Sandbox;
}
