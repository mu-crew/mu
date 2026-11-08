// Real pi (faux model) + real tmux: the AUT's world does not name the rig's checkout; aut-guard
// refuses a tool call that names it and cuts it from results; an AUT (R4 runOne without the
// guard, a probe answer) that reads the rig anyway gets an invalid row, never a hit.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOne } from "../../tools/eval/commands.ts";
import { sshShim } from "../../tools/eval/fixtures.ts";
import { playCase } from "../../tools/eval/nextstep.ts";
import { NEXT_CASES } from "../../tools/eval/nextstep-cases.ts";
import { BLOCKED, RIG_REPO } from "../../tools/eval/rig-guard.ts";
import { createSandbox, FAUX_EXT, REAL_PI } from "../../tools/eval/sandbox.ts";
import { surfaceFromDir } from "../../tools/eval/surface.ts";
import type { Sandbox, Scenario } from "../../tools/eval/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const hasTmux = (): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const ready = existsSync(join(ROOT, "dist", "cli.js")) && REAL_PI !== "pi" && hasTmux();
const surface = () => ({ ...surfaceFromDir("checkout", ROOT), family: "next" as const });

/** Every file under `dir` (no symlinks followed). */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return e.isFile() ? [p] : [];
  });
}

// A judge that always says completed: only the guard can make the row invalid.
const scenario: Scenario = {
  id: "rig_read",
  title: "rig read",
  prompt: "look around",
  quietMs: 0,
  async setup() {},
  async judge() {
    return { completed: true, wrong: [], destructive: [], notes: [] };
  },
};

describe.skipIf(!ready)("rig isolation", () => {
  let sb: Sandbox | undefined;
  let scriptDir = "";
  afterEach(async () => {
    try {
      await sb?.close();
    } catch {}
    sb = undefined;
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    scriptDir = "";
  });

  it("the sandbox's pi, ssh and runtime files name no rig file of the checkout", async () => {
    sb = await createSandbox(surface());
    await sshShim(sb, { host: "dev" });
    // the surface here is the checkout, so bin/mu names its dist/; nothing names its tools/
    const leaks = [...files(join(sb.dir, ".rt")), ...files(sb.binDir)].filter((f) =>
      readFileSync(f, "utf8").includes(join(RIG_REPO, "tools")),
    );
    expect(leaks).toEqual([]);
    expect(readFileSync(join(sb.dir, ".rt", "pi"), "utf8")).toContain(
      join(sb.dir, ".rt", "lib", "faux.ts"),
    );
  });

  async function run(calls: string[], over: { noAutGuard?: boolean } = {}) {
    scriptDir = mkdtempSync(join(tmpdir(), "mu-eval-rg-"));
    const auTScript = join(scriptDir, "aut.json");
    writeFileSync(
      auTScript,
      JSON.stringify([...calls.map((bash) => ({ calls: [{ bash }] })), { text: "done" }]),
    );
    return runOne({
      surface: surface(),
      scenario,
      model: "evalfaux/aut",
      providerExt: FAUX_EXT,
      rep: 1,
      auTScript,
      quietMs: 0,
      maxProds: 0,
      ...over,
    });
  }

  const reads = [
    `cat ${RIG_REPO}/tools/eval/scenarios/_smoke.ts`,
    `grep -rln judge ${RIG_REPO}/tools/eval | head -3`,
    `find ${RIG_REPO} -name '*.golden.next.json' | head -3`,
  ];

  it("aut-guard refuses an R4 AUT's cat, grep and find of the checkout: nothing read", async () => {
    const r = await run(reads);
    expect(r.metrics.toolCalls.map((c) => [c.isError, c.output.trim()])).toEqual(
      reads.map(() => [true, BLOCKED]),
    );
    expect(r.verdict.rigReads).toBeUndefined();
    expect(r.verdict.completed).toBe(true);
  }, 90_000);

  it("aut-guard cuts the rig's lines from a result whose command built the path at run time", async () => {
    const b64 = Buffer.from(`${RIG_REPO}/tools/eval/scenarios`).toString("base64");
    const r = await run([`grep -rn 'const scenario' "$(echo ${b64} | base64 -d)" | head -5`]);
    const out = r.metrics.toolCalls[0]?.output ?? "";
    expect(out).not.toContain(RIG_REPO);
    expect(out).toContain("line(s) outside this sandbox cut]");
    expect(r.verdict.rigReads).toBeUndefined();
  }, 90_000);

  it("without aut-guard, the judge-side check makes the same reads an invalid run", async () => {
    const r = await run(reads, { noAutGuard: true });
    expect(r.metrics.toolCalls).toHaveLength(3);
    expect(r.metrics.toolCalls[0]?.output).toContain("export default scenario");
    expect(r.verdict.rigReads).toHaveLength(3);
    expect(r.verdict.completed).toBe(false);
  }, 90_000);

  it("a run that stays in its sandbox keeps its verdict", async () => {
    const r = await run(["ls; mu --help >/dev/null"]);
    expect(r.verdict.rigReads).toBeUndefined();
    expect(r.verdict.completed).toBe(true);
  }, 90_000);

  it("a probe answer that reads the rig is refused unrun: invalid, no hit", async () => {
    const c = NEXT_CASES.find((x) => x.id === "close_preview_apply");
    if (!c) throw new Error("no close_preview_apply case");
    const para = c.paraphrases[0];
    if (!para) throw new Error("no paraphrase");
    scriptDir = mkdtempSync(join(tmpdir(), "mu-eval-rg-"));
    const row = await playCase(c, {
      surface: surface(),
      surfaceLabel: "base",
      arm: "skill",
      paraphrase: para.id,
      reply: async () => ({
        text: `\`\`\`sh\ncat ${RIG_REPO}/tools/eval/nextstep-cases-close.ts\n\`\`\``,
        tokens: 1,
      }),
      promptDir: scriptDir,
      gapMs: 0,
    });
    expect(row.rigReads).toEqual([`command 1: ${RIG_REPO}`]);
    expect(row.invalid).toBe(true);
    expect(row.hit).toBe(false);
    expect(row.perCommand).toEqual([]);
  }, 120_000);
});
