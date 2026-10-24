import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadScenario,
  logPath,
  resolveSurface,
  runMatrix,
  scenarioIds,
} from "../../tools/eval/commands.ts";
import { sandboxFamily, scenarioDir, writeWorkerDriver } from "../../tools/eval/fixtures.ts";
import { sandboxEnv } from "../../tools/eval/sandbox.ts";
import {
  checkScenarioRoot,
  parseSurfaceSpec,
  SURFACES_DIR,
  surfaceId,
} from "../../tools/eval/surface.ts";
import type { Sandbox } from "../../tools/eval/types.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-eval-family-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A minimal built surface dir: what surfaceFromDir checks for. */
function fakeSurface(name: string): string {
  const root = join(tmp, name);
  mkdirSync(join(root, "dist", "extension"), { recursive: true });
  mkdirSync(join(root, "skills", "mu"), { recursive: true });
  for (const f of ["dist/cli.js", "dist/extension/mu-pi.js", "skills/mu/SKILL.md"]) {
    writeFileSync(join(root, f), "");
  }
  return root;
}

describe("surface spec", () => {
  it("parses dir, family and root; absent parts stay undefined", () => {
    const root = join(tmp, "roots", "a");
    mkdirSync(root, { recursive: true });
    expect(parseSurfaceSpec("3x")).toEqual({
      target: "3x",
      family: undefined,
      scenarioRoot: undefined,
    });
    expect(parseSurfaceSpec("/x/y:next")).toMatchObject({ target: "/x/y", family: "next" });
    expect(parseSurfaceSpec(`s:next:${root}`)).toEqual({
      target: "s",
      family: "next",
      scenarioRoot: root,
    });
  });

  it("refuses an invented family and malformed specs", () => {
    expect(() => parseSurfaceSpec("s:v2")).toThrow(/3x or next/);
    expect(() => parseSurfaceSpec("s:next:")).toThrow(/bad --surface/);
    expect(() => parseSurfaceSpec(":next")).toThrow(/bad --surface/);
    expect(() => parseSurfaceSpec("s:next:/a:b")).toThrow(/bad --surface/);
  });

  it("refuses a scenario root inside the surface cache or missing", () => {
    expect(() => checkScenarioRoot(join(SURFACES_DIR, "dec-a", "scenarios"))).toThrow(
      /prepare deletes/,
    );
    expect(() => checkScenarioRoot(SURFACES_DIR)).toThrow(/prepare deletes/);
    expect(() => checkScenarioRoot(join(tmp, "nope"))).toThrow(/does not exist/);
  });
});

describe("surface id", () => {
  it("one built dir under two family/root specs gets distinct ids, hence distinct logs", () => {
    const dir = fakeSurface("3.13.3");
    const root = join(tmp, "r");
    mkdirSync(root);
    const a = resolveSurface(`${dir}:3x`);
    const b = resolveSurface(`${dir}:next:${root}`);
    expect(surfaceId(a)).not.toBe(surfaceId(b));
    expect(surfaceId(a)).toBe(surfaceId(resolveSurface(`${dir}:3x`)));
    const log = (s: typeof a) =>
      logPath(tmp, "t", { scenario: "x", surface: surfaceId(s), model: "m", rep: 1 });
    expect(log(a)).not.toBe(log(b));
  });

  it("runMatrix refuses the same spec twice", async () => {
    const dir = fakeSurface("dup");
    const s = resolveSurface(dir);
    await expect(
      runMatrix({
        surfaces: [s, s],
        models: ["m"],
        scenarios: [],
        reps: 1,
        concurrency: 1,
        budgetTokens: 1,
        providerExt: "",
        out: join(tmp, "o.jsonl"),
        root: tmp,
      }),
    ).rejects.toThrow(/duplicate --surface spec/);
  });
});

describe("two real surfaces, one matrix", () => {
  it("baseline defaults to 3x on the default root; the candidate carries next and its own root", () => {
    const base = fakeSurface("base");
    const cand = fakeSurface("cand");
    const root = join(tmp, "cand-scenarios");
    mkdirSync(root);
    const a = resolveSurface(base);
    const b = resolveSurface(`${cand}:next:${root}`);
    expect(a.family).toBeUndefined();
    expect(a.scenarioRoot).toBeUndefined();
    expect(b).toMatchObject({ name: "cand", family: "next", scenarioRoot: root });
    expect(sandboxEnv("/d", a, "s", {}).EVAL_SURFACE_FAMILY).toBe("3x");
    expect(sandboxEnv("/d", b, "s", {}).EVAL_SURFACE_FAMILY).toBe("next");
  });

  it("--family/--scenario-root defaults fill only specs that leave them out", () => {
    const base = fakeSurface("base");
    const cand = fakeSurface("cand");
    const root = join(tmp, "r");
    mkdirSync(root);
    const d = { family: "next" as const, scenarioRoot: root };
    expect(resolveSurface(cand, d)).toMatchObject({ family: "next", scenarioRoot: root });
    expect(resolveSurface(`${base}:3x`, d)).toMatchObject({ family: "3x", scenarioRoot: root });
  });
});

describe("scenario roots", () => {
  it("scenarioIds unions the default dir and a root; loadScenario falls back to the default", async () => {
    const root = join(tmp, "r");
    mkdirSync(root);
    writeFileSync(join(root, "only_candidate.ts"), "export default {};\n");
    writeFileSync(join(root, "only_candidate.golden.next.json"), "[]");
    const ids = scenarioIds(true, root);
    expect(ids).toContain("only_candidate");
    expect(ids).toContain("_smoke");
    expect(scenarioIds(true)).not.toContain("only_candidate");
    expect((await loadScenario("_smoke", root)).id).toBe("_smoke");
    await expect(loadScenario("nope_x", root)).rejects.toThrow(new RegExp(`${root}/nope_x.ts`));
  });

  it("a root override wins over the default scenario of the same id", async () => {
    const root = join(tmp, "r");
    mkdirSync(root);
    writeFileSync(join(root, "_smoke.ts"), 'export default { id: "override" };\n');
    expect((await loadScenario("_smoke", root)).id).toBe("override");
    expect((await loadScenario("_smoke")).id).toBe("_smoke");
    expect(scenarioDir()).not.toBe(root);
  });
});

describe("writeWorkerDriver reads the sandbox family", () => {
  function sandbox(family: string | undefined): Sandbox {
    const dir = join(tmp, `sb-${family}`);
    const sb = {
      dir,
      binDir: join(dir, "bin"),
      workerDir: join(dir, "workers"),
      env: family === undefined ? {} : { EVAL_SURFACE_FAMILY: family },
    };
    mkdirSync(sb.binDir, { recursive: true });
    return sb as unknown as Sandbox;
  }
  const mode = async (sb: Sandbox, o?: { closeMode?: "verb" | "block" | "none" }) => {
    await writeWorkerDriver(sb, o);
    return (await import("node:fs")).readFileSync(join(sb.workerDir, "close-mode"), "utf8");
  };

  it("3x (and unset) closes with the verb, next prints the CLOSE block, explicit mode wins", async () => {
    expect(await mode(sandbox(undefined))).toBe("verb");
    expect(await mode(sandbox("3x"))).toBe("verb");
    expect(await mode(sandbox("next"))).toBe("block");
    expect(await mode(sandbox("next"), { closeMode: "none" })).toBe("none");
    expect(await mode(sandbox("3x"), { closeMode: "block" })).toBe("block");
  });

  it("an unknown family fails loudly", () => {
    expect(() => sandboxFamily(sandbox("v2"))).toThrow(/3x or next/);
  });
});
