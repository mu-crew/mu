import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../src");

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("pane text is not used for agent state", () => {
  it("keeps input timing private to the mux implementation", () => {
    const offenders = sourceFiles()
      .filter((path) => !relative(SRC, path).startsWith("mux/"))
      .filter((path) => /from ["'][^"']*input-timing/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it("has no general pane status detector", () => {
    expect(existsSync(resolve(SRC, "detect.ts"))).toBe(false);
  });

  it("captures pane text only for input, output, or spawn failures", () => {
    const allowed = new Map([
      ["agents/spawn.ts", "detect startup errors and include failure context"],
      ["agents.ts", "return agent output from the SDK read operation"],
      ["cli/agents.ts", "print agent scrollback for read and show"],
      ["mux/herdr.ts", "implement the mux capture operation"],
      ["mux/tmux.ts", "implement capture and protect tmux input timing"],
      ["mux/types.ts", "declare the mux capture operation"],
    ]);
    const offenders = sourceFiles()
      .filter((path) => /\bcapturePane\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });
});
