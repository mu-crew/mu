// Guard for the TUI sync worker's packaging. src/cli/tui/state.ts loads
// `./tui-sync-worker.js` next to its bundle and silently falls back to
// in-process sync (ink's thread, the freeze it exists to fix) when the
// file is absent, so nothing else fails if tsup stops emitting the entry
// or the package stops shipping dist/. The worker path itself is driven
// in test/tui-sync-worker.integration.test.ts.

import { readFileSync } from "node:fs";
import type { Options } from "tsup";
import { describe, expect, it } from "vitest";
import config from "../tsup.config.js";

describe("TUI sync worker packaging", () => {
  it("tsup emits the tui-sync-worker entry next to dist/cli.js", () => {
    const configs = (Array.isArray(config) ? config : [config]) as Options[];
    const cli = configs.find((c) => (c.outDir ?? "dist") === "dist");
    expect(cli?.entry).toMatchObject({ "tui-sync-worker": "src/cli/tui/sync-worker.ts" });
    expect(cli?.entry).toMatchObject({ cli: "src/main.ts" });
  });

  it("state.ts looks for the file the entry produces", () => {
    const src = readFileSync("src/cli/tui/state.ts", "utf8");
    expect(src).toContain('new URL("./tui-sync-worker.js", import.meta.url)');
  });

  it("the npm package ships dist/", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files?: string[] };
    expect(pkg.files).toContain("dist");
  });
});
