// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Synthetic probe rows for the tournament scoring tests (tournament.test.ts, tournament-fast.test.ts).
import type { ExposureSpec } from "../../tools/eval/exposure.ts";
import type { ProbeRow } from "../../tools/eval/nextstep.ts";
import { BASE } from "../../tools/eval/tournament-score.ts";

export const HAIKU = "claude-haiku-5-5";
export const GEMINI = "gemini-3.8-flash";
export const SONNET = "claude-sonnet-5-5";
export const MARK = "the worker's final report line is shown below";
export const spec: ExposureSpec = {
  markers: [MARK],
  contextMarkers: [],
  newNames: [],
  changedCalls: [],
};
export const PROMPTS: Record<string, string> = { exposed: `x ${MARK} y`, plain: "x y" };
export const prompt = (sha: string): string => PROMPTS[sha] ?? "";

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function row(over: Partial<ProbeRow>): ProbeRow {
  return {
    kind: "probe",
    group: "c1_wait",
    round: "r2",
    case: "h1",
    role: "headline",
    paraphrase: "p1",
    leadIn: "a",
    arm: "none",
    surface: BASE,
    surfaceId: "s",
    build: "b",
    model: HAIKU,
    rep: 101,
    promptSha: "exposed",
    systemSha: "x",
    transcriptPath: "",
    leadInCalls: [],
    leadInExits: [0],
    reply: "",
    commands: [],
    tooMany: false,
    perCommand: [],
    muCalls: [],
    hit: false,
    partial: false,
    invalid: false,
    why: [],
    stray: [],
    destructive: [],
    tokens: 100,
    ms: 1,
    ...over,
  };
}

/**
 * Rows of one (surface, case) over `models`: m = arms × paraphrases clusters of r rows per model,
 * hit rate p, intra-cluster correlation ρ through a shared cluster draw (each row takes it with
 * probability √ρ, so two rows of a cluster correlate at ρ). The weak models share the cluster
 * draw (one prompt), sonnet has its own.
 */
export function cellRows(o: {
  surface: string;
  caseId: string;
  models: string[];
  p: number | Record<string, number>;
  m?: number;
  r: number;
  rho?: number;
  rand: () => number;
  round?: "r1" | "r2";
  promptSha?: string;
}): ProbeRow[] {
  const out: ProbeRow[] = [];
  const mix = Math.sqrt(o.rho ?? 0.2);
  const m = o.m ?? 30;
  for (let c = 0; c < m; c++) {
    const shared = o.rand();
    const own = o.rand();
    for (const model of o.models) {
      const p = typeof o.p === "number" ? o.p : (o.p[model] ?? 0);
      const u = model === SONNET ? own : shared;
      for (let k = 0; k < o.r; k++) {
        const hit = o.rand() < mix ? u < p : o.rand() < p;
        out.push(
          row({
            surface: o.surface,
            case: o.caseId,
            model,
            arm: `a${c % 3}` as ProbeRow["arm"],
            paraphrase: `p${Math.floor(c / 3)}`,
            rep: (o.round === "r1" ? 1 : 101) + k,
            round: o.round ?? "r2",
            hit,
            promptSha: o.promptSha ?? "exposed",
          }),
        );
      }
    }
  }
  return out;
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
