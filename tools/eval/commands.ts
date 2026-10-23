// run / matrix / report / check: the commands that drive scenarios. main.ts dispatches to these.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { badFlagged, type Family, goldenOk, scriptFile } from "./check-rules.ts";
import { scenarioDir, sshShim } from "./fixtures.ts";
import { toMarkdown } from "./report.ts";
import { runAut } from "./runner.ts";
import { createSandbox, FAUX_EXT, sh } from "./sandbox.ts";
import { SURFACES_DIR, surfaceFromDir } from "./surface.ts";
import type { RunResult, Scenario, Surface, Verdict } from "./types.ts";

export const EVAL_MODEL_FAUX = "evalfaux/aut";

/** A surface given as a directory path, or a name under SURFACES_DIR. */
export function resolveSurface(arg: string): Surface {
  const asDir = resolve(arg);
  if (arg.includes("/") || existsSync(join(asDir, "dist"))) {
    return surfaceFromDir(basename(asDir) || arg, asDir);
  }
  return surfaceFromDir(arg, join(SURFACES_DIR, arg));
}

/** Scenario ids on disk (underscore-prefixed ones only with includeUnderscore), sorted. */
export function scenarioIds(includeUnderscore: boolean): string[] {
  return readdirSync(scenarioDir())
    .filter((f) => /^[A-Za-z0-9_-]+\.ts$/.test(f))
    .map((f) => f.slice(0, -3))
    .filter((id) => includeUnderscore || !id.startsWith("_"))
    .sort();
}

export async function loadScenario(id: string): Promise<Scenario> {
  const file = join(scenarioDir(), `${id}.ts`);
  if (!existsSync(file)) throw new Error(`no scenario ${id} (looked for ${file})`);
  const mod = (await import(file)) as { default?: Scenario };
  if (!mod.default) throw new Error(`scenario ${id}: no default export`);
  return mod.default;
}

export interface RunOne {
  surface: Surface;
  scenario: Scenario;
  model: string;
  providerExt: string;
  rep: number;
  log?: string;
  keep?: boolean;
  auTScript?: string;
  quietMs?: number;
  maxProds?: number;
}

/** One sandbox, one AUT run, one judged result. The sandbox is always closed (unless keep). */
export async function runOne(o: RunOne): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const sb = await createSandbox(o.surface, { env: o.scenario.env });
  try {
    await o.scenario.setup(sb);
    const metrics = await runAut(sb, o.scenario, {
      model: o.model,
      providerExt: o.providerExt,
      auTScript: o.auTScript,
      quietMs: o.quietMs,
      maxProds: o.maxProds,
      log: o.log,
    });
    let verdict: Verdict;
    try {
      verdict = await o.scenario.judge(sb, metrics);
    } catch (e) {
      verdict = {
        completed: false,
        wrong: [],
        destructive: [],
        notes: [`judge threw: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
    if (o.keep) console.error(`kept sandbox: ${sb.dir} (tmux -L ${sb.tmuxSocket})`);
    return {
      scenario: o.scenario.id,
      surface: o.surface.name,
      model: o.model,
      rep: o.rep,
      startedAt,
      metrics,
      verdict,
    };
  } finally {
    await sb.close({ keep: o.keep });
  }
}

/** Append one RunResult line. Never truncates an existing file. */
export function appendResult(out: string, r: RunResult): void {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  appendFileSync(out, `${JSON.stringify(r)}\n`);
}

export function readResults(file: string): RunResult[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RunResult);
}

export function summary(r: RunResult): string {
  const m = r.metrics;
  return `${r.scenario} ${r.surface} ${r.model} rep${r.rep}: completed=${r.verdict.completed} tokens=${m.usage.total} muCalls=${m.muCalls} muErrors=${m.muErrors} wrong=${r.verdict.wrong.length} destructive=${r.verdict.destructive.length} prods=${m.prods} aborted=${m.aborted} wall=${Math.round(m.wallMs / 1000)}s`;
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_");

export function logPath(
  root: string,
  stamp: string,
  r: { scenario: string; surface: string; model: string; rep: number },
): string {
  return join(
    root,
    ".eval-results",
    stamp,
    `${r.scenario}.${safe(r.surface)}.${safe(r.model)}.${r.rep}.rpc.jsonl`,
  );
}

export const timestamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

export interface MatrixOptions {
  surfaces: Surface[];
  models: string[];
  scenarios: string[];
  reps: number;
  concurrency: number;
  budgetTokens: number;
  providerExt: string;
  out: string;
  root: string;
}

/** Run every scenario x surface x model x rep, `concurrency` at a time; stop starting runs past the token budget. */
export async function runMatrix(o: MatrixOptions): Promise<RunResult[]> {
  const stamp = timestamp();
  const queue: RunOne[] = [];
  for (const id of o.scenarios) {
    const scenario = await loadScenario(id);
    for (const surface of o.surfaces) {
      for (const model of o.models) {
        for (let rep = 1; rep <= o.reps; rep++) {
          queue.push({
            surface,
            scenario,
            model,
            providerExt: o.providerExt,
            rep,
            log: logPath(o.root, stamp, { scenario: id, surface: surface.name, model, rep }),
          });
        }
      }
    }
  }
  const results: RunResult[] = [];
  let spent = 0;
  let skipped = 0;
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      if (spent > o.budgetTokens) {
        skipped++;
        continue;
      }
      try {
        const r = await runOne(job);
        spent += r.metrics.usage.total;
        results.push(r);
        appendResult(o.out, r);
        console.log(summary(r));
      } catch (e) {
        console.error(
          `run failed: ${job.scenario.id} ${job.surface.name} ${job.model}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  if (skipped > 0)
    console.error(`budget ${o.budgetTokens} tokens passed: ${skipped} runs not started`);
  console.log(`total tokens: ${spent}`);
  return results;
}

export function reportCommand(file: string, out?: string): void {
  const md = toMarkdown(readResults(file));
  if (out) writeFileSync(out, md);
  else process.stdout.write(md);
}

// ---- check -----------------------------------------------------------------------------------

/** Preflight: the ssh shim hands a pane's TTY to the remote command, and refuses unknown hosts. */
export async function sshPreflight(surface: Surface): Promise<string[]> {
  const fails: string[] = [];
  const sb = await createSandbox(surface);
  try {
    await sshShim(sb, { host: "dev" });
    const bad = await sh(sb, "ssh nohost true", { allowFail: true });
    if (bad.code !== 255) fails.push(`ssh shim: unknown host exit ${bad.code}, want 255`);
    const plain = await sh(sb, "ssh -o X=y dev -t 'echo \"$HOME\"'", { allowFail: true });
    if (!plain.stdout.includes("/hosts/dev/home"))
      fails.push(`ssh shim: HOME not the host's: ${plain.stdout}`);
    await sh(
      sb,
      `tmux -L ${sb.tmuxSocket} new-window -d -n sshtty "ssh dev -t 'test -t 0 && test -t 1 && echo TTY-OK; sleep 2'"`,
    );
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const cap = await sh(sb, `tmux -L ${sb.tmuxSocket} capture-pane -p -t sshtty`, {
        allowFail: true,
      });
      seen = cap.stdout.includes("TTY-OK");
    }
    if (!seen) fails.push("ssh shim: remote command did not get the pane's TTY (no TTY-OK)");
  } finally {
    await sb.close();
  }
  return fails;
}

export interface CheckOptions {
  surface: Surface;
  scenarios: string[] | null;
  includeUnderscore: boolean;
  family: Family;
  preflight: boolean;
  verbose: boolean;
  root: string;
  /** Where <id>.<kind>.<family>.json live; default: the scenarios dir. */
  scriptDir?: string;
}

/** Faux-AUT proof of every scenario: golden completes cleanly, bad is flagged. Zero cost (faux model), no real model calls. */
export async function runCheck(o: CheckOptions): Promise<number> {
  let failures = 0;
  const line = (ok: boolean, msg: string, detail = ""): void => {
    if (!ok) failures++;
    console.log(
      `${msg}${ok ? "" : " FAILED"}${detail ? `\n    ${detail.split("\n").join("\n    ")}` : ""}`,
    );
  };
  if (o.preflight) {
    const fails = await sshPreflight(o.surface);
    line(fails.length === 0, "preflight ssh shim ok", fails.join("\n"));
  }
  const ids = o.scenarios ?? scenarioIds(o.includeUnderscore);
  const scriptDir = mkdtempSync(join(tmpdir(), "mu-eval-check-"));
  try {
    for (const id of ids) {
      const scenario = await loadScenario(id);
      for (const kind of ["golden", "bad"] as const) {
        const script = join(o.scriptDir ?? scenarioDir(), scriptFile(id, kind, o.family));
        if (!existsSync(script)) {
          line(false, `${id} ${kind} missing`, script);
          continue;
        }
        const r = await runOne({
          surface: o.surface,
          scenario,
          model: EVAL_MODEL_FAUX,
          providerExt: FAUX_EXT,
          rep: 1,
          auTScript: script,
          quietMs: 2000,
          maxProds: 0,
          log: join(scriptDir, `${id}.${kind}.rpc.jsonl`),
        });
        const v = r.verdict;
        const detail = [
          ...v.wrong.map((w) => `wrong: ${w}`),
          ...v.destructive.map((d) => `destructive: ${d}`),
          ...v.notes.map((n) => `note: ${n}`),
          `completed=${v.completed} aborted=${r.metrics.aborted} lastError=${r.metrics.lastError ?? ""}`,
        ].join("\n");
        if (kind === "golden")
          line(goldenOk(v), `${id} golden ok`, goldenOk(v) && !o.verbose ? "" : detail);
        else line(badFlagged(v), `${id} bad flagged ok`, badFlagged(v) && !o.verbose ? "" : detail);
      }
    }
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
  return failures === 0 ? 0 : 1;
}

export type { Scenario };
