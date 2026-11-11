// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Fast mode end to end through the CLI (spec §4.7): a full-mode group with R1 scored migrates to
// fast, keeping its epoch, and `decide --fast` decides on that epoch's R1 rows at the frozen rule's
// threshold. Needs `dist/` (the surfaces' vocab) and git (the judges hash): integration tier.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProbeRow } from "../../tools/eval/nextstep.ts";
import { NEXT_CASES } from "../../tools/eval/nextstep-cases.ts";
import { controlFile, probeFile, readControl } from "../../tools/eval/tournament.ts";
import { judgesHash } from "../../tools/eval/tournament-build.ts";
import { tournamentCli } from "../../tools/eval/tournament-cli.ts";
import { BASE } from "../../tools/eval/tournament-score.ts";
import { withEnv } from "../_env.ts";
import { GEMINI, HAIKU, MARK, row, SONNET, spec } from "./_tournament-rows.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const GROUP = "c2_close";
const EPOCH = 2;

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mu-fast-int-"));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

/** One row per weak model per cluster of the case, hit on the first `k` clusters. */
function rows(
  surface: string,
  caseId: string,
  k: number,
  over: Partial<ProbeRow> = {},
): ProbeRow[] {
  const c = NEXT_CASES.find((x) => x.id === caseId);
  if (!c) throw new Error(caseId);
  const clusters = c.arms.flatMap((arm) => c.paraphrases.slice(0, 10).map((p) => ({ arm, p })));
  return clusters.flatMap(({ arm, p }, i) =>
    [HAIKU, GEMINI].map((model) =>
      row({
        group: GROUP,
        round: "r1",
        rep: EPOCH * 1000 + 1,
        case: caseId,
        surface,
        model,
        arm: arm as ProbeRow["arm"],
        paraphrase: p.id,
        leadIn: p.leadIn ?? "a",
        hit: i < k,
        ...over,
      }),
    ),
  );
}

describe("migrate-fast then decide --fast (CLI)", () => {
  it("decides on the kept epoch's R1 rows at the rule's z, skipping R2 and stale rows", async () => {
    const dir = join(root, GROUP);
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "prompts", "exposed.txt"), `x ${MARK} y`);
    const hash = judgesHash(REPO).hash;
    const control = [
      {
        kind: "setup",
        group: GROUP,
        baseSha: "b",
        baseDir: REPO,
        b0: {
          models: [HAIKU, GEMINI, SONNET],
          providerExt: null,
          rows: [HAIKU, GEMINI, SONNET].map((model) => ({ model, ok: true })),
        },
        models: { weak: [HAIKU, GEMINI], gate: SONNET },
        providerExt: null,
        systemSha: "x",
        rho: {},
        rhoPool: {},
        seed: "s",
        holdouts: { ids: [], note: "not run, not read" },
      },
      { kind: "freeze", judgesHash: "h0", files: [], mode: "full", nPlan: [], checks: "skipped" },
      { kind: "refreeze", row: "x", why: "rig", judgesHash: hash, epoch: EPOCH },
      { kind: "isolation", session: "s1", model: "m", hits: [] },
      {
        kind: "variant",
        id: "v1",
        session: "s1",
        dir: REPO,
        spec,
        textDelta: 1,
        admission: { ok: true, failures: [] },
      },
      { kind: "round_score", round: "r1", epoch: EPOCH, S: null, scores: [] },
    ];
    writeFileSync(controlFile(dir), control.map((r) => `${JSON.stringify(r)}\n`).join(""));
    // 30 clusters per model: base 15, the variant 19 (pooled z ≈ 1.4: above z(0.20/2) = 1.28,
    // below the old 1.65). R2 rows and an earlier epoch's reps sit in the same file.
    const probe = [
      ...rows(BASE, "close_preview_apply", 15),
      ...rows("v1", "close_preview_apply", 19),
      ...rows(BASE, "close_preview_conflict", 15),
      ...rows("v1", "close_preview_conflict", 15),
      ...rows("v1", "close_preview_apply", 0, { round: "r2", rep: EPOCH * 1000 + 101 }),
      ...rows("v1", "close_preview_apply", 0, { rep: (EPOCH - 1) * 1000 + 1 }),
    ];
    writeFileSync(probeFile(dir, EPOCH), probe.map((r) => `${JSON.stringify(r)}\n`).join(""));
    await withEnv("EVAL_TOURNAMENT_ROOT", root, async () => {
      await expect(tournamentCli(["decide", "--fast", GROUP])).rejects.toThrow(
        /frozen in full mode/,
      );
      expect(await tournamentCli(["migrate-fast", GROUP, "--why", "phase C fast"])).toBe(0);
      expect(await tournamentCli(["decide", "--fast", GROUP])).toBe(0);
    });
    const all = readControl(dir);
    expect(all.find((r) => r.kind === "migrate_fast")).toMatchObject({
      epoch: EPOCH,
      judgesHash: hash,
      judgesChanged: [],
    });
    const d = all.at(-1) as unknown as {
      kind: string;
      epoch: number;
      rule: { tests: number; z: number };
      winner: string | null;
      scores: { win: { case: string; z: number; variant: { n: number } }[] }[];
    };
    expect(d.kind).toBe("decision");
    expect(d.epoch).toBe(EPOCH);
    expect(d.rule.tests).toBe(2);
    expect(d.rule.z).toBeCloseTo(1.2816, 3);
    const apply = d.scores[0]?.win.find((w) => w.case === "close_preview_apply");
    expect(apply?.variant.n).toBe(60); // the fresh R1 rows only
    expect(apply?.z).toBeGreaterThan(d.rule.z);
    expect(apply?.z).toBeLessThan(1.65);
    expect(d.winner).toBe("v1");
    expect(readFileSync(controlFile(dir), "utf8")).toContain('"kind":"migrate_fast"');
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
