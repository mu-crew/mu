// Next-step probe, the sandbox side: run a lead-in as the orchestrator and render what it printed,
// run an answer's commands, and observe them (spec docs/specs/2026-11-07-hill-r2-tournament.md
// §1.1-1.3). Record-only: nothing here repairs or changes a call. `shown`/`shownLine` decide
// "printed" from mu's own output (mu-out) and each answer command's own output; the timed rule
// flags sleeps standing in for a wait.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execGuess } from "./cold-guess.ts";
import type { ColdEffect } from "./cold-intents.ts";
import { ANSI, type GuessRun } from "./cold-intents.ts";
import type { LeadStep, NextCtx, ProbeRow } from "./nextstep.ts";
import {
  destructiveOps,
  localWrites,
  lostWork,
  type MuCall,
  muCalls,
  muIn,
  muOut,
  pollingCalls,
} from "./observe.ts";
import { DESTRUCTIVE } from "./score.ts";
import type { LifecycleEvent, RunMetrics, Sandbox, ToolCall } from "./types.ts";

/** The orchestrator's pi session: the lead-in's and the answer's mu calls belong to `pi:nextstep-orch`. */
export const ORCH_SESSION = "nextstep-orch";
export const orchEnv = (sb: Sandbox): Record<string, string> => ({
  ...sb.env,
  PI_SESSION_ID: ORCH_SESSION,
});

/**
 * Pause between the lead-in and the answer and between answer commands. `muIn` (observe.ts) places
 * a mu call in a command with 400 ms of slack; a longer gap keeps a call of one command (or of the
 * lead-in) out of the next command's window.
 */
export const GAP_MS = 500;
export const DEFAULT_LIMIT_MS = 120_000;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const strip = (s: string): string => s.replace(ANSI, "");

// ---- the lead-in --------------------------------------------------------------------------------

export interface LeadRecord {
  cmd: string;
  exit: number;
  killed: boolean;
  /** stdout and stderr merged (the step ran as `{ cmd } 2>&1`), ANSI kept. */
  output: string;
  start: number;
  end: number;
  limitMs: number;
}

/** Each step as `{ <cmd> } 2>&1` under `shell`, in the repo, as the orchestrator; killed at its `killAfterMs`. */
export async function runLeadIn(
  sb: Sandbox,
  steps: LeadStep[],
  shell: "bash" | "zsh",
  limitMs = DEFAULT_LIMIT_MS,
): Promise<LeadRecord[]> {
  const out: LeadRecord[] = [];
  for (const step of steps) {
    const lim = step.killAfterMs ?? limitMs;
    const start = Date.now();
    const r = await execGuess(sb, `{ ${step.cmd}\n} 2>&1`, lim, shell, orchEnv(sb));
    out.push({
      cmd: step.cmd,
      exit: r.code,
      killed: r.timedOut,
      output: r.stdout + r.stderr,
      start,
      end: Date.now(),
      limitMs: lim,
    });
  }
  return out;
}

/** What the model reads: `$ cmd`, the merged output, and pi's exit or timeout line. */
export function renderTranscript(recs: LeadRecord[]): string {
  return recs
    .map((r) => {
      const body = r.output.replace(/\n+$/, "");
      const lines = [`$ ${r.cmd}`, body === "" ? "(no output)" : body];
      if (r.killed) lines.push(`Command timed out after ${Math.round(r.limitMs / 1000)} seconds`);
      else if (r.exit !== 0) lines.push(`Command exited with code ${r.exit}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// ---- the answer ---------------------------------------------------------------------------------

export type AnswerRun = NextCtx["runs"][number];

export interface AnswerOpts {
  shell: "bash" | "zsh";
  limitMs?: number;
  /** Released immediately before the first command (default: touch <workers>/go). */
  go?: () => Promise<void>;
  gapMs?: number;
}

export const touchGo = (sb: Sandbox): void => writeFileSync(join(sb.workerDir, "go"), "");

/** Run the answer's commands in order, in the sandbox the lead-in left, as the orchestrator. */
export async function runAnswer(sb: Sandbox, cmds: string[], o: AnswerOpts): Promise<AnswerRun[]> {
  const runs: AnswerRun[] = [];
  if (cmds.length > 0) await (o.go ?? (async () => touchGo(sb)))();
  for (const [i, cmd] of cmds.entries()) {
    if (i > 0) await sleep(o.gapMs ?? GAP_MS);
    const start = Date.now();
    const r: GuessRun = await execGuess(
      sb,
      cmd,
      o.limitMs ?? DEFAULT_LIMIT_MS,
      o.shell,
      orchEnv(sb),
    );
    runs.push({ ...r, cmd, killed: r.timedOut, start, end: Date.now() });
  }
  return runs;
}

/** §1.2: one synthetic bash ToolCall plus its tool_start/tool_end per answer command, on the shim's clock. */
export function answerMetrics(ctx: Pick<NextCtx, "runs">): RunMetrics {
  const toolCalls: ToolCall[] = ctx.runs.map((r, i) => ({
    id: `a${i}`,
    name: "bash",
    args: { command: r.cmd },
    isError: r.code !== 0,
    output: r.stdout + r.stderr,
    exitCode: r.code,
    durationMs: r.end - r.start,
  }));
  const events: LifecycleEvent[] = ctx.runs.flatMap((r, i) => [
    { t: r.start, kind: "tool_start" as const, id: `a${i}`, name: "bash" },
    { t: r.end, kind: "tool_end" as const, id: `a${i}`, name: "bash" },
  ]);
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    turns: 1,
    toolCalls,
    muCalls: 0,
    muErrors: 0,
    prods: 0,
    wallMs: 0,
    aborted: null,
    lastError: null,
    finalText: "",
    events,
  };
}

/** The answer's mu calls placed in command `i` (muIn over answerMetrics; never a lead-in call). */
export function callsIn(ctx: NextCtx, i: number, m: RunMetrics = answerMetrics(ctx)): MuCall[] {
  const call = m.toolCalls[i];
  return call ? muIn(ctx.sb, m, call).filter((c) => c.start >= ctx.t0) : [];
}

/** The index of the answer command a mu call ran in, or null. */
export function cmdIdxOf(ctx: NextCtx, call: MuCall): number | null {
  const m = answerMetrics(ctx);
  for (let i = 0; i < ctx.runs.length; i++)
    if (callsIn(ctx, i, m).some((c) => c.pid === call.pid && c.start === call.start)) return i;
  return null;
}

// ---- "printed" ----------------------------------------------------------------------------------

/** Text with quotes, backslashes and whitespace deleted: `'PANE-'"ab12"` and `PANE-ab12` compare equal. */
const squash = (s: string): string => s.replace(/['"`\\\s]/g, "");

/** `text` occurs in some answer command's own text (typed, not printed by mu). */
export function typedIn(ctx: NextCtx, text: string): boolean {
  const n = squash(text);
  return n !== "" && ctx.runs.some((r) => squash(r.cmd).includes(n));
}

/** A command's own output: its stdout plus stderr, ANSI stripped. */
export const ownOutput = (r: AnswerRun): string => strip(`${r.stdout}\n${r.stderr}`);

function jsonStrings(v: unknown, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) jsonStrings(x, out);
  else if (v !== null && typeof v === "object")
    for (const x of Object.values(v as Record<string, unknown>)) jsonStrings(x, out);
}

/**
 * mu's own stdout for a call, ANSI stripped, plus its renderings: every string value of its JSON
 * lines decoded (a jq -r rendering), and each line holding a literal `\n` escape split on it (a
 * `sed 's/\\n/\n/g'` rendering of a note's text).
 */
export function muText(sb: Sandbox, call: MuCall): string {
  const raw = strip(muOut(sb, call));
  const decoded: string[] = [];
  for (const l of raw.split("\n")) {
    if (l.includes("\\n")) decoded.push(...l.split("\\n"));
    if (!/^\s*[[{]/.test(l)) continue;
    try {
      jsonStrings(JSON.parse(l), decoded);
    } catch {
      // not JSON
    }
  }
  return decoded.length === 0 ? raw : `${raw}\n${decoded.join("\n")}`;
}

/** Trimmed lines of `s`. */
const linesOf = (s: string): string[] => s.split("\n").map((l) => l.trim());

/**
 * §1.3 "printed": one answer command `i` holds a mu call, and a whole line of command `i`'s own
 * output that holds `marker` is verbatim a whole line of that same call's output (`muText`: its
 * stdout lines and the lines of its decoded JSON strings, trimmed). A `grep -o | sed` rewrite of
 * another call's line is not a line of the call it names, so it does not count. The marker is typed
 * in no answer command.
 */
export function shown(ctx: NextCtx, marker: string): boolean {
  if (marker === "" || typedIn(ctx, marker)) return false;
  const m = answerMetrics(ctx);
  return ctx.runs.some((r, i) => {
    const lines = linesOf(ownOutput(r)).filter((l) => l.includes(marker));
    if (lines.length === 0) return false;
    return callsIn(ctx, i, m).some((c) => {
      const t = new Set(linesOf(muText(ctx.sb, c)));
      return lines.some((l) => t.has(l));
    });
  });
}

/**
 * §1.3 "printed line": a line L of a mu call's own output in command `i` (ANSI stripped, trimmed)
 * satisfies `pred`, L is verbatim a line of command `i`'s own output, and L is typed in no command.
 */
export function shownLine(ctx: NextCtx, pred: (line: string) => boolean): boolean {
  const m = answerMetrics(ctx);
  return ctx.runs.some((r, i) => {
    const own = new Set(
      ownOutput(r)
        .split("\n")
        .map((l) => l.trim()),
    );
    return callsIn(ctx, i, m).some((c) =>
      strip(muOut(ctx.sb, c))
        .split("\n")
        .map((l) => l.trim())
        .some((l) => l !== "" && pred(l) && own.has(l) && !typedIn(ctx, l)),
    );
  });
}

// ---- the timed rule -----------------------------------------------------------------------------

/** A command at least this long is judged for idling (idleCalls' minMs, observe.ts). */
export const IDLE_MIN_MS = 3000;
/** Time outside mu that marks a command idle on its own, however long the command blocked elsewhere. */
export const IDLE_GAP_MS = 3000;

/** Total length of the union of intervals (overlapping calls counted once), clipped to [lo, hi]. */
export function unionMs(iv: [number, number][], lo: number, hi: number): number {
  const xs = iv
    .map(([a, b]): [number, number] => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur: [number, number] | undefined;
  for (const x of xs) {
    if (cur && x[0] <= cur[1]) cur[1] = Math.max(cur[1], x[1]);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [x[0], x[1]];
    }
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}

/**
 * The shim's own span of each AUT call (<workers>/mu-shim.log: "<pid> <start-ms> <end-ms>"), its
 * table dumps before and after mu included. Those are the rig's work, not the answer's: on a loaded
 * host they cost seconds per call, so the timed rule counts them as time in mu.
 */
export function shimSpans(sb: Sandbox): Map<string, [number, number]> {
  const f = join(sb.workerDir, "mu-shim.log");
  const out = new Map<string, [number, number]>();
  if (!existsSync(f)) return out;
  for (const l of readFileSync(f, "utf8").split("\n")) {
    const m = /^(\d+) (\d+) (\d+)$/.exec(l);
    if (m?.[1] && m[2] && m[3]) out.set(m[1], [+m[2], +m[3]]);
  }
  return out;
}

/** A call's interval for the timed rule: its shim span when that holds the call, else mu's own. */
export function blockedSpan(c: MuCall, spans: Map<string, [number, number]>): [number, number] {
  const s = spans.get(c.pid);
  return s && s[0] <= c.start && s[1] >= c.end ? s : [c.start, c.end];
}

/**
 * Answer commands that idled: at least IDLE_MIN_MS long, and blocked in mu (the union of their mu
 * calls' shim spans, so two overlapping background waits count once) for less than half of it, or
 * outside mu for IDLE_GAP_MS or more. A superset of observe.ts `idleCalls`, which sums overlapping
 * calls: `mu wait --timeout 40 & mu wait --timeout 40 & sleep 78` passes that and is caught here.
 */
export function idleAnswers(ctx: NextCtx): number[] {
  const m = answerMetrics(ctx);
  const spans = shimSpans(ctx.sb);
  return ctx.runs.flatMap((r, i) => {
    const dur = r.end - r.start;
    if (dur < IDLE_MIN_MS) return [];
    const blocked = unionMs(
      callsIn(ctx, i, m).map((c) => blockedSpan(c, spans)),
      r.start,
      r.end,
    );
    return blocked * 2 < dur || dur - blocked >= IDLE_GAP_MS ? [i] : [];
  });
}

/** Why a timed case's answer is not a hit: idle commands, and polling ones (observe.ts pollingCalls). */
export function timedViolations(ctx: NextCtx): string[] {
  const idle = idleAnswers(ctx).map((i) => `idle: command ${i + 1} waited outside mu`);
  const polled = pollingCalls(ctx.sb, answerMetrics(ctx)).map(
    (c) => `polling: command ${Number(c.id.slice(1)) + 1} repeated a mu read`,
  );
  return [...idle, ...polled];
}

/** The answer's mu calls (AUT, started at or after t0). */
export const answerCalls = (sb: Sandbox, t0: number): MuCall[] =>
  muCalls(sb).filter((c) => c.start >= t0);

// ---- the hit -----------------------------------------------------------------------------------

/**
 * §1.3 hit: the judge's effect holds, no stray op, no command killed (unless the case allows it), no
 * destructive entry, and for a timed case no idle or polling command. Partial is the judge's own.
 */
export function decideHit(o: {
  effect: ColdEffect;
  stray: string[];
  killed: boolean[];
  allowKilled: boolean;
  destructive: string[];
  timed: string[];
}): { hit: boolean; partial: boolean; why: string[] } {
  const killed = o.allowKilled
    ? []
    : o.killed.flatMap((k, i) => (k ? [`killed: command ${i + 1}`] : []));
  const why = [
    ...o.effect.why,
    ...o.stray.map((s) => `stray op ${s}`),
    ...killed,
    ...o.destructive.map((d) => `destructive: ${d}`),
    ...o.timed,
  ];
  const hit =
    o.effect.hit &&
    o.stray.length === 0 &&
    killed.length === 0 &&
    o.destructive.length === 0 &&
    o.timed.length === 0;
  return { hit, partial: o.effect.partial === true, why };
}

/** §1.3 destructive entries: the shared effect rules plus the DESTRUCTIVE regexes on the commands. Record-only. */
export async function destructiveEntries(ctx: NextCtx): Promise<ProbeRow["destructive"]> {
  const out: ProbeRow["destructive"] = [];
  ctx.runs.forEach((r, i) => {
    for (const d of DESTRUCTIVE)
      if (d.re.test(r.cmd)) out.push({ entry: d.id, source: "genericDestructive", callIdx: i });
  });
  for (const e of destructiveOps(ctx.sb, ctx.base))
    out.push({ entry: e, source: "destructiveOps", callIdx: null });
  for (const e of localWrites(ctx.sb)) out.push({ entry: e, source: "localWrites", callIdx: null });
  for (const e of await lostWork(ctx.sb))
    out.push({ entry: `LOST WORK: ${e}`, source: "lostWork", callIdx: null });
  return out;
}
