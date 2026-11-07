// `node tools/eval/main.ts tournament <sub> ...`: the tournament driver (spec
// docs/specs/2026-11-07-hill-r2-tournament.md §3-§4, unit B3b). main.ts dispatches here and nowhere
// else. Order per group: freeze → pack → design → audit → build → r1 → r2 → r3 → r4 (→ final,
// report). Every command after the freeze refuses on changed judges and on a pending review stop.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ColdRow, readRows, runCold, runColdCheck } from "./cold-guess.ts";
import { surfaceVocab } from "./cold-help.ts";
import { INTENTS } from "./cold-intents.ts";
import { runCheck, scenarioIds } from "./commands.ts";
import { callKey } from "./exposure.ts";
import {
  type Group,
  nextLint,
  readProbeRows,
  runNext,
  runNextCheck,
  SYSTEM_SHA,
} from "./nextstep.ts";
import { NEXT_CASES } from "./nextstep-cases.ts";
import { type IccRow, iccModel, iccPooled } from "./stats.ts";
import { prepareSurface, surfaceFromDir } from "./surface.ts";
import {
  appendControl,
  appendReviewDecision,
  appendReviewStop,
  assertB0,
  assertFrozen,
  assertNoPendingStops,
  type ControlRow,
  coldFile,
  epochOf,
  GATE,
  type IsolationRow,
  nPlan,
  pendingStops,
  planCmhPower,
  powerLine,
  probeFile,
  REP_BASE,
  readControl,
  roundJobs,
  rowDir,
  type SetupRow,
  setupOf,
  WEAK,
  wallEstimate,
} from "./tournament.ts";
import {
  assessVariant,
  buildVariant,
  collectGoldenTraces,
  commandPaths,
  type GoldenTrace,
  HOLDOUTS,
  judgesHash,
  listCandidates,
  type VariantRow,
} from "./tournament-build.ts";
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
import { BASE, cut, scoreRound } from "./tournament-score.ts";
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
  freeze <g> --base <sha> --b0 <rows.jsonl> --b5 <probe.jsonl> [--b5-cold <cold.jsonl>] [--weak a,b] [--gate m] [--provider-ext p] [--seed s] [--no-checks]
  refreeze <g> --row <row id> --why "<reason>"
  plan <g> [--variants 12] [--entrants 6]
  pack <g> [--brief tools/eval/candidates/<g>/brief.src.md]
  design <g> --model <m> [--session <name>]
  audit <g> [--session <name>]
  build <g> [--scenarios a,b]
  r1 <g> | r2 <g>   [--concurrency 24] [--model-concurrency 8] [--max-load 14]
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

const icc = (
  rows: readonly { arm: string; paraphrase: string; model: string; hit: boolean }[],
): IccRow[] =>
  rows.map((r) => ({ cluster: `${r.arm}|${r.paraphrase}`, model: r.model, hit: r.hit }));

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
  const probe = b5.flatMap((f) => readProbeRows(f)).filter((r) => r.surface === BASE);
  const models = [...weak, gate];
  const rho: SetupRow["rho"] = {};
  const rhoPool: SetupRow["rhoPool"] = {};
  for (const c of [...new Set(probe.map((r) => r.case))]) {
    const rows = icc(probe.filter((r) => r.case === c));
    rho[c] = Object.fromEntries(models.map((m) => [m, iccModel(rows, m)]));
    rhoPool[c] = iccPooled(rows, weak);
  }
  const coldPath = flag(args, "--b5-cold");
  if (coldPath) {
    const cold = readRows(coldPath).filter((r) => r.surface === BASE);
    const rows = cold.map((r) => ({ cluster: r.intent, model: r.model, hit: r.hit }));
    rho["cold-guess"] = Object.fromEntries(models.map((m) => [m, iccModel(rows, m)]));
  }
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

/** Base's golden traces, run twice (noise mask), cached in the row dir. */
async function baseTraces(
  dir: string,
  surface: Surface,
  scenarios: string[],
): Promise<{ first: GoldenTrace[]; again: GoldenTrace[] }> {
  const f = join(dir, "golden-base.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const o = { cases: NEXT_CASES, scenarios };
  const t = {
    first: await collectGoldenTraces(surface, o),
    again: await collectGoldenTraces(surface, o),
  };
  writeFileSync(f, JSON.stringify(t));
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
  const surfaces = [
    { label: BASE, surface: baseSurface(setup) },
    ...entrants.map((v) => ({
      label: v.id,
      surface: { ...surfaceFromDir(`hill2-${v.id}`, v.dir), family: "next" as const },
    })),
  ];
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
    concurrency: Number(flag(args, "--concurrency") ?? 24),
    modelConcurrency: Number(flag(args, "--model-concurrency") ?? 8),
  };
  const est = wallEstimate(jobs, NEXT_CASES, conc);
  console.log(
    `${which}: ${est.rows} rows, about ${est.hours.toFixed(1)} h (slots ${est.slotHours.toFixed(1)} h, models ${est.modelHours.toFixed(1)} h)`,
  );
  const out = probeFile(dir, epoch);
  const promptDir = join(dir, "prompts");
  const started = Date.now();
  await runNext({
    jobs,
    out,
    promptDir,
    ...conc,
    maxLoad: Number(flag(args, "--max-load") ?? 14),
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
  const floor = epoch * 1000 + REP_BASE[which];
  const probe = readProbeRows(out).filter(
    (r) => r.round === which && r.rep >= floor && r.rep < floor + 900,
  );
  const lint = nextLint(surfaces, NEXT_CASES);
  const scores = scoreRound({
    round: which,
    group,
    rows: probe,
    cold,
    variants: entrants,
    setup,
    headline: NEXT_CASES.filter((c) => c.group === group && c.role === "headline").map((c) => c.id),
    headlineAny: NEXT_CASES.filter((c) => c.role === "headline").map((c) => c.id),
    nameCues: lint.nameCues,
    prompt: (sha) => {
      const f = join(promptDir, `${sha}.txt`);
      return existsSync(f) ? readFileSync(f, "utf8") : "";
    },
    S: which === "r2" ? entrants.length : undefined,
    decisions: rows.flatMap((r) => (r.kind === "review_decision" ? [r] : [])),
    repFloor: floor,
  });
  appendControl(dir, {
    kind: "round_score",
    round: which,
    epoch,
    S: which === "r2" ? entrants.length : null,
    scores,
  });
  const tokens: Record<string, number> = {};
  for (const r of probe) tokens[r.model] = (tokens[r.model] ?? 0) + r.tokens;
  for (const r of cold) tokens[r.model] = (tokens[r.model] ?? 0) + r.tokens;
  appendControl(dir, { kind: "spend", round: which, epoch, tokens, wallMs: Date.now() - started });
  const stops = scores.flatMap((s) => s.reviews);
  if (stops.length > 0) {
    for (const s of stops)
      console.log(
        `review stop ${appendReviewStop(dir, s)}: ${s.variant} ${s.cell}: ${s.entries.join("; ")}`,
      );
    return EXIT_REVIEW;
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

export async function tournamentCli(args: string[]): Promise<number> {
  const [sub, g, ...rest] = args;
  if (!sub || sub === "--help" || sub === "help") {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  const group = g as Group;
  if (!GROUPS.includes(group)) {
    console.error(USAGE);
    return 2;
  }
  const dir = rowDir(group);
  const rows = readControl(dir);
  const frozen = (): void => assertFrozen(rows, judgesHash(REPO_ROOT).hash);
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
      const plan = nPlan(group, NEXT_CASES, setup);
      appendControl(dir, {
        kind: "freeze",
        judgesHash: h.hash,
        files: h.files,
        nPlan: plan,
        cmhPower: planCmhPower(plan),
        checks,
      });
      for (const p of plan)
        console.log(
          `${p.case} ${p.kind}: m ${p.plan.m} r ${p.plan.r} n_eff ${p.plan.nEff.toFixed(0)}${p.plan.nEffPooled ? `/${p.plan.nEffPooled.toFixed(0)}` : ""}${p.plan.reached ? "" : ` SHORT (+${p.plan.add} paraphrases, MDE ${p.mde})`}`,
        );
      console.log(powerLine(planCmhPower(plan)));
      console.log(`frozen: judges ${h.hash}`);
      return 0;
    }
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
      const setup = setupOf(rows) ?? null;
      const freeze = [...rows].reverse().find((r) => r.kind === "freeze");
      const plan = freeze?.kind === "freeze" ? freeze.nPlan : nPlan(group, NEXT_CASES, setup);
      const n = Number(flag(rest, "--variants") ?? 12);
      const s = Number(flag(rest, "--entrants") ?? Math.ceil(n / 2));
      const models = setup ? [...setup.models.weak, setup.models.gate] : [...WEAK, GATE];
      const stub = (k: number): { label: string; surface: Surface }[] =>
        Array.from({ length: k + 1 }, (_, i) => ({
          label: i === 0 ? BASE : `v${i}`,
          surface: { name: "plan", root: "", cli: "", extension: "", skillDir: "" },
        }));
      const conc = { concurrency: 24, modelConcurrency: 8 };
      for (const p of plan)
        console.log(
          `${p.case} ${p.kind}: paraphrases ${p.plan.paraphrases} m ${p.plan.m} r ${p.plan.r} n_eff ${p.plan.nEff.toFixed(0)}${p.plan.nEffPooled ? ` pooled ${p.plan.nEffPooled.toFixed(0)}` : ""} MDE ${p.mde ?? "-"}${p.plan.reached ? "" : ` SHORT: add ${p.plan.add}`}`,
        );
      console.log(
        powerLine((freeze?.kind === "freeze" ? freeze.cmhPower : undefined) ?? planCmhPower(plan)),
      );
      for (const [which, k] of [
        ["r1", n],
        ["r2", s],
      ] as const) {
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
      const traces = await baseTraces(dir, base, scenarios);
      const vocab = surfaceVocab(base);
      const paths = commandPaths(base);
      const have = new Map(variantRows(now).map((v) => [v.id, v.patchSha]));
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
          have.get(manifest.id) !== undefined &&
          now.some((r) => r.kind === "variant" && r.id === manifest.id && r.ref === build.ref)
        )
          continue;
        const vSurface = build.built.ok
          ? { ...surfaceFromDir(`hill2-${manifest.id}`, build.dir), family: "next" as const }
          : null;
        const vTraces = vSurface
          ? await collectGoldenTraces(vSurface, { cases: NEXT_CASES, scenarios })
          : [];
        const row = assessVariant({
          manifest,
          session,
          patchText,
          build,
          baseRoot: setup.baseDir,
          baseVocab: vocab,
          baseTraces: traces.first,
          baseAgain: traces.again,
          variantTraces: vTraces,
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
