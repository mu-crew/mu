// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Per-row muzzle claims (tools/eval/claim.ts): the plan per mode, the holder protocol, and that
// every R4 run holds its own claim while it runs.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimArgs,
  HOLDER,
  planRows,
  ROW_SLOTS,
  RowClaimError,
  rowClaim,
  setClaimSpawnForTests,
} from "../../tools/eval/claim.ts";
import type { RunOne } from "../../tools/eval/commands.ts";
import { runR4 } from "../../tools/eval/tournament-r4.ts";
import type { RunResult, Surface } from "../../tools/eval/types.ts";
import { withEnv } from "../_env.ts";

/** A fake muzzle holder: admits at once (or exits `failCode` first), records its args and stdin end. */
class FakeHolder extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  ended = false;
  stdin = {
    end: () => {
      this.ended = true;
      setImmediate(() => this.emit("close", 0));
    },
  };
}

interface Muzzle {
  args: string[][];
  held: number;
  peak: number;
  holders: FakeHolder[];
}

function fakeMuzzle(o: { failCode?: number } = {}): Muzzle {
  const m: Muzzle = { args: [], held: 0, peak: 0, holders: [] };
  setClaimSpawnForTests((_bin, args) => {
    const h = new FakeHolder();
    m.args.push(args);
    m.holders.push(h);
    setImmediate(() => {
      if (o.failCode !== undefined) {
        h.stderr.emit("data", Buffer.from("muzzle: gave up after 1s queued"));
        h.emit("close", o.failCode);
        return;
      }
      m.held++;
      m.peak = Math.max(m.peak, m.held);
      h.on("close", () => m.held--);
      h.stdout.emit("data", Buffer.from("admitted\n"));
    });
    return h as unknown as ChildProcess;
  });
  return m;
}

afterEach(() => setClaimSpawnForTests(null));

describe("planRows", () => {
  const budget = () => 22;
  it("claim mode: each row claims its slots; rows at once capped to the budget", () => {
    expect(planRows("probe", 24, {}, "muzzle", budget)).toMatchObject({
      mode: "claim",
      slots: ROW_SLOTS.probe,
      concurrency: Math.floor(22 / ROW_SLOTS.probe),
    });
    expect(planRows("probe", 2, {}, "muzzle", budget).concurrency).toBe(2);
  });

  it("nested in an outer claim: no per-row claims, floor(MUZZLE_SLOTS / w) rows, at least 1", () => {
    const w = ROW_SLOTS.aut;
    const p = planRows("aut", 24, { MUZZLE_SLOTS: String(4 * w) }, "muzzle", budget);
    expect(p).toMatchObject({ mode: "nested", concurrency: 4 });
    expect(p.note).toContain("inside a muzzle claim");
    expect(planRows("aut", 24, { MUZZLE_SLOTS: "1" }, "muzzle", budget).concurrency).toBe(1);
  });

  it("no muzzle: unclaimed, still capped to muzzle's default budget", () => {
    const p = planRows("probe", 1000, {}, null, budget);
    expect(p.mode).toBe("unmanaged");
    expect(p.concurrency).toBeLessThan(1000);
    expect(p.concurrency).toBeGreaterThanOrEqual(1);
  });

  it("EVAL_ROW_SLOTS_<KIND> overrides a row's weight", () => {
    const p = planRows("guess", 24, { EVAL_ROW_SLOTS_GUESS: "11" }, "muzzle", budget);
    expect(p).toMatchObject({ slots: 11, concurrency: 2 });
  });
});

describe("rowClaim", () => {
  const claimPlan = planRows("probe", 1, {}, "muzzle", () => 22);

  it("runs the row only once muzzle admits the holder, and releases it after", async () => {
    const m = fakeMuzzle();
    const claim = rowClaim("probe", claimPlan, "muzzle");
    const seen = await claim(async () => m.held);
    expect(seen).toBe(1);
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
    const claim = rowClaim("probe", claimPlan, "muzzle");
    await expect(
      claim(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(m.holders[0]?.ended).toBe(true);
  });

  it("a holder that exits before admission fails the row without running it", async () => {
    fakeMuzzle({ failCode: 75 });
    const claim = rowClaim("probe", claimPlan, "muzzle");
    let ran = false;
    const p = claim(async () => {
      ran = true;
    });
    await expect(p).rejects.toThrow(RowClaimError);
    await expect(p).rejects.toThrow(/exited 75 before admission: muzzle: gave up/);
    expect(ran).toBe(false);
  });

  it("nested and unmanaged plans take no claim", async () => {
    const m = fakeMuzzle();
    const nested = planRows("probe", 1, { MUZZLE_SLOTS: "6" }, "muzzle", () => 22);
    expect(await rowClaim("probe", nested, "muzzle")(async () => 7)).toBe(7);
    expect(m.args).toEqual([]);
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
