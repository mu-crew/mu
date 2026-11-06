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
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  badFlagged,
  extraScripts,
  goldenOk,
  missingGoldenEvidence,
  PENDING_NEXT,
  scriptFile,
} from "./check-rules.ts";
import { scenarioDir, sshShim } from "./fixtures.ts";
import {
  AUT_HARNESSES,
  type AutHarness,
  autSkill,
  HarnessToolsError,
  type HookTools,
  parseCodexHooks,
  realCodexDir,
  resolveTools,
  which,
} from "./harness.ts";
import { toMarkdown } from "./report.ts";
import { runAut } from "./runner.ts";
import { runPaneAut } from "./runner-pane.ts";
import { createSandbox, FAUX_EXT, sh } from "./sandbox.ts";
import {
  checkScenarioRoot,
  parseSurfaceSpec,
  SURFACES_DIR,
  surfaceFromDir,
  surfaceId,
} from "./surface.ts";
import type {
  Family,
  RunMetrics,
  RunResult,
  Sandbox,
  Scenario,
  Surface,
  Verdict,
} from "./types.ts";

export const EVAL_MODEL_FAUX = "evalfaux/aut";

/**
 * A surface given as a directory path, or a name under SURFACES_DIR, optionally followed by
 * `:<3x|next>[:<scenario-root>]`. `defaults` fill what the spec leaves out (the --family and
 * --scenario-root flags); with neither, the surface is 3x on the default scenario root.
 */
export function resolveSurface(
  arg: string,
  defaults: { family?: Family; scenarioRoot?: string } = {},
): Surface {
  const spec = parseSurfaceSpec(arg);
  const asDir = resolve(spec.target);
  const base =
    spec.target.includes("/") || existsSync(join(asDir, "dist"))
      ? surfaceFromDir(basename(asDir) || spec.target, asDir)
      : surfaceFromDir(spec.target, join(SURFACES_DIR, spec.target));
  const family = spec.family ?? defaults.family;
  const root =
    spec.scenarioRoot ??
    (defaults.scenarioRoot === undefined ? undefined : checkScenarioRoot(defaults.scenarioRoot));
  return {
    ...base,
    ...(family === undefined ? {} : { family }),
    ...(root === undefined ? {} : { scenarioRoot: root }),
  };
}

/** Scenario ids in the default dir and in each extra root (underscore ones only with includeUnderscore), sorted. */
export function scenarioIds(
  includeUnderscore: boolean,
  ...roots: (string | undefined)[]
): string[] {
  const ids = new Set<string>();
  for (const dir of [scenarioDir(), ...roots]) {
    if (dir === undefined || !existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (/^[A-Za-z0-9_-]+\.ts$/.test(f)) ids.add(f.slice(0, -3));
    }
  }
  return [...ids].filter((id) => includeUnderscore || !id.startsWith("_")).sort();
}

/** <root>/<id>.ts when a root is given and has it, else the default scenario. A root override imports tools/eval siblings as ../../fixtures.ts. */
export async function loadScenario(id: string, root?: string): Promise<Scenario> {
  const own = root === undefined ? undefined : join(root, `${id}.ts`);
  const file = own !== undefined && existsSync(own) ? own : join(scenarioDir(), `${id}.ts`);
  if (!existsSync(file)) throw new Error(`no scenario ${id} (looked for ${own ?? file})`);
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
  /** The AUT's harness (default pi, over rpc); claude and codex run in a pane (runner-pane.ts). */
  harness?: AutHarness;
  /** Real HOME, env and auth, and the user's harness binaries for the AUT and its workers (default: fakes). */
  live?: boolean;
  /** With `live`: fake worker binaries anyway (only the AUT is real, as in a pi scenario). */
  fakeWorkers?: boolean;
  /** Hook tools already resolved (check resolves them once); default: resolveTools(surface). */
  tools?: HookTools;
}

/** A live pane AUT's command: EVAL_AUT_COMMAND, else the user's launcher when workers are fakes, plus --model. */
export function autCommand(o: {
  harness: AutHarness;
  model: string;
  live: boolean;
  fakeWorkers: boolean;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = o.env ?? process.env;
  const fixed = env.EVAL_AUT_COMMAND?.trim();
  if (fixed) return fixed;
  if (!o.live) return undefined;
  const model = o.model === "" || o.model === "default" ? "" : ` --model ${o.model}`;
  if (o.fakeWorkers) {
    const real = which(o.harness, env.PATH);
    return real === null ? undefined : `${real}${model}`;
  }
  return model === "" ? undefined : `${o.harness}${model}`;
}

/** Sum two runs of one case: the crashed orchestrator's and its replacement's. */
export function mergeMetrics(a: RunMetrics, b: RunMetrics): RunMetrics {
  const u = (k: keyof RunMetrics["usage"]) => a.usage[k] + b.usage[k];
  return {
    usage: {
      input: u("input"),
      output: u("output"),
      cacheRead: u("cacheRead"),
      cacheWrite: u("cacheWrite"),
      total: u("total"),
      cost: u("cost"),
    },
    turns: a.turns + b.turns,
    toolCalls: [...a.toolCalls, ...b.toolCalls],
    muCalls: a.muCalls + b.muCalls,
    muErrors: a.muErrors + b.muErrors,
    prods: a.prods + b.prods,
    wallMs: a.wallMs + b.wallMs,
    aborted: b.aborted,
    lastError: b.lastError ?? a.lastError,
    finalText: b.finalText,
    events: [...a.events, ...b.events],
  };
}

/** The pi AUT over rpc; a replacement case runs a second pi on the steps after the crash. */
export async function runPiAut(
  sb: Sandbox,
  o: RunOne,
  run: typeof runAut = runAut,
): Promise<RunMetrics> {
  const base = {
    model: o.model,
    providerExt: o.providerExt,
    auTScript: o.auTScript,
    quietMs: o.quietMs,
    maxProds: o.maxProds,
    log: o.log,
  };
  const rep = o.scenario.replacement;
  if (rep === undefined) return run(sb, o.scenario, base);
  // a fake AUT crashes on its script's {die}; only a live one is killed by the rig
  const crashWhen = o.live === true ? rep.crashWhen : undefined;
  const first = await run(sb, o.scenario, {
    ...base,
    maxProds: 0,
    ...(crashWhen !== undefined ? { stopWhen: () => crashWhen(sb) } : {}),
  });
  const second = await run(
    sb,
    { ...o.scenario, prompt: rep.prompt },
    { ...base, env: { EVAL_FAUX_PHASE: "2" }, log: o.log ? `${o.log}.2` : undefined },
  );
  return mergeMetrics(first, second);
}

/** One sandbox, one AUT run, one judged result. The sandbox is always closed (unless keep). */
export async function runOne(o: RunOne): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const harness = o.harness ?? "pi";
  const hooks = o.scenario.hookHarnesses !== undefined || harness !== "pi";
  const codexHooks = parseCodexHooks(process.env.EVAL_CODEX_HOOKS);
  const skillNote =
    o.live === true && harness !== "pi"
      ? autSkill(harness, o.surface.skillDir, {
          home: process.env.HOME ?? homedir(),
          codexDir: realCodexDir(),
          codexHooks,
        })
      : null;
  if (skillNote !== null) console.error(`eval: ${skillNote}`);
  const sb = await createSandbox(o.surface, {
    env: { ...o.scenario.env, EVAL_AUT_HARNESS: harness, EVAL_AUT_MODEL: o.model },
    live: o.live === true,
    ...(o.live === true && o.fakeWorkers !== true ? { providerExt: o.providerExt } : {}),
    ...(hooks
      ? {
          harness: {
            tools: o.tools ?? resolveTools(o.surface),
            codexHooks,
            fake: o.live !== true || o.fakeWorkers === true,
          },
        }
      : {}),
  });
  try {
    await o.scenario.setup(sb);
    const metrics =
      harness === "pi"
        ? await runPiAut(sb, o)
        : await runPaneAut(sb, o.scenario, {
            harness,
            auTScript: o.auTScript,
            command: autCommand({
              harness,
              model: o.model,
              live: o.live === true,
              fakeWorkers: o.fakeWorkers === true,
            }),
            quietMs: o.quietMs,
            maxProds: o.maxProds,
            log: o.log,
            live: o.live === true,
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
    if (skillNote !== null) verdict.notes.push(skillNote);
    if (o.keep) console.error(`kept sandbox: ${sb.dir} (tmux -L ${sb.tmuxSocket})`);
    return {
      scenario: o.scenario.id,
      surface: surfaceId(o.surface),
      model: o.model,
      ...(harness !== "pi" ? { harness } : {}),
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
  return `${r.scenario} ${r.surface} ${r.model}${r.harness ? `@${r.harness}` : ""} rep${r.rep}: completed=${r.verdict.completed} tokens=${m.usage.total} muCalls=${m.muCalls} muErrors=${m.muErrors} wrong=${r.verdict.wrong.length} na=${r.verdict.na?.length ?? 0} destructive=${r.verdict.destructive.length} prods=${m.prods} aborted=${m.aborted} wall=${Math.round(m.wallMs / 1000)}s`;
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
  /** AUT harnesses (default pi); a scenario runs under those of them it names. */
  harnesses?: AutHarness[];
  /** Hook-harness scenarios: fake worker binaries even in a live run. */
  fakeWorkers?: boolean;
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
  const ids = o.surfaces.map(surfaceId);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(`duplicate --surface spec ${dup}`);
  const queue: RunOne[] = [];
  for (const id of o.scenarios) {
    for (const surface of o.surfaces) {
      const scenario = await loadScenario(id, surface.scenarioRoot);
      for (const harness of checkHarnesses(scenario, o.harnesses ?? ["pi"]))
        for (const model of o.models) {
          for (let rep = 1; rep <= o.reps; rep++) {
            queue.push({
              surface,
              scenario,
              model,
              providerExt: o.providerExt,
              rep,
              harness,
              live: isLiveRun(scenario, harness),
              fakeWorkers: o.fakeWorkers === true,
              log: logPath(o.root, stamp, {
                scenario: id,
                surface: surfaceId(surface),
                model: harness === "pi" ? model : `${model}@${harness}`,
                rep,
              }),
            });
          }
        }
    }
  }
  const uncounted = queue.filter((j) => j.live === true && (j.harness !== "pi" || !j.fakeWorkers));
  if (uncounted.length > 0)
    console.error(
      `eval: ${uncounted.length} live runs with a pane AUT or real workers: their tokens are not counted, so --budget-tokens and the scenarios' tokenCap do not bound them (only each run's timeout does)`,
    );
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
          `run failed: ${job.scenario.id} ${surfaceId(job.surface)} ${job.model}: ${e instanceof Error ? e.message : String(e)}`,
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
  /** Where <id>.<kind>.<family>.json live; test override. Default: surface.scenarioRoot, else the scenarios dir. */
  scriptDir?: string;
  /** Prove a hook-harness scenario under these AUT harnesses only (default: each the scenario names). */
  harnesses?: AutHarness[];
}

/** A run with a real model is live (real HOME, auth and harnesses) when a hook harness is in it. */
export function isLiveRun(scenario: Scenario, harness: AutHarness): boolean {
  return scenario.hookHarnesses !== undefined || harness !== "pi";
}

/** The AUT harnesses `check` proves a scenario under: pi alone for a pi scenario. */
export function checkHarnesses(scenario: Scenario, only?: AutHarness[]): AutHarness[] {
  const all: AutHarness[] =
    scenario.hookHarnesses === undefined
      ? ["pi"]
      : (scenario.hookHarnesses.aut ?? [...AUT_HARNESSES]);
  return only === undefined ? all : all.filter((h) => only.includes(h));
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
  const surface: Surface = { ...o.surface, family: o.family };
  if (o.preflight) {
    const fails = await sshPreflight(surface);
    line(fails.length === 0, "preflight ssh shim ok", fails.join("\n"));
  }
  const ids = o.scenarios ?? scenarioIds(o.includeUnderscore, surface.scenarioRoot);
  // hook-harness scenarios need murmur's build: without it each is skipped, the others still run
  let tools: HookTools | null = null;
  let noTools = "";
  try {
    tools = resolveTools(surface);
  } catch (e) {
    if (!(e instanceof HarnessToolsError)) throw e;
    noTools = e.message;
  }
  const scriptDir = mkdtempSync(join(tmpdir(), "mu-eval-check-"));
  try {
    for (const id of ids) {
      if (o.family === "next" && PENDING_NEXT.includes(id)) {
        console.log(
          `${id} pending: skipped (its next scripts are written against the planned surface)`,
        );
        continue;
      }
      const scenario = await loadScenario(id, surface.scenarioRoot);
      if (scenario.families !== undefined && !scenario.families.includes(o.family)) {
        console.log(
          `${id} ${o.family}: skipped (scripts only for ${scenario.families.join(", ")})`,
        );
        continue;
      }
      if (scenario.hookHarnesses !== undefined && tools === null) {
        console.log(`${id} skipped (${noTools})`);
        continue;
      }
      const dir = o.scriptDir ?? surface.scenarioRoot ?? scenarioDir();
      const named = (kind: "golden" | "bad") =>
        extraScripts(dir, id, o.family, kind).map((file) => ({
          kind,
          label: file.slice(id.length + 1).replace(`.${o.family}.json`, ""),
          file,
        }));
      const scripts = [
        { kind: "golden" as const, label: "golden", file: scriptFile(id, "golden", o.family) },
        // extra positive controls: <id>.golden-<name>.<family>.json, each must be clean too (the
        // same job done with different spellings: a judge may not prefer one)
        ...named("golden"),
        { kind: "bad" as const, label: "bad", file: scriptFile(id, "bad", o.family) },
        // extra negative controls: <id>.bad-<name>.<family>.json, each must be flagged too
        ...named("bad"),
      ];
      const harnesses = checkHarnesses(scenario, o.harnesses);
      for (const harness of harnesses)
        for (const { kind, label: base, file } of scripts) {
          const label = scenario.hookHarnesses === undefined ? base : `${base} [${harness}]`;
          const script = join(dir, file);
          if (!existsSync(script)) {
            line(false, `${id} ${label} missing`, script);
            continue;
          }
          const r = await runOne({
            surface,
            scenario,
            model: EVAL_MODEL_FAUX,
            providerExt: FAUX_EXT,
            rep: 1,
            auTScript: script,
            quietMs: scenario.check?.quietMs ?? 2000,
            maxProds: scenario.check?.maxProds ?? 0,
            harness,
            ...(tools !== null ? { tools } : {}),
            log: join(scriptDir, `${id}.${base}.${harness}.rpc.jsonl`),
          });
          const v = r.verdict;
          const detail = [
            ...v.wrong.map((w) => `wrong: ${w}`),
            ...v.destructive.map((d) => `destructive: ${d}`),
            ...v.notes.map((n) => `note: ${n}`),
            `completed=${v.completed} aborted=${r.metrics.aborted} lastError=${r.metrics.lastError ?? ""}`,
          ].join("\n");
          if (kind === "golden") {
            const missing = missingGoldenEvidence(id, v).map(
              (m) => `missing golden evidence: /${m}/`,
            );
            const ok = goldenOk(v) && missing.length === 0;
            const na = v.na?.length ? ` (manual workaround: ${v.na.length} N/A native)` : "";
            line(
              ok,
              `${id} ${label} ok${na}`,
              ok && !o.verbose ? "" : [...missing, detail].join("\n"),
            );
          } else {
            line(
              badFlagged(v),
              `${id} ${label} flagged ok`,
              badFlagged(v) && !o.verbose ? "" : detail,
            );
          }
        }
    }
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
  return failures === 0 ? 0 : 1;
}

export type { Scenario };
