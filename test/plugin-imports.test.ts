// A plugin can only report facts (plugins spec Principle 2, D13): the
// adapter is the only code that talks to a plugin, only the process manager
// starts one, and inside src/plugins/ only the registration store touches
// the DB (the plugins row). What a plugin answers reaches mu's state only
// through mu's own writes.

import { describe, expect, it } from "vitest";
import { all, bindingsFrom } from "./_imports.js";

const inPlugins = (file: string): boolean => file.startsWith("src/plugins/");

describe("the plugin adapter's boundary", () => {
  it("only src/plugins/process.ts starts a process inside src/plugins/", () => {
    const out = all()
      .filter(([file, text]) => inPlugins(file) && /node:child_process/.test(text))
      .map(([file]) => file);
    expect(out).toEqual(["src/plugins/process.ts"]);
  });

  it("only src/plugins/registry.ts touches the DB inside src/plugins/", () => {
    const out = all()
      .filter(
        ([file, text]) => inPlugins(file) && /\.prepare\(|\bdb\.exec\(|\.transaction\(/.test(text),
      )
      .map(([file]) => file);
    expect(out).toEqual(["src/plugins/registry.ts"]);
  });

  it("outside src/plugins/, the process and client are never imported; the rest only by the wiring", () => {
    const allowed: Record<string, readonly string[]> = {
      "src/plugins/errors.ts": ["src/hosts.ts", "src/index.ts", "src/cli/handle.ts"],
      "src/plugins/registry.ts": ["src/cli/handle.ts", "src/cli/plugin.ts"],
      "src/plugins/link.ts": ["src/host-provider.ts"],
      "src/plugins/process.ts": [],
      "src/plugins/client.ts": [],
      "src/plugins/protocol.ts": [],
    };
    const out: string[] = [];
    const seen: string[] = [];
    for (const [file, text] of all()) {
      if (inPlugins(file)) continue;
      for (const [target, ok] of Object.entries(allowed)) {
        const b = bindingsFrom(file, text, target);
        if (b !== "namespace" && b.length === 0) continue;
        if (ok.includes(file)) seen.push(`${file} -> ${target}`);
        else out.push(`${file} -> ${target}`);
      }
    }
    expect(out).toEqual([]);
    // Each allowance is used: the scan sees the imports it permits.
    const permitted = Object.entries(allowed).flatMap(([t, files]) =>
      files.map((f) => `${f} -> ${t}`),
    );
    expect(seen.sort()).toEqual(permitted.sort());
  });
});
