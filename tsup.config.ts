import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

// The extension reports the mu version it was built from (hello's
// extVersion), so doctor can flag a pi that loaded an older build.
const define = { __MU_VERSION__: JSON.stringify(version) };

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      // dist/cli.js is the bin: src/main.ts enables the compile cache,
      // then dynamically imports src/cli.ts (its own chunk).
      cli: "src/main.ts",
    },
    format: ["esm"],
    dts: { entry: { index: "src/index.ts" } }, // .d.ts only for the SDK entry, not the CLI
    // dist/extension/ belongs to the second config; both build in parallel.
    clean: ["!extension/**"],
    target: "node20",
    // Splitting keeps dynamic imports lazy: the ink TUI lands in its own
    // tui-*.js chunk. Without it, tsup inlines the TUI and hoists its
    // `import "ink"` / `import "react"` to static top-level imports of
    // cli.js, so every verb evaluated ink, react, and yoga.
    splitting: true,
    sourcemap: true,
    outDir: "dist",
    // Preserve the #!/usr/bin/env node shebang at the top of main.ts so
    // dist/cli.js is directly executable (referenced by the bin field in
    // package.json).
    shims: false,
    define,
  },
  {
    // The mu pi extension: pi loads dist/extension/mu-pi.js standalone, so
    // it must not share chunks with the CLI (a separate build guarantees it).
    entry: { "mu-pi": "extension/mu-pi.ts" },
    format: ["esm"],
    clean: true,
    target: "node20",
    splitting: false,
    sourcemap: true,
    outDir: "dist/extension",
    shims: false,
    define,
  },
]);
