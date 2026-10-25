// Scripted faux-agent step selection. Pure logic plus the <workerDir> control files; no pi import,
// so vitest can exercise it. faux.ts wires it to pi's fauxProvider.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FauxCall = { bash: string } | { tool: string; args?: Record<string, unknown> };

/** One step = one assistant message. */
export type FauxStep =
  | { calls: FauxCall[] }
  | { text: string }
  | { error: string }
  | { die: true }
  | { textFromLastResult: true };

/** What the provider should emit for one model call. */
export type FauxAction =
  | { kind: "calls"; calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }
  | { kind: "die" };

export const DEFAULT_SCRIPT: FauxStep[] = [{ text: "(no script)" }];

function readSteps(path: string): FauxStep[] | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? (parsed as FauxStep[]) : null;
}

/** AUT script: a JSON file at `path`. */
export function loadAutScript(path: string | undefined): FauxStep[] {
  return (path ? readSteps(path) : null) ?? DEFAULT_SCRIPT;
}

/**
 * Worker script by attempt: <agent>.<n>.json, then <agent>.json, then default.json.
 * attempt = 1 + prior loads, counted in <workerDir>/<agent>.attempts (bumped here).
 */
export function loadWorkerScript(workerDir: string, agent: string): FauxStep[] {
  const counter = join(workerDir, `${agent}.attempts`);
  const prior = existsSync(counter) ? Number.parseInt(readFileSync(counter, "utf8"), 10) || 0 : 0;
  writeFileSync(counter, String(prior + 1));
  const attempt = prior + 1;
  for (const name of [`${agent}.${attempt}.json`, `${agent}.json`, "default.json"]) {
    const steps = readSteps(join(workerDir, name));
    if (steps) return steps;
  }
  return DEFAULT_SCRIPT;
}

export interface StepContext {
  /** Text of the latest user message. */
  lastUser: string;
  /** Text of the latest tool result, or null when the transcript does not end in one. */
  lastResult: string | null;
  /** Messages in the session at this model call: a prompt that sees 1 started a fresh session. */
  messages?: number;
}

export class FauxScript {
  private idx = 0;
  private lastCalls = -1;

  private readonly steps: FauxStep[];
  /** Control-file directory; null disables last-prompt / die-next / error-next. */
  private readonly workerDir: string | null;
  /** Control-file suffix: MU_AGENT_NAME for workers, "aut" for the AUT. */
  private readonly agent: string;

  constructor(steps: FauxStep[], workerDir: string | null, agent: string) {
    this.steps = steps;
    this.workerDir = workerDir;
    this.agent = agent;
  }

  /** Index of the next step to run (exposed for tests). */
  get position(): number {
    return this.idx;
  }

  private ctl(prefix: string): string | null {
    return this.workerDir ? join(this.workerDir, `${prefix}.${this.agent}`) : null;
  }

  private consume(prefix: string): boolean {
    const file = this.ctl(prefix);
    if (!file || !existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }

  next(ctx: StepContext): FauxAction {
    const prompt = this.ctl("last-prompt");
    if (prompt) writeFileSync(prompt, ctx.lastUser);
    // Observed effect, not a claim: every prompt that reached this agent's model, with the session
    // length it arrived into. "<ms> <agent> <messages> <text>" in <workerDir>/prompts.log.
    if (this.workerDir && this.agent !== "aut" && ctx.lastResult === null)
      appendFileSync(
        join(this.workerDir, "prompts.log"),
        `${Date.now()} ${this.agent} ${ctx.messages ?? 0} ${ctx.lastUser.replace(/\s+/g, " ").slice(0, 300)}\n`,
      );
    if (this.consume("die-next")) return { kind: "die" };
    if (this.consume("error-next")) {
      // Re-run the calls step that just ran; before any calls step the index stays put.
      if (this.lastCalls >= 0) this.idx = this.lastCalls;
      return { kind: "error", message: "529 overloaded_error" };
    }
    const step = this.steps[this.idx];
    if (step === undefined) return { kind: "text", text: "(script exhausted)" };
    const at = this.idx++;
    return this.act(step, at, ctx);
  }

  private act(step: FauxStep, at: number, ctx: StepContext): FauxAction {
    const s = step as Record<string, unknown>;
    if (Array.isArray(s.calls)) {
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      for (const c of s.calls as Array<Record<string, unknown>>) {
        if (typeof c?.bash === "string") calls.push({ name: "bash", args: { command: c.bash } });
        else if (typeof c?.tool === "string") {
          const args =
            c.args && typeof c.args === "object" ? (c.args as Record<string, unknown>) : {};
          calls.push({ name: c.tool, args });
        } else return { kind: "text", text: "(bad step)" };
      }
      if (calls.length === 0) return { kind: "text", text: "(bad step)" };
      this.lastCalls = at;
      return { kind: "calls", calls };
    }
    if (typeof s.text === "string") return { kind: "text", text: s.text };
    if (typeof s.error === "string") return { kind: "error", message: s.error };
    if (s.die === true) return { kind: "die" };
    if (s.textFromLastResult === true) {
      const t = (ctx.lastResult ?? "").trim();
      return { kind: "text", text: t === "" ? "(empty result)" : t };
    }
    return { kind: "text", text: "(bad step)" };
  }
}
