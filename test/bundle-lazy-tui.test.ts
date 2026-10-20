// Guard for f_eager_ink_bundle: the CLI entry must not statically load the
// TUI stack. The source keeps the TUI behind `await import(...)`, but a
// bundler config with splitting off inlines it and hoists `import "ink"` /
// `import "react"` to the top of dist/cli.js, so `mu --version` and every
// verb evaluated ink, react, yoga, and es-toolkit (748 modules vs 201).
//
// dist/cli.js is the src/main.ts bootstrap; the CLI proper is a cli-*.js
// chunk it dynamically imports.
//
// Builds the real tsup.config.ts into a temp dir (no .d.ts, no sourcemap),
// then walks dist/cli.js's static import graph.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { isBuiltin } from "node:module";
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
    // Lets the built dist resolve its external deps (better-sqlite3, ink, ...).
    // Link only after the builds: tsup's `clean` globs the out dir and would
    // delete the files inside a symlinked node_modules.
    symlinkSync(join(__dirname, "..", "node_modules"), join(out, "node_modules"), "dir");
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

  it("the TUI is emitted as its own chunk, with ink and react bundled into it", () => {
    const tui = readdirSync(out).find((f) => /^tui-.*\.js$/.test(f));
    expect(tui).toBeDefined();
    if (tui === undefined) return;
    const src = readFileSync(join(out, tui), "utf8");
    // Bundled: ~560 node_modules ESM files otherwise resolve and compile per launch.
    expect(staticImports(src).filter((s) => TUI_PACKAGES.includes(s))).toEqual([]);
    // react's dev/prod build stays a runtime choice (src/cli/tui-load.ts
    // sets NODE_ENV): a `define` of NODE_ENV would fold these away.
    expect(src).toContain("process.env.NODE_ENV");
    const chunks = readdirSync(out).filter((f) => f.endsWith(".js"));
    const importers = chunks.filter((f) =>
      readFileSync(join(out, f), "utf8").includes(`import("./${tui}")`),
    );
    expect(importers.length).toBeGreaterThan(0);
  });

  it("the bin bootstrap statically loads only builtins before the CLI", () => {
    // src/main.ts must enable the compile cache before the CLI graph
    // loads, so its static graph holds no third-party packages.
    const bare = new Set<string>();
    const seen = new Set<string>();
    const queue = ["cli.js"];
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of staticImports(readFileSync(join(out, file), "utf8"))) {
        if (spec.startsWith("./")) queue.push(spec.slice(2));
        else bare.add(spec);
      }
    }
    expect([...bare].filter((b) => !isBuiltin(b))).toEqual([]);
    expect(readFileSync(join(out, "cli.js"), "utf8")).toMatch(
      /await import\("\.\/cli-[^"]+\.js"\)/,
    );
  });

  it("dist/extension/mu-pi.js is standalone (imports no sibling chunks)", () => {
    const src = readFileSync(join(out, "extension", "mu-pi.js"), "utf8");
    expect(staticImports(src).filter((s) => s.startsWith("."))).toEqual([]);
  });

  // Run the built dist with a loader hook that logs every module specifier
  // it resolves, so we can see what actually loaded.
  const HOOK = `data:text/javascript,${encodeURIComponent(`
    import { appendFileSync } from "node:fs";
    export async function resolve(spec, ctx, next) {
      appendFileSync(process.env.MU_RESOLVE_LOG, spec + "\\n");
      return next(spec, ctx);
    }`)}`;
  const PRELOAD = `data:text/javascript,${encodeURIComponent(
    `import { register } from "node:module"; register(${JSON.stringify(HOOK)});`,
  )}`;

  function runDist(args: string[], env: NodeJS.ProcessEnv = {}) {
    const log = join(out, `resolve-${Math.random().toString(36).slice(2)}.log`);
    const r = spawnSync(process.execPath, ["--import", PRELOAD, join(out, "cli.js"), ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: out,
        MU_DB_PATH: join(out, "smoke.db"),
        MU_SYNC_DIR: "",
        MU_RESOLVE_LOG: log,
        ...env,
      },
    });
    let resolved: string[] = [];
    try {
      resolved = readFileSync(log, "utf8").split("\n").filter(Boolean);
    } catch {}
    return { ...r, resolved };
  }

  it("the bundled CJS deps are inlined: no bare import or runtime resolve of them", () => {
    const BUNDLED = ["commander", "cli-table3", "string-width", "picocolors"];
    for (const f of readdirSync(out).filter((n) => n.endsWith(".js"))) {
      const bare = staticImports(readFileSync(join(out, f), "utf8"));
      expect(
        bare.filter((s) => BUNDLED.includes(s)),
        f,
      ).toEqual([]);
    }
    const r = runDist(["sql", "SELECT 1 AS result"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.resolved.filter((s) => BUNDLED.some((b) => s === b || s.startsWith(`${b}/`)))).toEqual(
      [],
    );
  });

  it("the CJS require path works in the built dist (cli-table3 colors its borders)", () => {
    // cli-table3 (CJS) loads @colors/colors via a dynamic require; without
    // the createRequire banner it silently drops border colors, so exit 0
    // and plain output would hide the break.
    const r = runDist(["sql", "SELECT 1 AS result"], { FORCE_COLOR: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("result");
    // The grey table border (SGR 90) comes from @colors/colors, loaded by
    // cli-table3 through the dynamic require; the bold header is picocolors.
    expect(r.stdout).toContain("\x1b[90m");
  });

  it("`mu --version` runs from the built dist without loading ink or react", () => {
    const r = runDist(["--version"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).not.toBe("");
    expect(r.resolved.length).toBeGreaterThan(0); // the hook saw the load
    expect(r.resolved.filter((s) => ["ink", "react", "yoga-layout"].includes(s))).toEqual([]);
  });

  it("the bundled TUI chunk evaluates without resolving ink or react", () => {
    const tui = readdirSync(out).find((f) => /^tui-.*\.js$/.test(f));
    expect(tui).toBeDefined();
    if (tui === undefined) return;
    // Evaluating the chunk runs the createRequire banner and the bundled
    // CJS react/reconciler; a missing shim throws "Dynamic require".
    const script = `const m = await import(${JSON.stringify(`./${tui}`)}); if (typeof m.runTui !== "function") process.exit(3);`;
    const log = join(out, "tui-resolve.log");
    const r = spawnSync(
      process.execPath,
      ["--import", PRELOAD, "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        cwd: out,
        env: { PATH: process.env.PATH, HOME: out, MU_RESOLVE_LOG: log },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const resolved = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.filter((s) => ["ink", "react", "yoga-layout"].includes(s))).toEqual([]);
  });
});
