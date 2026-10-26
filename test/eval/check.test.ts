import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PENDING_NEXT, pendingScripts } from "../../tools/eval/check-rules.ts";
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

describe("pending next scenarios", () => {
  const dir = join(import.meta.dirname, "../../tools/eval/scenarios");

  it("every pending scenario has a golden and three distinct bads, and no live next script", () => {
    // Empty once a unit has flipped them all (v_wait_surface did); the checks bind whatever is listed.
    for (const id of PENDING_NEXT) {
      const files = pendingScripts(dir, id);
      const golden = files.filter((f) => f.startsWith(`${id}.golden`));
      const bads = files.filter((f) => f.startsWith(`${id}.bad`));
      expect(golden, id).toHaveLength(1);
      expect(bads.length, id).toBeGreaterThanOrEqual(3);
      const bodies = bads.map((f) =>
        JSON.stringify(JSON.parse(readFileSync(join(dir, f), "utf8"))),
      );
      expect(new Set(bodies).size, `${id}: distinct bads`).toBe(bads.length);
      expect(existsSync(join(dir, `${id}.golden.next.json`)), id).toBe(false);
      expect(existsSync(join(dir, `${id}.bad.next.json`)), id).toBe(false);
      expect(existsSync(join(dir, `${id}.golden.3x.json`)), `${id}: 3x proof untouched`).toBe(true);
    }
  });

  it("a pending script file belongs to a listed scenario (a flip removes the id with the file)", () => {
    const ids = new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith(".next.pending.json"))
        .map((f) => f.split(".")[0] ?? ""),
    );
    expect([...ids].sort()).toEqual([...PENDING_NEXT].sort());
  });

  it.each(PENDING_NEXT)("%s: pending scripts are valid faux steps", (id) => {
    for (const f of pendingScripts(dir, id)) {
      const steps = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
      expect(Array.isArray(steps), f).toBe(true);
      for (const s of steps as Record<string, unknown>[])
        expect(
          ["calls", "text", "error", "die", "textFromLastResult"].some((k) => k in s),
          f,
        ).toBe(true);
    }
  });

  it("check --family next skips a listed pending scenario", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    // The list is empty now: list one for this test only (it is a plain array at runtime).
    const list = PENDING_NEXT as string[];
    list.push("wait_wave_six");
    try {
      const code = await runCheck({
        surface,
        scenarios: ["wait_wave_six"],
        includeUnderscore: false,
        family: "next",
        preflight: false,
        verbose: false,
        root: "/s",
      });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("wait_wave_six pending: skipped");
    } finally {
      list.pop();
    }
  });

  it("the four wait scenarios are live: no pending file is left for them", () => {
    for (const id of [
      "wait_interrupted",
      "wait_mixed_refs",
      "wait_wave_six",
      "wait_wave_starvation",
    ]) {
      expect(pendingScripts(dir, id), id).toEqual([]);
      expect(existsSync(join(dir, `${id}.golden.next.json`)), id).toBe(true);
    }
  });
});
