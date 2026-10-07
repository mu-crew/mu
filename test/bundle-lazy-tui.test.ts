// Guard for f_eager_ink_bundle: the CLI entry must not statically load the
// TUI stack. The source keeps the TUI behind `await import(...)`, but a
// bundler config with splitting off inlines it and hoists `import "ink"` /
// `import "react"` to the top of dist/cli.js, so `mu --version` and every
// verb evaluated ink, react, yoga, and es-toolkit (748 modules vs 201).
//
// Builds the real tsup.config.ts into a temp dir (no .d.ts, no sourcemap),
// then walks dist/cli.js's static import graph.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { build, type Options } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../tsup.config.js";

const TUI_PACKAGES = ["ink", "react", "react/jsx-runtime", "yoga-layout", "string-width"];

// `import {..} from "x"`, `import "x"`, `export {..} from "x"`; not `import("x")`.
const STATIC_IMPORT = /^\s*(?:import|export)\b[^(]*?["']([^"']+)["'];?\s*$/gm;

function staticImports(src: string): string[] {
  return [...src.matchAll(STATIC_IMPORT)].map((m) => m[1] ?? "");
}

describe("bundle keeps the TUI lazy", () => {
  let out: string;

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "mu-bundle-"));
    const configs = (Array.isArray(config) ? config : [config]) as Options[];
    for (const c of configs) {
      const outDir = join(out, relative("dist", c.outDir ?? "dist"));
      await build({ ...c, outDir, dts: false, sourcemap: false, silent: true, config: false });
    }
  }, 60_000);

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it("dist/cli.js's static import graph reaches no ink/react/yoga", () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const queue = ["cli.js"];
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of staticImports(readFileSync(join(out, file), "utf8"))) {
        if (spec.startsWith("./")) queue.push(spec.slice(2));
        else bare.add(spec);
      }
    }
    expect(seen.size).toBeGreaterThan(1); // the walk followed shared chunks
    expect([...bare].filter((s) => TUI_PACKAGES.includes(s))).toEqual([]);
  });

  it("the TUI is emitted as its own chunk that does import ink", () => {
    const tui = readdirSync(out).find((f) => /^tui-.*\.js$/.test(f));
    expect(tui).toBeDefined();
    if (tui === undefined) return;
    expect(staticImports(readFileSync(join(out, tui), "utf8"))).toContain("ink");
    expect(readFileSync(join(out, "cli.js"), "utf8")).toContain(`import("./${tui}")`);
  });

  it("dist/extension/mu-pi.js is standalone (imports no sibling chunks)", () => {
    const src = readFileSync(join(out, "extension", "mu-pi.js"), "utf8");
    expect(staticImports(src).filter((s) => s.startsWith("."))).toEqual([]);
  });
});
