// The shipped skill is capped, and each rule that a measured failure put
// there is pinned by a marker. A budget test that cannot fail is theatre,
// so the markers are checked against a tree with the guard deleted too.
// Rule -> destination -> failure: docs/mu-next/rule-destinations.md.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepDrivingRule } from "../extension/nudge.js";

const ROOT = join(import.meta.dirname, "..");
const SKILL_DIR = join(ROOT, "skills", "mu");

/** The pinned tokenizer: whitespace-separated words, exactly `wc -w`.
 *  Frontmatter, code blocks, tables and link targets all count. */
function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const CAPS = { skill: 600, recipe: 250, recipes: 4000, prompt: 80 } as const;

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const recipeFiles = (): string[] =>
  readdirSync(join(SKILL_DIR, "recipes"))
    .filter((f) => f.endsWith(".md"))
    .sort();
const promptFiles = (): string[] =>
  readdirSync(join(ROOT, "prompts"))
    .filter((f) => f.endsWith(".md"))
    .sort();

/** One marker per rule a failure put in the skill: where it lives and the
 *  text that carries it. A marker proves the guard is still written, not
 *  that it is obeyed; `t_skill` measures that. */
type Marker = { id: string; file: string; needles: readonly (string | RegExp)[] };

const MARKERS: readonly Marker[] = [
  {
    id: "keep-driving",
    file: "SKILL.md",
    needles: [
      "<!-- mu:keep-driving -->",
      "<!-- /mu:keep-driving -->",
      "**While workers run, keep driving.**",
      "An error never means a\nhuman is needed",
    ],
  },
  {
    id: "record",
    file: "recipes/tasks-or-calls.md",
    needles: [
      'record: {task: "<ws>/<id>"}',
      "VERDICT: <id> CONFIRMED|REFUTED|UNVERIFIED",
      "REFUTER <n>",
    ],
  },
  {
    id: "remote-collect",
    file: "recipes/remote-workers.md",
    needles: ["mu agent collect", "CLOSE: task=<id>", "re-run the evidence before you close"],
  },
  {
    id: "error-receipt",
    file: "SKILL.md",
    needles: [
      "A send that timed out is unknown, never resent",
      "mu agent check <a> <msgId>",
      "`unknown` is not dead.",
    ],
  },
  {
    id: "reviewer-evidence",
    file: "recipes/adversarial-review.md",
    needles: [
      "A review that ran no command is no verdict",
      '--evidence "<command it ran>: <result>"',
      "Two rejections of one unit end the loop",
    ],
  },
  {
    id: "claim-before-send",
    file: "SKILL.md",
    needles: ["**Claim before work is sent.**", "**Only `CLOSED/done` ships.**"],
  },
];

/** Needles missing from `text`, as `id: needle` lines. */
function missingMarkers(read: (file: string) => string): string[] {
  const out: string[] = [];
  for (const m of MARKERS) {
    const text = read(m.file);
    for (const n of m.needles) {
      if (typeof n === "string" ? !text.includes(n) : !n.test(text))
        out.push(`${m.id}: ${String(n)}`);
    }
  }
  return out;
}

const shipped = (file: string): string => readFileSync(join(SKILL_DIR, file), "utf8");

describe("prose budget", () => {
  it("counts words as wc -w does", () => {
    expect(words("a  b\n\nc\td ")).toBe(4);
    expect(words("")).toBe(0);
  });

  it(`SKILL.md is at most ${CAPS.skill} words`, () => {
    expect(words(shipped("SKILL.md"))).toBeLessThanOrEqual(CAPS.skill);
  });

  it.each(recipeFiles())(`recipe %s is at most ${CAPS.recipe} words`, (f) => {
    expect(words(shipped(`recipes/${f}`))).toBeLessThanOrEqual(CAPS.recipe);
  });

  it(`all recipes together are at most ${CAPS.recipes} words`, () => {
    const total = recipeFiles().reduce((n, f) => n + words(shipped(`recipes/${f}`)), 0);
    expect(total).toBeLessThanOrEqual(CAPS.recipes);
  });

  it(`each prompt is at most ${CAPS.prompt} words and points at one shipped recipe`, () => {
    const have = new Set(recipeFiles());
    for (const f of promptFiles()) {
      const text = read(`prompts/${f}`);
      expect(words(text), f).toBeLessThanOrEqual(CAPS.prompt);
      const refs = [...text.matchAll(/recipes\/([a-z-]+\.md)/g)].map((m) => m[1] ?? "");
      expect(refs.length, f).toBeGreaterThan(0);
      for (const r of refs) expect(have.has(r), `${f} -> ${r}`).toBe(true);
    }
  });

  it("every recipe is in the SKILL.md index, and every index row exists", () => {
    const skill = shipped("SKILL.md");
    const indexed = [...skill.matchAll(/\]\(recipes\/([a-z-]+)\.md\)/g)].map((m) => `${m[1]}.md`);
    expect(new Set(indexed)).toEqual(new Set(recipeFiles()));
    expect(skill).toMatch(/^## Recipes$/m);
  });

  it("skill and prompts teach no retired surface", () => {
    const retired = [
      /\bmu link\b/,
      /workspace refresh/,
      /\bmu kick\b/,
      /\bsleep \d/,
      /\btask wait\b/,
      /(?<!no `)\bsqlite3\b(?! -readonly)/, // `no \`sqlite3\`` is the write ban
    ];
    const files = [
      "skills/mu/SKILL.md",
      ...recipeFiles().map((f) => `skills/mu/recipes/${f}`),
      ...promptFiles().map((f) => `prompts/${f}`),
    ];
    for (const f of files) {
      for (const re of retired) expect(re.test(read(f)), `${f}: ${re}`).toBe(false);
    }
  });
});

describe("failure-backed markers", () => {
  it("the shipped tree carries every marker", () => {
    expect(missingMarkers(shipped)).toEqual([]);
  });

  it("the nudge parser reads the keep-driving block from the shipped SKILL.md", () => {
    const rule = keepDrivingRule(shipped("SKILL.md"));
    expect(rule).toMatch(/^\*\*While workers run, keep driving\.\*\*/);
  });

  it.each(MARKERS.flatMap((m) => m.needles.map((n) => [m.id, m.file, n] as const)))(
    "deleting %s's %s guard %s is caught",
    (id, file, needle) => {
      const strip = (f: string): string => {
        const text = shipped(f);
        if (f !== file) return text;
        return typeof needle === "string" ? text.split(needle).join("") : text.replace(needle, "");
      };
      expect(missingMarkers(strip).filter((l) => l.startsWith(`${id}:`))).not.toEqual([]);
    },
  );

  it("an emptied keep-driving block disables the nudge parser", () => {
    const emptied = shipped("SKILL.md").replace(
      /(<!-- mu:keep-driving -->)[\s\S]*?(<!-- \/mu:keep-driving -->)/,
      "$1\n$2",
    );
    expect(keepDrivingRule(emptied)).toBeUndefined();
    expect(missingMarkers((f) => (f === "SKILL.md" ? emptied : shipped(f)))).not.toEqual([]);
  });
});
