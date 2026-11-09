// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Next-step probe (spec docs/specs/2026-11-07-hill-r2-tournament.md §1, unit B2): a model gets the
// skill (or not, per arm), a transcript generated live in a seeded sandbox that ends in one mu output,
// and a goal; it answers with its next one to three commands; they run in the same sandbox, and the
// case's judge reads the state and mu's own output, never the spelling.
//
//   node tools/eval/main.ts nextstep run --surface [label=]<spec>... --model <m>... --out probe.jsonl
//   node tools/eval/main.ts nextstep check [--surface <spec>]   # golden hits; bad, `true`, lucky, sleep miss
//   node tools/eval/main.ts nextstep lint [--surface [label=]<spec>...]
//   node tools/eval/main.ts nextstep selftest [--surface <spec>] # the whole path with evalfaux, zero cost
//   node tools/eval/main.ts nextstep report probe.jsonl [--out f.md]
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
import { type Claim, rowPool } from "./claim.ts";
import { askModel, buildId, extractCommand, firstReach, muInText } from "./cold-guess.ts";
import { neutralityLeaks, surfaceVocab } from "./cold-help.ts";
import type { ColdEffect, GuessRun } from "./cold-intents.ts";
import { NEXT_CASES } from "./nextstep-cases.ts";
import {
  answerCalls,
  cmdIdxOf,
  DEFAULT_LIMIT_MS,
  decideHit,
  destructiveEntries,
  GAP_MS,
  ORCH_SESSION,
  renderTranscript,
  runAnswer,
  runLeadIn,
  sleep,
  strip,
  timedViolations,
} from "./nextstep-exec.ts";
import { nextReport } from "./nextstep-report.ts";
import { type MuCall, muCalls } from "./observe.ts";
import { maxSeq, type OpRow, opsSince } from "./ops.ts";
import { fingerprintInOutputs, rigFingerprint } from "./rig-fingerprint.ts";
import { canaryInOutputs, rigGuard, rigReadsInCommands } from "./rig-guard.ts";
import { createSandbox } from "./sandbox.ts";
import { surfaceId } from "./surface.ts";
import type { Sandbox, Surface } from "./types.ts";

export {
  answerMetrics,
  decideHit,
  idleAnswers,
  shown,
  shownLine,
  timedViolations,
} from "./nextstep-exec.ts";

// ---- §1.5 interface -----------------------------------------------------------------------------

export type Arm = "none" | "skill" | `recipe:${string}`;
export type Group =
  | "c1_wait"
  | "c2_close"
  | "c3_notes"
  | "c4_read"
  | "c5_outcome"
  | "c6_skill"
  | "guard";
export type St = Record<string, string>;

export interface LeadStep {
  cmd: string;
  killAfterMs?: number; // a step the shell kills (wait_shell_limit)
  expect?: (sb: Sandbox, st: St) => Promise<string | null>; // surface-independent precondition
}

export interface NextCase {
  id: string;
  /** Exactly one group: the one whose candidates the case scores; R2 runs it for every other group as a cross-group case (§4.3). */
  group: Group;
  /** headline: scored for its group; guard: no-regression only (R2, every group). */
  role: "headline" | "guard";
  arms: Arm[];
  shell: "bash" | "zsh";
  limitMs?: number;
  /** Goal state arrives after t0: a hit also needs no idle and no polling command (§1.3). */
  timed?: boolean;
  expectedRowMs: number;
  paraphrases: { id: string; goal: string; payload?: string; leadIn: "a" | "b" }[];
  leadInVerbs: string[];
  seed(sb: Sandbox): Promise<St>;
  leadIn(sb: Sandbox, st: St, v: "a" | "b"): LeadStep[];
  go?(sb: Sandbox, st: St): Promise<void>;
  judge(ctx: NextCtx): Promise<ColdEffect>;
  allow?: (o: OpRow) => boolean;
  allowKilled?: boolean;
  golden(st: St, v: "a" | "b"): string[];
  bad(st: St, v: "a" | "b"): string[];
  /** §2.3 says the bad row is "miss, partial": `check` then asserts the row's partial too. */
  badPartial?: boolean;
  /** The other §2.3 rows `check` must prove: alternatives (hit), lucky spellings and forgeries (miss),
   *  the sleep-wait (miss). `partial: true` where §2.3 says "miss, partial" (`check` asserts it). */
  extras(
    st: St,
    v: "a" | "b",
  ): {
    label: "alt" | "lucky" | "sleep";
    cmds: string[];
    expect: "hit" | "miss";
    partial?: boolean;
  }[];
}

export interface NextCtx {
  sb: Sandbox;
  state: St;
  /** ops seq after the lead-in. */
  base: number;
  /** answer start. */
  t0: number;
  runs: (GuessRun & { cmd: string; killed: boolean; start: number; end: number })[];
  /** The answer's mu calls. */
  calls: MuCall[];
  /** Combined stdout+stderr of every answer command, ANSI stripped. */
  output: string;
}

export interface NextJob {
  round: "r1" | "r2" | "b5" | "check";
  group: Group;
  surfaceLabel: string;
  surface: Surface;
  model: string;
  caseId: string;
  arm: Arm;
  paraphrase: string;
  rep: number;
}

export interface RunNextOpts {
  jobs: NextJob[];
  out: string;
  promptDir: string;
  concurrency: number;
  modelConcurrency: number;
  providerExt?: string;
  cases?: NextCase[];
  onRow?: (row: ProbeRow) => void;
}

/** §1.6. No exposure field: exposure.ts derives those at score time. */
export interface ProbeRow {
  kind: "probe";
  group: Group;
  round: NextJob["round"];
  case: string;
  role: NextCase["role"];
  paraphrase: string;
  leadIn: "a" | "b";
  arm: Arm;
  surface: string;
  surfaceId: string;
  build: string;
  model: string;
  rep: number;
  promptSha: string;
  systemSha: string;
  transcriptPath: string;
  leadInCalls: { argv: string; exit: number }[];
  /** Each lead-in step's exit (-1 killed): the driver compares its class against base (§1.4 lint 3). */
  leadInExits: number[];
  reply: string;
  commands: string[];
  tooMany: boolean;
  perCommand: { cmd: string; exit: number; killed: boolean; start: number; end: number }[];
  muCalls: { argv: string; exit: number; start: number; end: number; cmdIdx: number | null }[];
  hit: boolean;
  partial: boolean;
  invalid: boolean;
  why: string[];
  stray: string[];
  destructive: { entry: string; source: string; callIdx: number | null }[];
  tokens: number;
  ms: number;
  modelError?: string;
  /** The answer named the rig (rig-guard.ts): refused unrun, an invalid row, out of ρ̂. */
  rigReads?: string[];
}

// ---- prompt -------------------------------------------------------------------------------------

/** §1.1 system prompt; `{ARM}` takes the arm's text and `{LIMIT}` the shell limit in seconds. */
export const SYSTEM_TEMPLATE =
  "You orchestrate a crew of AI agents with a command-line tool called `mu`, and you are in the middle of a session. {ARM}Your shell tool runs one command per call in the project's git repo and kills a call after {LIMIT} seconds. Below are the last commands you ran and what each printed, then the user's goal. Answer with the next one to three commands that achieve the goal, each in its own ```sh fenced block, in the order to run them. You will not see any output before the last one has run. Names in the transcript and the goal are exact.";

export const sha12 = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 12);
export const SYSTEM_SHA = sha12(SYSTEM_TEMPLATE);

/** The arm's text, read from the surface under test (never the checkout). */
export function armText(surface: Surface, arm: Arm): string {
  if (arm === "none") return "";
  const skill = readFileSync(join(surface.skillDir, "SKILL.md"), "utf8").trimEnd();
  let t = `Below is the mu skill you loaded.\n\n<skill>\n${skill}\n</skill>\n\n`;
  if (arm.startsWith("recipe:")) {
    const name = arm.slice("recipe:".length);
    const body = readFileSync(join(surface.skillDir, "recipes", `${name}.md`), "utf8").trimEnd();
    t += `<recipe name="${name}">\n${body}\n</recipe>\n\n`;
  }
  return t;
}

export function systemPromptFor(surface: Surface, arm: Arm, limitMs = DEFAULT_LIMIT_MS): string {
  return SYSTEM_TEMPLATE.replace("{ARM}", armText(surface, arm)).replace(
    "{LIMIT}",
    String(Math.round(limitMs / 1000)),
  );
}

export const userPrompt = (transcript: string, goal: string): string =>
  `<transcript>\n${transcript}\n</transcript>\n\nGoal: ${goal}`;

// ---- extraction ---------------------------------------------------------------------------------

/** §1.2: every fenced block is one command; no fence: the first mu line; more than three runs nothing. */
export function extractCommands(reply: string): {
  commands: string[];
  tooMany: boolean;
  why: string | null;
} {
  const blocks = [...reply.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)]
    .map((m) =>
      (m[1] ?? "")
        .split("\n")
        .map((l) => l.replace(/^\s*\$\s+/, "").trimEnd())
        .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
        .join("\n"),
    )
    .filter((b) => b !== "");
  if (blocks.length > 3) return { commands: [], tooMany: true, why: "more than 3 commands" };
  if (blocks.length > 0) return { commands: blocks, tooMany: false, why: null };
  const one = /```/.test(reply) ? null : extractCommand(reply);
  return one === null
    ? { commands: [], tooMany: false, why: "no command" }
    : { commands: [one], tooMany: false, why: null };
}

export const fence = (cmds: string[]): string =>
  cmds.map((c) => `\`\`\`sh\n${c}\n\`\`\``).join("\n\n");

// ---- one row ------------------------------------------------------------------------------------

const builds = new Map<string, string>();
const buildOf = (s: Surface): string => {
  const b = builds.get(s.root) ?? buildId(s);
  builds.set(s.root, b);
  return b;
};

export interface PlayOpts {
  surface: Surface;
  surfaceLabel: string;
  arm: Arm;
  paraphrase: string;
  /** The model turn; gets the seeded state so a scripted answer can use it. */
  reply: (
    st: St,
    system: string,
    user: string,
  ) => Promise<{ text: string; tokens: number; error?: string }>;
  promptDir: string;
  gapMs?: number;
}

/** Seed, lead-in, prompt, answer, judge: one row. The sandbox lives for the row only. */
export async function playCase(c: NextCase, o: PlayOpts): Promise<ProbeRow> {
  const started = Date.now();
  const para = c.paraphrases.find((p) => p.id === o.paraphrase);
  if (!para) throw new Error(`${c.id}: no paraphrase ${o.paraphrase}`);
  const limitMs = c.limitMs ?? DEFAULT_LIMIT_MS;
  const row: ProbeRow = {
    kind: "probe",
    group: c.group,
    round: "check",
    case: c.id,
    role: c.role,
    paraphrase: para.id,
    leadIn: para.leadIn,
    arm: o.arm,
    surface: o.surfaceLabel,
    surfaceId: surfaceId(o.surface),
    build: buildOf(o.surface),
    model: "",
    rep: 0,
    promptSha: "",
    systemSha: SYSTEM_SHA,
    transcriptPath: "",
    leadInCalls: [],
    leadInExits: [],
    reply: "",
    commands: [],
    tooMany: false,
    perCommand: [],
    muCalls: [],
    hit: false,
    partial: false,
    invalid: false,
    why: [],
    stray: [],
    destructive: [],
    tokens: 0,
    ms: 0,
  };
  const sb = await createSandbox(o.surface, { env: { PI_SESSION_ID: ORCH_SESSION } });
  try {
    let st: St;
    try {
      st = await c.seed(sb);
    } catch (e) {
      // the seed is spelled in base grammar: a surface it fails on broke a base spelling (§1.4
      // lint 3), so the row is invalid like a failed lead-in, never a crash of the round
      row.invalid = true;
      row.why.push(`seed invalid: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
      return row;
    }
    const leadStart = Date.now();
    const steps = c.leadIn(sb, st, para.leadIn);
    const lead = await runLeadIn(sb, steps, c.shell, limitMs);
    row.leadInExits = lead.map((r) => (r.killed ? -1 : r.exit));
    for (const s of steps) {
      const bad = s.expect ? await s.expect(sb, st) : null;
      if (bad !== null) {
        row.invalid = true;
        row.why.push(`lead-in invalid: ${bad}`);
      }
    }
    row.leadInCalls = muCalls(sb)
      .filter((m) => m.start >= leadStart)
      .map((m) => ({ argv: m.argv, exit: m.exit }));
    const transcript = renderTranscript(lead);
    const system = systemPromptFor(o.surface, o.arm, limitMs);
    const user = userPrompt(transcript, para.goal);
    row.promptSha = sha12(`${system}\n\n${user}`);
    mkdirSync(o.promptDir, { recursive: true });
    row.transcriptPath = join(o.promptDir, `${row.promptSha}.txt`);
    if (!existsSync(row.transcriptPath))
      writeFileSync(row.transcriptPath, `${system}\n\n---- user ----\n\n${user}\n`);
    await sleep(o.gapMs ?? GAP_MS);
    const base = maxSeq(sb);
    if (row.invalid) return row;
    const reply = await o.reply(st, system, user);
    row.reply = reply.text;
    row.tokens = reply.tokens;
    if (reply.error !== undefined) {
      row.modelError = reply.error;
      row.why.push(`model error: ${reply.error.slice(0, 120)}`);
      return row;
    }
    const ex = extractCommands(reply.text);
    row.commands = ex.commands;
    row.tooMany = ex.tooMany;
    if (ex.why !== null) {
      row.why.push(ex.why);
      return row;
    }
    // an answer that reads the rig (scenario sources, judges, rows) is refused unrun: invalid
    const reads = rigReadsInCommands(
      ex.commands,
      rigGuard({
        surfaceRoot: o.surface.root,
        ownSandbox: sb.dir,
        home: sb.env.HOME,
        cwd: sb.repoDir,
      }),
    );
    if (reads.length > 0) {
      row.invalid = true;
      row.rigReads = reads;
      row.why.push(`rig read (refused): ${reads.join("; ")}`);
      return row;
    }
    const t0 = Date.now();
    const runs = await runAnswer(sb, ex.commands, {
      shell: c.shell,
      limitMs,
      go: c.go ? () => c.go?.(sb, st) ?? Promise.resolve() : undefined,
      gapMs: o.gapMs,
    });
    const calls = answerCalls(sb, t0);
    // what the path rules missed: an output that carries a rig file's canary read the rig
    const outs = runs.map((r) => `${r.stdout}${r.stderr}`);
    const leaked = [
      ...canaryInOutputs(outs),
      // a middle range of a rig file carries no canary: its names do (rig-fingerprint.ts)
      ...fingerprintInOutputs(outs, rigFingerprint({ surfaceRoot: o.surface.root }), {
        env: sb.env,
      }),
    ];
    if (leaked.length > 0) {
      row.invalid = true;
      row.rigReads = leaked;
      row.why.push(`rig read: ${leaked.join("; ")}`);
      return row;
    }
    const ctx: NextCtx = {
      sb,
      state: st,
      base,
      t0,
      runs,
      calls,
      output: runs.map((r) => strip(`${r.stdout}${r.stderr}`)).join("\n"),
    };
    row.perCommand = runs.map((r) => ({
      cmd: r.cmd,
      exit: r.code,
      killed: r.killed,
      start: r.start,
      end: r.end,
    }));
    row.muCalls = calls.map((m) => ({
      argv: m.argv,
      exit: m.exit,
      start: m.start,
      end: m.end,
      cmdIdx: cmdIdxOf(ctx, m),
    }));
    let effect: ColdEffect;
    try {
      effect = await c.judge(ctx);
    } catch (e) {
      effect = { hit: false, why: [`judge error: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const allow = c.allow ?? (() => false);
    row.stray = opsSince(sb, base)
      .filter((op) => !allow(op))
      .map((op) => `${op.intent ?? "?"} ${op.key}`);
    row.destructive = await destructiveEntries(ctx);
    const v = decideHit({
      effect,
      stray: row.stray,
      killed: runs.map((r) => r.killed),
      allowKilled: c.allowKilled === true,
      destructive: row.destructive.map((d) => d.entry),
      timed: c.timed ? timedViolations(ctx) : [],
    });
    row.hit = v.hit;
    row.partial = v.partial;
    row.why.push(...v.why);
    return row;
  } finally {
    row.ms = Date.now() - started;
    await sb.close();
  }
}

// ---- runNext ------------------------------------------------------------------------------------

export const rowKey = (r: {
  round: string;
  surface: string;
  model: string;
  case: string;
  arm: string;
  paraphrase: string;
  rep: number;
}): string => [r.round, r.surface, r.model, r.case, r.arm, r.paraphrase, r.rep].join("|");

const jobKey = (j: NextJob): string => rowKey({ ...j, surface: j.surfaceLabel, case: j.caseId });

export function readProbeRows(file: string): ProbeRow[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ProbeRow);
}

/** A counting semaphore. */
function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    while (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** The scripted replies of the evalfaux models for one row: the case's golden and bad, fenced. */
export const fauxReplies = (c: NextCase, st: St, v: "a" | "b"): Record<string, string> => ({
  "evalfaux/golden": fence(c.golden(st, v)),
  "evalfaux/bad": fence(c.bad(st, v)),
});

export async function runNext(o: RunNextOpts): Promise<{ written: number; skipped: number }> {
  const cases = o.cases ?? NEXT_CASES;
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const j of o.jobs) if (!byId.has(j.caseId)) throw new Error(`unknown case ${j.caseId}`);
  const surfaces = [...new Map(o.jobs.map((j) => [j.surfaceLabel, j.surface])).entries()].map(
    ([label, surface]) => ({ label, surface }),
  );
  const ids = [...new Set(o.jobs.map((j) => j.caseId))];
  const lint = nextLint(
    surfaces,
    cases.filter((c) => ids.includes(c.id)),
  );
  if (lint.failures.length > 0)
    throw new Error(`nextstep lint failed:\n  ${lint.failures.join("\n  ")}`);
  const done = new Set(readProbeRows(o.out).map(rowKey));
  const seen = new Set<string>();
  const queue = o.jobs.filter((j) => {
    const k = jobKey(j);
    if (done.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const skipped = o.jobs.length - queue.length;
  const perProvider = new Map<string, ReturnType<typeof limiter>>();
  const providerSlot = (model: string): ReturnType<typeof limiter> => {
    const p = model.split("/")[0] ?? model;
    const l = perProvider.get(p) ?? limiter(Math.max(1, o.modelConcurrency));
    perProvider.set(p, l);
    return l;
  };
  let written = 0;
  const worker = async (claim: Claim): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const c = byId.get(job.caseId);
      if (!c) continue;
      const para = c.paraphrases.find((p) => p.id === job.paraphrase);
      try {
        const row = await claim(() =>
          playCase(c, {
            surface: job.surface,
            surfaceLabel: job.surfaceLabel,
            arm: job.arm,
            paraphrase: job.paraphrase,
            promptDir: o.promptDir,
            reply: async (st, system, user) => {
              const faux = fauxReplies(c, st, para?.leadIn ?? "a");
              const ask = () => askModel(job.model, system, user, o.providerExt, faux);
              const slot = providerSlot(job.model);
              let r = await slot(ask);
              for (let i = 0; i < 2 && r.error !== undefined; i++) r = await slot(ask);
              return r;
            },
          }),
        );
        row.round = job.round;
        row.group = job.group;
        row.model = job.model;
        row.rep = job.rep;
        mkdirSync(dirname(o.out), { recursive: true });
        appendFileSync(o.out, `${JSON.stringify(row)}\n`);
        written++;
        o.onRow?.(row);
      } catch (e) {
        console.error(
          `nextstep row failed: ${jobKey(job)}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  };
  await rowPool("probe", o.concurrency, worker);
  return { written, skipped };
}

// ---- check --------------------------------------------------------------------------------------

export interface CheckResult {
  case: string;
  leadIn: "a" | "b";
  kind: string;
  expect: "hit" | "miss";
  ok: boolean;
  row: ProbeRow;
}

/** The lead-in variants a case's paraphrases use, each with its first paraphrase. */
export const variantsOf = (c: NextCase): { v: "a" | "b"; paraphrase: string }[] =>
  (["a", "b"] as const).flatMap((v) => {
    const p = c.paraphrases.find((x) => x.leadIn === v);
    return p ? [{ v, paraphrase: p.id }] : [];
  });

/** §1.5 check, zero model cost: per case and lead-in variant the golden hits, the bad and `true` miss, every extra gives its expect, every lead-in expect passes. */
export async function runNextCheck(
  surface: Surface,
  o: { cases?: NextCase[]; concurrency?: number; log?: (l: string) => void } = {},
): Promise<{ failures: number; results: CheckResult[] }> {
  const log = o.log ?? console.log;
  const promptDir = mkdtempSync(join(tmpdir(), "mu-nextstep-check-"));
  const jobs: {
    c: NextCase;
    v: "a" | "b";
    paraphrase: string;
    kind: string;
    expect: "hit" | "miss";
    partial?: boolean;
    cmds: (st: St) => string[];
  }[] = [];
  for (const c of o.cases ?? NEXT_CASES)
    for (const { v, paraphrase } of variantsOf(c)) {
      jobs.push({ c, v, paraphrase, kind: "golden", expect: "hit", cmds: (st) => c.golden(st, v) });
      jobs.push({
        c,
        v,
        paraphrase,
        kind: "bad",
        expect: "miss",
        ...(c.badPartial ? { partial: true } : {}),
        cmds: (st) => c.bad(st, v),
      });
      jobs.push({ c, v, paraphrase, kind: "true", expect: "miss", cmds: () => ["true"] });
      // extras are listed from a placeholder state; the commands are rebuilt from the real one
      c.extras(STUB_ST, v).forEach((x, i) => {
        jobs.push({
          c,
          v,
          paraphrase,
          kind: `${x.label}${i + 1}`,
          expect: x.expect,
          ...(x.partial ? { partial: true } : {}),
          cmds: (st) => c.extras(st, v)[i]?.cmds ?? [],
        });
      });
    }
  const results: CheckResult[] = [];
  try {
    const worker = async (claim: Claim): Promise<void> => {
      for (let j = jobs.shift(); j !== undefined; j = jobs.shift()) {
        const row = await claim(() =>
          playCase(j.c, {
            surface,
            surfaceLabel: "check",
            arm: "none",
            paraphrase: j.paraphrase,
            promptDir,
            reply: async (st) => ({ text: fence(j.cmds(st)), tokens: 0 }),
          }),
        );
        const partialOk = j.partial !== true || row.partial;
        const ok = !row.invalid && (j.expect === "hit" ? row.hit : !row.hit) && partialOk;
        results.push({ case: j.c.id, leadIn: j.v, kind: j.kind, expect: j.expect, ok, row });
        const exp = `${j.expect}${j.partial ? ", partial" : ""}`;
        log(
          `${ok ? "ok  " : "FAIL"} ${j.c.id}/${j.v} ${j.kind} (expect ${exp})${partialOk ? "" : " [not partial]"}${row.why.length > 0 ? `: ${row.why.join("; ").slice(0, 200)}` : ""}`,
        );
      }
    };
    await rowPool("probe", o.concurrency ?? 4, worker);
  } finally {
    rmSync(promptDir, { recursive: true, force: true });
  }
  const failures = results.filter((r) => !r.ok).length;
  log(
    failures === 0 ? "nextstep check: every row as expected" : `nextstep check: ${failures} FAILED`,
  );
  return { failures, results };
}

// ---- lint ---------------------------------------------------------------------------------------

export interface NameCue {
  case: string;
  paraphrase: string;
  variant: string;
  word: string;
}

/** A stand-in sandbox and state for listing a lead-in without running it. */
const STUB_SB = {
  dir: "/sb",
  env: {},
  binDir: "/sb/bin",
  repoDir: "/sb/repo",
  workerDir: "/sb/workers",
  tmuxSocket: "sb",
  dbPath: "/sb/mu.db",
  surface: { name: "stub", root: "/sb", cli: "", extension: "", skillDir: "" },
  close: async () => {},
} satisfies Sandbox;
const STUB_ST: St = new Proxy({}, { get: (_t, k) => `<${String(k)}>` });

/**
 * §1.4 lint. Goal neutrality against every surface's vocab (a base name fails; a name only a variant
 * has is a nameCue for that variant), the lead-in's first-reach verbs, the last lead-in step being
 * a mu call, and the paraphrase count (headline 10, guard 6, at most 14).
 */
/** A surface's names, read once per process (help walks run mu dozens of times). */
const vocabs = new Map<string, Set<string>>();

export function nextLint(
  surfaces: { label: string; surface: Surface }[],
  cases: NextCase[] = NEXT_CASES,
  baseLabel = "base",
): { failures: string[]; nameCues: NameCue[] } {
  const vocabOf = (s: Surface): Set<string> => {
    const v = vocabs.get(s.cli) ?? surfaceVocab(s);
    vocabs.set(s.cli, v);
    return v;
  };
  const vocab = Object.fromEntries(surfaces.map((s) => [s.label, vocabOf(s.surface)]));
  return nextLintVocab(vocab, cases, baseLabel);
}

/** nextLint over given vocabularies (label -> names); the base is `baseLabel`, else the first label. */
export function nextLintVocab(
  vocab: Record<string, Set<string>>,
  cases: NextCase[],
  baseLabel = "base",
): { failures: string[]; nameCues: NameCue[] } {
  const labels = Object.keys(vocab);
  const base = labels.includes(baseLabel) ? baseLabel : labels[0];
  const failures: string[] = [];
  const nameCues: NameCue[] = [];
  for (const c of cases) {
    const need = c.role === "headline" ? 10 : 6;
    if (c.paraphrases.length < need || c.paraphrases.length > 14)
      failures.push(`${c.id}: ${c.paraphrases.length} paraphrases (want ${need}..14)`);
    const goals = c.paraphrases.map((p) => ({ id: p.id, text: p.goal, payload: p.payload }));
    for (const l of neutralityLeaks(goals, vocab)) {
      if (base !== undefined && l.surfaces.includes(base))
        failures.push(`${c.id}/${l.intent}: "${l.word}" is a name on ${base}`);
      else
        for (const variant of l.surfaces)
          nameCues.push({ case: c.id, paraphrase: l.intent, variant, word: l.word });
    }
    for (const { v } of variantsOf(c)) {
      const steps = c.leadIn(STUB_SB, STUB_ST, v);
      const last = steps[steps.length - 1]?.cmd ?? "";
      if (!/^\s*mu\s/.test(last))
        failures.push(`${c.id}/${v}: the last lead-in step is not a mu call: ${last}`);
      for (const s of steps)
        for (const call of muInText(s.cmd)) {
          const verb = firstReach(call).verb;
          if (!c.leadInVerbs.includes(verb))
            failures.push(`${c.id}/${v}: lead-in uses "${verb}", not in leadInVerbs`);
        }
    }
  }
  return { failures, nameCues };
}

// ---- selftest -----------------------------------------------------------------------------------

/** §1.5 selftest: the whole path with the scripted evalfaux models, zero cost. 0 when every check holds. */
export async function nextSelftest(
  surface: Surface,
  o: { cases?: NextCase[]; log?: (l: string) => void } = {},
): Promise<number> {
  const log = o.log ?? console.log;
  const cases = o.cases ?? NEXT_CASES;
  const dir = mkdtempSync(join(tmpdir(), "mu-nextstep-selftest-"));
  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) failures++;
    log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `: ${detail}` : ""}`);
  };
  try {
    const out = join(dir, "probe.jsonl");
    const promptDir = join(dir, "prompts");
    const jobs: NextJob[] = cases.flatMap((c) =>
      variantsOf(c).flatMap(({ paraphrase }) =>
        (["evalfaux/golden", "evalfaux/bad"] as const).map((model) => ({
          round: "check" as const,
          group: c.group,
          surfaceLabel: "base",
          surface,
          model,
          caseId: c.id,
          arm: (model === "evalfaux/golden" ? c.arms[c.arms.length - 1] : "none") ?? "none",
          paraphrase,
          rep: 1,
        })),
      ),
    );
    const opts = {
      jobs,
      out,
      promptDir,
      concurrency: 4,
      modelConcurrency: 4,
      cases,
    };
    const first = await runNext(opts);
    check(
      `runNext wrote ${jobs.length} rows`,
      first.written === jobs.length,
      JSON.stringify(first),
    );
    const rows = readProbeRows(out);
    for (const r of rows) {
      const name = `${r.case}/${r.leadIn} ${r.model} ${r.arm}`;
      if (r.model === "evalfaux/golden") check(`${name} hits`, r.hit, r.why.join("; "));
      else check(`${name} misses`, !r.hit && !r.invalid, r.why.join("; "));
      check(
        `${name} ran its commands`,
        r.commands.length > 0 && r.perCommand.length === r.commands.length,
      );
      const prompt = existsSync(r.transcriptPath) ? readFileSync(r.transcriptPath, "utf8") : "";
      check(
        `${name} prompt stored under its sha`,
        prompt.includes("<transcript>") && r.promptSha !== "",
      );
      check(
        `${name} prompt carries its arm`,
        r.arm === "none"
          ? !prompt.includes("<skill>")
          : prompt.includes("<skill>") &&
              (!r.arm.startsWith("recipe:") || prompt.includes("<recipe name=")),
      );
      check(`${name} zero tokens`, r.tokens === 0 && r.systemSha === SYSTEM_SHA);
    }
    const again = await runNext(opts);
    check(
      "runNext resumes: nothing rerun",
      again.written === 0 && again.skipped === jobs.length,
      JSON.stringify(again),
    );
    const rep = nextReport(out, {});
    check(
      "nextstep report renders the rows",
      rep.code === 0 && rep.text.includes(`rows: ${jobs.length}`),
      rep.text.slice(0, 200),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  log(failures === 0 ? "nextstep selftest: ok" : `nextstep selftest: ${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
