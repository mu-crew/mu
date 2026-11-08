// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The hook-harness cases end to end at zero cost: a fake claude orchestrator in a pane of the
// sandbox's private tmux server, fake claude and codex workers that fire their hooks through the
// worktree murmur and mu builds, and the real judge: every case under a claude orchestrator, and
// E6 (interrupt, clear, resend) under codex too, and the sampled plan's cursor-agent and Muse Code
// rows with their worker mixes. Needs a built mu and EVAL_MURMUR (a built murmur
// checkout); skipped otherwise. The pi AUT is left out: it needs a pi that runs here. E7's pi
// workers need one too (the faux pi workers of every pi scenario): where the host pi cannot load
// the surface's extension, E7 fails here with its pi tasks unrun, as worktree_reuse's check does.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../../tools/eval/commands.ts";
import { planRows } from "../../tools/eval/mix.ts";
import { surfaceFromDir } from "../../tools/eval/surface.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const murmur = process.env.EVAL_MURMUR ?? "";
const ready =
  existsSync(join(ROOT, "dist", "cli.js")) &&
  murmur !== "" &&
  existsSync(join(murmur, "dist", "cli.js"));

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!ready)("check: hook-harness cases on fake harnesses", () => {
  const CASES = [
    "e1_dispatch_merge",
    "e2_cross_family_refuter",
    "e3_review_gate",
    "e4_replacement_orchestrator",
    "e5_remote_worker",
    "e6_interrupt_resend",
    "e7_mixed_crew",
  ];

  it.each(CASES)(
    "%s under a claude orchestrator: the golden passes, every bad is flagged",
    {
      timeout: 600_000,
    },
    async (id) => {
      const out: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        out.push(a.join(" "));
      });
      const code = await runCheck({
        surface: { ...surfaceFromDir("checkout", ROOT), family: "next" },
        scenarios: [id],
        includeUnderscore: false,
        family: "next",
        preflight: false,
        verbose: true,
        root: ROOT,
        harnesses: ["claude"],
      });
      const text = out.join("\n");
      expect(code, text).toBe(0);
      expect(text).toContain(`${id} golden [claude] ok`);
      expect(
        text.match(new RegExp(`${id} bad[-\\w]* \\[claude\\] flagged ok`, "g"))?.length,
      ).toBeGreaterThanOrEqual(3);
    },
  );

  it("E6 under a codex orchestrator: interrupt, clear and resend through mu", {
    timeout: 600_000,
  }, async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    const code = await runCheck({
      surface: { ...surfaceFromDir("checkout", ROOT), family: "next" },
      scenarios: ["e6_interrupt_resend"],
      includeUnderscore: false,
      family: "next",
      preflight: false,
      verbose: true,
      root: ROOT,
      harnesses: ["codex"],
    });
    expect(code, out.join("\n")).toBe(0);
  });

  it.each(["cursor-agent", "muse"] as const)(
    "the sampled plan's %s rows (check --plan): each golden passes with its mix, every bad is flagged",
    { timeout: 1_800_000 },
    async (aut) => {
      const out: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        out.push(a.join(" "));
      });
      const code = await runCheck({
        surface: { ...surfaceFromDir("checkout", ROOT), family: "next" },
        scenarios: null,
        includeUnderscore: false,
        family: "next",
        preflight: false,
        verbose: true,
        root: ROOT,
        harnesses: [aut],
        plan: true,
      });
      const text = out.join("\n");
      expect(code, text).toBe(0);
      for (const r of planRows([aut]))
        expect(text).toContain(
          `${r.scenario} golden [${aut}${r.workers ? `; workers ${r.workers.join(",")}` : ""}] ok`,
        );
    },
  );
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
