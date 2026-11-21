// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Synthetic end states for the hook-harness case judges (tools/eval/scenarios/e*_*.ts), so every
// judge's pass criterion is pinned at zero cost and without tmux: a git repo with the workers'
// commits, a DB with the ops a run leaves, runs.log, the observer's hooks.log, the main-commit log
// and the AUT's mu-call record. Times are offsets (ms) from the moment the world is built; a test
// moves one event across another to make a bad world.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /** AUT mu calls: [start offset, argv, exit (default 0)]. */
  autCalls?: [number, string, number?][];
  /** Remote working copies left on the host: agent names. */
  remoteLeft?: string[];
  /** The AUT's own hook record (agent `aut`): its harness's session start and the model it names. */
  autHooks?: { harness: string; model?: string; provider?: string };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The world's repo, built in one `git fast-import` (then a `reset --hard` for the work tree
 * and one patch-id pipe for every worker commit) instead of a git process per step: on an
 * endpoint-security host each start costs 14 ms to 1 s, and these worlds were the fast
 * tier's largest source of git starts. Same end state as the step-by-step build: an empty
 * `init` on main; per worker, its task file committed on `wk-<agent>` off init, authored
 * <agent>@worker.eval.invalid; a merged worker's commit re-made on main (the cherry-pick:
 * same author and message, committer eval); then the AUT's commits on main; main checked out.
 */
function buildRepo(
  repoDir: string,
  spec: WorldSpec,
  now: number,
): { head: string; built: Map<string, { sha: string; pid: string }> } {
  const git = (args: string[], input?: string): string =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8", input }).trim();
  const ident = (name: string, email: string): string =>
    `${name} <${email}> ${Math.floor(now / 1000)} +0000`;
  const evalId = ident("eval", "eval@example.invalid");
  const data = (text: string): string => `data ${Buffer.byteLength(text)}\n${text}\n`;
  const stream: string[] = [];
  let mark = 0;
  const commit = (
    ref: string,
    from: number | undefined,
    author: string,
    msg: string,
    file?: string,
  ): number => {
    stream.push(
      `commit ${ref}\nmark :${++mark}\nauthor ${author}\ncommitter ${evalId}\n${data(`${msg}\n`)}`,
      ...(from === undefined ? [] : [`from :${from}\n`]),
      ...(file === undefined ? [] : [`M 100644 inline ${file}.txt\n${data(`${file}\n`)}`]),
    );
    return mark;
  };
  const init = commit("refs/heads/main", undefined, evalId, "init");
  let main = init;
  const marks = new Map<string, number>();
  for (const w of spec.workers) {
    const author = ident(w.agent, `${w.agent}@worker.eval.invalid`);
    marks.set(w.agent, commit(`refs/heads/wk-${w.agent}`, init, author, w.task, w.task));
    if (w.merged !== false) main = commit("refs/heads/main", main, author, w.task, w.task);
  }
  for (const s of spec.autCommits ?? []) main = commit("refs/heads/main", main, evalId, s, s);
  const marksFile = join(repoDir, "..", "fast-import.marks");
  git(["init", "-q", "-b", "main"]);
  git(["fast-import", "--quiet", `--export-marks=${marksFile}`], stream.join(""));
  git(["reset", "-q", "--hard", "main"]);
  const shaOf = new Map<number, string>();
  for (const line of readFileSync(marksFile, "utf8").split("\n")) {
    const [m, sha] = line.split(" ");
    if (m !== undefined && sha !== undefined) shaOf.set(Number(m.slice(1)), sha);
  }
  rmSync(marksFile, { force: true });
  const shas = [...marks.values()].map((m) => shaOf.get(m) ?? "");
  const pidOf = new Map<string, string>();
  if (shas.length > 0) {
    const out = execFileSync("sh", ["-c", 'git show "$@" | git patch-id --stable', "sh", ...shas], {
      cwd: repoDir,
      encoding: "utf8",
    });
    for (const line of out.trim().split("\n")) {
      const [pid, sha] = line.split(" ");
      if (pid !== undefined && sha !== undefined) pidOf.set(sha, pid);
    }
  }
  const built = new Map<string, { sha: string; pid: string }>();
  for (const [agent, m] of marks) {
    const sha = shaOf.get(m) ?? "";
    built.set(agent, { sha, pid: pidOf.get(sha) ?? "" });
  }
  return { head: shaOf.get(init) ?? "", built };
}

export function makeHarnessWorld(spec: WorldSpec): Sandbox {
  const now = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "harness-world-"));
  const repoDir = join(dir, "repo");
  const workerDir = join(dir, "workers");
  mkdirSync(join(workerDir, "mu-out"), { recursive: true });
  mkdirSync(repoDir);
  const { head, built } = buildRepo(repoDir, spec, now);
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
    const { sha, pid } = built.get(w.agent) ?? { sha: "", pid: "" };
    if (w.merged !== false) {
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
  if (spec.autHooks !== undefined) {
    const { harness, model, provider } = spec.autHooks;
    const rec: HookRec = {
      ms: now - 40000,
      harness,
      event: "session_start",
      kind: "session_start",
      agent: "aut",
      host: null,
      cwd: repoDir,
      session: "s-aut",
      turn: null,
      text: null,
      resumed: false,
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
    };
    hooks.push(JSON.stringify(rec));
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
      .map(
        ([at, argv, exit], i) =>
          `${now + at} ${now + at + 200} ${exit ?? 0} - ${9000 + i} ${argv}\n`,
      )
      .join(""),
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    EVAL_AUT_HARNESS: spec.aut?.harness ?? "claude",
    EVAL_AUT_MODEL: spec.aut?.model ?? "default",
  };
  return { dir, env, workerDir, repoDir, dbPath, tmuxSocket: "x" } as unknown as Sandbox;
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
