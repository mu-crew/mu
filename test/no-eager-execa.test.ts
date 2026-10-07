// Guards f_eager_execa: execa pulls in ~110 modules, so a static import
// anywhere in src/ puts it on every CLI startup (--version, DB-only
// verbs). Load it with `await import("execa")` at the call site instead.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("execa stays off the startup path", () => {
  it("no src/ module imports execa statically", () => {
    const offenders = tsFiles(join(__dirname, "..", "src")).filter((f) =>
      /^\s*import\s[^;]*from\s+["']execa["']/m.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
