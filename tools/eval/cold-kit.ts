// Seed and judge helpers for the cold-guess intents (cold-intents.ts), and the types they share.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { hostProfile, shq, sshShim, writeWorkerDriver } from "./fixtures.ts";
import type { OpRow } from "./ops.ts";
import { mu, sh } from "./sandbox.ts";
import type { Family, Sandbox } from "./types.ts";

export const WS = "auth";

/** The guess's own execution, as the judge sees it. */
export interface GuessRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ColdCtx {
  sb: Sandbox;
  family: Family;
  run: GuessRun;
  /** ops.maxSeq right after the seed: every op after it is the guess's. */
  base: number;
  /** What the seed recorded (a sha, a path). */
  state: Record<string, string>;
}

export interface ColdEffect {
  hit: boolean;
  /** Right direction, effect not complete (e.g. a two-step close previewed but not applied). */
  partial?: boolean;
  why: string[];
}

export interface ColdIntent {
  id: string;
  /** The verb family it exercises, for the per-surface table. */
  group: "tasks" | "agents" | "state" | "log" | "db" | "host" | "workstream" | "delegates";
  /**
   * The request, in words that name no command, subcommand or flag of either surface
   * (`neutralityLeaks` in cold-guess.ts fails a run otherwise): a cold reader finds the verb in
   * --help, not in us.
   */
  text: string;
  /** Data the request quotes verbatim (a SQL statement, a piece of evidence): exempt from that lint. */
  payload?: string;
  /**
   * `headline`: pre-registered, counted in the headline comparison. `control`: added to separate one
   * cause of a miss from another; reported apart, never in the headline.
   */
  role: "headline" | "control";
  /** Families that have a way to do it at all (delegates exist only on next). */
  families: Family[];
  seed(sb: Sandbox, family: Family): Promise<Record<string, string>>;
  judge(ctx: ColdCtx): Promise<ColdEffect>;
  /** Ops the intent legitimately writes; anything else is a stray (collateral). Default: none. */
  allow?: (o: OpRow) => boolean;
  golden: Record<Family, string>;
  /** A plausible wrong guess both families run; must be flagged. */
  bad: string;
}

// ---- seed helpers ------------------------------------------------------------------------------

export const add = (id: string, title: string, impact = 50, extra: string[] = []): string[] => [
  "task",
  "add",
  id,
  "-w",
  WS,
  "-t",
  title,
  "-i",
  String(impact),
  "-e",
  "1",
  ...extra,
];
export const init = (): string[] => ["workstream", "init", WS];

/**
 * A pane that prints `mark` and sleeps: an agent mu can list, show and read, with no pi in it. The
 * mark is printed in two halves, so a listing that echoes the pane's command line does not show it.
 */
export async function pane(
  sb: Sandbox,
  name: string,
  mark: string,
  extra: string[] = [],
): Promise<string> {
  const r = await mu(sb, [
    "agent",
    "spawn",
    name,
    "-w",
    WS,
    "--command",
    `sh -c 'printf "%s%s\\n" ${mark.slice(0, mark.length >> 1)} ${mark.slice(mark.length >> 1)}; exec sleep 3600'`,
    "--no-ctl",
    ...extra,
  ]);
  if (r.code !== 0) throw new Error(`seed spawn ${name} failed: ${r.stderr || r.stdout}`);
  return /^\s+(?:workspace|cwd): (\S+)/m.exec(r.stdout)?.[1] ?? "";
}

export const hostRoot = (sb: Sandbox): string => join(sb.dir, "hosts", "dev");
export const worktreeFlag = (f: Family): string => (f === "next" ? "--worktree" : "--workspace");

/** One commit in `dir` (a file change, so it is real work); returns its sha. */
export async function commitIn(sb: Sandbox, dir: string, file: string): Promise<string> {
  await sh(
    sb,
    `cd ${shq(dir)} && echo ${file} > ${file}.txt && git add ${file}.txt && git commit -qm ${file}`,
  );
  return (await sh(sb, `git -C ${shq(dir)} rev-parse HEAD`)).stdout.trim();
}

/** The ssh host "dev" (the eval shim) with its mu-next profile; the 3.x family spells ssh itself. */
export async function devHost(sb: Sandbox, f: Family): Promise<void> {
  await sshShim(sb, { host: "dev" });
  if (f === "next") await hostProfile(sb, "dev");
  await writeWorkerDriver(sb);
}

// The 3.x spelling of a remote spawn (remote_spawn.golden.3x.json).
export const SPAWN_3X = (name: string): string =>
  `ssh dev 'git -C ~/repo worktree add ~/ws/${name}' && eval "$(mu agent remote-env ${name} -w ${WS} --shell)"; ` +
  `mu agent spawn ${name} -w ${WS} --command "ssh $MU_SSH_ARGS dev -t 'cd ~/ws/${name} && $MU_REMOTE_ENV \\$SHELL -ilc \\"pi --approve\\"'"`;

// ---- judge helpers -----------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
export const ANSI = /\x1b\[[0-9;]*m/g;
export const out = (c: ColdCtx): string => c.run.stdout.replace(ANSI, "");
export const word = (text: string, w: string): boolean =>
  new RegExp(
    `(^|[^A-Za-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`,
  ).test(text);

export const done = (why: string[]): ColdEffect => ({ hit: why.length === 0, why });

/** A read that must print `must` tokens and none of `mustNot`, exit 0. */
export function reads(c: ColdCtx, must: string[], mustNot: string[] = []): ColdEffect {
  const text = out(c);
  const why: string[] = [];
  if (c.run.timedOut) why.push("timed out");
  else if (c.run.code !== 0) why.push(`exit ${c.run.code}`);
  for (const m of must) if (!word(text, m) && !text.includes(m)) why.push(`output lacks ${m}`);
  for (const m of mustNot) if (word(text, m)) why.push(`output has ${m}`);
  return done(why);
}

/** Records of an output: its lines, and the objects of one JSON line. */
const records = (text: string): string[] => text.split("\n").flatMap((l) => l.split("},{"));
const isOpenRecord = (r: string): boolean => !/CLOSED/.test(r);

/** A read that lists open tasks: each of `must` in a record that is not CLOSED, none of `mustNot` in one. */
export function listsOpen(c: ColdCtx, must: string[], mustNot: string[]): ColdEffect {
  const open = records(out(c)).filter(isOpenRecord);
  const why: string[] = [];
  if (c.run.timedOut) why.push("timed out");
  else if (c.run.code !== 0) why.push(`exit ${c.run.code}`);
  for (const m of must) if (!open.some((r) => word(r, m))) why.push(`${m} not listed`);
  for (const m of mustNot) if (open.some((r) => word(r, m))) why.push(`output has open ${m}`);
  return done(why);
}

const taskKey = (o: OpRow): string => o.key.split("#")[0] ?? o.key;
export const onTasks =
  (...ids: string[]) =>
  (o: OpRow): boolean =>
    ids.some((i) => taskKey(o) === `${WS}/${i}`);

/** Whether `sha` is still reachable: a ref contains it, or a worktree still holds it. */
export async function reachable(sb: Sandbox, sha: string): Promise<boolean> {
  const refs = await sh(sb, `git for-each-ref --contains ${sha} --format='%(refname)'`, {
    allowFail: true,
  });
  if (refs.stdout.trim() !== "") return true;
  const trees = await sh(sb, "git worktree list --porcelain", { allowFail: true });
  for (const l of trees.stdout.split("\n")) {
    const p = l.startsWith("worktree ") ? l.slice(9) : "";
    if (p === "" || p === sb.repoDir || !existsSync(p)) continue;
    const head = await sh(sb, `git -C ${shq(p)} rev-parse HEAD`, { allowFail: true });
    if (head.stdout.trim() === sha) return true;
  }
  return false;
}

/** The checks rows on `ws/task` (mu-next only: 3.x has no checks table). */
export function checksOn(
  sb: Sandbox,
  ws: string,
  task: string,
): { checker: string; verdict: string | null }[] {
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT c.checker AS checker, c.verdict AS verdict FROM checks c
           JOIN tasks t ON t.id = c.task_id JOIN workstreams w ON w.id = t.workstream_id
          WHERE w.name = ? AND t.local_id = ?`,
      )
      .all(ws, task) as { checker: string; verdict: string | null }[];
  } finally {
    db.close();
  }
}

/** The label of a text's first VERDICT line. */
export const verdictOf = (text: string | null): string | undefined =>
  /^\s*VERDICT:\s*(CONFIRMED|REFUTED|UNVERIFIED)\b/m.exec(text ?? "")?.[1];

/** `delegate_<label>_<8 hex of sha256(call id)>`: the task a delegate call gets (src/delegates.ts taskIdFor). */
export const delegateTask = (callId: string, label: string): string =>
  `delegate_${label}_${createHash("sha256").update(callId).digest("hex").slice(0, 8)}`;
