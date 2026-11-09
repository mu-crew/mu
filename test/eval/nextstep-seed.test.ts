// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// A seed spelled in base grammar that fails on a surface (a variant that changed a base spelling)
// gives an invalid row, scored like a failed lead-in; it never throws out of the round.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Surface } from "../../tools/eval/types.ts";

const closed = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../tools/eval/sandbox.ts", async (orig) => ({
  ...(await orig<typeof import("../../tools/eval/sandbox.ts")>()),
  createSandbox: async () => ({
    dir: "/nonexistent",
    env: {},
    binDir: "/nonexistent/bin",
    repoDir: "/nonexistent/repo",
    workerDir: "/nonexistent/workers",
    tmuxSocket: "/nonexistent/sock",
    dbPath: "/nonexistent/mu.db",
    surface: { name: "stub", root: "/nonexistent", cli: "", extension: "", skillDir: "" },
    close: async () => {
      closed.n++;
    },
  }),
}));

const { playCase } = await import("../../tools/eval/nextstep.ts");
const { NEXT_CASES } = await import("../../tools/eval/nextstep-cases.ts");

let tmp = "";
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function surface(): Surface {
  tmp = mkdtempSync(join(tmpdir(), "mu-seed-"));
  mkdirSync(join(tmp, "dist"), { recursive: true });
  writeFileSync(join(tmp, "dist", "cli.js"), "");
  return { name: "v", root: tmp, cli: join(tmp, "dist", "cli.js"), extension: "", skillDir: "" };
}

describe("playCase seed failure", () => {
  it("a seed that throws gives an invalid row without asking the model", async () => {
    const base = NEXT_CASES.find((c) => c.id === "close_preview_apply");
    if (!base) throw new Error("no case");
    const c = {
      ...base,
      seed: async () => {
        throw new Error("seed: no revision in {}");
      },
    };
    let asked = 0;
    const row = await playCase(c, {
      surface: surface(),
      surfaceLabel: "v1",
      arm: "none",
      paraphrase: base.paraphrases[0]?.id ?? "p1",
      reply: async () => {
        asked++;
        return { text: "", tokens: 0 };
      },
      promptDir: join(tmp, "prompts"),
      gapMs: 0,
    });
    expect(row.invalid).toBe(true);
    expect(row.hit).toBe(false);
    expect(row.why).toEqual(["seed invalid: seed: no revision in {}"]);
    expect(asked).toBe(0);
    expect(closed.n).toBe(1);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
