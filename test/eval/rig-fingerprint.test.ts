// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// rig-fingerprint.ts: an output that prints a middle range of a rig file (no canary, no path) is a
// rig read by the rig's own names; mu's text, the staged sandbox files and the run's own env are not.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  declaredIds,
  declaredNames,
  distinctive,
  FINGERPRINT_K,
  type Fingerprint,
  fingerprintHits,
  fingerprintInOutputs,
  fingerprintInTranscripts,
  fingerprintRead,
  fingerprintReads,
  HOLDOUTS,
  rigFingerprint,
  rowIds,
  stagedSources,
  words,
} from "../../tools/eval/rig-fingerprint.ts";
import { RIG_REPO } from "../../tools/eval/rig-guard.ts";

const fp = rigFingerprint();
const evalDir = join(RIG_REPO, "tools", "eval");
const sh = (cmd: string): string =>
  execFileSync("sh", ["-c", cmd], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const b64 = (s: string): string => Buffer.from(s).toString("base64");
/** A dir the command computes at run time: no path rule sees it (rig-guard.integration.test.ts). */
const computed = (dir: string): string => `"$(echo ${b64(dir)} | base64 -d)"`;

describe("the fingerprint's tokens", () => {
  it("are the rig's distinctive names: ids, rows, declared names", () => {
    expect(distinctive("closeEarnedWrong")).toBe(true);
    expect(distinctive("wait_wave_six")).toBe(true);
    expect(distinctive("bad-close-early")).toBe(true);
    expect(distinctive("teardown")).toBe(false);
    expect(distinctive("a_b")).toBe(false);
    expect(
      declaredNames("export function fooBar() {}\nconst { a, b: c } = x;\n  baz(q: T): R {"),
    ).toEqual(["fooBar", "baz", "a", "b", "c"]);
    expect(declaredIds('{ id: "notes_multi", x: 1 }')).toEqual(["notes_multi"]);
    expect(rowIds("tools/eval/scenarios/poll_wave.bad-early.next.json")).toEqual([
      "poll_wave",
      "bad-early",
    ]);
    expect([...words("a bad-close-early x")]).toEqual([
      "a",
      "bad-close-early",
      "bad",
      "close",
      "early",
      "x",
    ]);
    expect(fp.tokens.size).toBeGreaterThan(500);
    expect(fp.holdouts).toEqual(HOLDOUTS);
    expect(fp.k).toBe(FINGERPRINT_K);
  });

  it("leave out what the surface prints: mu's verbs, flags, messages, skill, guide", () => {
    for (const f of ["skills/mu/SKILL.md", "CHANGELOG.md", "src/cli.ts", "src/messages.ts"])
      expect(fingerprintHits(readFileSync(join(RIG_REPO, f), "utf8"), fp), f).toEqual([]);
  });

  it("leave out the rig modules staged into a sandbox, which the AUT may read", () => {
    const staged = stagedSources(evalDir);
    expect([...staged.keys()]).toEqual(
      expect.arrayContaining(["faux.ts", "aut-guard.ts", "ssh-shim.ts"]),
    );
    for (const [f, src] of staged) expect(fingerprintHits(src, fp), f).toEqual([]);
  });

  it("leave out the run's own scenario id and its own env", () => {
    const text = "EVAL_SCENARIO_HINT poll_wave";
    const t = { ...fp, tokens: new Set(["EVAL_SCENARIO_HINT", "poll_wave"]) };
    expect(fingerprintHits(text, t)).toEqual(["EVAL_SCENARIO_HINT", "poll_wave"]);
    expect(
      fingerprintHits(text, t, { own: "poll_wave", env: { EVAL_SCENARIO_HINT: "1" } }),
    ).toEqual([]);
  });
});

describe("fingerprintRead", () => {
  const toy: Fingerprint = {
    tokens: new Set(["closeEarnedWrong", "readVerdictRow", "wrong_id"]),
    holdouts: ["wrong_id"],
    k: 2,
  };

  it("needs k distinct tokens, or one holdout id, and names counts only", () => {
    expect(fingerprintRead("closeEarnedWrong closeEarnedWrong", toy)).toBeNull();
    expect(fingerprintRead("closeEarnedWrong", { ...toy, k: 1 })).toBe(
      "rig fingerprint in output (1 token)",
    );
    expect(fingerprintRead("closeEarnedWrong(readVerdictRow(x))", toy)).toBe(
      "rig fingerprint in output (2 tokens)",
    );
    expect(fingerprintRead("./scenarios/wrong_id.ts", toy)).toBe("holdout id in output (1)");
    // the holdout's own run may print its id (its log path)
    expect(fingerprintRead("./scenarios/wrong_id.ts", toy, { own: "wrong_id" })).toBeNull();
  });

  it("reports per tool call and per probe command", () => {
    const calls = [
      { name: "bash", output: "ok" },
      { name: "bash", output: "closeEarnedWrong readVerdictRow" },
    ];
    expect(fingerprintReads(calls, toy)).toEqual(["#1 bash: rig fingerprint in output (2 tokens)"]);
    expect(fingerprintInOutputs(["", "wrong_id"], toy)).toEqual([
      "command 2: holdout id in output (1)",
    ]);
  });

  it("scans a pane AUT's transcript line by line, each named once", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-eval-fp-"));
    try {
      const t = join(dir, "s.jsonl");
      writeFileSync(t, '{"a":"closeEarnedWrong"}\n{"b":"readVerdictRow"}\n');
      expect(fingerprintInTranscripts([t, t], toy)).toEqual([]);
      expect(fingerprintInTranscripts([t, t], { ...toy, k: 1 })).toEqual([
        "transcript s.jsonl:1: rig fingerprint in output (1 token)",
      ]);
      expect(fingerprintInTranscripts([join(dir, "gone.jsonl")], toy)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// the escapes of review delegate_rv-iso2: content from a middle range, never the canary
describe("the reviewer's escapes", () => {
  const judge = join(evalDir, "check-rules.ts");

  it("sed -n of a judge file's middle range", () => {
    const out = sh(`cd ${computed(evalDir)} && sed -n 5,15p check-rules.ts`);
    expect(out).not.toContain("RIG-CANARY");
    expect(fingerprintRead(out, fp)).toMatch(/^rig fingerprint in output/);
  });

  it("xargs grep -h of a judge identifier (no file names)", () => {
    const out = sh(`find ${computed(evalDir)} -name '*.ts' | xargs grep -h goldenOk`);
    expect(out).not.toContain(judge);
    expect(fingerprintRead(out, fp)).toMatch(/^rig fingerprint in output/);
  });

  // a non-holdout file only (t*.ts): the test itself never reads a holdout source
  it("grep -rn after a computed cd (relative names only)", () => {
    const out = sh(
      `cd ${computed(join(evalDir, "scenarios"))} && grep -rn -e import -e wrong . --include='t*.ts' | head -20`,
    );
    expect(out).not.toContain("tools/eval");
    expect(fingerprintRead(out, fp)).not.toBeNull();
  });

  it("tar t of the scenarios names a holdout; of test/eval it prints names only and escapes", () => {
    const scen = sh(`tar c -C ${computed(evalDir)} scenarios | tar t`);
    expect(fingerprintRead(scen, fp)).toMatch(/^holdout id in output/);
    const tests = sh(
      `tar c -C ${computed(join(RIG_REPO, "test"))} eval | tar t | grep -v scenarios`,
    );
    expect(fingerprintRead(tests, fp)).toBeNull();
  });

  it("an encoding escapes (residual: the model must decode it on purpose)", () => {
    // xxd's ASCII column keeps some 16-byte runs of a name, so it is caught only by chance
    for (const enc of ["base64", "gzip -c | base64", "rev", "tr a-z n-za-m"])
      expect(fingerprintRead(sh(`sed -n 5,15p ${computed(judge)} | ${enc}`), fp), enc).toBeNull();
  });

  it("covers a share of middle ranges, not all: 11-line windows of the rig's TypeScript", () => {
    const files = execFileSync("git", ["-C", RIG_REPO, "ls-files", "tools/eval", "test/eval"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f.endsWith(".ts"));
    let n = 0;
    let hit = 0;
    for (const f of files) {
      const lines = readFileSync(join(RIG_REPO, f), "utf8").split("\n");
      for (let i = 1; i + 11 < lines.length - 1; i += 11) {
        n++;
        if (fingerprintRead(lines.slice(i, i + 11).join("\n"), fp) !== null) hit++;
      }
    }
    // README "What each layer catches": about 70% at k=1 when measured
    expect(hit / n).toBeGreaterThan(0.6);
    expect(hit / n).toBeLessThan(0.9);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
