// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The committed tournament report and control copy (hill2 note 32: the writer put no canary, real
// home paths and live recipe links in them). A fixture report is written and run through the same
// checks the repo's tests apply to docs/eval: the canary lines, no home path, every link resolving.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RIG_CANARY } from "../../tools/eval/rig-private.ts";
import { controlFile } from "../../tools/eval/tournament.ts";
import {
  committedControl,
  defangLinks,
  fenceFor,
  publicReport,
  renderReport,
  tildeHome,
  writeReport,
} from "../../tools/eval/tournament-report.ts";

const CHECKER = join(import.meta.dirname, "..", "..", "scripts", "check-doc-links.mjs");
const links = (root: string): { status: number | null; out: string } => {
  const r = spawnSync(process.execPath, [CHECKER, root], { encoding: "utf8" });
  return { status: r.status, out: r.stdout };
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-publish-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const HOME = homedir();
// recipe text quoted the way an admission failure and a patch quote it
const RECIPE_LINE = "One `wave` per fan-out ([tasks-or-calls](tasks-or-calls.md)); then read";
const PATCH = [
  "diff --git a/skills/mu/recipes/orchestrator-loop.md b/skills/mu/recipes/orchestrator-loop.md",
  "--- a/skills/mu/recipes/orchestrator-loop.md",
  "+++ b/skills/mu/recipes/orchestrator-loop.md",
  "@@ -1,5 +1,5 @@",
  " ```sh",
  " mu wait -w ws",
  " ```",
  `-${RECIPE_LINE}`,
  `+${RECIPE_LINE} the result whole ([upgrade](../../../docs/guide/upgrade.md)).`,
  "",
].join("\n");

function fixture(): { dir: string; repo: string } {
  const dir = join(tmp, "rows", "c3_notes");
  const repo = join(tmp, "repo");
  const cand = join(repo, "tools", "eval", "candidates", "c3_notes", "opus");
  mkdirSync(cand, { recursive: true });
  writeFileSync(
    join(cand, "v1.json"),
    JSON.stringify({ id: "v1", group: "c3_notes", kind: ["recipe"], summary: "s" }),
  );
  writeFileSync(join(cand, "v1.patch"), PATCH);
  mkdirSync(dir, { recursive: true });
  const rows = [
    {
      kind: "setup",
      group: "c3_notes",
      baseSha: "473b3f5e",
      baseDir: `${HOME}/.cache/b`,
      b0: { models: ["m"], providerExt: null, rows: [{ model: "m", ok: true }] },
      models: { weak: ["m"], gate: "m" },
      providerExt: null,
      systemSha: "sys",
      rho: {},
      rhoPool: {},
      seed: "seed",
      holdouts: { ids: [], note: "not run, not read" },
    },
    {
      kind: "variant",
      id: "v1",
      session: "opus",
      manifest: { id: "v1", group: "c3_notes", kind: ["recipe"], summary: `see ${RECIPE_LINE}` },
      patchSha: "x",
      ref: "r",
      dir: `${HOME}/.cache/mu/eval/surfaces/hill2-v1`,
      spec: { markers: [], contextMarkers: [], newNames: [], changedCalls: [] },
      rejectedContext: [],
      textDelta: 1,
      admission: {
        ok: false,
        failures: [`skills/mu/recipes/orchestrator-loop.md: over its cap 153: ${RECIPE_LINE}`],
        caps: { src: 0, skill: 1 },
      },
      goldenCompat: { broken: [] },
    },
  ];
  writeFileSync(controlFile(dir), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return { dir, repo };
}

describe("the committed report", () => {
  it("carries the canary first and last, ~ for home, and links that resolve", async () => {
    const { dir, repo } = fixture();
    const out = "docs/eval/hill-r2/c3.md";
    expect(await writeReport({ group: "c3_notes", dir, repo, args: [], out })).toBe(0);
    const md = readFileSync(join(repo, out), "utf8");
    const lines = md.trimEnd().split("\n");
    expect(lines[0]).toContain(RIG_CANARY);
    expect(lines.at(-1)).toContain(RIG_CANARY);
    expect(md).not.toContain(HOME);
    expect(md).toContain("`~/.cache/b`");
    expect(md).toContain("(length caps: src 0, skill 1 strings)");
    // the patch is verbatim inside a fence its own ``` lines cannot close
    expect(md).toContain(`\`\`\`\`diff\n${PATCH.trimEnd()}\n\`\`\`\``);
    expect(links(repo)).toEqual({ status: 0, out: "" });
    // the fixture does exercise the checker: the unpublished render fails it
    writeFileSync(
      join(repo, out),
      renderReport({
        group: "c3_notes",
        dir,
        candDir: join(repo, "tools/eval/candidates/c3_notes"),
      })
        .split("````")
        .join("```"),
    );
    expect(links(repo).status).toBe(1);
    const jsonl = readFileSync(committedControl(repo, "c3_notes"), "utf8").trimEnd().split("\n");
    expect(jsonl[0]).toContain(RIG_CANARY);
    expect(jsonl.at(-1)).toContain(RIG_CANARY);
    expect(jsonl.join("\n")).not.toContain(HOME);
    // every line is still a JSON row
    for (const l of jsonl) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(jsonl[1] ?? "{}").baseDir).toBe("~/.cache/b");
  });

  it("tildeHome rewrites the home dir only where it ends a path segment", () => {
    expect(tildeHome("/u/me/x and /u/me and /u/mex /u/me.bak", "/u/me")).toBe(
      "~/x and ~ and /u/mex /u/me.bak",
    );
  });

  it("defangLinks leaves code alone and breaks prose links and definitions", () => {
    const md = ["a [x](y.md) `[c](d.md)` b", "[ref]: z.md", "```", "[f](g.md)", "```"].join("\n");
    expect(defangLinks(md)).toBe(
      ["a [x]\\(y.md) `[c](d.md)` b", "\\[ref]: z.md", "```", "[f](g.md)", "```"].join("\n"),
    );
  });

  it("fenceFor outruns the longest backtick run in the body", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor(" ```sh\n x\n ```")).toBe("````");
    expect(fenceFor("`````")).toBe("``````");
  });

  it("publicReport puts the canary on exactly two lines", () => {
    const once = publicReport("# t\n", "/h");
    expect(once.split("\n").filter((l) => l.includes(RIG_CANARY))).toHaveLength(2);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
