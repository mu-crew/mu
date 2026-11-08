// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Real pi (faux model) + real tmux: the AUT's world does not name the rig's checkout; aut-guard
// refuses a tool call that names it and cuts it from results; an AUT (R4 runOne without the
// guard, a probe answer) that reads the rig anyway gets an invalid row, never a hit.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOne } from "../../tools/eval/commands.ts";
import { sshShim } from "../../tools/eval/fixtures.ts";
import { playCase } from "../../tools/eval/nextstep.ts";
import { NEXT_CASES } from "../../tools/eval/nextstep-cases.ts";
import { BLOCKED, RIG_REPO, WITHHELD } from "../../tools/eval/rig-guard.ts";
import { RIG_CANARY } from "../../tools/eval/rig-private.ts";
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

  async function run(
    calls: string[],
    over: { noAutGuard?: boolean; noFingerprint?: boolean } = {},
  ) {
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
    // the path rule names each call; the fingerprint adds the outputs that print rig names
    for (const i of [0, 1, 2])
      expect(r.verdict.rigReads?.some((l) => l.startsWith(`#${i} bash: ${RIG_REPO}`))).toBe(true);
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
  // the reviewer's evasions of the path rules (review_f_aut_reads_rig): each prints faux.ts whole
  const parent = dirname(RIG_REPO);
  const co = basename(RIG_REPO);
  // every segment's last letter a `?`: the command names no root, no store, no rig segment
  const glob = `cat ${`${RIG_REPO}/tools/eval`
    .split("/")
    .map((x) => (x === "" ? x : `${x.slice(0, -1)}?`))
    .join("/")}/faux.ts`;
  const evasions = [
    `cd ${parent} && cd ${co} && cd tools && cd eval && cat faux.ts`,
    `cd ${parent} && git -C ${co} show HEAD:tools/eval/faux.ts`,
    glob,
    `ln -s ${parent} y && cd y/${co}/tools && cat eval/faux.ts`,
  ];

  it("without aut-guard, the canary makes every evasion a rig read", async () => {
    const r = await run(evasions, { noAutGuard: true });
    expect(r.metrics.toolCalls).toHaveLength(4);
    for (const c of r.metrics.toolCalls) expect(c.output).toContain(RIG_CANARY);
    expect(r.verdict.rigReads).toHaveLength(4);
    for (const line of r.verdict.rigReads ?? []) expect(line).toContain("rig canary in output");
    expect(r.verdict.completed).toBe(false);
  }, 120_000);

  it("aut-guard refuses the path evasions and withholds the glob's output: still a rig read", async () => {
    const r = await run(evasions);
    expect(r.metrics.toolCalls.map((c) => c.output.trim())).toEqual([
      BLOCKED,
      BLOCKED,
      WITHHELD,
      BLOCKED,
    ]);
    expect(r.verdict.rigReads).toEqual(["#2 bash: rig canary in output"]);
    expect(r.verdict.completed).toBe(false);
  }, 120_000);

  it("a probe answer whose output carries the canary is invalid, no hit", async () => {
    const c = NEXT_CASES.find((x) => x.id === "close_preview_apply");
    const para = c?.paraphrases[0];
    if (!c || !para) throw new Error("no close_preview_apply case");
    scriptDir = mkdtempSync(join(tmpdir(), "mu-eval-rg-"));
    const row = await playCase(c, {
      surface: surface(),
      surfaceLabel: "base",
      arm: "skill",
      paraphrase: para.id,
      reply: async () => ({ text: `\`\`\`sh\n${glob}\n\`\`\``, tokens: 1 }),
      promptDir: scriptDir,
      gapMs: 0,
    });
    expect(row.rigReads).toEqual(["command 1: rig canary in output"]);
    expect(row.invalid).toBe(true);
    expect(row.hit).toBe(false);
  }, 120_000);

  // the escapes of review delegate_rv-iso2: a middle range, no canary, a path no rule sees
  const b64 = (x: string): string => Buffer.from(x).toString("base64");
  const evalDir = `"$(echo ${b64(join(RIG_REPO, "tools", "eval"))} | base64 -d)"`;
  const partial = [
    `cd ${evalDir} && sed -n 5,15p check-rules.ts`,
    `find ${evalDir} -name '*.ts' | xargs grep -h goldenOk`,
    // a non-holdout file only: the test itself never reads a holdout source
    `cd ${evalDir} && cd scenarios && grep -rn -e import -e wrong . --include='t*.ts' | head -20`,
  ];

  it("the fingerprint makes each partial read a rig read, past aut-guard", async () => {
    const r = await run(partial);
    expect(r.metrics.toolCalls).toHaveLength(3);
    for (const c of r.metrics.toolCalls) {
      expect(c.output).not.toContain(RIG_CANARY);
      expect(c.output.trim()).not.toBe(BLOCKED);
    }
    expect(r.verdict.rigReads).toEqual([
      expect.stringMatching(/^#0 bash: rig fingerprint in output/),
      expect.stringMatching(/^#1 bash: rig fingerprint in output/),
      expect.stringMatching(/^#2 bash: rig fingerprint in output/),
    ]);
    expect(r.verdict.completed).toBe(false);
  }, 120_000);

  it("mutation: without the fingerprint scan the same reads keep a completed verdict", async () => {
    const r = await run(partial, { noFingerprint: true });
    expect(r.verdict.rigReads).toBeUndefined();
    expect(r.verdict.completed).toBe(true);
  }, 120_000);

  it("a probe answer whose output carries the fingerprint is invalid, no hit", async () => {
    const c = NEXT_CASES.find((x) => x.id === "close_preview_apply");
    const para = c?.paraphrases[0];
    if (!c || !para) throw new Error("no close_preview_apply case");
    scriptDir = mkdtempSync(join(tmpdir(), "mu-eval-rg-"));
    const row = await playCase(c, {
      surface: surface(),
      surfaceLabel: "base",
      arm: "skill",
      paraphrase: para.id,
      reply: async () => ({ text: `\`\`\`sh\n${partial[0]}\n\`\`\``, tokens: 1 }),
      promptDir: scriptDir,
      gapMs: 0,
    });
    expect(row.rigReads).toEqual([expect.stringMatching(/^command 1: rig fingerprint in output/)]);
    expect(row.invalid).toBe(true);
    expect(row.hit).toBe(false);
  }, 120_000);
});

describe("hook observer", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const observe = (payload: unknown): Record<string, unknown> => {
    const log = join(dir, "hooks.log");
    rmSync(log, { force: true });
    execFileSync(
      process.execPath,
      [join(ROOT, "tools", "eval", "hook-observer.ts"), "claude", log],
      {
        input: JSON.stringify(payload),
        env: { ...process.env, MU_AGENT_NAME: "aut" },
      },
    );
    return JSON.parse(readFileSync(log, "utf8").trim()) as Record<string, unknown>;
  };

  it("flags a pane AUT's payload or transcript that carries the canary", () => {
    dir = mkdtempSync(join(tmpdir(), "mu-eval-obs-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, `{"tool_result":"${RIG_CANARY}"}\n`);
    const stop = { hook_event_name: "Stop", session_id: "s", last_assistant_message: "done" };
    expect(observe({ ...stop, transcript_path: transcript }).rigCanary).toBe(true);
    expect(observe({ ...stop, last_assistant_message: RIG_CANARY }).rigCanary).toBe(true);
    writeFileSync(transcript, "{}\n");
    expect(observe({ ...stop, transcript_path: transcript }).rigCanary).toBeUndefined();
    // the judge scans the named transcript for the fingerprint (rig-fingerprint.ts)
    expect(observe({ ...stop, transcript_path: transcript }).transcript).toBe(transcript);
    expect(observe({ ...stop, last_assistant_message: "x" }).transcript).toBeUndefined();
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
