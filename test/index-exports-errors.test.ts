// Every typed error the CLI maps to an exit code is part of the SDK
// surface: an SDK caller must be able to `instanceof` what mu throws.
// Errors defined inside src/cli/ are CLI-only; herdr's live on the `mux`
// namespace export.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ONLY = new Set(["CommanderError", "UsageError", "CliExitError", "NameAmbiguousError"]);

describe("src/index.ts error exports", () => {
  it("exports every error class src/cli/handle.ts classifies", () => {
    const handle = readFileSync(join(root, "src", "cli", "handle.ts"), "utf8");
    const names = [
      ...new Set([...handle.matchAll(/instanceof ([A-Z][A-Za-z]*Error)\b/g)].map((m) => m[1])),
    ].filter((n): n is string => n !== undefined && !CLI_ONLY.has(n));
    expect(names.length).toBeGreaterThan(30);
    const exported = sdk as Record<string, unknown>;
    const mux = sdk.mux as Record<string, unknown>;
    const missing = names.filter(
      (n) => typeof exported[n] !== "function" && typeof mux[n] !== "function",
    );
    expect(missing).toEqual([]);
  });
});
