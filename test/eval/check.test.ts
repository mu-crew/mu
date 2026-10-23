import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../../tools/eval/commands.ts";
import type { Surface } from "../../tools/eval/types.ts";

const surface: Surface = {
  name: "s",
  root: "/s",
  cli: "/s/dist/cli.js",
  extension: "/s/dist/extension/mu-pi.js",
  skillDir: "/s/skills/mu",
};

afterEach(() => vi.restoreAllMocks());

describe("runCheck missing scripts", () => {
  it.each(["3x", "next"] as const)(
    "a missing golden AND bad script fails the check (%s)",
    async (family) => {
      const dir = mkdtempSync(join(tmpdir(), "mu-eval-check-test-"));
      const out: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        out.push(a.join(" "));
      });
      try {
        const code = await runCheck({
          surface,
          scenarios: ["_smoke"],
          includeUnderscore: true,
          family,
          preflight: false,
          verbose: false,
          root: "/s",
          scriptDir: dir,
        });
        const text = out.join("\n");
        expect(code).toBe(1);
        expect(text).toContain("_smoke golden missing");
        expect(text).toContain("_smoke bad missing");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
