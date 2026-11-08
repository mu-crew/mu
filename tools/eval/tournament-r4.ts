// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// R3 scan, R4 gate and the final holdout gate (spec docs/specs/2026-11-07-hill-r2-tournament.md
// §4.4-4.6, unit B3c). All three run AUT jobs through `runR4`; the scoring is in
// tournament-r4-score.ts. The final gate's logs go under `sealed/` only.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isLiveRun, loadScenario, logPath, runOne, scenarioIds } from "./commands.ts";
import {
  attribute,
  baseSpec,
  callKey,
  type Exposure,
  type ExposureSpec,
  r4Exposure,
} from "./exposure.ts";
import type { Group } from "./nextstep.ts";
import { surfaceFromDir } from "./surface.ts";
import {
  appendControl,
  appendReviewStop,
  type ControlRow,
  epochOf,
  readControl,
  type SetupRow,
  setupOf,
  shuffle,
} from "./tournament.ts";
import {
  collectGoldenTraces,
  commandPaths,
  type GoldenTrace,
  HOLDOUTS,
  type VariantRow,
} from "./tournament-build.ts";
import {
  BASE,
  HOLDOUT_REPS,
  needsLive,
  placedFx,
  r4Reps,
  SCAN_LIVE_RUNS,
  type ScanResult,
  scanSelect,
  scanZero,
  scoreFinal,
  scoreR4,
  validRun,
} from "./tournament-r4-score.ts";
import type { DestructiveFx, RunResult, Scenario, Surface } from "./types.ts";

// ---- the runner ---------------------------------------------------------------------------------

export interface R4Job {
  group: Group;
  round: "scan" | "r4" | "final";
  /** "base" or a variant id (the final gate: "combined"). */
  variant: string;
  surface: Surface;
  scenario: string;
  model: string;
  rep: number;
}

export type R4Row = RunResult & {
  group: Group;
  round: R4Job["round"];
  variant: string;
  exposure: Exposure[];
  destructiveFx: DestructiveFx[];
  attributable: DestructiveFx[];
  /** The run's rpc log (what a reviewer reads). */
  log: string;
};

export interface RunR4Opts {
  /** Built by the caller, shuffled with the setup seed. */
  jobs: R4Job[];
  /** r4.jsonl | scan.jsonl | holdouts.jsonl; resumable by (round, variant, scenario, model, rep). */
  out: string;
  /** <rowdir>/logs, or sealed/ for "final". */
  logRoot: string;
  /** AUT runs at once (default 6). */
  concurrency: number;
  providerExt?: string;
  /** From the `variant` rows; base gets its context markers. */
  spec: (variant: string) => ExposureSpec;
  /** Injectable for tests. */
  run?: typeof runOne;
  onRow?: (row: R4Row) => void;
}

const jobKey = (j: Pick<R4Job, "round" | "variant" | "scenario" | "model" | "rep">): string =>
  [j.round, j.variant, j.scenario, j.model, j.rep].join("|");

export function readR4Rows(file: string): R4Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as R4Row);
}

/**
 * The skill's frontmatter `description` (what pi puts in the system prompt), whitespace as in the
 * file; "" without one. Folded (`>-`, `|`) and inline values.
 */
export function skillDescription(skillDir: string): string {
  const f = join(skillDir, "SKILL.md");
  if (!existsSync(f)) return "";
  const lines = readFileSync(f, "utf8").split("\n");
  if (lines[0]?.trim() !== "---") return "";
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  const fm = lines.slice(1, end < 0 ? lines.length : end);
  const i = fm.findIndex((l) => /^description:/.test(l));
  if (i < 0) return "";
  const inline = (fm[i] ?? "").replace(/^description:\s*/, "");
  if (!/^[>|][-+]?\s*$/.test(inline)) return inline.replace(/^["']|["']$/g, "");
  const body: string[] = [];
  for (const l of fm.slice(i + 1)) {
    if (l !== "" && !/^\s/.test(l)) break;
    body.push(l.trim());
  }
  return body.join(" ").trim();
}

/** The log of one job: `<logRoot>/.eval-results/<round>/<scenario>.<variant>.<model>.<rep>.rpc.jsonl`. */
export const jobLog = (logRoot: string, j: R4Job): string =>
  logPath(logRoot, j.round, {
    scenario: j.scenario,
    surface: j.variant,
    model: j.model,
    rep: j.rep,
  });

/** True when `p` is `dir` or inside it. */
const inside = (p: string, dir: string): boolean => {
  const a = resolve(p);
  const d = resolve(dir);
  return a === d || a.startsWith(d + sep);
};

/**
 * Run the jobs not yet in `out`, `concurrency` at a time, and append one R4Row per finished run:
 * the judged RunResult with its placed destructive entries (`placedFx`: a verdict without
 * `destructiveFx` never reads as clean), its exposure under the job's variant spec and the
 * attributable entries. A run that throws writes nothing, so running again retries it.
 */
export async function runR4(o: RunR4Opts): Promise<{ written: number; skipped: number }> {
  if (o.jobs.some((j) => j.round === "final") && !resolve(o.logRoot).endsWith(`${sep}sealed`))
    throw new Error(`final runs log under sealed/ only, not ${o.logRoot}`);
  const done = new Set(readR4Rows(o.out).map(jobKey));
  const pending = o.jobs.filter((j) => !done.has(jobKey(j)));
  const skipped = o.jobs.length - pending.length;
  const run = o.run ?? runOne;
  const scenarios = new Map<string, Promise<Scenario>>();
  const skills = new Map<string, string>();
  let written = 0;
  mkdirSync(dirname(resolve(o.out)), { recursive: true });
  const queue = [...pending];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      try {
        const sk = `${job.surface.scenarioRoot ?? ""}|${job.scenario}`;
        if (!scenarios.has(sk))
          scenarios.set(sk, loadScenario(job.scenario, job.surface.scenarioRoot));
        const scenario = await (scenarios.get(sk) as Promise<Scenario>);
        if (!skills.has(job.surface.skillDir))
          skills.set(job.surface.skillDir, skillDescription(job.surface.skillDir));
        const log = jobLog(o.logRoot, job);
        if (!inside(log, o.logRoot)) throw new Error(`log ${log} outside ${o.logRoot}`);
        const result = await run({
          surface: job.surface,
          scenario,
          model: job.model,
          rep: job.rep,
          providerExt: o.providerExt,
          live: isLiveRun(scenario, "pi"),
          log,
        });
        const destructiveFx = placedFx(result.verdict);
        const verdict = { ...result.verdict, destructiveFx };
        const exposure = r4Exposure(
          { metrics: result.metrics, verdict },
          {
            scenarioPrompt: scenario.prompt,
            skillDescription: skills.get(job.surface.skillDir) ?? "",
          },
          o.spec(job.variant),
        );
        const row: R4Row = {
          ...result,
          verdict,
          group: job.group,
          round: job.round,
          variant: job.variant,
          exposure,
          destructiveFx,
          attributable: attribute(destructiveFx, exposure),
          log,
        };
        appendFileSync(o.out, `${JSON.stringify(row)}\n`);
        written++;
        o.onRow?.(row);
      } catch (e) {
        console.error(
          `r4 run failed: ${jobKey(job)}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  return { written, skipped };
}

// ---- shared -------------------------------------------------------------------------------------

/** What every gate command gets from the CLI: the group, its row dir, the repo and its own args. */
export interface GateOpts {
  group: Group;
  /** The group's row dir (tournament.ts rowDir). */
  dir: string;
  repo: string;
  args: string[];
  /** Test seams: the AUT run, the golden traces, the command paths, the review ping. */
  deps?: {
    run?: typeof runOne;
    traces?: (surface: Surface, scenarios: readonly string[]) => Promise<GoldenTrace[]>;
    paths?: (surface: Surface) => string[];
    ping?: (msg: string) => void;
  };
}

/** Exit code of a review stop (§5.2, §4.6). */
export const EXIT_REVIEW = 7;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const num = (args: string[], name: string, d: number): number => {
  const v = flag(args, name);
  return v === undefined ? d : Number(v);
};

/** Rep indices never meet another round's: scan from 301, R4 from 201, final from 401, per epoch. */
export const R4_REP_BASE = { r4: 201, scan: 301, final: 401 } as const;
const repFloor = (round: R4Job["round"], epoch: number): number =>
  epoch * 1000 + R4_REP_BASE[round];

const roundFile = (dir: string, name: "r4" | "scan", epoch: number): string =>
  join(dir, epoch === 0 ? `${name}.jsonl` : `${name}.e${epoch}.jsonl`);
export const r4File = (dir: string, epoch: number): string => roundFile(dir, "r4", epoch);
export const scanFile = (dir: string, epoch: number): string => roundFile(dir, "scan", epoch);
export const holdoutsFile = (dir: string): string => join(dir, "holdouts.jsonl");
export const sealedDir = (dir: string): string => join(dir, "sealed");

const surfaceOf = (label: string, root: string): Surface => ({
  ...surfaceFromDir(label, root),
  family: "next",
});

const variantRows = (rows: readonly ControlRow[]): Map<string, VariantRow> =>
  new Map(rows.filter((r): r is VariantRow => r.kind === "variant").map((r) => [r.id, r]));

function need(rows: readonly ControlRow[]): { setup: SetupRow; epoch: number } {
  const setup = setupOf(rows);
  if (!setup) throw new Error("no setup row: run `tournament freeze` first");
  return { setup, epoch: epochOf(rows) };
}

/** The R2 finalists of this epoch (the last R2 cut's advanced ids). */
function finalists(rows: readonly ControlRow[], epoch: number): string[] {
  const c = [...rows]
    .reverse()
    .find((r) => r.kind === "cut" && r.round === "r2" && r.epoch === epoch);
  if (c?.kind !== "cut") throw new Error("no R2 cut in this epoch: run `tournament r2` first");
  return c.advanced as string[];
}

/** The spec of a job's variant: its own; base gets every finalist's context markers. */
const specFor =
  (vs: Map<string, VariantRow>, ids: readonly string[]) =>
  (variant: string): ExposureSpec => {
    if (variant !== BASE) {
      const v = vs.get(variant);
      if (!v) throw new Error(`no variant row ${variant}`);
      return v.spec;
    }
    const s = ids.flatMap((id) => {
      const v = vs.get(id);
      return v ? [baseSpec(v.spec)] : [];
    });
    return {
      markers: [...new Set(s.flatMap((x) => x.markers))],
      contextMarkers: [],
      newNames: [],
      changedCalls: [],
    };
  };

const haiku = (setup: SetupRow): string =>
  setup.models.weak.find((m) => m.includes("haiku")) ?? setup.models.weak[0] ?? "";

const goldens = (s: Surface, scenarios: readonly string[]): Promise<GoldenTrace[]> =>
  collectGoldenTraces(s, { cases: [], intents: [], scenarios });

// ---- R3 (§4.4) ----------------------------------------------------------------------------------

/** §4.4 R3: which scenarios exercise each finalist (text, behaviour, live haiku runs). Exit code. */
export async function runScan(o: GateOpts): Promise<number> {
  const rows = readControl(o.dir);
  const { setup, epoch } = need(rows);
  const ids = finalists(rows, epoch);
  if (ids.length === 0) {
    console.log("no R2 finalists: nothing to scan");
    return 0;
  }
  const vs = variantRows(rows);
  const only = flag(o.args, "--scenarios")?.split(",").filter(Boolean);
  const scenarios = (only ?? scenarioIds(false)).filter((id) => !HOLDOUTS.includes(id));
  const traces = o.deps?.traces ?? goldens;
  const base = surfaceOf("hill2-base", setup.baseDir);
  const baseFirst = await traces(base, scenarios);
  const baseAgain = await traces(base, scenarios);
  const paths = (o.deps?.paths ?? commandPaths)(base);
  const key = (argv: string): string => callKey(argv, paths);
  const spec = specFor(vs, ids);
  const floor = repFloor("scan", epoch);
  for (const id of ids) {
    const v = vs.get(id);
    if (!v) throw new Error(`no variant row ${id}`);
    const vSurface = surfaceOf(`hill2-${id}`, v.dir);
    const zero = scanZero({
      kind: v.manifest.kind,
      spec: v.spec,
      scenarios,
      base: baseFirst,
      baseAgain,
      variant: await traces(vSurface, scenarios),
      key,
    });
    let live: R4Row[] | null = null;
    if (needsLive(v.manifest.kind, zero)) {
      const jobs: R4Job[] = scenarios.flatMap((scenario) =>
        Array.from({ length: SCAN_LIVE_RUNS }, (_, k) => ({
          group: o.group,
          round: "scan" as const,
          variant: id,
          surface: vSurface,
          scenario,
          model: haiku(setup),
          rep: floor + k,
        })),
      );
      const out = scanFile(o.dir, epoch);
      await runR4({
        jobs: shuffle(jobs, `${setup.seed}:scan:${epoch}:${id}`),
        out,
        logRoot: join(o.dir, "logs"),
        concurrency: num(o.args, "--concurrency", 6),
        providerExt: setup.providerExt ?? undefined,
        spec,
        run: o.deps?.run,
      });
      live = readR4Rows(out).filter(
        (r) =>
          r.round === "scan" &&
          r.variant === id &&
          r.rep >= floor &&
          r.rep < floor + 900 &&
          validRun(r),
      );
    }
    const res = scanSelect(id, zero, live);
    appendControl(o.dir, { kind: "scan", epoch, ...res });
    console.log(
      `${id}: ${res.selected.length > 0 ? `R4 on ${res.selected.join(", ")}` : "no exercising scenario: it cannot win (add one, §2.2)"}`,
    );
  }
  return 0;
}

// ---- R4 (§4.5) ----------------------------------------------------------------------------------

const scanOf = (rows: readonly ControlRow[], epoch: number, id: string): ScanResult | undefined =>
  [...rows].reverse().find((r) => r.kind === "scan" && r.epoch === epoch && r.variant === id) as
    | ScanResult
    | undefined;

/** R2 wins and win z per variant, from the last R2 score of the epoch. */
function r2Wins(
  rows: readonly ControlRow[],
  epoch: number,
): Map<string, { wins: number; winZ: number }> {
  const s = [...(rows as unknown as Record<string, unknown>[])]
    .reverse()
    .find((r) => r.kind === "round_score" && r.round === "r2" && r.epoch === epoch);
  const scores = (s?.scores ?? []) as { id: string; wins: number; winZ: number }[];
  return new Map(scores.map((x) => [x.id, { wins: x.wins, winZ: x.winZ }]));
}

/** §4.5 R4: finalists plus base on the exercising scenarios; the decision. Exit code (7: review stop). */
export async function runR4Gate(o: GateOpts): Promise<number> {
  const rows = readControl(o.dir);
  const { setup, epoch } = need(rows);
  const ids = finalists(rows, epoch);
  const vs = variantRows(rows);
  const wins = r2Wins(rows, epoch);
  const fins = ids.map((id) => {
    const scan = scanOf(rows, epoch, id);
    if (!scan) throw new Error(`no R3 scan for ${id}: run \`tournament r3\` first`);
    const w = wins.get(id) ?? { wins: 0, winZ: 0 };
    return {
      id,
      scenarios: scan.selected,
      reps: r4Reps(scan.selected.length),
      ...w,
      textDelta: vs.get(id)?.textDelta ?? 0,
    };
  });
  const models = [...setup.models.weak, setup.models.gate];
  const floor = repFloor("r4", epoch);
  const base = surfaceOf("hill2-base", setup.baseDir);
  const baseReps = new Map<string, number>();
  const jobs: R4Job[] = [];
  const push = (variant: string, surface: Surface, scenario: string, reps: number): void => {
    for (const model of models)
      for (let k = 0; k < reps; k++)
        jobs.push({
          group: o.group,
          round: "r4",
          variant,
          surface,
          scenario,
          model,
          rep: floor + k,
        });
  };
  for (const f of fins) {
    const v = vs.get(f.id);
    if (!v) throw new Error(`no variant row ${f.id}`);
    for (const s of f.scenarios) {
      push(f.id, surfaceOf(`hill2-${f.id}`, v.dir), s, f.reps);
      baseReps.set(s, Math.max(baseReps.get(s) ?? 0, f.reps));
    }
  }
  for (const [s, reps] of [...baseReps].sort()) push(BASE, base, s, reps);
  const out = r4File(o.dir, epoch);
  const started = Date.now();
  await runR4({
    jobs: shuffle(jobs, `${setup.seed}:r4:${epoch}`),
    out,
    logRoot: join(o.dir, "logs"),
    concurrency: num(o.args, "--concurrency", 6),
    providerExt: setup.providerExt ?? undefined,
    spec: specFor(vs, ids),
    run: o.deps?.run,
  });
  const r4 = readR4Rows(out).filter(
    (r) => r.round === "r4" && r.rep >= floor && r.rep < floor + 900,
  );
  const score = scoreR4({
    rows: r4,
    finalists: fins,
    models,
    weak: setup.models.weak,
    repFloor: floor,
    decisions: rows.flatMap((r) => (r.kind === "review_decision" ? [r] : [])),
  });
  appendControl(o.dir, { kind: "r4_score", epoch, ...score });
  const tokens: Record<string, number> = {};
  for (const r of r4) tokens[r.model] = (tokens[r.model] ?? 0) + r.metrics.usage.total;
  appendControl(o.dir, { kind: "spend", round: "r4", epoch, tokens, wallMs: Date.now() - started });
  const stops = score.finalists.flatMap((f) => f.reviews);
  if (stops.length > 0) {
    for (const s of stops)
      console.log(
        `review stop ${appendReviewStop(o.dir, s, o.deps?.ping)}: ${s.variant} ${s.cell}: ${s.entries.join("; ")}`,
      );
    return EXIT_REVIEW;
  }
  for (const f of score.finalists)
    console.log(
      `${f.id}: ${f.passes ? "passes" : `OUT (${f.eliminated.join(", ")})`}; ${f.models.map((m) => `${m.model} ${m.variant.completed}/${m.variant.n} vs ${m.base.completed}/${m.base.n} p ${m.p.toFixed(3)}`).join("; ")}`,
    );
  appendControl(o.dir, { kind: "decision", epoch, winner: score.winner ?? null, why: score.why });
  console.log(`decision: ${score.winner ?? "base stays"} (${score.why})`);
  return 0;
}

// ---- the final gate (§4.6) ----------------------------------------------------------------------

export const COMBINED = "combined";

/**
 * §4.6 the final gate: holdouts once on the combined winners surface (`--surface <dir>`), 4
 * scenarios × 3 models × 12 reps against base, fresh. Rows go to holdouts.jsonl, logs under
 * `sealed/` only. A loss or a destructive entry new against base is a review stop (exit 7). The
 * gate never runs a second time and never on a subset: a holdout stop is decided by a person from
 * the non-holdout evidence, and a run after it is refused. Exit code.
 */
export async function runFinal(o: GateOpts): Promise<number> {
  const rows = readControl(o.dir);
  const { setup } = need(rows);
  const dirArg = flag(o.args, "--surface");
  if (!dirArg) throw new Error("final needs --surface <combined winners dir>");
  const ref = existsSync(join(dirArg, ".ref"))
    ? readFileSync(join(dirArg, ".ref"), "utf8").trim()
    : resolve(dirArg);
  if (rows.some((r) => r.kind === "final_score"))
    throw new Error(
      "the holdouts have been spent: they run once, and a holdout stop is decided without a re-run or a bisection (§4.6)",
    );
  const started = (rows as unknown as Record<string, unknown>[]).find((r) => r.kind === "final");
  if (started && started.ref !== ref)
    throw new Error(
      `the final gate already started on ${String(started.ref)}: the holdouts run once, on one combined surface`,
    );
  if (!started) appendControl(o.dir, { kind: "final", surface: resolve(dirArg), ref });
  const models = [...setup.models.weak, setup.models.gate];
  const reps = num(o.args, "--reps", HOLDOUT_REPS);
  const floor = repFloor("final", 0);
  const sides = [
    { variant: BASE, surface: surfaceOf("hill2-base", setup.baseDir) },
    { variant: COMBINED, surface: surfaceOf("hill2-combined", dirArg) },
  ];
  const jobs: R4Job[] = HOLDOUTS.flatMap((scenario) =>
    sides.flatMap(({ variant, surface }) =>
      models.flatMap((model) =>
        Array.from({ length: reps }, (_, k) => ({
          group: o.group,
          round: "final" as const,
          variant,
          surface,
          scenario,
          model,
          rep: floor + k,
        })),
      ),
    ),
  );
  const out = holdoutsFile(o.dir);
  const empty: ExposureSpec = { markers: [], contextMarkers: [], newNames: [], changedCalls: [] };
  const t0 = Date.now();
  await runR4({
    jobs: shuffle(jobs, `${setup.seed}:final`),
    out,
    logRoot: sealedDir(o.dir),
    concurrency: num(o.args, "--concurrency", 6),
    providerExt: setup.providerExt ?? undefined,
    spec: () => empty,
    run: o.deps?.run,
  });
  const got = readR4Rows(out).filter((r) => r.round === "final");
  const missing = jobs.length - new Set(got.map(jobKey)).size;
  if (missing > 0) {
    console.error(
      `final: ${missing} holdout runs failed; run \`tournament final\` again to finish`,
    );
    return 1;
  }
  const s = scoreFinal({ rows: got, combined: COMBINED, models });
  const tokens: Record<string, number> = {};
  for (const r of got) tokens[r.model] = (tokens[r.model] ?? 0) + r.metrics.usage.total;
  appendControl(o.dir, { kind: "spend", round: "final", tokens, wallMs: Date.now() - t0 });
  // counts only: the report reads this row, never sealed/
  appendControl(o.dir, {
    kind: "final_score",
    ref,
    models: s.models,
    newDestructive: s.newDestructive,
    stop: s.stop,
    why: s.why,
  });
  if (s.stop) {
    const id = appendReviewStop(
      o.dir,
      {
        variant: COMBINED,
        cell: "holdouts",
        entries: [
          s.why,
          ...s.newDestructive.flatMap((d) => d.entries.map((e) => `${d.cell}: ${e}`)),
        ],
        transcript: "sealed/ (open only after the decision is written)",
        source: "holdout",
      },
      o.deps?.ping,
    );
    console.log(
      `holdout stop ${id}: ${s.why}. Decide from the R2/R4 evidence, not by re-running holdouts.`,
    );
    return EXIT_REVIEW;
  }
  console.log(`final: ${s.why}`);
  return 0;
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
