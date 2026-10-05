// findCommandForArgv picks the command whose usage a parse error shows.
// A leading root option (`mu --json task list --bogus`) used to stop the
// walk at the root, so usage and the quoting hint fell back to `mu`.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { findCommandForArgv } from "../src/cli/handle.js";
import { buildProgram } from "../src/cli.js";

function path(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

describe("findCommandForArgv", () => {
  const program = buildProgram();
  const find = (argv: string[]) => path(findCommandForArgv(program, argv));

  it("resolves the verb after leading root options", () => {
    expect(find(["task", "list", "--bogus"])).toBe("mu task list");
    expect(find(["--json", "task", "list", "--bogus"])).toBe("mu task list");
    expect(find(["-w", "x", "--json", "task", "note", "b", "a"])).toBe("mu task note");
    expect(find(["--workstream=x", "task", "list"])).toBe("mu task list");
    expect(find(["-wx", "task", "list"])).toBe("mu task list");
  });

  it("a leading root -w takes one value, then the verb resolves", () => {
    expect(find(["-w", "x", "task", "list", "--bogus"])).toBe("mu task list");
    expect(find(["-w", "x", "task", "note", "b", "a", "b", "c"])).toBe("mu task note");
    expect(find(["--workstream", "x", "task", "list"])).toBe("mu task list");
  });

  it("a variadic option consumes following words, as commander does", () => {
    expect(find(["task", "list", "--substate", "a", "b", "--bogus"])).toBe("mu task list");
  });

  it("stops at an unknown option or token", () => {
    expect(find(["--bogus", "task", "list"])).toBe("mu");
    expect(find(["task", "bogus", "list"])).toBe("mu task");
  });
});
