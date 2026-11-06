// The pane runner's crash-and-replace step and the pi AUT's two phases, with the outside world
// (mu, murmur, tmux, signals, the rpc runner) replaced: no tmux, no harness, no sleeps.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runPiAut } from "../../tools/eval/commands.ts";
import type { runAut } from "../../tools/eval/runner.ts";
import { type PaneIO, type PaneView, runPaneAut } from "../../tools/eval/runner-pane.ts";
import type { ExecResult } from "../../tools/eval/sandbox.ts";
import type { Sandbox, Scenario, Surface } from "../../tools/eval/types.ts";
import { emptyRun } from "./_judge-sandbox.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const surface: Surface = {
  name: "s",
  root: "/s",
  cli: "/s/dist/cli.js",
  extension: "/s/e.js",
  skillDir: "/s/skills/mu",
};

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "runner-pane-"));
  dirs.push(dir);
  const workerDir = join(dir, "workers");
  mkdirSync(workerDir);
  return {
    dir,
    env: {},
    binDir: join(dir, "bin"),
    repoDir: join(dir, "repo"),
    workerDir,
    tmuxSocket: "t",
    dbPath: join(dir, "mu.db"),
    surface,
    close: async () => {},
  };
}

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };
const idle: PaneView = {
  activity: "stopped",
  state: "idle",
  runCount: 1,
  lastText: "done",
  sessionId: "s",
};

interface World {
  io: PaneIO;
  started: string[];
  sends: { name: string; text: string }[];
  kills: number[];
}

/**
 * Pane %1 is `aut` (pid 100), %2 is `aut-2` (pid 200). `dies(tick)` says when aut's process is
 * gone; aut-2 runs a turn, then stops.
 */
function world(dies: (tick: number) => boolean): World {
  const w: World = { io: {} as PaneIO, started: [], sends: [], kills: [] };
  let tick = 0;
  let views2 = 0;
  w.io = {
    async orchestrate(_sb, _ws, name) {
      w.started.push(name);
      return { pane: name === "aut" ? "%1" : "%2", r: ok };
    },
    async mu(_sb, args) {
      if (args[0] === "agent" && args[1] === "send")
        w.sends.push({ name: args[2] ?? "", text: args[5] ?? "" });
      return ok;
    },
    view(_sb, pane) {
      if (pane === "%1") return { ...idle, activity: "running" };
      views2++;
      return views2 === 1 ? idle : views2 <= 3 ? { ...idle, activity: "running" } : idle;
    },
    pid(_sb, pane) {
      if (pane === "%2") return 200;
      tick++;
      return dies(tick) ? null : 100;
    },
    capture: () => "",
    keys: () => {},
    kill: (t) => {
      w.kills.push(t);
    },
    mtime: () => 0,
    sleep: async () => {},
  };
  return w;
}

const REPLACEMENT = "take over";

function scenario(o: { crashWhen?: () => Promise<boolean> } = {}): Scenario {
  return {
    id: "x",
    title: "x",
    prompt: "first",
    replacement: { prompt: REPLACEMENT, ...(o.crashWhen ? { crashWhen: o.crashWhen } : {}) },
    setup: async () => {},
    judge: async () => ({ completed: true, wrong: [], destructive: [], notes: [] }),
  } as Scenario;
}

describe("the pane runner's replacement", () => {
  it("when the AUT's pane dies, aut-2 is orchestrated and gets the replacement prompt", async () => {
    const w = world((t) => t > 3);
    const m = await runPaneAut(sandbox(), scenario(), { harness: "claude", quietMs: 0 }, w.io);
    expect(w.started).toEqual(["aut", "aut-2"]);
    expect(w.sends).toEqual([
      { name: "aut", text: "first" },
      { name: "aut-2", text: REPLACEMENT },
    ]);
    expect(w.kills).toEqual([]);
    expect(m.events.filter((e) => e.kind === "prompt").map((e) => e.text)).toEqual([
      "first",
      REPLACEMENT,
    ]);
    expect(m.aborted).toBeNull();
    expect(m.turns).toBe(1);
  });

  it("a live run kills the AUT's process group when crashWhen holds, then replaces it", async () => {
    const w = world(() => false);
    let polls = 0;
    const sc = scenario({ crashWhen: async () => ++polls >= 3 });
    await runPaneAut(sandbox(), sc, { harness: "codex", quietMs: 0, live: true }, w.io);
    expect(w.kills).toEqual([-100, 100]);
    expect(w.started).toEqual(["aut", "aut-2"]);
    expect(w.sends.at(-1)).toEqual({ name: "aut-2", text: REPLACEMENT });
  });

  it("a fake run never kills on crashWhen: only the AUT's own {die} replaces it", async () => {
    const w = world((t) => t > 5);
    const sc = scenario({ crashWhen: async () => true });
    await runPaneAut(sandbox(), sc, { harness: "claude", quietMs: 0 }, w.io);
    expect(w.kills).toEqual([]);
    expect(w.started).toEqual(["aut", "aut-2"]);
  });

  it("without a replacement a dead pane ends the run as exit", async () => {
    const w = world((t) => t > 2);
    const sc = { ...scenario(), replacement: undefined } as Scenario;
    const m = await runPaneAut(sandbox(), sc, { harness: "claude", quietMs: 0 }, w.io);
    expect(w.started).toEqual(["aut"]);
    expect(m.aborted).toBe("exit");
  });
});

describe("the pi AUT's phases", () => {
  const calls: { prompt: string; opts: Parameters<typeof runAut>[2] }[] = [];
  const fakeRun: typeof runAut = async (_sb, sc, opts) => {
    calls.push({ prompt: sc.prompt, opts });
    return { ...emptyRun(), turns: 1 };
  };
  const one = (sc: Scenario, live: boolean) => ({
    surface,
    scenario: sc,
    model: "m",
    providerExt: "/p.ts",
    rep: 1,
    live,
  });

  it("a replacement case runs phase 1 unprodded, then phase 2 on the replacement prompt", async () => {
    calls.length = 0;
    const m = await runPiAut(sandbox(), one(scenario(), false), fakeRun);
    expect(calls.map((c) => c.prompt)).toEqual(["first", REPLACEMENT]);
    expect(calls[0]?.opts.maxProds).toBe(0);
    expect(calls[0]?.opts.stopWhen).toBeUndefined();
    expect(calls[0]?.opts.env).toBeUndefined();
    expect(calls[1]?.opts.env).toEqual({ EVAL_FAUX_PHASE: "2" });
    expect(m.turns).toBe(2);
  });

  it("live, phase 1 stops on crashWhen", async () => {
    calls.length = 0;
    let asked = 0;
    const sc = scenario({
      crashWhen: async () => {
        asked++;
        return true;
      },
    });
    await runPiAut(sandbox(), one(sc, true), fakeRun);
    expect(await calls[0]?.opts.stopWhen?.()).toBe(true);
    expect(asked).toBe(1);
  });

  it("no replacement: one run", async () => {
    calls.length = 0;
    await runPiAut(
      sandbox(),
      one({ ...scenario(), replacement: undefined } as Scenario, false),
      fakeRun,
    );
    expect(calls).toHaveLength(1);
  });
});
