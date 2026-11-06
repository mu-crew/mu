// Every harness first-class, in the docs (spec D16, U19). The skill has a
// capability section per channel, each recipe the spec names gives the path a
// non-pi orchestrator or worker takes, the setup guide has a section per hook
// harness, and no doc a user or an agent reads still says mu is pi's alone.
// Each check also runs on a planted or stripped copy, so it can fail.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNEL_NAMES } from "../src/channels/index.js";
import { HARNESS_TABLE, HARNESSES } from "../src/harnesses.js";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** The wording U19 retires: `rg -i` of its acceptance check. */
const RETIRED = /pi-first|pi is the agent|crew of pi agents/i;

/** Not what a reader is told today: old release notes keep their words, and a
 *  spec quotes the wording it retires. */
const NOT_READER_DOCS = new Set(["docs/history", "docs/specs"]);

/** Every markdown file under `dir`, repo-relative, outside NOT_READER_DOCS. */
function markdown(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return NOT_READER_DOCS.has(rel) ? [] : markdown(rel);
    return e.name.endsWith(".md") ? [rel] : [];
  });
}

/** What a user or an agent reads: README, docs, the skill, the prompts, and the package description. */
function readerDocs(): Record<string, string> {
  const files = ["README.md", ...markdown("docs"), ...markdown("skills"), ...markdown("prompts")];
  const docs = Object.fromEntries(files.map((f) => [f, read(f)]));
  const pkg = JSON.parse(read("package.json")) as { description: string };
  return { ...docs, "package.json#description": pkg.description };
}

function retiredHits(docs: Record<string, string>): string[] {
  return Object.entries(docs).flatMap(([file, text]) =>
    text
      .split("\n")
      .map((line, i) => (RETIRED.test(line) ? `${file}:${i + 1}` : ""))
      .filter(Boolean),
  );
}

/** The channel each bullet of SKILL.md's `## Channels` section names, in order. */
function skillChannels(skill: string): string[] {
  const section = /^## Channels\n([\s\S]*?)(?=^## )/m.exec(skill)?.[1] ?? "";
  return [...section.matchAll(/^- \*\*([a-z]+)\*\*/gm)].map((m) => m[1] ?? "");
}

/** The `hooks` bullet of that section. */
function hooksBullet(skill: string): string {
  const section = /^## Channels\n([\s\S]*?)(?=^## )/m.exec(skill)?.[1] ?? "";
  return /^- \*\*hooks\*\*[\s\S]*?(?=^- |$(?![\s\S]))/m.exec(section)?.[0] ?? "";
}

const HOOK_HARNESSES = HARNESSES.filter((h) => HARNESS_TABLE[h].defaultChannel === "hooks");

/** What each recipe the spec names must tell a non-pi orchestrator or worker. */
const RECIPE_NEEDLES: Record<string, readonly string[]> = {
  "tasks-or-calls.md": [
    "## Outside pi",
    "mu task check <id>",
    "mu task verdict <id>",
    "-w scratch --force --wait -",
  ],
  "findings.md": ["another family"],
  "adversarial-review.md": ["native subagent under `mu task check"],
  "course-correct.md": ["native subagent"],
  "test-health.md": ["native-subagent check"],
  "orchestrator-loop.md": ["mu orchestrate -w <ws> --cli <harness>", "`hooks`:", "`idle?`"],
  "worker.md": ["**Not pi:**", ".mu/brief-", "mu task park"],
  "models.md": ["`--model <id>`", "harness's own flag"],
  "remote-workers.md": ["`hooks`", "ack: sent"],
};

function missingNeedles(recipe: (file: string) => string): string[] {
  return Object.entries(RECIPE_NEEDLES).flatMap(([file, needles]) =>
    needles.filter((n) => !recipe(file).includes(n)).map((n) => `${file}: ${n}`),
  );
}

const shippedRecipe = (file: string): string => read(`skills/mu/recipes/${file}`);

describe("docs: every harness first-class", () => {
  it("no doc says mu is pi's alone", () => {
    expect(retiredHits(readerDocs())).toEqual([]);
  });

  it("the wording check catches a planted line, in any case", () => {
    const planted = { ...readerDocs(), "docs/guide/x.md": "a\nRun a Crew of Pi Agents in tmux\n" };
    expect(retiredHits(planted)).toEqual(["docs/guide/x.md:2"]);
    expect(retiredHits({ "STANCE.md": "**pi is the agent.**" })).toEqual(["STANCE.md:1"]);
  });

  it("SKILL.md has one capability bullet per channel, and the hooks one names every hook harness", () => {
    const skill = read("skills/mu/SKILL.md");
    expect(skillChannels(skill)).toEqual([...CHANNEL_NAMES]);
    const hooks = hooksBullet(skill);
    for (const h of HOOK_HARNESSES) expect(hooks, h).toContain(h);
    expect(hooks).toContain("mu agent answer");
    expect(skill).toContain("native subagents under `mu task check`");
  });

  it("a channel section missing a channel, or a harness, is caught", () => {
    const skill = read("skills/mu/SKILL.md");
    const noMux = skill.replace(/^- \*\*mux\*\*.*\n/m, "");
    expect(skillChannels(noMux)).not.toEqual([...CHANNEL_NAMES]);
    expect(hooksBullet(skill.replace("cursor-agent, ", ""))).not.toContain("cursor-agent");
  });

  it("each named recipe gives the non-pi path", () => {
    expect(missingNeedles(shippedRecipe)).toEqual([]);
  });

  it.each(Object.entries(RECIPE_NEEDLES).flatMap(([f, ns]) => ns.map((n) => [f, n] as const)))(
    "deleting %s's %s is caught",
    (file, needle) => {
      const strip = (f: string): string =>
        f === file ? shippedRecipe(f).split(needle).join("") : shippedRecipe(f);
      expect(missingNeedles(strip)).toContain(`${file}: ${needle}`);
    },
  );

  it("the setup guide has a section and a table column per hook harness", () => {
    const guide = read("docs/guide/other-agent-clis.md");
    const header = guide.split("\n").find((l) => l.startsWith("| | ")) ?? "";
    for (const h of HOOK_HARNESSES) {
      const name = HARNESS_TABLE[h].displayName;
      expect(guide, name).toMatch(new RegExp(`^### ${name}$`, "m"));
      expect(header, name).toContain(name);
    }
    expect(guide).toMatch(/^## Set up a machine$/m);
  });

  it("README names all five harnesses and pi's exact channel", () => {
    const readme = read("README.md");
    for (const h of HARNESSES) expect(readme, h).toContain(HARNESS_TABLE[h].displayName);
    expect(readme).toMatch(/pi has the exact channel/);
  });
});
