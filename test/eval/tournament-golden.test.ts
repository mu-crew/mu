// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The tournament build's golden passes (tools/eval/tournament-build.ts): run side by side under
// per-row claims, cut-short base passes, the trace caches' keys, a variant whose pass threw.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withRowClaim } from "../../tools/eval/claim.ts";
import {
  assessVariant,
  behaviourDiff,
  cachedTraces,
  type GoldenTrace,
  passPool,
  traceCacheKey,
  unmaskedCases,
} from "../../tools/eval/tournament-build.ts";
import { parseManifest } from "../../tools/eval/tournament-patch.ts";
import { withEnv } from "../_env.ts";
import { fakeMuzzle, resetFakeMuzzle } from "./_fake-muzzle.ts";

const tmps: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mu-tgolden-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  resetFakeMuzzle();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("golden passes side by side", () => {
  // a pass shaped like collectGoldenTraces: its rows one after another, each in its own claim
  const fakePass = (inFlight: { now: number; max: number }) => async (item: string) => {
    const traces: GoldenTrace[] = [];
    for (const row of ["a", "b", "c"]) {
      const calls = await withRowClaim("probe", async () => {
        inFlight.now++;
        inFlight.max = Math.max(inFlight.max, inFlight.now);
        await new Promise((r) => setTimeout(r, 5));
        inFlight.now--;
        return [{ argv: `task show ${item}-${row}`, exit: 0, out: row }];
      });
      traces.push({ id: `nextstep:${row}/${item}`, ok: true, calls });
    }
    return traces;
  };
  const items = ["v1", "v2", "v3", "v4", "v5"];

  it("runs passes concurrently, each row under its own muzzle claim, with the serial traces", async () => {
    const run = async (width: number) => {
      const f = { now: 0, max: 0 };
      let m: ReturnType<typeof fakeMuzzle> | undefined;
      let out: GoldenTrace[][] = [];
      await withEnv("MUZZLE_SLOTS", undefined, () =>
        withEnv("EVAL_MUZZLE_BIN", "fake-muzzle", async () => {
          m = fakeMuzzle({ budget: 22 });
          out = await passPool(items, width, fakePass(f));
        }),
      );
      resetFakeMuzzle();
      return { out, m, f };
    };
    const serial = await run(1);
    const wide = await run(4);
    expect(serial.f.max).toBe(1);
    expect(serial.m?.peak).toBe(1);
    expect(wide.f.max).toBeGreaterThan(1);
    expect(wide.m?.peak).toBeGreaterThan(1);
    // every row took a claim of its own, in both
    expect(serial.m?.args).toHaveLength(items.length * 3);
    expect(wide.m?.args).toHaveLength(items.length * 3);
    // same traces, in item order
    expect(wide.out).toEqual(serial.out);
    expect(wide.out.map((t) => t[0]?.id)).toEqual(items.map((i) => `nextstep:a/${i}`));
  });
});

describe("a noisy call keeps the lines both base passes agree on", () => {
  const k = (argv: string): string => argv.split(" ").slice(0, 2).join(" ");
  const pane = (phrase: string, chrome = true): GoldenTrace[] => [
    {
      id: "nextstep:read/a",
      ok: true,
      calls: [
        {
          argv: "agent read worker-1 -w auth",
          exit: 0,
          out: `${chrome ? "\n\n────\n ↑ 3 more\n" : ""}PANE-x: tests passed, ${phrase}\n`,
        },
      ],
    },
  ];
  const [a, a2] = [pane("indigo yarrow summit"), pane("pebble falcon cedar")];

  it("detects dropped chrome rows in a family whose random phrase differs between base passes", () => {
    expect(behaviourDiff(a, pane("amber cedar meadow", false), k, a2)).toEqual(["agent read"]);
    // the same rows with another phrase: chance, not behaviour
    expect(behaviourDiff(a, pane("amber cedar meadow"), k, a2)).toEqual([]);
    // base passes of different line counts mask the family's text whole, as before
    const short = pane("x y z", false);
    expect(behaviourDiff(a, pane("amber cedar meadow", false), k, short)).toEqual([]);
  });
});

describe("cut-short base passes are no noise", () => {
  const k = (argv: string): string => argv.split(" ").slice(0, 2).join(" ");
  const close = (applied: boolean) => ({
    argv: "agent close w1 --if-clean",
    exit: 0,
    out: JSON.stringify({ applied }),
  });
  const claim = { argv: "task claim a", exit: 0, out: "claimed" };
  const wait = { argv: "wait x", exit: 0, out: "done" };
  const t = (ok: boolean, calls: GoldenTrace["calls"]): GoldenTrace[] => [
    { id: "r4:wait_remote_gate", ok, calls },
  ];
  const full = t(true, [claim, close(false), wait]);
  const cut = t(false, [claim]);

  it("detects a dropped call or a flipped value where base's second pass was cut short", () => {
    expect(behaviourDiff(full, t(true, [claim, close(false)]), k, cut)).toEqual(["wait x"]);
    expect(behaviourDiff(full, t(true, [claim, close(true), wait]), k, cut)).toEqual([
      "agent close",
    ]);
    expect(behaviourDiff(full, full, k, cut)).toEqual([]);
    // the first pass cut short: the variant is held against the complete second one
    expect(behaviourDiff(cut, t(true, [claim, close(true), wait]), k, full)).toEqual([
      "agent close",
    ]);
    expect(behaviourDiff(cut, full, k, full)).toEqual([]);
    // two complete passes that disagree still mask
    const other = t(true, [claim, { ...wait, out: "done later" }]);
    expect(behaviourDiff(full, t(true, [claim, close(false), wait]), k, other)).toEqual([]);
    // and the build says which goldens went unmasked
    expect(unmaskedCases(full, cut)).toEqual(["r4:wait_remote_gate"]);
    expect(unmaskedCases(cut, full)).toEqual(["r4:wait_remote_gate"]);
    expect(unmaskedCases(full, full)).toEqual([]);
  });
});

describe("trace caches", () => {
  it("key on build ref, judges hash and the scenario and golden files", async () => {
    const root = tmp();
    const golden = join(root, "s1.golden.next.json");
    writeFileSync(join(root, "s1.ts"), "export default {}");
    writeFileSync(golden, '{"steps":[1]}');
    const o = { ref: "abc+123", judgesHash: "j1", scenarios: ["s1"], scenarioRoot: root };
    const k0 = traceCacheKey(o);
    expect(traceCacheKey(o)).toBe(k0);
    expect(traceCacheKey({ ...o, ref: "abc+456" })).not.toBe(k0);
    expect(traceCacheKey({ ...o, judgesHash: "j2" })).not.toBe(k0);
    expect(traceCacheKey({ ...o, scenarios: [] })).not.toBe(k0);
    writeFileSync(golden, '{"steps":[2]}');
    const k1 = traceCacheKey(o);
    expect(k1).not.toBe(k0);

    // a cache file under one key is reused; a refreeze (new key, new file) reruns
    const dir = tmp();
    let runs = 0;
    const run = async (): Promise<GoldenTrace[]> => [
      { id: `r4:s1`, ok: true, calls: [], runs: ++runs } as GoldenTrace,
    ];
    const first = await cachedTraces(join(dir, `golden-base-${k1}.json`), run);
    expect(await cachedTraces(join(dir, `golden-base-${k1}.json`), run)).toEqual(first);
    expect(runs).toBe(1);
    await cachedTraces(
      join(dir, `golden-base-${traceCacheKey({ ...o, judgesHash: "j2" })}.json`),
      run,
    );
    expect(runs).toBe(2);
  });
});

describe("a variant whose golden pass threw", () => {
  it("reports goldenCompat not run and is not admitted", () => {
    const root = tmp();
    mkdirSync(join(root, "skills", "mu"), { recursive: true });
    writeFileSync(join(root, "skills", "mu", "SKILL.md"), "one two");
    const patchText =
      'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n+  .option("--if-clean", "apply when clean")\n const b = 2;\n';
    const baseTraces: GoldenTrace[] = [{ id: "nextstep:a/a", ok: true, calls: [] }];
    const o = {
      manifest: parseManifest(
        JSON.stringify({ id: "c2-x", group: "c2_close", kind: ["output"], summary: "s" }),
        "c2_close",
      ),
      session: "s1",
      patchText,
      build: { dir: root, ref: "r", built: { ok: true }, helpExit: 0 },
      baseRoot: root,
      baseVocab: new Set<string>(),
      baseTraces,
      variantTraces: [] as GoldenTrace[],
      key: (a: string) => a,
    };
    const clean = assessVariant(o);
    expect(clean.admission.ok).toBe(true);
    expect(clean.goldenCompat).toEqual({ broken: [] });
    const threw = assessVariant({ ...o, goldenError: "sandbox died" });
    expect(threw.goldenCompat).toEqual({ broken: [], notRun: "sandbox died" });
    expect(threw.admission.ok).toBe(false);
    expect(threw.admission.failures).toContain("golden pass not run: sandbox died");
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
