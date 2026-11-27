// The pi extension is loaded standalone (dist/extension/mu-pi.js, its own
// tsup build): everything it reaches must import only Node built-ins, never
// better-sqlite3 or the DB layer. Walks the source import graph from the entry.

import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const SPEC = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g;

function graph(entry: string): { files: Set<string>; external: Map<string, string> } {
  const files = new Set<string>();
  const external = new Map<string, string>();
  const todo = [entry];
  for (let f = todo.pop(); f !== undefined; f = todo.pop()) {
    if (files.has(f)) continue;
    files.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(SPEC)) {
      const spec = m[1] ?? m[2];
      if (spec === undefined) continue;
      if (spec.startsWith(".")) todo.push(resolve(dirname(f), spec.replace(/\.js$/, ".ts")));
      else external.set(spec, f);
    }
  }
  return { files, external };
}

describe("pi extension bundle stays standalone", () => {
  it("reaches only Node built-ins (no better-sqlite3, no src/db.ts)", () => {
    const { files, external } = graph(join(root, "extension", "mu-pi.ts"));
    const builtin = new Set(builtinModules);
    const bad = [...external].filter(([spec]) => !spec.startsWith("node:") && !builtin.has(spec));
    expect(bad).toEqual([]);
    expect([...files].some((f) => f.endsWith(join("src", "db.ts")))).toBe(false);
  });
});
