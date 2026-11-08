// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The tournament report (spec docs/specs/2026-11-07-hill-r2-tournament.md §6, unit B3c): the
// markdown sections of one group from its control rows, and the committed copy of tournament.jsonl
// (`docs/eval/hill-r2/<group>.tournament.jsonl`). It reads the control file, the variant patches and
// the hashes of the row files; it never opens `sealed/`, and holdout numbers come from the
// `final_score` control row.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Group } from "./nextstep.ts";
import { fisherPower } from "./stats.ts";
import {
  ALPHA,
  type CasePlan,
  type ControlRow,
  controlFile,
  epochOf,
  type FreezeRow,
  type IsolationRow,
  planCmhPower,
  readControl,
  type SetupRow,
  setupOf,
  WORST_B,
} from "./tournament.ts";
import { listCandidates, type VariantRow } from "./tournament-build.ts";
import type { GateOpts } from "./tournament-r4.ts";
import { R4_RUNS, type R4Score, r4Reps, type ScanResult } from "./tournament-r4-score.ts";
import type { VariantScore } from "./tournament-score.ts";

/** The committed copy of a group's control file (§6, Q3). */
export const committedControl = (repo: string, group: Group): string =>
  join(repo, "docs", "eval", "hill-r2", `${group}.tournament.jsonl`);

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const f2 = (x: number): string => x.toFixed(2);
const fp = (x: number): string => (x < 0.001 ? x.toExponential(1) : x.toFixed(3));
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (head: string[], rows: string[][]): string[] => [
  `| ${head.join(" | ")} |`,
  `|${head.map(() => "---").join("|")}|`,
  ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
];

const lastOf = <K extends ControlRow["kind"]>(
  rows: readonly ControlRow[],
  kind: K,
  pick: (r: Extract<ControlRow, { kind: K }>) => boolean = () => true,
): Extract<ControlRow, { kind: K }> | undefined =>
  [...rows].reverse().find((r) => r.kind === kind && pick(r as Extract<ControlRow, { kind: K }>)) as
    | Extract<ControlRow, { kind: K }>
    | undefined;

/** A control row read by field name (the catch-all kinds carry free fields). */
type Loose = { kind: string; [k: string]: unknown };
const lastLoose = (
  rows: readonly ControlRow[],
  kind: string,
  pick: (r: Loose) => boolean = () => true,
): Loose | undefined =>
  [...(rows as unknown as Loose[])].reverse().find((r) => r.kind === kind && pick(r));

// ---- error rates and power ----------------------------------------------------------------------

/** Groups run one after another; each controls its false wins at ALPHA. */
export const GROUPS_N = 6;
/** False-loss bounds per round under the null (§4.1: Holm + CMH ≤ 0.10; §4.5: Holm ≤ 0.05). */
export const FALSE_LOSS = { r1: 0.1, r2: 0.1, r4: 0.05 } as const;

export interface PowerFacts {
  ownPerModel: number[];
  ownPooled: number[];
  B: number;
  /** Fisher power of the pooled win test for 0.5 → 0.8 at the planned pooled n_eff, α 0.05/B (the worst own case). */
  winPower: number;
  cmh: { drop: string; power: number }[];
  /** Fisher power of the R4 test for 0.8 → 0.5 at α 0.05/3, per pooled run count. */
  r4: { k: number; n: number; power: number }[];
  /** P(≥ 1 false winner across the six groups) ≤ 1 − (1 − α)^6. */
  falseWinAny: number;
  /** End-to-end chance to land a real 0.5 → 0.8 fix: no false loss in R1, R2, R4, times win power. */
  endToEnd: number;
}

/**
 * The numbers the report states (§4.2 at the frozen plan, never the spec table's assumed n): own
 * headline n_eff per model and pooled, the win power at B = S·h, the plan's CMH power, the R4
 * power at the pooled run counts, the six-group false-win bound and the end-to-end power.
 */
export function powerFacts(
  plan: readonly CasePlan[],
  o: { S?: number; ks?: readonly number[] } = {},
): PowerFacts {
  const own = plan.filter((p) => p.kind === "own");
  const B = o.S !== undefined ? Math.max(1, o.S * Math.max(1, own.length)) : WORST_B;
  const pooled = own.map((p) => Math.round(p.plan.nEffPooled ?? p.plan.nEff));
  const winPower =
    pooled.length === 0
      ? 0
      : Math.min(...pooled.map((n) => fisherPower(0.8, 0.5, n, n, ALPHA / B, "greater")));
  const ks = [...new Set(o.ks && o.ks.length > 0 ? o.ks : [3, 4, 6])].sort((a, b) => a - b);
  const r4 = ks.map((k) => {
    const n = k * r4Reps(k);
    return { k, n, power: fisherPower(0.5, 0.8, n, n, ALPHA / 3, "less") };
  });
  return {
    ownPerModel: own.map((p) => Math.round(p.plan.nEff)),
    ownPooled: pooled,
    B,
    winPower,
    cmh: planCmhPower(plan),
    r4,
    falseWinAny: 1 - (1 - ALPHA) ** GROUPS_N,
    endToEnd: (1 - FALSE_LOSS.r1) * (1 - FALSE_LOSS.r2) * (1 - FALSE_LOSS.r4) * winPower,
  };
}

function powerSection(p: PowerFacts): string[] {
  return [
    "### Error rates and power (at the frozen plan)",
    "",
    `- Own headline cases: per-model n_eff ${p.ownPerModel.join(", ") || "-"}, pooled weak-model n_eff ${p.ownPooled.join(", ") || "-"}.`,
    `- Win power (pooled Fisher, 0.5 → 0.8, α 0.05/${p.B}): ${f2(p.winPower)} on the weakest own case.`,
    `- CMH loss power per model at the planned per-case n_eff (α 0.05/3, cold-guess stratum not counted): ${p.cmh.map((c) => `${c.drop} ${f2(c.power)}`).join(", ")}.`,
    `- R4 loss power per model (Fisher, 0.8 → 0.5, α 0.05/3; ${R4_RUNS} runs wanted): ${p.r4.map((r) => `k = ${r.k}: n ${r.n}, ${f2(r.power)}`).join("; ")}.`,
    `- **False wins are controlled per group, not across groups.** Each group lands a false R2 win with probability at most ${ALPHA}; over the ${GROUPS_N} groups the chance of at least one false winner in the combined surface is up to 1 − 0.95^${GROUPS_N} = ${f2(p.falseWinAny)}. The holdouts are a no-regression check only: they cannot catch a false win.`,
    `- **End-to-end power.** A real 0.5 → 0.8 fix must survive a false loss in R1 (≤ ${FALSE_LOSS.r1}), R2 (≤ ${FALSE_LOSS.r2}) and R4 (≤ ${FALSE_LOSS.r4}) and win R2: (1 − ${FALSE_LOSS.r1})·(1 − ${FALSE_LOSS.r2})·(1 − ${FALSE_LOSS.r4})·${f2(p.winPower)} ≈ ${f2(p.endToEnd)}. The R1 cut and the holdout gate are not counted, so this is an upper bound.`,
    "",
  ];
}

// ---- sections -----------------------------------------------------------------------------------

function setupSection(
  dir: string,
  rows: readonly ControlRow[],
  setup: SetupRow | undefined,
  freeze: FreezeRow | undefined,
  power: PowerFacts | null,
): string[] {
  const out = ["## 1. Setup", ""];
  if (setup) {
    out.push(
      `- Base: \`${setup.baseSha}\` built at \`${setup.baseDir}\``,
      `- Models: weak ${setup.models.weak.join(", ")}; gate ${setup.models.gate}; provider ext ${setup.providerExt ?? "-"}; systemSha ${setup.systemSha}`,
      `- B0: ${setup.b0.rows.map((r) => `${r.model} ${r.ok ? "ok" : "FAILED"}`).join(", ") || "none"}`,
      `- Queue seed: ${setup.seed}; holdouts ${setup.holdouts.ids.join(", ")} (${setup.holdouts.note})`,
    );
  } else out.push("- no setup row");
  if (freeze) out.push(`- judgesHash: \`${freeze.judgesHash}\` (checks ${freeze.checks})`);
  const refreezes = rows.filter((r) => r.kind === "refreeze");
  for (const r of refreezes)
    if (r.kind === "refreeze") out.push(`- refreeze (epoch ${r.epoch}) on ${r.row}: ${r.why}`);
  out.push("");
  if (setup) {
    const models = [...setup.models.weak, setup.models.gate];
    const cases = Object.keys(setup.rho).sort();
    out.push(
      ...table(
        ["case", ...models.map((m) => `ρ̂ ${m}`), "ρ̂_pool"],
        cases.map((c) => [
          c,
          ...models.map((m) =>
            setup.rho[c]?.[m] === undefined ? "-" : f2(setup.rho[c]?.[m] ?? 0),
          ),
          setup.rhoPool[c] === undefined ? "-" : f2(setup.rhoPool[c] ?? 0),
        ]),
      ),
      "",
    );
  }
  if (freeze) {
    out.push(
      "n plan:",
      "",
      ...table(
        [
          "case",
          "kind",
          "paraphrases",
          "m",
          "r",
          "n_eff per model",
          "pooled n_eff",
          "MDE",
          "reached",
        ],
        freeze.nPlan.map((p) => [
          p.case,
          p.kind,
          String(p.plan.paraphrases),
          String(p.plan.m),
          String(p.plan.r),
          p.plan.nEff.toFixed(0),
          p.plan.nEffPooled === undefined ? "-" : p.plan.nEffPooled.toFixed(0),
          p.mde === null ? "-" : String(p.mde),
          p.plan.reached ? "yes" : `SHORT (+${p.plan.add})`,
        ]),
      ),
      "",
    );
  }
  if (power) out.push(...powerSection(power));
  const iso = rows.filter((r): r is IsolationRow => r.kind === "isolation");
  out.push("Designer sessions:", "");
  if (iso.length === 0) out.push("- none");
  for (const r of iso)
    out.push(
      `- ${r.session} (${r.model || "?"}): ${r.hits.length === 0 ? "clean" : `${r.hits.length} hits, every variant discarded`}`,
    );
  out.push("", `Row dir: \`${dir}\``, "");
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
    : [];
  out.push(
    ...table(
      ["file", "sha256"],
      files.map((f) => [f, sha256(join(dir, f))]),
    ),
    "",
  );
  return out;
}

function patchOf(candDir: string, id: string): string | null {
  for (const c of listCandidates(candDir)) {
    try {
      if ((JSON.parse(readFileSync(c.manifest, "utf8")) as { id?: string }).id === id)
        return readFileSync(c.patch, "utf8");
    } catch {}
  }
  return null;
}

function variantsSection(vs: readonly VariantRow[], candDir: string): string[] {
  const out = ["## 2. Variants", ""];
  if (vs.length === 0) out.push("none", "");
  for (const v of vs) {
    const patch = patchOf(candDir, v.id);
    out.push(
      `### ${v.id}`,
      "",
      `- ${v.manifest.summary} (kind ${v.manifest.kind.join(", ")}; session ${v.session})`,
      `- markers: ${v.spec.markers.map((m) => `\`${m}\``).join(", ") || "-"}; context: ${v.spec.contextMarkers.map((m) => `\`${m}\``).join(", ") || "-"}`,
      `- behaviour: names ${v.spec.newNames.join(" ") || "-"}; calls ${v.spec.changedCalls.join(" ") || "-"}`,
      `- text delta ${v.textDelta}; admission ${v.admission.ok ? "ok" : `REFUSED: ${v.admission.failures.join("; ")}`}; goldenCompat ${v.goldenCompat.broken.join(", ") || "clean"}`,
      "",
      "<details><summary>patch</summary>",
      "",
      "```diff",
      (patch ?? "(patch not found)").trimEnd(),
      "```",
      "",
      "</details>",
      "",
    );
  }
  return out;
}

function caseResult(s: VariantScore, c: string): string {
  if (s.loss.some((l) => l.case === c && l.loss)) return "loss";
  const w = s.win.find((x) => x.case === c);
  const cue = w && w.nameCueRows > 0 ? ` (nameCue ${w.nameCueRows})` : "";
  if (!w) return "no loss";
  if (w.win) return `win${cue}`;
  if (w.unexposed) return `unexposed${cue}`;
  return `tie${cue}`;
}

function roundSection(rows: readonly ControlRow[], round: "r1" | "r2", epoch: number): string[] {
  const out = [`### ${round.toUpperCase()}`, ""];
  const rs = lastOf(rows, "round_score", (r) => r.round === round && r.epoch === epoch);
  if (!rs) return [...out, "not run", ""];
  const scores = rs.scores as VariantScore[];
  const models = [...new Set(scores.flatMap((s) => s.loss.map((l) => l.model)))];
  if (round === "r2") out.push(`S = ${String(rs.S)}`, "");
  for (const s of scores) {
    const cases = [...new Set([...s.win.map((w) => w.case), ...s.loss.map((l) => l.case)])];
    out.push(
      `#### ${s.id}`,
      "",
      ...table(
        ["case", ...models, "exposed clusters", "win p (threshold)", "result"],
        cases.map((c) => {
          const w = s.win.find((x) => x.case === c);
          return [
            c,
            ...models.map((m) => {
              const l = s.loss.find((x) => x.case === c && x.model === m);
              return l
                ? `${l.variant.hits}/${l.variant.n} (n_eff ${l.variant.nStar}, p ${fp(l.p)}, Holm ${fp(l.holmP)})`
                : "-";
            }),
            w ? String(w.exposedClusters) : "-",
            w ? `${fp(w.p)}${w.threshold === null ? "" : ` (${fp(w.threshold)})`}` : "-",
            caseResult(s, c),
          ];
        }),
      ),
      "",
      `CMH per model: ${s.cmh.map((c) => `${c.model} z ${f2(c.z)} p ${fp(c.p)}${c.loss ? " LOSS" : ""}`).join("; ")}`,
      "",
      `Keys: R1 score ${f2(s.r1Score)}, wins ${s.wins}, win z ${f2(s.winZ)}, exposed weak hits ${s.hitsExposed}, mean tokens ${s.meanTokens.toFixed(0)}, text delta ${s.textDelta}; eliminated: ${s.eliminated.join(", ") || "no"}`,
      "",
    );
  }
  const cut = lastOf(rows, "cut", (r) => r.round === round && r.epoch === epoch);
  if (cut)
    out.push(
      `Cut: ranking ${(cut.ranking as string[]).join(" > ")}; eligible ${(cut.eligible as string[]).join(", ") || "none"}; advance ${String(cut.advance)}: ${(cut.advanced as string[]).join(", ") || "none"}`,
      "",
    );
  return out;
}

function scanSection(rows: readonly ControlRow[], epoch: number): string[] {
  const out = ["## 4. R3 scan", ""];
  const scans = [
    ...new Map(
      rows
        .filter((r) => r.kind === "scan" && r.epoch === epoch)
        .map((r) => [(r as unknown as ScanResult).variant, r as unknown as ScanResult]),
    ).values(),
  ];
  if (scans.length === 0) return [...out, "not run", ""];
  const ids = [...new Set(scans.flatMap((s) => s.scenarios.map((x) => x.id)))].sort();
  out.push(
    ...table(
      ["scenario", ...scans.map((s) => s.variant)],
      ids.map((id) => [
        id,
        ...scans.map((s) => {
          const x = s.scenarios.find((y) => y.id === id);
          if (!x) return "-";
          const live = x.live ? `; live ${x.live.exposed}/${x.live.runs} exposed` : "";
          return `${x.exercised ? `yes (${x.why.join(", ")})` : "no"}${live}${s.selected.includes(id) ? "; R4" : ""}`;
        }),
      ]),
    ),
    "",
  );
  const cannot = scans.filter((s) => !s.canWin);
  for (const s of cannot)
    out.push(`- ${s.variant}: no scenario exercises it, so it cannot win (§4.4 step 5).`);
  if (cannot.length > 0) out.push("");
  return out;
}

function r4Section(rows: readonly ControlRow[], epoch: number): string[] {
  const out = ["## 5. R4", ""];
  const s = lastLoose(rows, "r4_score", (r) => r.epoch === epoch) as unknown as R4Score | undefined;
  if (!s) return [...out, "not run", ""];
  const seen = new Set<string>();
  const cells = s.finalists
    .flatMap((f) => f.cells)
    .filter((c) => {
      const k = `${c.scenario}|${c.model}|${c.surface}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) =>
      `${a.scenario}|${a.model}|${a.surface}`.localeCompare(
        `${b.scenario}|${b.model}|${b.surface}`,
      ),
    );
  out.push(
    ...table(
      [
        "scenario",
        "model",
        "surface",
        "completed",
        "exposed",
        "wrong",
        "muErrors",
        "destructive (attributable / new / noted)",
      ],
      cells.map((c) => [
        c.scenario,
        c.model,
        c.surface,
        `${c.completed}/${c.runs}`,
        String(c.exposed),
        String(c.wrong),
        String(c.muErrors),
        `${c.attributable} / ${c.review} / ${c.noted}`,
      ]),
    ),
    "",
  );
  for (const f of s.finalists)
    out.push(
      `- ${f.id} (${f.scenarios.length} scenarios × ${f.reps} reps): ${f.models.map((m) => `${m.model} ${m.variant.completed}/${m.variant.n} vs base ${m.base.completed}/${m.base.n}, p ${fp(m.p)}, Holm ${fp(m.holmP)}${m.loss ? " LOSS" : ""}`).join("; ")}; exercised ${f.exercised ? "yes" : "no"}; mean cost ${f.meanCost.toFixed(0)}; ${f.passes ? "passes" : `out: ${f.eliminated.join(", ") || "review pending"}`}`,
    );
  out.push(
    `- base mean cost ${s.base.meanCost.toFixed(0)}, spread (max − min of per-rep totals) ${s.base.spread.toFixed(0)}`,
    "",
  );
  return out;
}

function reviewSection(rows: readonly ControlRow[]): string[] {
  const rs = rows.filter((r) => r.kind === "review_stop" || r.kind === "review_decision");
  return [
    "## 6. Review stops and decisions",
    "",
    ...(rs.length === 0 ? ["none"] : ["```json", ...rs.map((r) => JSON.stringify(r)), "```"]),
    "",
  ];
}

function decisionSection(rows: readonly ControlRow[]): string[] {
  const out = ["## 7. Decision", ""];
  const d = lastLoose(rows, "decision");
  out.push(
    d
      ? `${d.winner === null || d.winner === undefined ? "**base stays**" : `**winner: ${String(d.winner)}**`}: ${String(d.why)}`
      : "no decision yet",
    "",
  );
  const fin = lastLoose(rows, "final_score");
  if (fin) {
    const ms = fin.models as R4Score["finalists"][number]["models"];
    out.push(
      `Holdouts (once, on \`${String(fin.ref)}\`): ${ms.map((m) => `${m.model} ${m.variant.completed}/${m.variant.n} vs base ${m.base.completed}/${m.base.n}, Holm ${fp(m.holmP)}${m.loss ? " LOSS" : ""}`).join("; ")}; ${String(fin.why)}`,
      "",
    );
  }
  const holdStops = new Set(
    rows.flatMap((r) => (r.kind === "review_stop" && r.source === "holdout" ? [r.id] : [])),
  );
  if (
    rows.some((r) => r.kind === "review_decision" && holdStops.has(r.stop) && r.decision === "drop")
  )
    out.push(
      "A winner was dropped after a holdout stop: the holdouts have been spent, and the new combination has no clean holdout result.",
      "",
    );
  return out;
}

function spendSection(rows: readonly ControlRow[]): string[] {
  const sp = (rows as unknown as Loose[]).filter((r) => r.kind === "spend");
  return [
    "## 8. Spend",
    "",
    ...(sp.length === 0
      ? ["none"]
      : table(
          ["round", "epoch", "tokens per model", "wall"],
          sp.map((r) => [
            String(r.round ?? "-"),
            String(r.epoch ?? "-"),
            Object.entries((r.tokens ?? {}) as Record<string, number>)
              .map(([m, t]) => `${m} ${t}`)
              .join(", "),
            `${((Number(r.wallMs) || 0) / 3_600_000).toFixed(1)} h`,
          ]),
        )),
    "",
  ];
}

/** The §6 report of one group, from its row dir. Pure but for reading the row dir and the patches. */
export function renderReport(o: { group: Group; dir: string; candDir: string }): string {
  const rows = readControl(o.dir);
  const setup = setupOf(rows);
  const freeze = lastOf(rows, "freeze");
  const epoch = epochOf(rows);
  const r2 = lastOf(rows, "round_score", (r) => r.round === "r2" && r.epoch === epoch);
  const scans = rows.filter(
    (r) => r.kind === "scan" && r.epoch === epoch,
  ) as unknown as ScanResult[];
  const power = freeze
    ? powerFacts(freeze.nPlan, {
        ...(typeof r2?.S === "number" ? { S: r2.S } : {}),
        ks: scans.map((s) => s.selected.length).filter((k) => k > 0),
      })
    : null;
  const vs = [
    ...new Map(
      rows.filter((r): r is VariantRow => r.kind === "variant").map((r) => [r.id, r]),
    ).values(),
  ];
  return [
    `# hill-r2 tournament: ${o.group}`,
    "",
    ...setupSection(o.dir, rows, setup, freeze, power),
    ...variantsSection(vs, o.candDir),
    "## 3. R1 / R2",
    "",
    ...roundSection(rows, "r1", epoch),
    ...roundSection(rows, "r2", epoch),
    ...scanSection(rows, epoch),
    ...r4Section(rows, epoch),
    ...reviewSection(rows),
    ...decisionSection(rows),
    ...spendSection(rows),
  ].join("\n");
}

/** `tournament report <group> --out <md>`: the §6 sections, and the copy of tournament.jsonl. Exit code. */
export async function writeReport(o: GateOpts & { out: string }): Promise<number> {
  const ctl = controlFile(o.dir);
  if (!existsSync(ctl)) {
    console.error(`no control file ${ctl}`);
    return 2;
  }
  const md = renderReport({
    group: o.group,
    dir: o.dir,
    candDir: join(o.repo, "tools", "eval", "candidates", o.group),
  });
  const out = resolve(o.repo, o.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${md}\n`);
  const copy = committedControl(o.repo, o.group);
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(ctl, copy);
  console.log(`report: ${out}; control file copied to ${copy}`);
  return 0;
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
