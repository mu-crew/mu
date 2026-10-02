import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    // The mu pi extension: pi loads dist/extension/mu-pi.js standalone.
    "extension/mu-pi": "extension/mu-pi.ts",
  },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts" } }, // .d.ts only for the SDK entry, not the CLI
  clean: true,
  target: "node20",
  splitting: false,
  sourcemap: true,
  outDir: "dist",
  // Preserve the #!/usr/bin/env node shebang at the top of cli.ts so
  // dist/cli.js is directly executable (referenced by the bin field in
  // package.json).
  shims: false,
  // The extension reports the mu version it was built from (hello's
  // extVersion), so doctor can flag a pi that loaded an older build.
  define: { __MU_VERSION__: JSON.stringify(version) },
});
