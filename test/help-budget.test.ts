// Help budget: every verb's --help description is at most 3 lines at 80 columns.
// Flags have their own option text and are not counted; the rest of a verb's
// story (exit codes, what a cut result names, remote and recovery rules) lives in
// docs/guide/ and the one-line errors, not in --help. A verb added over budget
// fails here, naming the verb and its length.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

const WIDTH = 80;
const MAX_LINES = 3;

function walk(cmd: Command, path: string[], out: Array<{ path: string; cmd: Command }>): void {
  out.push({ path: path.join(" ") || "mu", cmd });
  for (const sub of cmd.commands) walk(sub, [...path, sub.name()], out);
}

/** The lines between `Usage:` and the first Arguments/Options/Commands block. */
function descriptionLines(cmd: Command): string[] {
  const help = cmd.helpInformation({ error: false });
  const lines = help.split("\n");
  const start = lines.findIndex((l) => l.startsWith("Usage:"));
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^(Arguments|Options|Commands):/.test(l)) break;
    if (l.trim() !== "") body.push(l);
  }
  return body;
}

function fixWidth(cmd: Command): void {
  cmd.configureHelp({ ...cmd.configureHelp(), helpWidth: WIDTH });
  for (const sub of cmd.commands) fixWidth(sub);
}

describe("help budget", () => {
  const program = buildProgram();
  fixWidth(program);
  const all: Array<{ path: string; cmd: Command }> = [];
  walk(program, [], all);

  it("walks the whole verb tree", () => {
    // A broken walker finds only the root.
    expect(all.length).toBeGreaterThan(60);
  });

  it("measures lines the way a reader sees them", () => {
    const wait = all.find((v) => v.path === "wait");
    if (!wait) throw new Error("no wait verb");
    expect(descriptionLines(wait.cmd).length).toBeGreaterThan(0);
    // Planted: a 4-line description must be seen as 4 lines.
    const probe = buildProgram().command("zz-probe").description("word ".repeat(70));
    fixWidth(probe);
    expect(descriptionLines(probe).length).toBeGreaterThan(MAX_LINES);
  });

  it.each(all.map((v) => [v.path, v.cmd] as const))(
    "%s has at most 3 description lines",
    (_p, cmd) => {
      expect(descriptionLines(cmd).length).toBeLessThanOrEqual(MAX_LINES);
    },
  );
});
