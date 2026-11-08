// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Per-row muzzle claims (tools/eval/claim.ts): the plan per mode, the holder protocol, the nesting
// check, and that every R4 run holds its own claim while it runs (claim-sites.test.ts: the others).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertInRow,
  claimArgs,
  currentRow,
  HOLDER,
  LOW_CAP_SLOTS,
  outerHolder,
  parseConcurrency,
  planRows,
  ROW_SLOTS,
  RowClaimError,
  rowClaim,
} from "../../tools/eval/claim.ts";
import type { RunOne } from "../../tools/eval/commands.ts";
import { runR4 } from "../../tools/eval/tournament-r4.ts";
import type { RunResult, Surface } from "../../tools/eval/types.ts";
import { withEnv } from "../_env.ts";
import { fakeMuzzle, resetFakeMuzzle } from "./_fake-muzzle.ts";

afterEach(() => resetFakeMuzzle());

describe("planRows", () => {
  it("claim mode: each row claims its slots; rows at once capped to the budget", () => {
    fakeMuzzle({ budget: 22 });
    expect(planRows("probe", 24, {}, "muzzle")).toMatchObject({
      mode: "claim",
      slots: ROW_SLOTS.probe,
      concurrency: Math.floor(22 / ROW_SLOTS.probe),
    });
    expect(planRows("probe", 2, {}, "muzzle").concurrency).toBe(2);
    expect(planRows("aut", Number.POSITIVE_INFINITY, {}, "muzzle").concurrency).toBe(
      Math.floor(22 / ROW_SLOTS.aut),
    );
  });

  it("MUZZLE_SLOTS set: nested, no per-row claims, floor(MUZZLE_SLOTS / w) rows, at least 1", () => {
    fakeMuzzle();
    const w = ROW_SLOTS.aut;
    const p = planRows("aut", 24, { MUZZLE_SLOTS: String(4 * w) }, "muzzle");
    expect(p).toMatchObject({ mode: "nested", concurrency: 4 });
    expect(p.note).toContain("inside a muzzle claim");
    expect(planRows("aut", 24, { MUZZLE_SLOTS: "1" }, "muzzle").concurrency).toBe(1);
  });

  it("an outer holder in the rig's ancestry (MUZZLE_SLOTS and MUZZLE_HOLD unset): nested on its slots", () => {
    // pi's muzzle extension: the rig's parent is the holder's muzzle, or the rig is in its group
    fakeMuzzle({
      others: [{ slots: 3, pid: 4242, pgid: 4300 }],
      ancestors: [{ pid: 4242, pgid: 4242 }],
    });
    const p = planRows("probe", 24, {}, "muzzle");
    expect(p).toMatchObject({ mode: "nested", concurrency: 3 });
    expect(p.note).toContain("holder pid 4242");
    resetFakeMuzzle();
    fakeMuzzle({
      others: [{ slots: 3, pid: 4242, pgid: 4300 }],
      ancestors: [
        { pid: process.pid, pgid: 4300 },
        { pid: 1000, pgid: 1000 },
      ],
    });
    expect(planRows("aut", 24, {}, "muzzle")).toMatchObject({ mode: "nested", concurrency: 1 });
  });

  it("outerHolder ignores holders outside the ancestry", () => {
    const st = { budget: 22, holders: [{ slots: 3, pid: 7, pgid: 8 }] };
    expect(outerHolder(st, [{ pid: 9, pgid: 9 }])).toBeNull();
    expect(outerHolder(st, [{ pid: 9, pgid: 8 }])?.pid).toBe(7);
  });

  it("no muzzle on PATH: the low fixed cap (2 probe rows, 1 AUT run), unclaimed, with a warning", () => {
    const p = planRows("probe", 1000, {}, null);
    expect(p).toMatchObject({ mode: "capped", concurrency: LOW_CAP_SLOTS / ROW_SLOTS.probe });
    expect(p.note).toMatch(/WARNING no muzzle on PATH/);
    expect(planRows("aut", 24, {}, null).concurrency).toBe(1);
    expect(planRows("probe", 1, {}, null).concurrency).toBe(1);
  });

  it("muzzle unusable (`status --json` fails): the same low cap", () => {
    fakeMuzzle({ statusFails: true });
    const p = planRows("probe", 24, {}, "muzzle");
    expect(p).toMatchObject({ mode: "capped", concurrency: 2 });
    expect(p.note).toMatch(/WARNING .*status --json` failed/);
  });

  it("EVAL_ROW_SLOTS_<KIND> overrides a row's weight", () => {
    fakeMuzzle({ budget: 22 });
    const p = planRows("guess", 24, { EVAL_ROW_SLOTS_GUESS: "11" }, "muzzle");
    expect(p).toMatchObject({ slots: 11, concurrency: 2 });
  });

  it("parseConcurrency: auto is Infinity, a number stays, junk is refused", () => {
    expect(parseConcurrency(undefined, "auto")).toBe(Number.POSITIVE_INFINITY);
    expect(parseConcurrency("3", "auto")).toBe(3);
    expect(parseConcurrency(undefined, 6)).toBe(6);
    expect(() => parseConcurrency("0", 6)).toThrow(/positive integer or auto/);
  });
});

describe("rowClaim", () => {
  const claimPlan = () => planRows("probe", 1, {}, "muzzle");

  it("runs the row only once muzzle admits the holder, and releases it after", async () => {
    const m = fakeMuzzle();
    const claim = rowClaim("probe", claimPlan(), "muzzle");
    const seen = await claim(async () => [m.held, currentRow()]);
    expect(seen).toEqual([1, "probe"]);
    expect(m.args).toEqual([claimArgs("probe", ROW_SLOTS.probe)]);
    expect(m.args[0]).toEqual([
      "run",
      "--rule",
      "mu-eval-probe",
      "--slots",
      String(ROW_SLOTS.probe),
      "--",
      ...HOLDER,
    ]);
    expect(m.holders[0]?.ended).toBe(true);
    expect(m.held).toBe(0);
  });

  it("releases the claim when the row throws", async () => {
    const m = fakeMuzzle();
    const claim = rowClaim("probe", claimPlan(), "muzzle");
    await expect(
      claim(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(m.holders[0]?.ended).toBe(true);
  });

  it("a holder that exits before admission fails the row without running it", async () => {
    fakeMuzzle({ failCode: 75 });
    const claim = rowClaim("probe", claimPlan(), "muzzle");
    let ran = false;
    const p = claim(async () => {
      ran = true;
    });
    await expect(p).rejects.toThrow(RowClaimError);
    await expect(p).rejects.toThrow(/exited 75 before admission: muzzle: gave up/);
    expect(ran).toBe(false);
  });

  it("nested and capped plans take no claim, but still mark the row", async () => {
    const m = fakeMuzzle();
    const nested = planRows("probe", 1, { MUZZLE_SLOTS: "6" }, "muzzle");
    expect(await rowClaim("probe", nested, "muzzle")(async () => currentRow())).toBe("probe");
    expect(
      await rowClaim("aut", planRows("aut", 1, {}, null), null)(async () => currentRow()),
    ).toBe("aut");
    expect(m.args).toEqual([]);
  });

  it("a first holder muzzle ran nested (holds nothing): warn once, then rows run unclaimed at the low cap", async () => {
    const m = fakeMuzzle({ nested: true });
    const lines: string[] = [];
    const plan = planRows("probe", 24, {}, "muzzle");
    expect(plan.mode).toBe("claim");
    const claim = rowClaim("probe", plan, "muzzle", (l) => lines.push(l));
    let active = 0;
    let peak = 0;
    const row = async (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 8 }, () => claim(row)));
    expect(m.args).toHaveLength(1); // only the first row asked muzzle
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/WARNING .*holds no slots .*nested/);
    expect(peak).toBeLessThanOrEqual(LOW_CAP_SLOTS / ROW_SLOTS.probe);
  });

  it("a first holder that holds its slots: every row claims", async () => {
    const m = fakeMuzzle();
    const lines: string[] = [];
    const claim = rowClaim("probe", planRows("probe", 24, {}, "muzzle"), "muzzle", (l) =>
      lines.push(l),
    );
    await Promise.all(Array.from({ length: 4 }, () => claim(async () => undefined)));
    expect(m.args).toHaveLength(4);
    expect(lines).toEqual([]);
  });
});

describe("assertInRow", () => {
  it("outside vitest, a sandbox outside every row is refused; inside a row it passes", async () => {
    await withEnv("VITEST", undefined, async () => {
      expect(() => assertInRow("createSandbox")).toThrow(/createSandbox outside a row claim/);
      const plan = planRows("aut", 1, {}, null);
      await rowClaim("aut", plan, null)(async () => assertInRow("createSandbox"));
    });
  });
});

describe("runR4 rows run under their own claim", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-claim-test-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("every AUT run holds one claim of ROW_SLOTS.aut while it runs; at most `concurrency` at once", async () => {
    const root = join(tmp, "v1");
    mkdirSync(join(root, "skills", "mu"), { recursive: true });
    writeFileSync(join(root, "skills", "mu", "SKILL.md"), "---\nname: mu\n---\n");
    const s: Surface = {
      name: "v1",
      root,
      family: "next",
      cli: join(root, "cli.js"),
      extension: join(root, "ext.js"),
      skillDir: join(root, "skills", "mu"),
    };
    const m = fakeMuzzle();
    const heldDuring: number[] = [];
    const run = async (o: RunOne): Promise<RunResult> => {
      heldDuring.push(m.held);
      await new Promise((r) => setTimeout(r, 5));
      return {
        scenario: o.scenario.id,
        surface: o.surface.name,
        model: o.model,
        rep: o.rep,
        startedAt: "2026-11-08T00:00:00.000Z",
        metrics: {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 },
          turns: 1,
          toolCalls: [],
          muCalls: 0,
          muErrors: 0,
          prods: 0,
          wallMs: 1,
          aborted: null,
          lastError: null,
          finalText: "",
          events: [],
        },
        verdict: {
          completed: true,
          wrong: [],
          destructive: [],
          destructiveFx: [],
          muCalls: [],
          notes: [],
        },
      };
    };
    const jobs = [201, 202, 203, 204, 205].map((rep) => ({
      group: "c1_wait" as const,
      round: "r4" as const,
      variant: "v1",
      scenario: "course_check",
      model: "m",
      rep,
      surface: s,
    }));
    await withEnv("MUZZLE_SLOTS", undefined, () =>
      withEnv("EVAL_MUZZLE_BIN", "fake-muzzle", async () => {
        const r = await runR4({
          jobs,
          out: join(tmp, "r4.jsonl"),
          logRoot: join(tmp, "logs"),
          concurrency: 2,
          spec: () => ({ markers: [], contextMarkers: [], newNames: [], changedCalls: [] }),
          run,
        });
        expect(r.written).toBe(5);
      }),
    );
    expect(m.args).toHaveLength(5);
    for (const a of m.args)
      expect(a.slice(0, 5)).toEqual([
        "run",
        "--rule",
        "mu-eval-aut",
        "--slots",
        String(ROW_SLOTS.aut),
      ]);
    expect(heldDuring.every((h) => h >= 1)).toBe(true);
    expect(m.peak).toBe(2);
    expect(m.held).toBe(0);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
