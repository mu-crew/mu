// Real pi (faux model) + real processes: runAut must clean up on every path.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAut } from "../../tools/eval/runner.ts";
import { createSandbox, FAUX_EXT, REAL_PI, tmuxSocketPath } from "../../tools/eval/sandbox.ts";
import { surfaceFromDir } from "../../tools/eval/surface.ts";
import type { Sandbox, Scenario } from "../../tools/eval/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const ready = existsSync(join(ROOT, "dist", "cli.js")) && REAL_PI !== "pi";

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) [ZX]/.test(stat);
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

function scenario(judge: Scenario["judge"]): Scenario {
  return { id: "t", title: "t", prompt: "go", quietMs: 0, async setup() {}, judge };
}

describe.skipIf(!ready)("runAut cleanup", () => {
  let sb: Sandbox | undefined;
  let scriptDir = "";
  afterEach(async () => {
    try {
      await sb?.close();
    } catch {}
    sb = undefined;
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    scriptDir = "";
  });

  async function setup(script: unknown): Promise<string> {
    scriptDir = mkdtempSync(join(tmpdir(), "mu-eval-rt-"));
    const path = join(scriptDir, "aut.json");
    writeFileSync(path, JSON.stringify(script));
    sb = await createSandbox(surfaceFromDir("checkout", ROOT));
    return path;
  }

  it("a throwing judge rejects runAut's promise, so the caller's finally cleans the sandbox", async () => {
    const auTScript = await setup([{ text: "done" }]);
    const dir = (sb as Sandbox).dir;
    const sock = tmuxSocketPath(dir, (sb as Sandbox).tmuxSocket);
    let caught: unknown;
    let finallyRan = false;
    try {
      await runAut(
        sb as Sandbox,
        scenario(async () => {
          throw new Error("judge DB read failed");
        }),
        { model: "evalfaux/aut", providerExt: FAUX_EXT, auTScript, timeoutMs: 60_000, quietMs: 0 },
      );
    } catch (e) {
      caught = e;
    } finally {
      finallyRan = true;
      await (sb as Sandbox).close();
    }
    expect(finallyRan).toBe(true);
    expect((caught as Error | undefined)?.message).toBe("judge DB read failed");
    expect(existsSync(dir)).toBe(false);
    expect(() => execFileSync("tmux", ["-S", sock, "ls"], { stdio: "ignore" })).toThrow();
    sb = undefined;
  }, 90_000);

  it("pi exiting on its own while a tool runs leaves no tool process behind", async () => {
    const auTScript = await setup([
      {
        calls: [
          { bash: 'sleep 600 & echo $! > "$EVAL_WORKER_DIR/orphan.pid"; kill -9 "$PPID"; wait' },
        ],
      },
    ]);
    const pidFile = join((sb as Sandbox).workerDir, "orphan.pid");
    let pid = 0;
    try {
      const m = await runAut(
        sb as Sandbox,
        scenario(async () => ({ completed: false, wrong: [], destructive: [], notes: [] })),
        { model: "evalfaux/aut", providerExt: FAUX_EXT, auTScript, timeoutMs: 60_000 },
      );
      pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(m.aborted).toBe("exit");
      expect(pid).toBeGreaterThan(1);
      expect(await waitDead(pid)).toBe(true);
    } finally {
      if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 90_000);
});
