// Cold-guess probe (e_cold_guess): give a model ONLY `mu --help` (no skill, no tools) and a short
// intent, take the one shell command it answers with, run that command in a seeded sandbox and
// judge the STATE it left (cold-intents.ts), never its spelling. Not a scored scenario: it feeds
// t_surface (which verbs, flags and fields a cold reader reaches for) and v_hints.
//
//   node tools/eval/main.ts cold-guess run --surface next=<dir>:next --surface 3.13.3=3.13.3:3x \
//        --model <m>... --reps 3 --out cold-guess.jsonl
//   node tools/eval/main.ts cold-guess check --surface <spec>     # goldens hit, bads and a no-op miss
//   node tools/eval/main.ts cold-guess report cold-guess.jsonl --out cold-guess.md
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { helpBundle, neutralityLeaks, surfaceVocab } from "./cold-help.ts";
import {
  ANSI,
  type ColdCtx,
  type ColdEffect,
  type ColdIntent,
  type GuessRun,
  INTENTS,
} from "./cold-intents.ts";
import { muCalls } from "./observe.ts";
import { maxSeq, opsSince } from "./ops.ts";
import { createSandbox, REAL_PI } from "./sandbox.ts";
import type { Family, Sandbox, Surface } from "./types.ts";

export const COLD_PI_SESSION = "cold-seed";
const GUESS_TIMEOUT_MS = 45_000;
const MODEL_TIMEOUT_MS = 120_000;

// ---- the command a model answers with ------------------------------------------------------------

/** The command in a reply: the first fenced block, else the first line that starts with `mu`. */
export function extractCommand(reply: string): string | null {
  const fence = /```[A-Za-z]*\n([\s\S]*?)```/.exec(reply);
  const body = fence ? (fence[1] ?? "") : reply;
  const lines = body
    .split("\n")
    .map((l) => l.replace(/^\s*\$\s+/, "").trimEnd())
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (fence) return lines.length > 0 ? lines.join("\n") : null;
  const first = lines.find((l) => /(^|[\s;&|(`])mu\s/.test(l));
  return first ?? null;
}

/** Nouns whose second word is a subcommand (mu task show); the rest take arguments (mu log text). */
const NOUNS = new Set([
  "agent",
  "task",
  "workstream",
  "delegates",
  "host",
  "db",
  "pi",
  "me",
  "workspace",
]);
const VALUE_FLAGS = new Set(["-w", "--workstream"]);

export interface Reach {
  /** `task show`, `sql`, `log`: the verb words, no arguments. */
  verb: string;
  flags: string[];
  /** Tables a `mu sql` guess read. */
  tables: string[];
}

/** First verb, flags and SQL tables of one mu argv string (the shim's record, or text after `mu `). */
export function firstReach(argv: string): Reach {
  const toks = argv
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "");
  const words: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] ?? "";
    if (t.startsWith("-")) {
      flags.push(t.split("=")[0] ?? t);
      if (VALUE_FLAGS.has(t)) i++;
      continue;
    }
    if (flags.length > 0 && words.length >= 1 && !NOUNS.has(words[0] ?? "")) continue;
    if (words.length === 0) words.push(t);
    else if (words.length === 1 && NOUNS.has(words[0] ?? "") && /^[a-z][a-z-]*$/.test(t))
      words.push(t);
  }
  const tables = [...argv.matchAll(/\b(?:from|join)\s+"?([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) =>
    (m[1] ?? "").toLowerCase(),
  );
  return {
    verb: words.join(" "),
    flags: [...new Set(flags)].sort(),
    tables: [...new Set(tables)].sort(),
  };
}

/** The mu invocations a command text spells, when none ran (a shell error before mu started). */
export function muInText(cmd: string): string[] {
  return [...cmd.matchAll(/(?:^|[;&|(`]|\$\()\s*(?:[A-Za-z_]+=\S+\s+)*mu\s+([^;&|)`\n]*)/g)].map(
    (m) => m[1] ?? "",
  );
}

// ---- the model ----------------------------------------------------------------------------------

/** What the model reads: `mu --help` and every namespace's `--help`, the same depth on every surface. */
export function helpText(surface: Surface): string {
  return helpBundle(surface);
}

/** `<mu --version>` plus the short sha: the checkout's HEAD, or the .ref `prepare` stamped on an exported surface. */
export function buildId(surface: Surface): string {
  const v = execFileSync("node", [surface.cli, "--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).trim();
  const ref = join(surface.root, ".ref");
  if (existsSync(ref)) return `${v}+${readFileSync(ref, "utf8").trim().slice(0, 7)}`;
  try {
    const sha = execFileSync("git", ["-C", surface.root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return `${v}+${sha}`;
  } catch {
    return v;
  }
}

export function systemPrompt(help: string): string {
  return [
    "You orchestrate a crew of AI agents with a command-line tool called `mu`. You have never used it. Below is the output of `mu --help` followed by the `--help` of each command group (task, agent, and so on); it is the only documentation you have.",
    "",
    "<help>",
    help.trimEnd(),
    "</help>",
    "",
    "You cannot run anything now and you cannot ask questions. For each request, answer with the ONE shell command you would run, in a single ```sh fenced block and nothing else. Commit to your best guess of the real command: a `--help` command is not an answer. Names in the request (workstream, task and agent ids, hosts) are exact. mu is on PATH and you are in the project's git repo.",
  ].join("\n");
}

export interface ModelReply {
  text: string;
  tokens: number;
  error?: string;
}

/** One pi print-mode turn: no tools, no skills, no context files, empty HOME and cwd. */
export async function askModel(
  model: string,
  system: string,
  user: string,
  providerExt: string,
): Promise<ModelReply> {
  const home = mkdtempSync(join(tmpdir(), "mu-cold-pi-"));
  try {
    writeFileSync(
      join(home, "settings.json"),
      `${JSON.stringify({ retry: { enabled: false } })}\n`,
    );
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      PI_CODING_AGENT_DIR: home,
    };
    for (const [k, v] of Object.entries(process.env))
      if (k.startsWith("MODELBRIDGE_") && v !== undefined) env[k] = v;
    const args = [
      "-p",
      "--mode",
      "json",
      "--no-tools",
      "--no-session",
      "--no-extensions",
      "-e",
      providerExt,
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--offline",
      "--system-prompt",
      system,
      "--model",
      model,
      user,
    ];
    const r = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const child = spawn(REAL_PI, args, { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), MODEL_TIMEOUT_MS);
      child.on("error", (e) => resolve({ stdout, stderr: String(e), code: 127 }));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
    return parsePiJson(r.stdout, r.stderr, r.code);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The assistant text and token total of a `pi --mode json` stream. */
export function parsePiJson(stdout: string, stderr = "", code = 0): ModelReply {
  let text = "";
  let tokens = 0;
  let error: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let ev: {
      type?: string;
      message?: {
        role?: string;
        content?: unknown;
        usage?: { totalTokens?: number };
        stopReason?: string;
        errorMessage?: string;
      };
    };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const m = ev.message;
    if (ev.type !== "message_end" || m?.role !== "assistant") continue;
    tokens += m.usage?.totalTokens ?? 0;
    if (m.stopReason === "error") error = m.errorMessage ?? "model error";
    if (Array.isArray(m.content))
      text += m.content
        .map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
        .join("");
  }
  if (text === "" && error === undefined)
    error = (stderr.trim().split("\n").pop() ?? "") || `pi exit ${code}, no assistant text`;
  return { text, tokens, ...(error === undefined ? {} : { error }) };
}

// ---- running a guess ----------------------------------------------------------------------------

/** `bash -c cmd` in the sandbox, killed with its process group after `timeoutMs`. */
export function execGuess(
  sb: Sandbox,
  cmd: string,
  timeoutMs = GUESS_TIMEOUT_MS,
): Promise<GuessRun> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn("bash", ["-c", cmd], {
      cwd: sb.repoDir,
      env: sb.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (e) =>
      resolve({ code: 127, stdout, stderr: `${stderr}${e.message}`, timedOut }),
    );
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr, timedOut });
    });
  });
}

export interface ColdRow {
  intent: string;
  group: string;
  /** Pre-registered (counted in the headline) or a control (reported apart). */
  role: "headline" | "control";
  surface: string;
  family: Family;
  version: string;
  model: string;
  rep: number;
  /** sha256 of the --help text the model saw (first 12 hex). */
  helpSha: string;
  reply: string;
  command: string | null;
  parsed: boolean;
  multiLine: boolean;
  exit: number | null;
  timedOut: boolean;
  hit: boolean;
  partial: boolean;
  destructive: boolean;
  /** Ops the guess wrote that the intent does not allow. */
  stray: string[];
  why: string[];
  reach: Reach | null;
  /** argv of each mu call the guess made, in order. */
  muCalls: string[];
  firstError: string;
  tokens: number;
  modelError?: string;
  ms: number;
}

const firstLine = (s: string): string =>
  (
    s
      .replace(ANSI, "")
      .split("\n")
      .find((l) => l.trim() !== "") ?? ""
  ).slice(0, 160);

/** Seed, run `command`, judge. The caller owns neither the sandbox nor the DB. */
export async function guessEffect(
  intent: ColdIntent,
  surface: Surface,
  command: string,
): Promise<{ run: GuessRun; effect: ColdEffect; stray: string[]; calls: string[] }> {
  const family: Family = surface.family ?? "3x";
  const sb = await createSandbox(surface, { env: { PI_SESSION_ID: COLD_PI_SESSION } });
  try {
    const state = await intent.seed(sb, family);
    const base = maxSeq(sb);
    const t0 = Date.now() - 5;
    const run = await execGuess(sb, command);
    const effect = await intent.judge({ sb, family, run, base, state });
    const allow = intent.allow ?? (() => false);
    const stray = opsSince(sb, base)
      .filter((o) => !allow(o))
      .map((o) => `${o.intent ?? "?"} ${o.key}`);
    const calls = muCalls(sb)
      .filter((m) => m.start >= t0)
      .map((m) => m.argv);
    return { run, effect, stray, calls };
  } finally {
    await sb.close();
  }
}

export interface ColdJob {
  intent: ColdIntent;
  surface: Surface;
  label: string;
  version: string;
  model: string;
  rep: number;
  help: string;
  providerExt: string;
}

export async function runJob(job: ColdJob): Promise<ColdRow> {
  const started = Date.now();
  const family: Family = job.surface.family ?? "3x";
  const row: ColdRow = {
    intent: job.intent.id,
    group: job.intent.group,
    role: job.intent.role,
    surface: job.label,
    family,
    version: job.version,
    model: job.model,
    rep: job.rep,
    helpSha: createHash("sha256").update(job.help).digest("hex").slice(0, 12),
    reply: "",
    command: null,
    parsed: false,
    multiLine: false,
    exit: null,
    timedOut: false,
    hit: false,
    partial: false,
    destructive: false,
    stray: [],
    why: [],
    reach: null,
    muCalls: [],
    firstError: "",
    tokens: 0,
    ms: 0,
  };
  let reply = await askModel(job.model, systemPrompt(job.help), job.intent.text, job.providerExt);
  for (let i = 0; i < 2 && reply.error !== undefined; i++)
    reply = await askModel(job.model, systemPrompt(job.help), job.intent.text, job.providerExt);
  row.reply = reply.text;
  row.tokens = reply.tokens;
  if (reply.error !== undefined) {
    row.modelError = reply.error;
    row.why = [`model error: ${reply.error.slice(0, 120)}`];
    row.ms = Date.now() - started;
    return row;
  }
  const command = extractCommand(reply.text);
  row.command = command;
  row.parsed = command !== null && /(^|[\s;&|(`$])mu\s|\b(sqlite3|git|ssh)\b/.test(command);
  if (command === null) {
    row.why = ["no command in the reply"];
    row.ms = Date.now() - started;
    return row;
  }
  row.multiLine = command.includes("\n");
  const r = await guessEffect(job.intent, job.surface, command);
  row.exit = r.run.code;
  row.timedOut = r.run.timedOut;
  row.stray = r.stray;
  row.muCalls = r.calls;
  row.firstError = firstLine(r.run.stderr) || (r.run.code !== 0 ? firstLine(r.run.stdout) : "");
  row.partial = r.effect.partial === true;
  row.destructive = r.effect.why.some((w) => w.startsWith("LOST WORK"));
  row.why = [...r.effect.why, ...r.stray.map((s) => `stray op ${s}`)];
  row.hit = r.effect.hit && r.stray.length === 0 && !r.run.timedOut;
  const first = r.calls[0] ?? muInText(command)[0];
  row.reach = first === undefined ? null : firstReach(first);
  row.ms = Date.now() - started;
  return row;
}

// ---- run / check --------------------------------------------------------------------------------

export interface ColdSurface {
  label: string;
  surface: Surface;
}

export interface ColdRunOptions {
  surfaces: ColdSurface[];
  models: string[];
  reps: number;
  intents: string[] | null;
  concurrency: number;
  out: string;
  providerExt: string;
}

const keyOf = (r: { surface: string; model: string; intent: string; rep: number }): string =>
  `${r.surface}|${r.model}|${r.intent}|${r.rep}`;

export function readRows(file: string): ColdRow[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ColdRow);
}

/** Intent requests that name a command, subcommand or flag of any surface in the run. */
export function intentLeaks(surfaces: ColdSurface[]): string[] {
  const vocab = Object.fromEntries(surfaces.map((s) => [s.label, surfaceVocab(s.surface)]));
  return neutralityLeaks(INTENTS, vocab).map(
    (l) => `${l.intent}: "${l.word}" is a name on ${l.surfaces.join(", ")}`,
  );
}

export async function runCold(o: ColdRunOptions): Promise<ColdRow[]> {
  const leaks = intentLeaks(o.surfaces);
  if (leaks.length > 0)
    throw new Error(`intent wording leaks a surface's names:\n  ${leaks.join("\n  ")}`);
  const done = new Set(readRows(o.out).map(keyOf));
  const queue: ColdJob[] = [];
  for (const { label, surface } of o.surfaces) {
    const family: Family = surface.family ?? "3x";
    const help = helpText(surface);
    const version = buildId(surface);
    for (const intent of INTENTS) {
      if (!intent.families.includes(family) || (o.intents && !o.intents.includes(intent.id)))
        continue;
      for (const model of o.models)
        for (let rep = 1; rep <= o.reps; rep++)
          if (!done.has(keyOf({ surface: label, model, intent: intent.id, rep })))
            queue.push({
              intent,
              surface,
              label,
              version,
              model,
              rep,
              help,
              providerExt: o.providerExt,
            });
    }
  }
  console.log(`${queue.length} guesses to run (${done.size} already in ${o.out})`);
  const rows: ColdRow[] = [];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      try {
        const r = await runJob(job);
        rows.push(r);
        mkdirSync(dirname(o.out), { recursive: true });
        appendFileSync(o.out, `${JSON.stringify(r)}\n`);
        console.log(
          `${r.hit ? "HIT " : r.partial ? "part" : "miss"} ${r.surface} ${r.model.split("/").pop()} ${r.intent} rep${r.rep}: ${r.command?.split("\n")[0]?.slice(0, 90) ?? r.why.join("; ")}`,
        );
      } catch (e) {
        console.error(
          `guess failed: ${job.label} ${job.intent.id} ${job.model}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  return rows;
}

/** Scripted proof of the judges, zero model cost: golden hits, the bad and a no-op do not. */
export async function runColdCheck(
  surface: Surface,
  intents: string[] | null,
  concurrency = 4,
): Promise<number> {
  const family: Family = surface.family ?? "3x";
  const jobs: { intent: ColdIntent; kind: "golden" | "bad" | "noop"; cmd: string }[] = [];
  for (const intent of INTENTS) {
    if (!intent.families.includes(family) || (intents && !intents.includes(intent.id))) continue;
    jobs.push({ intent, kind: "golden", cmd: intent.golden[family] });
    jobs.push({ intent, kind: "bad", cmd: intent.bad });
    jobs.push({ intent, kind: "noop", cmd: "true" });
  }
  let failures = 0;
  const worker = async (): Promise<void> => {
    for (let j = jobs.shift(); j !== undefined; j = jobs.shift()) {
      const r = await guessEffect(j.intent, surface, j.cmd);
      const hit = r.effect.hit && r.stray.length === 0 && !r.run.timedOut;
      const ok = j.kind === "golden" ? hit : !hit;
      if (!ok) failures++;
      const why = [
        ...r.effect.why,
        ...r.stray.map((s) => `stray ${s}`),
        r.run.timedOut ? "timed out" : "",
        firstLine(r.run.stderr),
      ]
        .filter(Boolean)
        .join("; ");
      console.log(
        `${ok ? "ok  " : "FAIL"} ${j.intent.id} ${j.kind}${ok ? "" : ` (hit=${hit}): ${why}`}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  console.log(
    failures === 0
      ? "cold-guess check: all goldens hit, every bad and no-op missed"
      : `cold-guess check: ${failures} FAILED`,
  );
  return failures === 0 ? 0 : 1;
}

/** A judge needs no more than this to be run directly (tests). */
export type { ColdCtx };
