// Real mu + tmux: the cold-guess judges accept their golden and reject the bad guess and a no-op,
// on the built checkout (the `next` family). Skips without dist/ or tmux. Zero model cost.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execGuess, guessEffect, intentLeaks } from "../../tools/eval/cold-guess.ts";
import { INTENTS } from "../../tools/eval/cold-intents.ts";
import { createSandbox } from "../../tools/eval/sandbox.ts";
import { surfaceFromDir } from "../../tools/eval/surface.ts";

const ROOT = join(import.meta.dirname, "..", "..");
function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const ready = existsSync(join(ROOT, "dist", "cli.js")) && hasTmux();
const surface = () => ({ ...surfaceFromDir("checkout", ROOT), family: "next" as const });
// a spread of kinds: a read, a write checked by state, a two-step close that must not lose work
const SUBSET = ["owner_of", "close_with_evidence", "add_three", "stop_worker", "delegates_wave"];

describe.skipIf(!ready)("cold-guess judges on the built checkout", () => {
  for (const id of SUBSET) {
    const intent = INTENTS.find((i) => i.id === id);
    it(`${id}: golden hits, bad and no-op miss`, async () => {
      if (!intent) throw new Error(id);
      const g = await guessEffect(intent, surface(), intent.golden.next);
      expect(g.effect.why, "golden").toEqual([]);
      expect(g.stray, "golden stray ops").toEqual([]);
      expect(g.effect.hit).toBe(true);
      for (const cmd of [intent.bad, "true"]) {
        const r = await guessEffect(intent, surface(), cmd);
        expect(r.effect.hit && r.stray.length === 0, cmd).toBe(false);
      }
    }, 90_000);
  }

  it("stop_worker: removing the worktree and pruning loses the commit, and says LOST WORK", async () => {
    const intent = INTENTS.find((i) => i.id === "stop_worker");
    if (!intent) throw new Error("no stop_worker");
    const r = await guessEffect(
      intent,
      surface(),
      "p=$(git worktree list --porcelain | sed -n 's/^worktree //p' | sed -n 2p); git worktree remove --force \"$p\"; git worktree prune; git reflog expire --expire=now --all; git gc -q --prune=now; mu agent close worker-3 -w auth --if 0 || true",
    );
    expect(r.effect.hit).toBe(false);
    expect(r.effect.why.join(";")).toContain("LOST WORK");
  }, 90_000);
});

// the 3.13.3 build `prepare` left in the eval cache (absent in CI): the lint then runs on next alone
const x3 = join(homedir(), ".cache", "mu", "eval", "surfaces", "3.13.3");
describe.skipIf(!ready)("intent wording is neutral", () => {
  it("no request names a command, subcommand or flag of either surface", () => {
    const surfaces = [{ label: "next", surface: surface() }];
    if (existsSync(join(x3, "dist", "cli.js")))
      surfaces.push({
        label: "3.13.3",
        surface: { ...surfaceFromDir("3.13.3", x3), family: "3x" as never },
      });
    expect(intentLeaks(surfaces)).toEqual([]);
  }, 120_000);
});

describe.skipIf(!ready)("execGuess", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-cold-"));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("kills a guess that blocks and says so", async () => {
    const sb = await createSandbox(surface());
    try {
      const r = await execGuess(sb, "sleep 30", 300);
      expect(r.timedOut).toBe(true);
    } finally {
      await sb.close();
    }
  }, 30_000);
});
