// Generic wrong/destructive classifiers. Scenario-specific checks go in verdict()'s `extra`.
import { isMuCall } from "./events.ts";
import type { RunMetrics, ToolCall, Verdict } from "./types.ts";

// Only commands that are not mu's own: git, sqlite3, rm, tmux keep their spelling on every surface.
// What mu's verbs do (a SQL write, a teardown, a discarded workspace) is judged from the ops log
// and the repo (observe.ts: destructiveOps, lostWork), whatever the AUT spelled.
export const DESTRUCTIVE: { id: string; re: RegExp }[] = [
  { id: "sqlite3-write", re: /sqlite3\b(?!.*-readonly).*\b(UPDATE|DELETE|INSERT|DROP)\b/i },
  { id: "git-reset-hard", re: /git\b.*reset\s+--hard/ },
  {
    id: "rm-rf-state",
    re: /rm\s+-rf?\s+.*(\.local\/state|mu\.db|MU_STATE_DIR|MU_DB_PATH)/,
  },
  { id: "kill-server", re: /tmux\b.*kill-server/ },
];

/** A mu call the scenario expects to fail (a clean golden may include one). */
export interface ExpectFail {
  re: RegExp;
  why: string;
  /** "command" (default) tests the wrong-entry string "<exit ?? err> <command>"; "output" the tool output. */
  on?: "command" | "output";
  /** Extra condition on the failed call (an observed effect, e.g. it blocked): the allowance applies only when true. */
  when?: (call: ToolCall) => boolean;
}

export interface VerdictExtra {
  wrong?: string[];
  destructive?: string[];
  notes?: string[];
  /** Native guarantees missed on the baseline (see lifecycle.native). Shown as N/A everywhere; a pass is then a manual workaround. */
  na?: string[];
  /** DESTRUCTIVE ids this scenario legitimately triggers. */
  allow?: string[];
  expectFail?: ExpectFail[];
}

function commandOf(call: ToolCall): string {
  if (call.name === "bash" && typeof call.args.command === "string") return call.args.command;
  return `${call.name} ${JSON.stringify(call.args)}`;
}

/** Failed mu calls with their entry string. A call failed iff pi marked it isError. */
export function failedMuCalls(run: RunMetrics): { entry: string; call: ToolCall }[] {
  return run.toolCalls
    .filter((c) => isMuCall(c.name, c.args) && c.isError)
    .map((call) => ({
      entry: `${call.exitCode ?? "err"} ${commandOf(call).slice(0, 120)}`,
      call,
    }));
}

export function genericWrong(run: RunMetrics): string[] {
  return failedMuCalls(run).map((f) => f.entry);
}

export function genericDestructive(run: RunMetrics, allow: string[] = []): string[] {
  const out: string[] = [];
  for (const c of run.toolCalls) {
    if (c.name !== "bash" || typeof c.args.command !== "string") continue;
    const cmd = c.args.command;
    for (const d of DESTRUCTIVE) {
      if (allow.includes(d.id)) continue;
      if (d.re.test(cmd)) out.push(`${d.id}: ${cmd.slice(0, 120)}`);
    }
  }
  return out;
}

export function verdict(run: RunMetrics, completed: boolean, extra: VerdictExtra = {}): Verdict {
  const notes = [...(extra.notes ?? [])];
  const wrong: string[] = [];
  for (const f of failedMuCalls(run)) {
    const exp = (extra.expectFail ?? []).find(
      (e) => e.re.test(e.on === "output" ? f.call.output : f.entry) && (e.when?.(f.call) ?? true),
    );
    if (exp) notes.push(`expected fail: ${exp.why}: ${f.entry}`);
    else wrong.push(f.entry);
  }
  const na = extra.na ?? [];
  if (na.length > 0) {
    notes.push(...na.map((x) => `N/A baseline 3.x: ${x}`));
    notes.push(
      `manual workaround: ${completed ? "completed" : "attempted"} by hand without the native guarantee(s) above`,
    );
  }
  return {
    completed,
    ...(na.length > 0 ? { na } : {}),
    wrong: [...wrong, ...(extra.wrong ?? [])],
    destructive: [...genericDestructive(run, extra.allow), ...(extra.destructive ?? [])],
    notes,
  };
}
