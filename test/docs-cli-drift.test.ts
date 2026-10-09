// The doc/CLI drift guard.
//
// Every `mu ...` command written in the docs must name a real verb and
// pass only real flags. See test/_doc-commands.ts for why this is a
// tree walk rather than N `--help` subprocesses, and for the escape
// hatch (SKIP_MARKER) an author uses on an illustrative snippet.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { checkDocCommand, type DocCommandProblem, extractDocCommands } from "./_doc-commands.js";

const ROOT = join(import.meta.dirname, "..");

/** Docs whose `mu` snippets are load-bearing instructions.
 *  Deliberately excludes CHANGELOG.md: it is a historical record and
 *  MUST keep naming removed verbs, so a skip region per release entry
 *  would be pure noise. ROADMAP.md IS checked — its live sections are
 *  instructions — with its one superseded section bracketed by the
 *  skip markers. */
const DOC_FILES = [
  "README.md",
  "AGENTS.md",
  "docs/guide/README.md",
  "docs/guide/getting-started.md",
  "docs/guide/dispatch.md",
  "docs/guide/stop-a-worker.md",
  "docs/guide/delegate.md",
  "docs/guide/remote.md",
  "docs/guide/recovery.md",
  "docs/guide/sync.md",
  "docs/guide/tui.md",
  "docs/guide/sql.md",
  "docs/guide/upgrade.md",
  "docs/guide/backends.md",
  "docs/guide/cleanup.md",
  "docs/VOCABULARY.md",
  "docs/reference/env.md",
  "docs/reference/naming.md",
  "docs/ARCHITECTURE.md",
  "docs/architecture/control-socket.md",
  "docs/architecture/dag.md",
  "docs/architecture/mux.md",
  "docs/architecture/ops-log.md",
  "docs/architecture/sdk.md",
  "docs/architecture/sync.md",
  "docs/architecture/tui.md",
  "docs/VISION.md",
  "docs/ROADMAP.md",
  "skills/mu/SKILL.md",
  "skills/mu/recipes/remote-workers.md",
  "skills/mu/recipes/waves.md",
  "skills/mu/recipes/long-run.md",
  "skills/mu/recipes/watcher.md",
  "skills/mu/recipes/orchestrator-loop.md",
  "skills/mu/recipes/worker.md",
  "skills/mu/recipes/recovery.md",
  "skills/mu/recipes/adversarial-review.md",
  "skills/mu/recipes/fan-out.md",
  "skills/mu/recipes/refute.md",
  "skills/mu/recipes/hypothesis-panel.md",
  "skills/mu/recipes/tournament.md",
  "skills/mu/recipes/loop-until-done.md",
  "skills/mu/recipes/backlog-triage.md",
  "skills/mu/recipes/codemode-driver.md",
  "skills/mu/recipes/ultrathink.md",
  "skills/mu/recipes/brief.md",
  "skills/mu/recipes/plan.md",
  "skills/mu/recipes/deep-research.md",
  "skills/mu/recipes/review-panel.md",
  "skills/mu/recipes/rules-audit.md",
  "skills/mu/recipes/findings.md",
  "skills/mu/recipes/tasks-or-calls.md",
  "skills/mu/recipes/drift-audit.md",
  "skills/mu/recipes/models.md",
  "scripts/README.md",
];

describe("docs name only real CLI surface", () => {
  const program = buildProgram();

  it("extracts a non-trivial number of commands (the guard is actually looking)", () => {
    let total = 0;
    for (const file of DOC_FILES) {
      total += extractDocCommands(file, readFileSync(join(ROOT, file), "utf8")).length;
    }
    // Floor, not a target: the docs-audit compression (docs/guide/)
    // dropped the count from ~560; a broken extractor finds ~0.
    expect(total).toBeGreaterThan(200);
  });

  // A guard that cannot fail is theatre. Plant each drift shape the
  // 1.0 arc actually produced and assert it is named.
  it.each([
    // `db` SURVIVES as a namespace (v2 R17 wired `mu db backup`), so the
    // guard names the missing SUBCOMMAND rather than the namespace. That
    // is the more precise message, and asserting it here pins the
    // distinction: a removed subverb under a live namespace must still
    // be caught.
    [
      "a removed subverb under a live namespace",
      "`mu db export /tmp/x.db`",
      "unknown command 'export' under 'db'",
    ],
    ["a removed subverb", "`mu snapshot list`", "unknown command 'snapshot'"],
    ["a flag removed from a live verb", "`mu undo --to 12`", "unknown option '--to'"],
    // `mu` inside a path or a quoted brief is not a second command, so
    // it must not exempt the line from the check.
    [
      "a bad flag next to a mu-named path",
      "`mu db backup /tmp/mu-backup.db --bogus`",
      "unknown option '--bogus'",
    ],
    [
      "a bad flag next to a quoted brief naming mu",
      "`mu agent send w-1 --bogus 'run mu task notes x'`",
      "unknown option '--bogus'",
    ],
  ])("detects %s", (_label, snippet, expected) => {
    const found = extractDocCommands("fixture.md", snippet);
    expect(found).toHaveLength(1);
    const first = found[0];
    if (!first) throw new Error("unreachable");
    expect(checkDocCommand(program, first)).toContain(expected);
  });

  it("still skips a line that chains two mu commands", () => {
    const found = extractDocCommands("fixture.md", "`mu task list; mu task show x --bogus`");
    const first = found[0];
    if (!first) throw new Error("unreachable");
    expect(checkDocCommand(program, first)).toBeNull();
  });

  it("covers every skills/mu recipe", () => {
    const recipes = readdirSync(join(ROOT, "skills/mu/recipes"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `skills/mu/recipes/${f}`);
    expect(recipes.filter((r) => !DOC_FILES.includes(r))).toEqual([]);
  });

  it("honours the skip region so historical sections can name dead verbs", () => {
    const src = [
      "<!-- doc-cli-drift:skip-start -->",
      "`mu db export /tmp/x.db`",
      "<!-- doc-cli-drift:skip-end -->",
      "`mu task list`",
    ].join("\n");
    const found = extractDocCommands("fixture.md", src);
    expect(found.map((c) => c.text)).toEqual(["mu task list"]);
  });

  for (const file of DOC_FILES) {
    it(`${file} has no unknown verbs or flags`, () => {
      const source = readFileSync(join(ROOT, file), "utf8");
      const problems: DocCommandProblem[] = [];
      for (const cmd of extractDocCommands(file, source)) {
        const reason = checkDocCommand(program, cmd);
        if (reason) problems.push({ ...cmd, reason });
      }
      const rendered = problems.map((p) => `${p.file}:${p.line}: ${p.reason}\n    ${p.text}`);
      expect(rendered).toEqual([]);
    });
  }
});
