// Shared seed and judge helpers of the next-step cases (nextstep-cases*.ts, spec
// docs/specs/2026-11-07-hill-r2-tournament.md §2). Seeds go through `mu(sb, …)` (the surface's cli,
// not the recording shim), so no seed call is a call anyone made; lead-ins and answers go through
// the shim.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { WS } from "./cold-intents.ts";
import { runsLog, shq } from "./fixtures.ts";
import type { NextCase } from "./nextstep.ts";
import { muCalls, muOut } from "./observe.ts";
import type { OpRow } from "./ops.ts";
import { mu, sh } from "./sandbox.ts";
import type { Sandbox } from "./types.ts";

export const nonce = (): string => randomBytes(4).toString("hex");

/**
 * An `allow` for one agent's ops only: an agent op's key is its workstream and its payload names the
 * agent ("agent close worker-1 (…)"), so a stray spawn of another agent is a stray op.
 */
export const agentOpsOf =
  (name: string) =>
  (o: OpRow): boolean =>
    o.entity === "agent" &&
    o.key === WS &&
    (o.intent ?? "").startsWith("agent.") &&
    (o.payload ?? "").split(" ")[2] === name;

const WORDS = [
  "amber",
  "basil",
  "cedar",
  "delta",
  "ember",
  "fjord",
  "garnet",
  "harbor",
  "indigo",
  "juniper",
  "kelp",
  "lumen",
  "maple",
  "nectar",
  "onyx",
  "pebble",
  "quartz",
  "russet",
  "saffron",
  "tundra",
  "umber",
  "violet",
  "willow",
  "yarrow",
  "zephyr",
  "copper",
  "falcon",
  "meadow",
  "orchid",
  "prism",
  "summit",
  "thistle",
];

/** Four words drawn from a fixed list by the row's nonce and `k`: the random phrase of a whole-line marker (§1.3). */
export function phrase(seed: string, k = 0): string {
  const h = createHash("sha256").update(`${seed}:${k}`).digest();
  return [0, 1, 2, 3].map((i) => WORDS[(h[i] ?? 0) % WORDS.length]).join(" ");
}

/** Paraphrases p1..pN from goals; a goal is a string (lead-in a) or [goal, lead-in]. */
export function paras(goals: (string | [string, "a" | "b"])[]): NextCase["paraphrases"] {
  return goals.map((g, i) =>
    typeof g === "string"
      ? { id: `p${i + 1}`, goal: g, leadIn: "a" as const }
      : { id: `p${i + 1}`, goal: g[0], leadIn: g[1] },
  );
}

export const addTask = (id: string, title: string, ws = WS): string[] => [
  "task",
  "add",
  id,
  "-w",
  ws,
  "-t",
  title,
  "-i",
  "50",
  "-e",
  "1",
];

/** Run seed commands through the surface's cli (not recorded); throws on a failure. */
export async function seedMu(sb: Sandbox, args: string[]): Promise<string> {
  const r = await mu(sb, args);
  if (r.code !== 0) throw new Error(`seed failed (${r.code}): mu ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}

/** A pi worker (the faux pi) spawned on `task` with its prompt sent. */
export async function spawnWorker(
  sb: Sandbox,
  name: string,
  task: string,
  extra: string[] = [],
): Promise<void> {
  await seedMu(sb, [
    "agent",
    "spawn",
    name,
    "-w",
    WS,
    "--task",
    task,
    ...extra,
    "--send",
    `do ${task}`,
  ]);
}

/** Poll until `pred` holds (every 200 ms), else throw after `ms`. */
export async function until(
  what: string,
  pred: () => Promise<boolean>,
  ms = 60_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`seed: timed out waiting for ${what}`);
}

/** `task`'s worker run is in runs.log with `action` (block, close, die, …). */
export const ranTask = async (sb: Sandbox, task: string, action: string): Promise<boolean> =>
  (await runsLog(sb)).some((r) => r.task === task && r.action === action);

/** `sha` is on main: an ancestor of it, or a main commit with the same patch-id. */
export async function onMain(sb: Sandbox, sha: string): Promise<boolean> {
  if (sha === "") return false;
  const anc = await sh(sb, `git merge-base --is-ancestor ${sha} main`, { allowFail: true });
  if (anc.code === 0) return true;
  const pid = (
    await sh(sb, `git show --format= ${sha} | git patch-id --stable | cut -d' ' -f1`, {
      allowFail: true,
    })
  ).stdout.trim();
  if (pid === "") return false;
  const ids = await sh(
    sb,
    "git log --format=%H main | while read c; do git show --format= $c | git patch-id --stable | cut -d' ' -f1; done",
    { allowFail: true },
  );
  return ids.stdout.split("\n").includes(pid);
}

/** A worktree spawn of a `--command` pane: its directory. */
export async function worktreePane(sb: Sandbox, name: string): Promise<string> {
  const out = await seedMu(sb, [
    "agent",
    "spawn",
    name,
    "-w",
    WS,
    "--command",
    `sh -c 'echo ${name}; exec sleep 3600'`,
    "--no-ctl",
    "--worktree",
  ]);
  const dir = /^\s+(?:workspace|cwd): (\S+)/m.exec(out)?.[1] ?? "";
  if (dir === "") throw new Error(`seed spawn ${name}: no worktree in ${out}`);
  return dir;
}

/** One commit in `dir` touching `file`; its sha. */
export async function commitIn(
  sb: Sandbox,
  dir: string,
  file: string,
  subject: string,
): Promise<string> {
  await sh(
    sb,
    `cd ${shq(dir)} && echo ${subject} > ${file} && git add ${file} && git commit -qm ${shq(subject)}`,
  );
  return (await sh(sb, `git -C ${shq(dir)} rev-parse HEAD`)).stdout.trim();
}

/** The preview revision `mu agent close <name> --json` reports. */
export async function closeRev(sb: Sandbox, name: string): Promise<string> {
  const out = await seedMu(sb, ["agent", "close", name, "-w", WS, "--json"]);
  const rev = String((JSON.parse(out) as { data?: { revision?: unknown } }).data?.revision ?? "");
  if (rev === "" || rev === "0") throw new Error(`seed: no revision in ${out}`);
  return rev;
}

/** The `next:` line the latest lead-in mu call whose argv holds `argvHas` printed (lead-in steps built from an earlier step's output). */
export function hintOf(sb: Sandbox, argvHas: string): string | null {
  try {
    const call = muCalls(sb)
      .filter((c) => c.argv.includes(argvHas))
      .pop();
    if (!call) return null;
    return /^next: (.+)$/m.exec(muOut(sb, call))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Records of an output line: its tab/space text, or one object of a JSON line. */
export const records = (line: string): string[] => line.split("},{");

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `w` occurs as a whole word (not inside t10, worker-12, x1y). */
export const word = (text: string, w: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_-])${esc(w)}($|[^A-Za-z0-9_-])`).test(text);

/** A line one of whose records names task `id` and `state`. */
export const namesState =
  (id: string, state: string) =>
  (line: string): boolean =>
    records(line).some((r) => word(r, id) && word(r, state));

/** Read-only query on the sandbox DB. */
export function q<T>(sb: Sandbox, sql: string, ...args: unknown[]): T[] {
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

/** The ISO time of epoch ms `t` (the DB's created_at clock). */
export const iso = (t: number): string => new Date(t).toISOString();

/** The label of a text's first `VERDICT:` line (src/delegate-verdict.ts parseVerdict, restated). */
export function verdictLabel(text: string | null): string | undefined {
  const line = (text ?? "").split("\n").find((l) => /^(?:\w+: )?VERDICT:/.test(l));
  if (line === undefined) return undefined;
  return /\b(CONFIRMED|REFUTED|UNVERIFIED)\b/.exec(line.slice(line.indexOf("VERDICT:") + 8))?.[1];
}

/** The sandbox's driver nonce (writeWorkerDriver): part of every faux close evidence. */
export const driverNonce = (sb: Sandbox): string => {
  const f = join(sb.workerDir, "nonce");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
};
