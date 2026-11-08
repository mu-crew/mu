// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The pane runner's crash-and-replace step and the pi AUT's two phases, with the outside world
// (mu, murmur, tmux, signals, the rpc runner) replaced: no tmux, no harness, no sleeps.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runPiAut } from "../../tools/eval/commands.ts";
import type { runAut } from "../../tools/eval/runner.ts";
import {
  type PaneIO,
  type PaneView,
  runPaneAut,
  sandboxRefusal,
  trustDialogKeys,
} from "../../tools/eval/runner-pane.ts";
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

describe("ready to prompt", () => {
  /** murmur reports the AUT's session from the `sessionAfter`th view on; the views seen at the send. */
  function readyWorld(sessionAfter: number) {
    let views = 0;
    let atSend = -1;
    const io: PaneIO = {
      ...world(() => false).io,
      async orchestrate() {
        return { pane: "%1", r: ok };
      },
      view() {
        views++;
        return { ...idle, sessionId: views > sessionAfter ? "s" : null };
      },
      async mu(_sb, args) {
        if (args[1] === "send" && atSend < 0) atSend = views;
        return ok;
      },
      // the pane is gone after the send: the run ends there
      pid: () => null,
    };
    return { io, atSend: () => atSend };
  }
  const noReplacement = (): Scenario => ({ ...scenario(), replacement: undefined }) as Scenario;

  it("cursor-agent and claude: sent once the session they report at launch is seen", async () => {
    for (const harness of ["cursor-agent", "claude"] as const) {
      const w = readyWorld(20);
      await runPaneAut(sandbox(), noReplacement(), { harness, quietMs: 0 }, w.io);
      expect(w.atSend(), harness).toBe(21);
    }
  });
  it("Muse and codex report a session only with their first prompt: sent once no dialog is up", async () => {
    for (const harness of ["muse", "codex"] as const) {
      const w = readyWorld(1000);
      await runPaneAut(sandbox(), noReplacement(), { harness, quietMs: 0 }, w.io);
      expect(w.atSend(), harness).toBe(9);
    }
  });
});

describe("a pane AUT's own sandbox refusing a command", () => {
  const settled = (scrollback: string): PaneIO => ({
    ...world(() => false).io,
    view: () => idle,
    scrollback: () => scrollback,
  });
  const noReplacement = (): Scenario => ({ ...scenario(), replacement: undefined }) as Scenario;

  it("is the run's lastError, marked as the environment's", async () => {
    const io = settled(
      "$ mu task list -w eval\nsandbox-exec: sandbox_apply: Operation not permitted\n> ",
    );
    const m = await runPaneAut(
      sandbox(),
      noReplacement(),
      { harness: "cursor-agent", quietMs: 0 },
      io,
    );
    expect(m.lastError).toMatch(/^environment: .*sandbox_apply: Operation not permitted/);
  });
  it("leaves a clean pane's run alone", async () => {
    const m = await runPaneAut(
      sandbox(),
      noReplacement(),
      { harness: "muse", quietMs: 0 },
      settled("$ mu task list -w eval\nd1 OPEN\n"),
    );
    expect(m.lastError).toBeNull();
  });
  it("names cursor-agent's sandbox-exec failure and a denied DB write", () => {
    expect(sandboxRefusal("x\n  Failed to execute sandbox-exec: 1\n")).toBe(
      "Failed to execute sandbox-exec: 1",
    );
    expect(sandboxRefusal("Error: attempt to write a readonly database")).not.toBeNull();
    expect(sandboxRefusal("all good")).toBeNull();
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

  it("a live hook-harness case runs pi without a token cap, like a claude or codex AUT", async () => {
    calls.length = 0;
    const hooked = { ...scenario(), replacement: undefined, hookHarnesses: { workers: ["codex"] } };
    await runPiAut(sandbox(), one(hooked as Scenario, true), fakeRun);
    expect(calls[0]?.opts.tokenCap).toBe(Number.POSITIVE_INFINITY);
    calls.length = 0;
    await runPiAut(sandbox(), one(hooked as Scenario, false), fakeRun);
    expect(calls[0]?.opts.tokenCap).toBeUndefined();
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

describe("trustDialogKeys", () => {
  it("moves off Claude Code's default 'No, exit' when the folder pre-approves tools", () => {
    const screen = [
      " Accessing workspace:",
      " Quick safety check: Is this a project you created or one you trust?",
      " ⚠ This folder pre-approves 10 tool permissions in .claude/settings.json:",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(trustDialogKeys(screen)).toEqual(["Down", "Enter"]);
  });
  it("takes the default when it already trusts", () => {
    expect(trustDialogKeys(" ❯ 1. Yes, I trust this folder\n   2. No, exit")).toEqual(["Enter"]);
  });
  it("trusts codex's hooks instead of opening the review", () => {
    const screen = [
      "  Hooks need review",
      "  14 hooks are new or changed.",
      "  Hooks can run outside the sandbox after you trust them.",
      "› 1. Review hooks",
      "  2. Trust all and continue",
      "  3. Continue without trusting (hooks won't run)",
      "  enter confirm · esc skip",
    ].join("\n");
    expect(trustDialogKeys(screen)).toEqual(["Down", "Enter"]);
  });
  it("takes a codex launcher's folder 'Trust and continue'", () => {
    const screen =
      "  trust these files. Your trust decision will be saved.\n› 1. Trust and continue\n  2. Back to the launcher\n  enter continue · esc back";
    expect(trustDialogKeys(screen)).toEqual(["Enter"]);
  });
  it("takes codex's folder 'Yes, continue'", () => {
    const screen = "  Do you trust the files in this folder?\n› 1. Yes, continue\n  2. No, quit";
    expect(trustDialogKeys(screen)).toEqual(["Enter"]);
  });
  it("sends nothing without a trust dialog, or with trust text but no selector", () => {
    expect(trustDialogKeys("> ready")).toBeNull();
    expect(trustDialogKeys("I trust you will merge it")).toBeNull();
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
