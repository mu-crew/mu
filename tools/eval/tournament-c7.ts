// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// C7, the combined gate (spec docs/specs/2026-11-07-hill-r2-tournament.md §4.7, fast mode): one
// surface with every group's winning patch, R4 on the scenarios that exercise the winners (sonnet
// and both weak models, n per the §4.5 plan), then the holdouts once. On an R4 regression it
// bisects the winners on the R4 scenarios only, never the holdouts, and reports which winner to
// drop. Rows live in `<root>/c7/`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scenarioIds } from "./commands.ts";
import { baseSpec, type ExposureSpec } from "./exposure.ts";
import type { Group } from "./nextstep.ts";
import { surfaceDir } from "./surface.ts";
import {
  appendControl,
  appendReviewStop,
  assertFrozen,
  assertNoPendingStops,
  epochOf,
  ntfyPing,
  ROW_ROOT,
  readControl,
  rowDir,
  type SetupRow,
  setupOf,
  shuffle,
} from "./tournament.ts";
import {
  buildVariant,
  HOLDOUTS,
  judgesHash,
  listCandidates,
  type VariantRow,
} from "./tournament-build.ts";
import {
  EXIT_REVIEW,
  flag,
  type GateOpts,
  num,
  type R4Job,
  r4File,
  readR4Rows,
  repFloor,
  runFinal,
  runR4,
  type ScanContext,
  scanContext,
  scanOne,
  surfaceOf,
} from "./tournament-r4.ts";
import {
  BASE,
  type R4FinalistScore,
  r4Reps,
  type ScanResult,
  scoreR4,
} from "./tournament-r4-score.ts";

export const C7 = "c7";
export const c7Dir = (root = process.env.EVAL_TOURNAMENT_ROOT ?? ROW_ROOT): string =>
  join(root, C7);

export interface Winner {
  group: Group;
  id: string;
  variant: VariantRow;
  /** The patch file in tools/eval/candidates/<group>/. */
  patch: string;
  /** Sum of the win-case pooled z (fast decision) or R2 win z; the bisection's tie-break. */
  winZ: number;
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** The patch file of a variant row: its manifest id in the group's candidates, same patch sha. */
function patchFor(repo: string, group: Group, v: VariantRow): string {
  const cand = join(repo, "tools", "eval", "candidates", group);
  for (const c of listCandidates(cand)) {
    try {
      const id = (JSON.parse(readFileSync(c.manifest, "utf8")) as { id?: string }).id;
      if (id === v.id && sha256(readFileSync(c.patch)) === v.patchSha) return c.patch;
    } catch {}
  }
  throw new Error(`${group}: no patch for winner ${v.id} (sha ${v.patchSha}) under ${cand}`);
}

/**
 * Each group's winner: the latest `decision` row of its current epoch with a winner (fast or full
 * mode), its variant row and patch. Refuses on changed judges, a pending review stop, or groups
 * on different base shas (one combined surface has one base).
 */
export function groupWinners(o: {
  root: string;
  repo: string;
  groups: readonly Group[];
  hash: string;
  drop?: readonly string[];
}): { winners: Winner[]; setup: SetupRow | undefined; none: string[] } {
  const winners: Winner[] = [];
  const none: string[] = [];
  let setup: SetupRow | undefined;
  for (const group of o.groups) {
    const rows = readControl(rowDir(group, o.root));
    if (rows.length === 0) {
      none.push(`${group}: no control rows`);
      continue;
    }
    assertFrozen(rows, o.hash);
    assertNoPendingStops(rows);
    const s = setupOf(rows);
    if (s && setup && s.baseSha !== setup.baseSha)
      throw new Error(
        `${group} is on base ${s.baseSha}, not ${setup.baseSha}: one combined surface has one base`,
      );
    setup ??= s;
    const epoch = epochOf(rows);
    const d = [...(rows as unknown as Record<string, unknown>[])]
      .reverse()
      .find((r) => r.kind === "decision" && (r.epoch === undefined || r.epoch === epoch));
    const id = typeof d?.winner === "string" ? d.winner : null;
    if (id === null) {
      none.push(`${group}: base stays`);
      continue;
    }
    if (o.drop?.includes(id)) {
      none.push(`${group}: ${id} dropped (--drop)`);
      continue;
    }
    const v = [...rows].reverse().find((r): r is VariantRow => r.kind === "variant" && r.id === id);
    if (!v) throw new Error(`${group}: no variant row for winner ${id}`);
    const scores = (d?.scores ?? []) as { id: string; winZ?: number }[];
    const winZ = scores.find((x) => x.id === id)?.winZ ?? 0;
    winners.push({ group, id, variant: v, patch: patchFor(o.repo, group, v), winZ });
  }
  return { winners, setup, none };
}

/** The label of a winner set: its R4 rows and its surface dir. */
export const setLabel = (ids: readonly string[]): string => `${C7}:${ids.join("+")}`;

/** The exposure spec of a set of winners: the union of theirs; base gets their context markers. */
export function setSpec(ws: readonly Winner[]): { set: ExposureSpec; base: ExposureSpec } {
  const u = (f: (s: ExposureSpec) => readonly string[], xs: readonly ExposureSpec[]): string[] => [
    ...new Set(xs.flatMap(f)),
  ];
  const specs = ws.map((w) => w.variant.spec);
  const bases = specs.map(baseSpec);
  return {
    set: {
      markers: u((s) => s.markers, specs),
      contextMarkers: u((s) => s.contextMarkers, specs),
      newNames: u((s) => s.newNames, specs),
      changedCalls: u((s) => s.changedCalls, specs),
    },
    base: {
      markers: u((s) => s.markers, bases),
      contextMarkers: [],
      newNames: [],
      changedCalls: [],
    },
  };
}

export interface Bisection {
  /** The one winner whose removal the bisection points to (null: an interaction). */
  culprit: string | null;
  /** No half regressed alone: the regression needs winners from both halves. */
  interaction: [string[], string[]] | null;
  tested: { set: string[]; regressed: boolean }[];
}

/**
 * Bisect a regressing winner set: test the first half, then the second, and recurse into the one
 * that regresses alone. Never runs a holdout: `regresses` is the R4 check on the R4 scenarios.
 */
export async function bisectWinners(
  ids: readonly string[],
  regresses: (set: string[]) => Promise<boolean>,
): Promise<Bisection> {
  const tested: Bisection["tested"] = [];
  const check = async (set: string[]): Promise<boolean> => {
    const regressed = await regresses(set);
    tested.push({ set, regressed });
    return regressed;
  };
  let set = [...ids];
  while (set.length > 1) {
    const mid = Math.ceil(set.length / 2);
    const a = set.slice(0, mid);
    const b = set.slice(mid);
    if (await check(a)) set = a;
    else if (await check(b)) set = b;
    else return { culprit: null, interaction: [a, b], tested };
  }
  return { culprit: set[0] ?? null, interaction: null, tested };
}

/**
 * An R4 check of one winner set against base; `regressed` is an R4 Holm loss, an attributable
 * destructive entry, or a review stop decided `drop`.
 */
export interface SetCheck {
  set: string[];
  label: string;
  score: R4FinalistScore;
  regressed: boolean;
}

export interface CombinedOpts {
  repo: string;
  groups: readonly Group[];
  args: string[];
  /** The row root (default EVAL_TOURNAMENT_ROOT or ~/.local/state/mu-next/eval-transcripts/hill-r2). */
  root?: string;
  deps?: GateOpts["deps"] & {
    /** Build a surface with these patches on base (default buildVariant). */
    build?: (
      baseDir: string,
      baseSha: string,
      label: string,
      patches: readonly string[],
    ) => { dir: string; built: { ok: boolean; why?: string } };
    /** The judges' hash (default judgesHash(repo)). */
    hash?: () => string;
  };
}

const defaultBuild = (
  baseDir: string,
  baseSha: string,
  label: string,
  patches: readonly string[],
): { dir: string; built: { ok: boolean; why?: string } } =>
  buildVariant(
    baseDir,
    baseSha,
    label,
    patches,
    surfaceDir(`hill2-c7-${sha256(label).slice(0, 10)}`),
  );

/**
 * `tournament final --combined`: C7 over every group's winner. Exit code: 0 the combination passes
 * R4 (and the holdouts ran, or were already spent), 1 an R4 regression (the decision row names the
 * winner to drop: re-run with `--drop <id>`), 7 a review stop.
 */
export async function runCombined(o: CombinedOpts): Promise<number> {
  const root = o.root ?? process.env.EVAL_TOURNAMENT_ROOT ?? ROW_ROOT;
  const dir = c7Dir(root);
  const only = flag(o.args, "--groups")?.split(",").filter(Boolean);
  const groups = only ? o.groups.filter((g) => only.includes(g)) : o.groups;
  const drop = flag(o.args, "--drop")?.split(",").filter(Boolean) ?? [];
  const { winners, setup, none } = groupWinners({
    root,
    repo: o.repo,
    groups,
    hash: (o.deps?.hash ?? (() => judgesHash(o.repo).hash))(),
    drop,
  });
  for (const n of none) console.log(n);
  if (winners.length === 0 || !setup) {
    appendControl(dir, { kind: "decision", c7: true, winner: null, why: "no group winner" });
    console.log("C7: no group winner: base stays");
    return 0;
  }
  const own = setupOf(readControl(dir));
  if (own && own.baseSha !== setup.baseSha)
    throw new Error(`c7 rows are on base ${own.baseSha}, the winners on ${setup.baseSha}`);
  if (!own) appendControl(dir, setup);
  const ids = winners.map((w) => w.id);
  console.log(`C7 winners: ${winners.map((w) => `${w.group} ${w.id}`).join(", ")}`);
  const build = o.deps?.build ?? defaultBuild;
  const surfaces = new Map<string, string>();
  const surfaceFor = (set: readonly string[]): string => {
    const label = setLabel(set);
    const have = surfaces.get(label);
    if (have) return have;
    const patches = winners.filter((w) => set.includes(w.id)).map((w) => w.patch);
    const b = build(setup.baseDir, setup.baseSha, label, patches);
    if (!b.built.ok) throw new Error(`C7: ${label} does not build: ${b.built.why ?? ""}`);
    surfaces.set(label, b.dir);
    return b.dir;
  };
  let full: string;
  try {
    full = surfaceFor(ids);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    appendControl(dir, { kind: "decision", c7: true, winner: null, set: ids, why });
    console.error(`${why}: the winners' patches do not combine; a person picks which to drop`);
    return 1;
  }
  // ---- the R4 scenarios: every winner's exercising ones (§4.4), scanned against base once
  const rows = readControl(dir);
  const candidates = (
    flag(o.args, "--scenarios")?.split(",").filter(Boolean) ?? scenarioIds(false)
  ).filter((id) => !HOLDOUTS.includes(id));
  const spec = setSpec(winners);
  const specOf = (variant: string): ExposureSpec => {
    if (variant === BASE) return spec.base;
    const set = variant.slice(C7.length + 1).split("+");
    const ws = winners.filter((w) => set.includes(w.id));
    if (ws.length > 0) return setSpec(ws).set;
    const w = winners.find((x) => x.id === variant);
    if (w) return w.variant.spec;
    throw new Error(`C7: no spec for ${variant}`);
  };
  const gate = { group: C7 as R4Job["group"], dir, args: o.args, deps: o.deps };
  let ctx: ScanContext | undefined;
  const selected = new Set<string>();
  for (const w of winners) {
    let scan = [...rows]
      .reverse()
      .find((r) => r.kind === "scan" && (r as unknown as ScanResult).variant === w.id) as unknown as
      | ScanResult
      | undefined;
    if (!scan) {
      ctx ??= await scanContext(gate, setup, 0, candidates, specOf);
      scan = await scanOne(ctx, w.variant);
      appendControl(dir, { kind: "scan", epoch: 0, group: w.group, ...scan });
    }
    for (const s of scan.selected) selected.add(s);
    console.log(`${w.id}: ${scan.selected.join(", ") || "no exercising scenario"}`);
  }
  const scenarios = [...selected].sort();
  if (scenarios.length === 0) {
    console.error("C7: no scenario exercises any winner: add one (§2.2) before the gate");
    return 1;
  }
  const reps = r4Reps(scenarios.length);
  const models = [...setup.models.weak, setup.models.gate];
  const floor = repFloor("r4", 0);
  const out = r4File(dir, 0);
  const base = surfaceOf("hill2-base", setup.baseDir);
  const decisions = readControl(dir).flatMap((r) => (r.kind === "review_decision" ? [r] : []));
  /** R4 of one set against base (base rows run once, with the full set, and are shared). */
  const check = async (set: string[]): Promise<SetCheck> => {
    const label = setLabel(set);
    const surface = surfaceOf(label, surfaceFor(set));
    const jobs: R4Job[] = [];
    for (const scenario of scenarios)
      for (const model of models)
        for (let k = 0; k < reps; k++)
          for (const [variant, s] of [
            [label, surface],
            [BASE, base],
          ] as const)
            jobs.push({
              group: C7,
              round: "r4",
              variant,
              surface: s,
              scenario,
              model,
              rep: floor + k,
            });
    await runR4({
      jobs: shuffle(jobs, `${setup.seed}:c7:${label}`),
      out,
      logRoot: join(dir, "logs"),
      concurrency: num(o.args, "--concurrency", 6),
      providerExt: setup.providerExt ?? undefined,
      spec: specOf,
      run: o.deps?.run,
    });
    const r4 = readR4Rows(out).filter(
      (r) => r.round === "r4" && (r.variant === label || r.variant === BASE),
    );
    const [score] = scoreR4({
      rows: r4,
      finalists: [{ id: label, scenarios, reps, wins: 1, winZ: 0, textDelta: 0 }],
      models,
      weak: setup.models.weak,
      repFloor: floor,
      decisions,
    }).finalists;
    if (!score) throw new Error(`C7: no score for ${label}`);
    const regressed =
      score.models.some((m) => m.loss) ||
      score.attributable.length > 0 ||
      score.eliminated.some((e) => e.startsWith("review drop"));
    appendControl(dir, {
      kind: "c7_r4",
      set,
      label,
      scenarios,
      reps,
      regressed,
      models: score.models,
      attributable: score.attributable,
      cells: score.cells,
    });
    console.log(
      `${label}: ${regressed ? "REGRESSES" : "no regression"}; ${score.models.map((m) => `${m.model} ${m.variant.completed}/${m.variant.n} vs ${m.base.completed}/${m.base.n} Holm ${m.holmP.toFixed(3)}${m.loss ? " LOSS" : ""}`).join("; ")}`,
    );
    return { set, label, score, regressed };
  };
  const first = await check(ids);
  if (first.score.reviews.length > 0) {
    for (const s of first.score.reviews)
      console.log(
        `review stop ${appendReviewStop(dir, { ...s, source: "r4" }, o.deps?.ping)}: ${s.variant} ${s.cell}: ${s.entries.join("; ")}`,
      );
    return EXIT_REVIEW;
  }
  if (!first.regressed) {
    const spent = (readControl(dir) as unknown as Record<string, unknown>[]).find(
      (r) => r.kind === "final_score",
    );
    if (spent) {
      const why = `combination passes R4; the holdouts were spent on ${String(spent.ref)}: this combination has no clean holdout result (§4.6)`;
      appendControl(dir, { kind: "decision", c7: true, winner: ids.join("+"), set: ids, why });
      console.log(`C7: ${why}`);
      return 0;
    }
    appendControl(dir, {
      kind: "decision",
      c7: true,
      winner: ids.join("+"),
      set: ids,
      why: "combination passes R4: holdouts next",
    });
    console.log("C7: no R4 regression: the holdouts, once");
    return runFinal({
      ...gate,
      repo: o.repo,
      // runFinal reads the first --surface: the combined one
      args: ["--surface", full, ...o.args],
    });
  }
  const b =
    ids.length === 1
      ? { culprit: ids[0] ?? null, interaction: null, tested: [] }
      : await bisectWinners(ids, async (set) => (await check(set)).regressed);
  const zOf = (id: string): number => winners.find((w) => w.id === id)?.winZ ?? 0;
  const suggest = b.interaction
    ? [...b.interaction.flat()].sort((x, y) => zOf(x) - zOf(y) || x.localeCompare(y))[0]
    : b.culprit;
  const why = b.interaction
    ? `R4 regression; no half regresses alone (${b.interaction.map((h) => h.join("+")).join(" | ")}): an interaction. Drop one of them, the lowest win z is ${suggest}`
    : `R4 regression: bisection points to ${b.culprit}; drop it`;
  appendControl(dir, {
    kind: "decision",
    c7: true,
    winner: null,
    set: ids,
    regression: true,
    drop: suggest ?? null,
    interaction: b.interaction,
    tested: b.tested,
    why,
  });
  console.log(
    `C7: ${why}. Holdouts not run. Re-run: tournament final --combined --drop ${suggest}`,
  );
  (o.deps?.ping ?? ntfyPing)(`C7 regression: drop ${suggest}`);
  return 1;
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
