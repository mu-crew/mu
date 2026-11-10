// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// `node tools/eval/main.ts tournament <sub> ...`: the tournament driver (spec
// docs/specs/2026-11-07-hill-r2-tournament.md §3-§4, unit B3b). main.ts dispatches here and nowhere
// else. Order per group: freeze → pack → design → audit → build → r1 → r2 → r3 → r4 (→ final,
// report). Every command after the freeze refuses on changed judges and on a pending review stop.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConcurrency, rowsAtOnce } from "./claim.ts";
import { type ColdRow, readRows, runCold, runColdCheck } from "./cold-guess.ts";
import { surfaceVocab } from "./cold-help.ts";
import { INTENTS } from "./cold-intents.ts";
import { runCheck, scenarioIds } from "./commands.ts";
import { callKey } from "./exposure.ts";
import {
  type Group,
  nextLint,
  type ProbeRow,
  readProbeRows,
  runNext,
  runNextCheck,
  SYSTEM_SHA,
} from "./nextstep.ts";
import { NEXT_CASES } from "./nextstep-cases.ts";
import { prepareSurface, surfaceFromDir } from "./surface.ts";
import {
  appendControl,
  appendReviewDecision,
  appendReviewStop,
  assertB0,
  assertFrozen,
  assertMode,
  assertNoPendingStops,
  type ControlRow,
  coldFile,
  epochOf,
  FAST_TARGET,
  freshRows,
  frozenHash,
  GATE,
  type IsolationRow,
  modeOf,
  nPlan,
  parseWinRule,
  pendingStops,
  planCmhPower,
  powerLine,
  probeFile,
  REP_BASE,
  readControl,
  rhoFromB5,
  roundJobs,
  rowDir,
  ruleLine,
  ruleTests,
  type SetupRow,
  setupOf,
  WEAK,
  type WinRule,
  wallEstimate,
  winRuleOf,
  winZ,
} from "./tournament.ts";
import {
  assessVariant,
  buildVariant,
  cachedTraces,
  collectGoldenTraces,
  commandPaths,
  type GoldenTrace,
  HOLDOUTS,
  judgesHash,
  listCandidates,
  passPool,
  traceCacheKey,
  unmaskedCases,
  type VariantRow,
} from "./tournament-build.ts";
import { runCombined } from "./tournament-c7.ts";
import {
  auditSession,
  collectVariants,
  DESIGNERS_DIR,
  defaultDenyContext,
  PACKS_DIR,
  packGroup,
  packTokens,
  runDesigner,
} from "./tournament-design.ts";
import { parseManifest } from "./tournament-patch.ts";
import { EXIT_REVIEW, runFinal, runR4Gate, runScan } from "./tournament-r4.ts";
import { writeReport } from "./tournament-report.ts";
import { BASE, cut, decideFast, scoreRound } from "./tournament-score.ts";
import type { Surface } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GROUPS: readonly Group[] = [
  "c1_wait",
  "c2_close",
  "c3_notes",
  "c4_read",
  "c5_outcome",
  "c6_skill",
];

const USAGE = `usage: node tools/eval/main.ts tournament <sub> <group> ...
  --fast on plan/freeze (then r1, decide, report follow the frozen mode): R1 decides, no R2/R3/R4 per group, C7 gates
  fast plans add the help and skill+help arms to every case (--no-help-arms: the case's own arms only)
  --win-alpha <a> --correct none|variants|bonferroni on freeze --fast / migrate-fast: the fast win threshold (default 0.2, bonferroni over variants x headline cases)
  freeze <g> [--fast [--win-alpha a] [--correct c]] --base <sha> --b0 <rows.jsonl> --b5 <probe.jsonl> [--b5-cold <cold.jsonl>] [--weak a,b] [--gate m] [--provider-ext p] [--seed s] [--no-checks]
  refreeze <g> --row <row id> --why "<reason>"
  migrate-fast <g> --why "<reason>" [--win-alpha a] [--correct c] [--accept-judges <hash>]   (a full group with R1 scored switches to fast, keeping its epoch's R1 rows)
  plan <g> [--fast] [--variants 12] [--entrants 6] [--b5 <probe.jsonl> [--b5-cold <cold.jsonl>] [--weak a,b] [--gate m]]
  pack <g> [--brief tools/eval/candidates/<g>/brief.src.md]
  design <g> --model <m> [--session <name>]
  audit <g> [--session <name>]
  build <g> [--scenarios a,b] [--passes 4] [--force]   (golden passes at once, each row claims; --force re-assesses built variants from cached traces)
  r1 <g> | r2 <g>   [--concurrency auto|n] [--model-concurrency 8]   (auto: as many probe rows as muzzle's budget holds)
  decide --fast <g>   (fast mode: the R1 decision; at most one winner)
  final --combined [--base <sha>] [--groups a,b] [--drop v1,v2] [--concurrency 6]   (C7: every group's winner on one surface; R4, then holdouts once; every group must be frozen on the one base, else refused)
  review <g> --stop <id> --decision drop|continue --why "<transcript lines>"
  status <g>
  r3 <g> [--scenarios a,b] [--concurrency 6]
  r4 <g> [--concurrency 6]
  final <g> --surface <combined winners dir> [--concurrency 6]   (holdouts, once; logs under sealed/)
  report <g> --out docs/eval/hill-r2/<g>.md   (also copies tournament.jsonl to docs/eval/hill-r2/<g>.tournament.jsonl)
groups: ${GROUPS.join(", ")}`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const list = (v: string | undefined): string[] | undefined =>
  v === undefined ? undefined : v.split(",").filter((x) => x !== "");

const candDir = (group: Group): string => join(REPO_ROOT, "tools", "eval", "candidates", group);
const baseSurface = (setup: SetupRow): Surface => ({
  ...surfaceFromDir("hill2-base", setup.baseDir),
  family: "next",
});

/** The latest variant row per id. */
const variantRows = (rows: readonly ControlRow[]): VariantRow[] => [
  ...new Map(
    rows.filter((r): r is VariantRow => r.kind === "variant").map((r) => [r.id, r]),
  ).values(),
];

/** Sessions whose audit found nothing; every variant of any other session is discarded. */
const cleanSessions = (rows: readonly ControlRow[]): Set<string> => {
  const last = new Map(
    rows.filter((r): r is IsolationRow => r.kind === "isolation").map((r) => [r.session, r]),
  );
  return new Set([...last.values()].filter((r) => r.hits.length === 0).map((r) => r.session));
};

/** Admitted variants of clean sessions: the R1 field. */
const field = (rows: readonly ControlRow[]): VariantRow[] => {
  const clean = cleanSessions(rows);
  return variantRows(rows).filter((v) => v.admission.ok && clean.has(v.session));
};

/** B5's base rows: `--b5 <probe.jsonl>[,...]` and `--b5-cold <cold.jsonl>`. */
const b5Rows = (args: string[]): { probe: ProbeRow[]; cold: ColdRow[] } => {
  const coldPath = flag(args, "--b5-cold");
  return {
    probe: (list(flag(args, "--b5")) ?? [])
      .flatMap((f) => readProbeRows(f))
      .filter((r) => r.surface === BASE),
    cold: coldPath ? readRows(coldPath).filter((r) => r.surface === BASE) : [],
  };
};

/** The setup row (§6): base, B0 proof, models, ρ̂ from B5's base rows, the queue seed. */
async function makeSetup(group: Group, args: string[]): Promise<SetupRow> {
  const base = flag(args, "--base");
  const b0 = flag(args, "--b0");
  const b5 = list(flag(args, "--b5")) ?? [];
  if (!base || !b0 || b5.length === 0) throw new Error(USAGE);
  const weak = list(flag(args, "--weak")) ?? [...WEAK];
  const gate = flag(args, "--gate") ?? GATE;
  const providerExt = flag(args, "--provider-ext") ?? null;
  const surface = await prepareSurface("hill2-base", base, REPO_ROOT);
  const b0Rows = readFileSync(b0, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { model?: string; modelError?: string });
  const models = [...weak, gate];
  const { probe, cold } = b5Rows(args);
  const { rho, rhoPool } = rhoFromB5(probe, cold, { weak, gate });
  return {
    kind: "setup",
    group,
    baseSha: base,
    baseDir: surface.root,
    b0: {
      models,
      providerExt,
      rows: b0Rows
        .filter((r) => typeof r.model === "string")
        .map((r) => ({ model: r.model as string, ok: r.modelError === undefined })),
    },
    models: { weak, gate },
    providerExt,
    systemSha: SYSTEM_SHA,
    rho,
    rhoPool,
    seed: flag(args, "--seed") ?? `${group}-${base.slice(0, 8)}`,
    holdouts: { ids: [...HOLDOUTS], note: "not run, not read" },
  };
}

const r4Scenarios = (only?: string[]): string[] =>
  (only ?? scenarioIds(false)).filter((id) => !HOLDOUTS.includes(id));

/**
 * Base's golden traces, run twice (noise mask) side by side, cached in the row dir under the
 * base ref, the judges' hash and the scenario files (traceCacheKey).
 */
async function baseTraces(
  dir: string,
  surface: Surface,
  ref: string,
  scenarios: string[],
): Promise<{ first: GoldenTrace[]; again: GoldenTrace[] }> {
  const key = traceCacheKey({
    ref,
    judgesHash: judgesHash(REPO_ROOT).hash,
    scenarios,
    scenarioRoot: surface.scenarioRoot,
  });
  const o = { cases: NEXT_CASES, scenarios };
  const t = await cachedTraces(join(dir, `golden-base-${key}.json`), async () => {
    // two independent passes over fresh sandboxes; each row still takes its own muzzle claim
    const [first = [], again = []] = await passPool([0, 1], 2, () =>
      collectGoldenTraces(surface, o),
    );
    return { first, again };
  });
  const unmasked = unmaskedCases(t.first, t.again);
  if (unmasked.length > 0)
    console.log(
      `base goldens not complete on both passes (no noise mask, every difference counts): ${unmasked.join(" ")}`,
    );
  return t;
}

function audit(group: Group, rows: readonly ControlRow[], dir: string, only?: string): number {
  const gdir = join(DESIGNERS_DIR, group);
  if (!existsSync(gdir)) return 0;
  const done = new Set(rows.flatMap((r) => (r.kind === "isolation" ? [r.session] : [])));
  let n = 0;
  let excused: Set<string> | undefined;
  for (const session of readdirSync(gdir).sort()) {
    if (only !== undefined ? session !== only : done.has(session)) continue;
    const ddir = join(gdir, session);
    const ctx = defaultDenyContext({
      repo: REPO_ROOT,
      ownPack: join(ddir, "pack"),
      ownDdir: ddir,
      caseIds: NEXT_CASES.map((c) => c.id),
      providerExt: setupOf(rows)?.providerExt ?? undefined,
    });
    ctx.allow.push(join(PACKS_DIR, group));
    // a path below HOME in a top dir this host lacks names nothing the designer could read
    ctx.exists = existsSync;
    // what the pristine pack itself says is no leak (mu's docs name its own state dirs)
    excused ??= packTokens(join(PACKS_DIR, group), ctx);
    const hits = auditSession(join(ddir, "sessions"), ctx, excused);
    const model = existsSync(join(ddir, "model"))
      ? readFileSync(join(ddir, "model"), "utf8").trim()
      : "";
    appendControl(dir, { kind: "isolation", session, model, hits });
    console.log(
      `isolation ${session}: ${hits.length === 0 ? "clean" : `${hits.length} hits, every variant discarded`}`,
    );
    for (const h of hits.slice(0, 20)) console.log(`  ${h.file}: ${h.rule}: ${h.match}`);
    n++;
  }
  return n;
}

const surfacesOf = (
  setup: SetupRow,
  entrants: readonly VariantRow[],
): { label: string; surface: Surface }[] => [
  { label: BASE, surface: baseSurface(setup) },
  ...entrants.map((v) => ({
    label: v.id,
    surface: { ...surfaceFromDir(`hill2-${v.id}`, v.dir), family: "next" as const },
  })),
];

/** Score a round from its probe rows of this epoch (fresh rows only: the round's rep range). */
function scoreFrom(o: {
  which: "r1" | "r2";
  group: Group;
  dir: string;
  rows: readonly ControlRow[];
  setup: SetupRow;
  entrants: readonly VariantRow[];
  cold: readonly ColdRow[];
  fast: boolean;
  rule: WinRule;
}): { scores: ReturnType<typeof scoreRound>; probe: ProbeRow[] } {
  const epoch = epochOf(o.rows);
  const floor = epoch * 1000 + REP_BASE[o.which];
  const promptDir = join(o.dir, "prompts");
  const probe = freshRows(readProbeRows(probeFile(o.dir, epoch)), o.which, epoch);
  const lint = nextLint(surfacesOf(o.setup, o.entrants), NEXT_CASES);
  const headline = ownHeadline(o.group);
  const scores = scoreRound({
    round: o.which,
    group: o.group,
    rows: probe,
    cold: o.cold,
    variants: o.entrants,
    setup: o.setup,
    headline,
    headlineAny: NEXT_CASES.filter((c) => c.role === "headline").map((c) => c.id),
    nameCues: lint.nameCues,
    prompt: (sha) => {
      const f = join(promptDir, `${sha}.txt`);
      return existsSync(f) ? readFileSync(f, "utf8") : "";
    },
    S: o.which === "r2" ? o.entrants.length : undefined,
    decisions: o.rows.flatMap((r) => (r.kind === "review_decision" ? [r] : [])),
    repFloor: floor,
    fast: o.fast,
    ...(o.fast ? { fastZ: winZ(o.rule, o.entrants.length, headline.length) } : {}),
  });
  return { scores, probe };
}

const ownHeadline = (group: Group): string[] =>
  NEXT_CASES.filter((c) => c.group === group && c.role === "headline").map((c) => c.id);

/** The judge files that differ between two judges trees (best effort: a tree may be gone). */
function judgesDiff(from: string, to: string): string[] {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "diff-tree", "-r", "--name-only", from, to], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [`(tree ${from} not in this repo: the changed files are unknown)`];
  }
}

/** Append and print every pending review stop of a score; true when there was one (exit 7). */
function stopFor(dir: string, scores: ReturnType<typeof scoreRound>): boolean {
  const stops = scores.flatMap((s) => s.reviews);
  for (const s of stops)
    console.log(
      `review stop ${appendReviewStop(dir, s)}: ${s.variant} ${s.cell}: ${s.entries.join("; ")}`,
    );
  return stops.length > 0;
}

/**
 * §4.7 `decide --fast <group>`: re-score the group's R1 rows of this epoch (base interleaved, fresh
 * rows only) with the fast win rule, and write the decision row: at most one winner. Exit code.
 */
export function decide(group: Group, dir: string): number {
  const rows = readControl(dir);
  const setup = setupOf(rows);
  assertB0(setup);
  if (!setup) return 2;
  const epoch = epochOf(rows);
  if (!rows.some((r) => r.kind === "round_score" && r.round === "r1" && r.epoch === epoch))
    throw new Error("no R1 in this epoch: run `tournament r1` first");
  const entrants = field(rows);
  const rule = winRuleOf(rows);
  const { scores } = scoreFrom({
    which: "r1",
    group,
    dir,
    rows,
    setup,
    entrants,
    cold: [],
    fast: true,
    rule,
  });
  if (stopFor(dir, scores)) return EXIT_REVIEW;
  const d = decideFast(scores);
  const h = ownHeadline(group).length;
  console.log(`fast win rule: ${ruleLine(rule, entrants.length, h)}`);
  appendControl(dir, {
    kind: "decision",
    mode: "fast",
    epoch,
    rule: {
      ...rule,
      tests: ruleTests(rule, entrants.length, h),
      z: winZ(rule, entrants.length, h),
    },
    winner: d.winner,
    ranking: d.ranking,
    why: d.why,
    scores,
  });
  console.log(`decision: ${d.winner ?? "base stays"} (${d.why})`);
  return 0;
}

async function round(
  group: Group,
  which: "r1" | "r2",
  args: string[],
  dir: string,
): Promise<number> {
  const rows = readControl(dir);
  const setup = setupOf(rows);
  assertB0(setup);
  if (!setup) return 2;
  const freeze = [...rows].reverse().find((r) => r.kind === "freeze");
  if (freeze?.kind !== "freeze") throw new Error("no freeze row");
  const fast = modeOf(rows) === "fast";
  const epoch = epochOf(rows);
  const all = field(rows);
  let entrants = all;
  if (which === "r2") {
    const c1 = [...rows]
      .reverse()
      .find((r) => r.kind === "cut" && r.round === "r1" && r.epoch === epoch);
    if (c1?.kind !== "cut") throw new Error("no R1 cut in this epoch: run `tournament r1` first");
    const adv = new Set(c1.advanced as string[]);
    entrants = all.filter((v) => adv.has(v.id));
    if (entrants.length === 0) {
      appendControl(dir, { kind: "decision", winner: null, why: "no R2 entrants: base stays" });
      console.log("no R2 entrants: base stays");
      return 0;
    }
  }
  const surfaces = surfacesOf(setup, entrants);
  const models = [...setup.models.weak, setup.models.gate];
  const jobs = roundJobs(
    which,
    group,
    NEXT_CASES,
    freeze.nPlan,
    { surfaces, models },
    { seed: setup.seed, epoch },
  );
  const conc = {
    concurrency: parseConcurrency(flag(args, "--concurrency"), "auto"),
    modelConcurrency: Number(flag(args, "--model-concurrency") ?? 8),
  };
  const est = wallEstimate(jobs, NEXT_CASES, {
    ...conc,
    concurrency: rowsAtOnce("probe", conc.concurrency),
  });
  console.log(
    `${which}: ${est.rows} rows, about ${est.hours.toFixed(1)} h (slots ${est.slotHours.toFixed(1)} h, models ${est.modelHours.toFixed(1)} h)`,
  );
  const started = Date.now();
  await runNext({
    jobs,
    out: probeFile(dir, epoch),
    promptDir: join(dir, "prompts"),
    ...conc,
    providerExt: setup.providerExt ?? undefined,
  });
  let cold: ColdRow[] = [];
  if (which === "r2") {
    const intents = INTENTS.filter((i) => i.role === "headline" && i.families.includes("next")).map(
      (i) => i.id,
    );
    cold = await runCold({
      surfaces,
      models,
      reps: 3,
      intents,
      concurrency: conc.modelConcurrency,
      out: coldFile(dir, epoch),
      providerExt: setup.providerExt ?? undefined,
    });
    cold = readRows(coldFile(dir, epoch));
  }
  const { scores, probe } = scoreFrom({
    which,
    group,
    dir,
    rows,
    setup,
    entrants,
    cold,
    fast,
    rule: winRuleOf(rows),
  });
  appendControl(dir, {
    kind: "round_score",
    round: which,
    epoch,
    S: which === "r2" ? entrants.length : null,
    ...(fast ? { mode: "fast" } : {}),
    scores,
  });
  const tokens: Record<string, number> = {};
  for (const r of probe) tokens[r.model] = (tokens[r.model] ?? 0) + r.tokens;
  for (const r of cold) tokens[r.model] = (tokens[r.model] ?? 0) + r.tokens;
  appendControl(dir, { kind: "spend", round: which, epoch, tokens, wallMs: Date.now() - started });
  if (stopFor(dir, scores)) return EXIT_REVIEW;
  if (fast) {
    for (const s of scores)
      console.log(
        `${s.id}: fast wins ${s.wins} (z ${s.winZ.toFixed(2)}), infra ${s.infra.retries} retries / ${s.infra.excludedRows} excluded${s.eliminated.length > 0 ? ` OUT (${s.eliminated.join(", ")})` : ""}`,
      );
    console.log(`fast mode: no cut; next \`tournament decide --fast ${group}\``);
    return 0;
  }
  const c = cut(which, scores);
  appendControl(dir, { kind: "cut", round: which, epoch, ...c });
  for (const s of scores)
    console.log(
      `${s.id}: ${which === "r1" ? `score ${s.r1Score.toFixed(2)}` : `wins ${s.wins}`}${s.eliminated.length > 0 ? ` OUT (${s.eliminated.join(", ")})` : ""}`,
    );
  console.log(`${which} cut: advance ${c.advance}: ${c.advanced.join(", ") || "none"}`);
  if (which === "r2" && c.advance === 0)
    appendControl(dir, {
      kind: "decision",
      winner: null,
      why: "no R2 survivor with a win: base stays",
    });
  return 0;
}

/**
 * §4.7 `migrate-fast <group>`: a full-mode group with R1 scored in this epoch (and no R2 score, so
 * the switch never follows an R2 result) goes fast, keeping the epoch: `decide --fast` then reads
 * this epoch's R1 rows, nothing re-runs. The judges are re-checked against the latest freeze or
 * refreeze; a moved hash lists the changed files and needs `--accept-judges <the new hash>`.
 */
export function migrateFast(
  group: Group,
  dir: string,
  rows: readonly ControlRow[],
  args: string[],
  deps: { hash?: () => string; diff?: (from: string, to: string) => string[] } = {},
): number {
  const why = flag(args, "--why");
  if (!why) throw new Error(USAGE);
  if (!rows.some((r) => r.kind === "freeze")) throw new Error("not frozen yet");
  const epoch = epochOf(rows);
  const scored = (round: string): boolean =>
    rows.some((r) => r.kind === "round_score" && r.round === round && r.epoch === epoch);
  if (!scored("r1"))
    throw new Error(
      `no R1 score in epoch ${epoch}: migrate-fast reuses a scored R1, run \`tournament r1\` first`,
    );
  if (scored("r2") || rows.some((r) => r.kind === "decision"))
    throw new Error(
      `epoch ${epoch} already has an R2 score or a decision: switching to fast now would follow its result`,
    );
  const win = parseWinRule(flag(args, "--win-alpha"), flag(args, "--correct"));
  const previous = frozenHash(rows) ?? "";
  const current = (deps.hash ?? (() => judgesHash(REPO_ROOT).hash))();
  const changed = previous === current ? [] : (deps.diff ?? judgesDiff)(previous, current);
  if (changed.length > 0 && flag(args, "--accept-judges") !== current) {
    console.error(
      `judges changed since the freeze (${previous} -> ${current}): ${changed.length} files\n${changed.map((f) => `  ${f}`).join("\n")}\nmigrate-fast reuses rows judged before the change: check none of these decides an R1 row, then pass --accept-judges ${current}`,
    );
    return 1;
  }
  appendControl(dir, {
    kind: "migrate_fast",
    from: "full",
    epoch,
    why,
    win,
    judgesHash: current,
    previousJudgesHash: previous,
    judgesChanged: changed,
  });
  const h = ownHeadline(group).length;
  const n = field(rows).length;
  console.log(
    `migrated to fast mode (epoch ${epoch} kept; its R1 rows decide): win rule ${ruleLine(win, n, h)}${changed.length > 0 ? `; judges ${previous} -> ${current} accepted (${changed.length} files)` : ""}`,
  );
  console.log(`next: \`tournament decide --fast ${group}\``);
  return 0;
}

export async function tournamentCli(argv: string[]): Promise<number> {
  // `--fast` and `--combined` may stand anywhere (`decide --fast <group>`, `final --combined`)
  const fastFlag = argv.includes("--fast");
  const args = argv.filter((a) => a !== "--fast");
  const [sub, g, ...rest] = args;
  if (!sub || sub === "--help" || sub === "help") {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  if (sub === "final" && args.includes("--combined"))
    return runCombined({
      repo: REPO_ROOT,
      groups: GROUPS,
      args: args.slice(1).filter((a) => a !== "--combined"),
    });
  const group = g as Group;
  if (!GROUPS.includes(group)) {
    console.error(USAGE);
    return 2;
  }
  const dir = rowDir(group);
  const rows = readControl(dir);
  const frozen = (): void => assertFrozen(rows, judgesHash(REPO_ROOT).hash);
  assertMode(rows, sub, fastFlag);
  switch (sub) {
    case "freeze": {
      if (rows.some((r) => r.kind === "freeze"))
        throw new Error("already frozen: a judge changes only through `tournament refreeze`");
      const setup = setupOf(rows) ?? (await makeSetup(group, rest));
      assertB0(setup);
      let checks: "green" | "skipped" = "skipped";
      if (!rest.includes("--no-checks")) {
        const s = baseSurface(setup);
        const n = await runNextCheck(s);
        const c = await runColdCheck(s, null);
        const r4 = await runCheck({
          surface: s,
          scenarios: r4Scenarios(),
          includeUnderscore: false,
          family: "next",
          preflight: false,
          verbose: false,
          root: REPO_ROOT,
        });
        if (n.failures > 0 || c !== 0 || r4 !== 0) {
          console.error("freeze refused: nextstep, cold-guess or R4 check is not green on base");
          return 1;
        }
        checks = "green";
      }
      if (!setupOf(rows)) appendControl(dir, setup);
      const h = judgesHash(REPO_ROOT);
      const mode = fastFlag ? "fast" : "full";
      const plan = nPlan(group, NEXT_CASES, setup, mode, {
        helpArms: !rest.includes("--no-help-arms"),
      });
      const win = fastFlag
        ? parseWinRule(flag(rest, "--win-alpha"), flag(rest, "--correct"))
        : null;
      appendControl(dir, {
        kind: "freeze",
        judgesHash: h.hash,
        files: h.files,
        mode,
        ...(win ? { targets: { ...FAST_TARGET }, win } : {}),
        nPlan: plan,
        cmhPower: planCmhPower(plan),
        checks,
      });
      for (const p of plan)
        console.log(
          `${p.case} ${p.kind}: m ${p.plan.m} r ${p.plan.r} n_eff ${p.plan.nEff.toFixed(0)}${p.plan.nEffPooled ? `/${p.plan.nEffPooled.toFixed(0)}` : ""}${p.plan.reached ? "" : ` SHORT (+${p.plan.add} paraphrases, MDE ${p.mde})`}`,
        );
      console.log(powerLine(planCmhPower(plan)));
      if (win) console.log(`fast win rule: ${ruleLine(win)}`);
      console.log(`frozen (${mode} mode): judges ${h.hash}`);
      return 0;
    }
    case "migrate-fast":
      return migrateFast(group, dir, rows, rest);
    case "refreeze": {
      const row = flag(rest, "--row");
      const why = flag(rest, "--why");
      if (!row || !why) throw new Error(USAGE);
      if (!rows.some((r) => r.kind === "freeze")) throw new Error("not frozen yet");
      const epoch = epochOf(rows) + 1;
      appendControl(dir, {
        kind: "refreeze",
        row,
        why,
        judgesHash: judgesHash(REPO_ROOT).hash,
        epoch,
      });
      console.log(`refrozen (epoch ${epoch}): every round already run is re-run with fresh rows`);
      return 0;
    }
    case "plan": {
      // before the freeze, `--b5` plans from B5's base rows without writing a setup row
      const b5 = flag(rest, "--b5") === undefined ? null : b5Rows(rest);
      const weak = list(flag(rest, "--weak")) ?? [...WEAK];
      const gate = flag(rest, "--gate") ?? GATE;
      const setup =
        setupOf(rows) ??
        (b5 ? { models: { weak, gate }, ...rhoFromB5(b5.probe, b5.cold, { weak, gate }) } : null);
      const freeze = [...rows].reverse().find((r) => r.kind === "freeze");
      const fast = freeze?.kind === "freeze" ? freeze.mode === "fast" : fastFlag;
      const plan =
        freeze?.kind === "freeze"
          ? freeze.nPlan
          : nPlan(group, NEXT_CASES, setup, fast ? "fast" : "full", {
              helpArms: !rest.includes("--no-help-arms"),
            });
      const n = Number(flag(rest, "--variants") ?? 12);
      if (fast) {
        const rule = freeze
          ? winRuleOf(rows)
          : parseWinRule(flag(rest, "--win-alpha"), flag(rest, "--correct"));
        console.log(
          `fast mode: R1 decides (own headline n_eff ${FAST_TARGET.own} per model, ${FAST_TARGET.pooled} pooled); no R2, no per-group R4; C7 is the gate`,
        );
        console.log(
          `fast win rule at ${n} variants: ${ruleLine(rule, n, plan.filter((p) => p.kind === "own").length)}`,
        );
      }
      const s = Number(flag(rest, "--entrants") ?? Math.ceil(n / 2));
      const models = setup ? [...setup.models.weak, setup.models.gate] : [...WEAK, GATE];
      const stub = (k: number): { label: string; surface: Surface }[] =>
        Array.from({ length: k + 1 }, (_, i) => ({
          label: i === 0 ? BASE : `v${i}`,
          surface: { name: "plan", root: "", cli: "", extension: "", skillDir: "" },
        }));
      const conc = {
        concurrency: rowsAtOnce("probe", Number.POSITIVE_INFINITY),
        modelConcurrency: 8,
      };
      for (const p of plan)
        console.log(
          `${p.case} ${p.kind}: paraphrases ${p.plan.paraphrases} m ${p.plan.m} r ${p.plan.r} n_eff ${p.plan.nEff.toFixed(0)}${p.plan.nEffPooled ? ` pooled ${p.plan.nEffPooled.toFixed(0)}` : ""} MDE ${p.mde ?? "-"}${p.plan.reached ? "" : ` SHORT: add ${p.plan.add}`}`,
        );
      console.log(
        powerLine((freeze?.kind === "freeze" ? freeze.cmhPower : undefined) ?? planCmhPower(plan)),
      );
      const rounds: (readonly ["r1" | "r2", number])[] = fast
        ? [["r1", n]]
        : [
            ["r1", n],
            ["r2", s],
          ];
      for (const [which, k] of rounds) {
        const e = wallEstimate(
          roundJobs(
            which,
            group,
            NEXT_CASES,
            plan,
            { surfaces: stub(k), models },
            { seed: "plan", epoch: 0 },
          ),
          NEXT_CASES,
          conc,
        );
        console.log(
          `${which} (${k} variants + base): ${e.rows} rows, about ${e.hours.toFixed(1)} h`,
        );
      }
      return 0;
    }
    case "pack": {
      frozen();
      assertNoPendingStops(rows);
      const setup = setupOf(rows);
      if (!setup) throw new Error("no setup row");
      const src = flag(rest, "--brief") ?? join(candDir(group), "brief.src.md");
      const { dir: pack } = packGroup({
        repo: REPO_ROOT,
        baseSha: setup.baseSha,
        group,
        briefSrc: readFileSync(src, "utf8"),
        cases: NEXT_CASES,
        nodeModulesFrom: setup.baseDir,
      });
      console.log(`pack: ${pack}`);
      return 0;
    }
    case "design": {
      frozen();
      assertNoPendingStops(rows);
      const model = flag(rest, "--model");
      if (!model) throw new Error(USAGE);
      const session =
        flag(rest, "--session") ??
        (model.split("/").pop() ?? model)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "")
          .slice(0, 12);
      const pack = join(PACKS_DIR, group);
      if (!existsSync(join(pack, "BRIEF.md")))
        throw new Error(`no pack for ${group}: run \`tournament pack\``);
      const r = await runDesigner({
        group,
        model,
        session,
        pack,
        providerExt: setupOf(rows)?.providerExt ?? undefined,
      });
      writeFileSync(join(r.ddir, "model"), `${model}\n`);
      const got = collectVariants(r.pack, group, session, candDir(group));
      console.log(
        `designer ${session} (pi exit ${r.code}): ${got.ids.length} variants${got.refused.length > 0 ? `; refused ${got.refused.join("; ")}` : ""}`,
      );
      audit(group, rows, dir, session);
      return r.code === 0 ? 0 : 1;
    }
    case "audit": {
      frozen();
      const n = audit(group, rows, dir, flag(rest, "--session"));
      console.log(`${n} sessions audited`);
      return 0;
    }
    case "build": {
      frozen();
      assertNoPendingStops(rows);
      audit(group, rows, dir);
      const now = readControl(dir);
      const setup = setupOf(now);
      if (!setup) throw new Error("no setup row");
      const base = baseSurface(setup);
      const clean = cleanSessions(now);
      const scenarios = r4Scenarios(list(flag(rest, "--scenarios")));
      const traces = await baseTraces(dir, base, setup.baseSha, scenarios);
      const vocab = surfaceVocab(base);
      const paths = commandPaths(base);
      const have = new Map(variantRows(now).map((v) => [v.id, v.patchSha]));
      const todo: {
        manifest: ReturnType<typeof parseManifest>;
        session: string;
        patchText: string;
        build: ReturnType<typeof buildVariant>;
      }[] = [];
      for (const c of listCandidates(candDir(group))) {
        const session = c.manifest.slice(candDir(group).length + 1).split("/")[0] ?? "";
        if (!clean.has(session)) {
          console.log(`${c.manifest}: session ${session} not clean (or not audited): discarded`);
          continue;
        }
        const manifest = parseManifest(readFileSync(c.manifest, "utf8"), group);
        const patchText = readFileSync(c.patch, "utf8");
        const build = buildVariant(setup.baseDir, setup.baseSha, manifest.id, c.patch);
        if (
          !rest.includes("--force") &&
          have.get(manifest.id) !== undefined &&
          now.some((r) => r.kind === "variant" && r.id === manifest.id && r.ref === build.ref)
        )
          continue;
        todo.push({ manifest, session, patchText, build });
      }
      // the variants' golden passes run side by side (each row under its own muzzle claim);
      // rows are appended in candidate order once all are in
      const width = Math.max(1, Number(flag(rest, "--passes") ?? 4));
      const judges = judgesHash(REPO_ROOT).hash;
      const passes = await passPool(
        todo,
        width,
        async (t): Promise<{ traces: GoldenTrace[]; error?: string }> => {
          if (!t.build.built.ok) return { traces: [] };
          const surface = {
            ...surfaceFromDir(`hill2-${t.manifest.id}`, t.build.dir),
            family: "next" as const,
          };
          // cached like base's: a re-assessment (`--force`) reruns no golden, a refreeze does
          const key = traceCacheKey({
            ref: t.build.ref,
            judgesHash: judges,
            scenarios,
            scenarioRoot: surface.scenarioRoot,
          });
          try {
            const traces = await cachedTraces(
              join(dir, `golden-${t.manifest.id}-${key}.json`),
              () => collectGoldenTraces(surface, { cases: NEXT_CASES, scenarios }),
            );
            return { traces };
          } catch (e) {
            // one variant's broken golden pass must not discard the others'
            const error = e instanceof Error ? e.message : String(e);
            console.log(`${t.manifest.id}: golden pass failed (${error}); goldens not run`);
            return { traces: [], error };
          }
        },
      );
      for (const [i, { manifest, session, patchText, build }] of todo.entries()) {
        const pass = passes[i] ?? { traces: [], error: "no pass" };
        const row = assessVariant({
          manifest,
          session,
          patchText,
          build,
          baseRoot: setup.baseDir,
          baseVocab: vocab,
          baseTraces: traces.first,
          baseAgain: traces.again,
          variantTraces: pass.traces,
          goldenError: pass.error,
          key: (argv) => callKey(argv, paths),
        });
        appendControl(dir, row);
        console.log(
          `${row.id}: ${row.admission.ok ? "admitted" : `refused (${row.admission.failures.join("; ")})`}; markers ${row.spec.markers.length}, context ${row.spec.contextMarkers.length}, names ${row.spec.newNames.join(" ") || "-"}, calls ${row.spec.changedCalls.join(" ") || "-"}`,
        );
      }
      return 0;
    }
    case "r1":
    case "r2":
      frozen();
      assertNoPendingStops(rows);
      return round(group, sub, rest, dir);
    case "decide":
      frozen();
      assertNoPendingStops(rows);
      return decide(group, dir);
    case "review": {
      const stop = flag(rest, "--stop");
      const decision = flag(rest, "--decision");
      const why = flag(rest, "--why");
      if (!stop || (decision !== "drop" && decision !== "continue") || !why) throw new Error(USAGE);
      appendReviewDecision(dir, { stop, decision, why });
      console.log(`review ${stop}: ${decision}`);
      return 0;
    }
    case "status": {
      const kinds = new Map<string, number>();
      for (const r of rows) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
      console.log(`row dir: ${dir}`);
      console.log(`rows: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
      console.log(`epoch: ${epochOf(rows)}`);
      try {
        frozen();
        console.log("judges: frozen hash matches");
      } catch (e) {
        console.log(`judges: ${e instanceof Error ? e.message : String(e)}`);
      }
      const f = field(rows);
      console.log(`field: ${f.map((v) => v.id).join(", ") || "none"}`);
      for (const s of pendingStops(rows))
        console.log(`PENDING review ${s.id}: ${s.variant} ${s.cell}: ${s.entries.join("; ")}`);
      for (const r of rows)
        if (r.kind === "cut")
          console.log(
            `cut ${r.round} (epoch ${r.epoch}): ${(r.advanced as string[]).join(", ") || "none"}`,
          );
      return 0;
    }
    case "r3":
    case "r4":
    case "final":
    case "report": {
      frozen();
      if (sub !== "report") assertNoPendingStops(rows);
      const o = { group, dir, repo: REPO_ROOT, args: rest };
      if (sub === "r3") return runScan(o);
      if (sub === "r4") return runR4Gate(o);
      if (sub === "final") return runFinal(o);
      const out = flag(rest, "--out");
      if (!out) throw new Error(USAGE);
      return writeReport({ ...o, out });
    }
    default:
      console.error(USAGE);
      return 2;
  }
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
