// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// f_help_markers: markers from the rendered help, for what the source hunks cannot see (C3 multi-id:
// commander composes `notes [options] [ids...]`, and the new sentence sits in a literal whose `\\n`
// escape `dist/` spells differently, so the hunks gave no marker any help arm showed).
import { describe, expect, it } from "vitest";
import { baseSpec, type ExposureSpec, probeExposure } from "../../tools/eval/exposure.ts";
import {
  type CorpusFile,
  deriveMarkers,
  type HelpPage,
} from "../../tools/eval/tournament-build.ts";
import { changedStrings, parsePatch } from "../../tools/eval/tournament-patch.ts";

// C3 multi-id's shape: a usage change and a sentence appended to an escaped literal
const PATCH = `diff --git a/src/cli/tasks/wire.ts b/src/cli/tasks/wire.ts
--- a/src/cli/tasks/wire.ts
+++ b/src/cli/tasks/wire.ts
@@ -1,6 +1,6 @@
   task
-    .command("notes <id>")
+    .command("notes [ids...]")
     .description(
-      "A task's notes, one per line (a newline inside a note prints as \\\\n): the brief, the report.",
+      "A task's notes, one per line (a newline inside a note prints as \\\\n): the brief, the report. Multiple ids print under a header per task.",
     )
`;

const COMMENT_PATCH = `diff --git a/src/cli/tasks/wire.ts b/src/cli/tasks/wire.ts
--- a/src/cli/tasks/wire.ts
+++ b/src/cli/tasks/wire.ts
@@ -1,3 +1,3 @@
   task
-    // the notes verb
+    // the notes verb, one page per task
     .command("notes <id>")
`;

// what dist/ ships: the bundler spells the literal with one backslash, so no hunk part matches
const corpus = (desc: string): CorpusFile[] => [
  { file: "dist/cli.js", text: `.command("notes <id>").description("${desc}")` },
  { file: "skills/mu/SKILL.md", text: "Read a task's notes with mu task notes <id> -w <ws>." },
];
const BASE_DESC =
  "A task's notes, one per line (a newline inside a note prints as \\n): the brief, the report.";
const V_DESC = `${BASE_DESC} Multiple ids print under a header per task.`;

const page = (path: string, usage: string, desc: string): HelpPage => ({
  path,
  text: `Usage: mu ${path} [options] ${usage}\n\n${desc}\n\nOptions:\n  --all        every note\n  -h, --help   display help for command\n`,
});
const BASE_HELP: HelpPage[] = [
  { path: "", text: "Usage: mu [options] [command]\n\nCommands:\n  task   tasks\n" },
  page("task notes", "<id>", BASE_DESC),
];
const V_HELP: HelpPage[] = [
  BASE_HELP[0] as HelpPage,
  // a wider usage re-pads nothing that matters: whitespace is collapsed
  page("task notes", "[ids...]", V_DESC.replace(" Multiple", "\nMultiple")),
];

const specOf = (d: ReturnType<typeof deriveMarkers>): ExposureSpec => ({
  markers: d.markers,
  contextMarkers: d.contextMarkers,
  newNames: [],
  changedCalls: [],
});

// a help arm's block, as nextstep.helpBlock renders it; the transcript is the same on both
const prompt = (help: HelpPage[] | null): string =>
  [
    "system: you orchestrate with mu.",
    ...(help === null
      ? []
      : [
          "<help>",
          ...help.filter((p) => p.path !== "").map((p) => `$ mu ${p.path} --help\n${p.text}`),
          "</help>",
        ]),
    "$ mu task notes delegate_rev_1 -w auth",
    "brief\treport",
  ].join("\n");
const row = { leadInCalls: [], muCalls: [] };

describe("markers from the rendered help", () => {
  const diff = changedStrings(parsePatch(PATCH));

  it("the source pass alone sees nothing a help arm shows (the C3 multi-id gap)", () => {
    const d = deriveMarkers(diff, corpus(V_DESC), corpus(BASE_DESC));
    expect(probeExposure(row, prompt(V_HELP), specOf(d)).winExposed).toBe(false);
  });

  it("a usage line and a sentence the variant's help adds are markers; the variant is winExposed under a help arm only", () => {
    const d = deriveMarkers(diff, corpus(V_DESC), corpus(BASE_DESC), {
      variant: V_HELP,
      base: BASE_HELP,
    });
    expect(d.markers).toContain("Usage: mu task notes [options] [ids...]");
    expect(d.markers).toContain("Multiple ids print under a header per task.");
    // unchanged help lines (re-padded or not) are no marker
    expect(d.markers.some((m) => m.includes("display help"))).toBe(false);
    expect(d.contextMarkers).toContain("Usage: mu task notes [options] <id>");
    const spec = specOf(d);
    expect(probeExposure(row, prompt(V_HELP), spec).winExposed).toBe(true);
    // no help arm: the transcript alone shows no marker
    expect(probeExposure(row, prompt(null), spec).winExposed).toBe(false);
    // base never shows a variant marker, under any arm
    expect(probeExposure(row, prompt(BASE_HELP), spec).markersSeen).toEqual([]);
    expect(probeExposure(row, prompt(null), spec).markersSeen).toEqual([]);
    // a base row under a help arm sees the rewritten usage line (its context marker)
    expect(probeExposure(row, prompt(BASE_HELP), baseSpec(spec)).winExposed).toBe(true);
  });

  it("a help line base prints anywhere, even across a wrap, is no marker; one base prints twice is no context marker", () => {
    const shared = "Multiple ids print under a header per task.";
    const base: HelpPage[] = [
      ...BASE_HELP,
      // the same sentence wrapped over two lines on another page
      {
        path: "task show",
        text: `Usage: mu task show <id>\n\nMultiple ids print\nunder a header per task.\n`,
      },
      { path: "task list", text: "Usage: mu task notes [options] <id>\n" },
    ];
    const d = deriveMarkers(diff, corpus(V_DESC), corpus(BASE_DESC), { variant: V_HELP, base });
    expect(d.markers).not.toContain(shared);
    expect(d.contextMarkers).not.toContain("Usage: mu task notes [options] <id>");
    expect(d.rejected.map((r) => r.text)).toContain("Usage: mu task notes [options] <id>");
  });

  it("a variant that only changes a src comment has no marker", () => {
    const d = deriveMarkers(
      changedStrings(parsePatch(COMMENT_PATCH)),
      corpus(BASE_DESC),
      corpus(BASE_DESC),
      {
        variant: BASE_HELP,
        base: BASE_HELP,
      },
    );
    expect(d).toEqual({ markers: [], contextMarkers: [], rejected: [] });
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
