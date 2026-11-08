// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { autCommand, checkHarnesses, isLiveRun, mergeMetrics } from "../../tools/eval/commands.ts";
import {
  AUT_FLAGS,
  AUT_PROJECT_SKILL,
  autSkill,
  CLAUDE_ALLOW,
  HOST_HOME_LINKS,
  type HookPaths,
  type HookTools,
  hookDoc,
  hookEntries,
  installCodexGlobal,
  linkHostHome,
  MURMUR_EVENTS,
  makeCodexHome,
  murmurShim,
  muzzleShim,
  parseAutHarness,
  parseCodexHooks,
  projectHookFiles,
  realCodexDir,
  recoverCodexBackup,
  resolveTools,
  which,
} from "../../tools/eval/harness.ts";
import {
  harnessFamily,
  harnessOf,
  modelFamily,
  observerRecord,
  parseHookLog,
  promptsTo,
  reportedAt,
} from "../../tools/eval/harness-observe.ts";
import { parsePaneJson } from "../../tools/eval/runner-pane.ts";
import { LIVE_DROP, muShim, sandboxEnv } from "../../tools/eval/sandbox.ts";
import { remoteEnv } from "../../tools/eval/ssh-args.ts";
import type { RunMetrics, Scenario, Surface } from "../../tools/eval/types.ts";
import { emptyRun } from "./_judge-sandbox.ts";

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tools: HookTools = {
  node: "/n/node",
  mu: "/w/mu/dist/cli.js",
  murmur: "/w/murmur/dist/cli.js",
  muzzle: "/w/muzzle/target/debug/muzzle",
  observer: "/w/mu/tools/eval/hook-observer.ts",
};
const paths: HookPaths = {
  murmurState: "/sb/murmur2",
  workerDir: "/sb/workers",
  stateHome: "/sb/home/.local/state",
  stopTimeoutS: 600,
};

describe("the rig's hook entries", () => {
  it("observer and murmur on every murmur event, by absolute path", () => {
    for (const h of ["claude", "codex", "cursor-agent", "muse"] as const) {
      const es = hookEntries(h, tools, paths);
      for (const ev of MURMUR_EVENTS[h]) {
        const cmds = es.filter((e) => e.event === ev).map((e) => e.command);
        expect(
          cmds.some((c) => c.includes("'/w/mu/tools/eval/hook-observer.ts'")),
          `${h} ${ev}`,
        ).toBe(true);
        expect(
          cmds.some((c) => c.includes(`'/n/node' '/w/murmur/dist/cli.js' hook ${h}`)),
          `${h} ${ev}`,
        ).toBe(true);
      }
    }
  });

  it("mu's Stop entry for claude, codex and cursor-agent, never Muse (D7)", () => {
    const stop = (h: "claude" | "codex" | "cursor-agent" | "muse") =>
      hookEntries(h, tools, paths).filter((e) => e.command.includes("hook stop"));
    expect(stop("claude")).toEqual([
      {
        event: "Stop",
        command: "'/n/node' '/w/mu/dist/cli.js' hook stop claude --timeout 600 || true",
        timeout: 600,
      },
    ]);
    expect(stop("cursor-agent")[0]?.event).toBe("stop");
    expect(stop("codex")).toHaveLength(1);
    expect(stop("muse")).toEqual([]);
  });

  it("muzzle's tool entry with each harness's matcher, only when muzzle is given", () => {
    const z = (h: "claude" | "codex" | "cursor-agent" | "muse") =>
      hookEntries(h, tools, paths).find((e) => e.command.includes("muzzle"));
    expect(z("claude")).toMatchObject({ event: "PreToolUse", matcher: "Bash" });
    expect(z("codex")).toMatchObject({ event: "PreToolUse", matcher: "^Bash$" });
    expect(z("cursor-agent")).toMatchObject({ event: "beforeShellExecution" });
    expect(z("muse")?.command).toContain("hook claude");
    expect(
      hookEntries("claude", { ...tools, muzzle: null }, paths).some((e) =>
        e.command.includes("muzzle"),
      ),
    ).toBe(false);
  });

  it("Muse's entries name the sandbox paths (its hooks get no env); codex's never do", () => {
    const muse = hookEntries("muse", tools, paths).map((e) => e.command);
    expect(muse.some((c) => c.startsWith("MURMUR_STATE_DIR='/sb/murmur2' "))).toBe(true);
    expect(muse.some((c) => c.endsWith("'/sb/workers/hooks.log'"))).toBe(true);
    for (const e of hookEntries("codex", tools, paths)) expect(e.command).not.toContain("/sb/");
  });

  it("Muse's Interrupt handlers are async", () => {
    const doc = hookDoc("muse", hookEntries("muse", tools, paths)) as {
      hooks: Record<string, { hooks: { async?: boolean }[] }[]>;
    };
    expect(doc.hooks.Interrupt?.[0]?.hooks.every((h) => h.async === true)).toBe(true);
    expect(doc.hooks.Stop?.[0]?.hooks.some((h) => h.async === true)).toBe(false);
  });

  it("cursor's file is flat with a version; the grouped ones group by matcher", () => {
    const cur = hookDoc("cursor-agent", hookEntries("cursor-agent", tools, paths)) as {
      version: number;
      hooks: Record<string, Record<string, unknown>[]>;
    };
    expect(cur.version).toBe(1);
    expect(cur.hooks.stop?.find((h) => String(h.command).includes("hook stop"))).toMatchObject({
      timeout: 600,
      loop_limit: null,
    });
    const cl = hookDoc("claude", hookEntries("claude", tools, paths)) as {
      hooks: Record<string, { matcher?: string; hooks: unknown[] }[]>;
    };
    expect(cl.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [expect.any(Object)] }]);
    expect(cl.hooks.Stop).toHaveLength(1);
  });

  it("project files: claude's, cursor's and Muse's, claude's with the allow list", () => {
    const files = projectHookFiles(tools, paths);
    expect(Object.keys(files).sort()).toEqual([
      ".claude/settings.json",
      ".cursor/hooks.json",
      ".muse/hooks.json",
    ]);
    const claude = JSON.parse(files[".claude/settings.json"] ?? "{}") as {
      permissions: { allow: string[] };
    };
    expect(claude.permissions.allow).toEqual(CLAUDE_ALLOW);
    expect(CLAUDE_ALLOW).toContain("Bash(eval-worker)");
  });
});

describe("codex's global hooks.json: backed up, merged, restored", () => {
  const doc = { hooks: { Stop: [{ hooks: [{ type: "command", command: "rig" }] }] } };

  it("merges the rig's entries after the user's and restores the file byte for byte", () => {
    const d = tmp("codex-global-");
    const before = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "mine" }] }] }, x: 1 }, null, 2)}\n`;
    writeFileSync(join(d, "hooks.json"), before);
    const restore = installCodexGlobal(d, doc);
    const during = JSON.parse(readFileSync(join(d, "hooks.json"), "utf8")) as {
      x: number;
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    expect(during.x).toBe(1);
    expect(during.hooks.Stop.map((g) => g.hooks[0]?.command)).toEqual(["mine", "rig"]);
    expect(existsSync(join(d, `hooks.json.mu-eval-${process.pid}`))).toBe(true);
    restore();
    restore();
    expect(readFileSync(join(d, "hooks.json"), "utf8")).toBe(before);
    expect(existsSync(join(d, `hooks.json.mu-eval-${process.pid}`))).toBe(false);
  });

  it("sandboxes of one process share the install; the last to close restores", () => {
    const d = tmp("codex-global-");
    writeFileSync(join(d, "hooks.json"), "{}\n");
    const a = installCodexGlobal(d, doc);
    const b = installCodexGlobal(d, doc);
    const during = readFileSync(join(d, "hooks.json"), "utf8");
    expect(JSON.parse(during).hooks.Stop).toHaveLength(1);
    a();
    a();
    expect(readFileSync(join(d, "hooks.json"), "utf8")).toBe(during);
    expect(existsSync(join(d, `hooks.json.mu-eval-${process.pid}`))).toBe(true);
    b();
    expect(readFileSync(join(d, "hooks.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(d, `hooks.json.mu-eval-${process.pid}`))).toBe(false);
  });

  it("a sandbox with other entries is refused while one is live", () => {
    const d = tmp("codex-global-");
    const a = installCodexGlobal(d, doc);
    expect(() => installCodexGlobal(d, { hooks: {} })).toThrow(/--concurrency 1/);
    a();
    installCodexGlobal(d, { hooks: {} })();
    expect(existsSync(join(d, "hooks.json"))).toBe(false);
  });

  it("the real codex home is the caller's CODEX_HOME, else ~/.codex", () => {
    expect(realCodexDir({ CODEX_HOME: "/x/codex" })).toBe("/x/codex");
    expect(realCodexDir({ CODEX_HOME: "rel" })).toMatch(/\/\.codex$/);
    expect(realCodexDir({})).toMatch(/\/\.codex$/);
  });

  it("no file before: none after", () => {
    const d = tmp("codex-global-");
    installCodexGlobal(d, doc)();
    expect(existsSync(join(d, "hooks.json"))).toBe(false);
  });

  it("a crashed run's backup is restored first; a live run's is refused", () => {
    const d = tmp("codex-global-");
    writeFileSync(join(d, "hooks.json"), "rig's\n");
    writeFileSync(join(d, "hooks.json.mu-eval-999999999"), "user's\n");
    recoverCodexBackup(d);
    expect(readFileSync(join(d, "hooks.json"), "utf8")).toBe("user's\n");
    writeFileSync(join(d, `hooks.json.mu-eval-${process.ppid}`), "x");
    expect(() => recoverCodexBackup(d)).toThrow(/another live eval run/);
  });

  it("refuses a hooks.json that is not JSON, and leaves it", () => {
    const d = tmp("codex-global-");
    writeFileSync(join(d, "hooks.json"), "{nope");
    expect(() => installCodexGlobal(d, doc)).toThrow(/not JSON/);
    expect(readFileSync(join(d, "hooks.json"), "utf8")).toBe("{nope");
  });

  it("codex-home: the rig's hooks, a copy of config.toml, links to the rest", () => {
    const real = tmp("codex-real-");
    writeFileSync(join(real, "config.toml"), "model = 'x'\n");
    writeFileSync(join(real, "auth.json"), "{}");
    writeFileSync(join(real, "hooks.json"), "user's");
    mkdirSync(join(real, "sessions"));
    const home = join(tmp("codex-home-"), "h");
    makeCodexHome(home, real, doc);
    expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, "sessions"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"))).toEqual(doc);
    expect(readFileSync(join(real, "hooks.json"), "utf8")).toBe("user's");
  });

  it("codex-home: skills/ holds the surface's mu beside links to the user's other skills", () => {
    const real = tmp("codex-real-");
    mkdirSync(join(real, "skills", "mu"), { recursive: true });
    writeFileSync(join(real, "skills", "mu", "SKILL.md"), "old mu");
    mkdirSync(join(real, "skills", "other"));
    const skill = tmp("skill-");
    writeFileSync(join(skill, "SKILL.md"), "surface mu");
    const home = join(tmp("codex-home-"), "h");
    makeCodexHome(home, real, doc, skill);
    expect(readFileSync(join(home, "skills", "mu", "SKILL.md"), "utf8")).toBe("surface mu");
    expect(lstatSync(join(home, "skills", "mu")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(home, "skills", "other")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(real, "skills", "mu", "SKILL.md"), "utf8")).toBe("old mu");
  });

  it("parses the mode", () => {
    expect(parseCodexHooks(undefined)).toBe("global");
    expect(parseCodexHooks("codex-home")).toBe("codex-home");
    expect(() => parseCodexHooks("x")).toThrow();
  });
});

describe("the sandbox's tool shims", () => {
  it("murmur: a user's harness hook entry is dropped; mu's own events pass", () => {
    const d = tmp("shim-");
    const shim = join(d, "murmur");
    writeFileSync(shim, murmurShim({ ...tools, node: "/bin/echo" }), { mode: 0o755 });
    expect(spawnSync(shim, ["hook", "claude"], { encoding: "utf8" }).stdout).toBe("");
    expect(spawnSync(shim, ["hook", "mu", "--pane", "%1"], { encoding: "utf8" }).stdout).toBe(
      "/w/murmur/dist/cli.js hook mu --pane %1\n",
    );
  });

  it("muzzle: hook calls are dropped; runs keep their state in the sandbox", () => {
    const d = tmp("shim-");
    const shim = join(d, "muzzle");
    writeFileSync(shim, muzzleShim("/usr/bin/env", "/sb/state"), { mode: 0o755 });
    expect(spawnSync(shim, ["hook", "claude"], { encoding: "utf8" }).stdout).toBe("");
    const out = spawnSync(shim, [], { encoding: "utf8", env: { PATH: process.env.PATH } }).stdout;
    expect(out).toContain("XDG_STATE_HOME=/sb/state");
    // a live run keeps the caller's env: their XDG_STATE_HOME must not take muzzle's queue there
    const live = spawnSync(shim, [], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, XDG_STATE_HOME: "/home/real/.local/state" },
    }).stdout;
    expect(live).toContain("XDG_STATE_HOME=/sb/state");
    expect(live).not.toContain("/home/real");
  });

  it("mu: drops a user's `mu hook stop`, logs an orchestrator pane's calls as the AUT's", () => {
    const d = tmp("shim-");
    const cli = join(d, "cli.js");
    writeFileSync(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n");
    const shim = join(d, "mu");
    writeFileSync(shim, muShim(cli), { mode: 0o755 });
    const workers = join(d, "workers");
    mkdirSync(workers);
    const env = (name?: string) => ({
      PATH: process.env.PATH ?? "",
      EVAL_WORKER_DIR: workers,
      MU_DB_PATH: join(d, "none.db"),
      ...(name !== undefined ? { MU_AGENT_NAME: name } : {}),
    });
    expect(
      spawnSync(shim, ["hook", "stop", "claude"], { encoding: "utf8", env: env("w1") }).stdout,
    ).toBe("");
    expect(spawnSync(shim, ["task", "list"], { encoding: "utf8", env: env("aut") }).stdout).toBe(
      '["task","list"]\n',
    );
    spawnSync(shim, ["agent", "list"], { encoding: "utf8", env: env("w1") });
    spawnSync(shim, ["state"], { encoding: "utf8", env: env() });
    const lines = readFileSync(join(workers, "mu-calls.log"), "utf8").trim().split("\n");
    expect(lines.map((l) => l.split(" ").slice(3, 4)[0])).toEqual(["-", "w1", "-"]);
    for (const l of lines) expect(l).toMatch(/^\d{13} \d{13} 0 /);
    expect(readFileSync(join(workers, "mu-calls.log"), "utf8")).not.toContain("hook stop");
  });
});

describe("live sandbox environment", () => {
  const surface: Surface = {
    name: "s",
    root: "/s",
    cli: "/s/dist/cli.js",
    extension: "/s/e.js",
    skillDir: "/s/skills/mu",
  };
  const base: NodeJS.ProcessEnv = {
    PATH: "/opt/me/bin:/usr/bin",
    HOME: "/home/real",
    ANTHROPIC_SOMETHING: "keep",
    MU_DB_PATH: "/real/mu.db",
    TMUX: "x",
    CLAUDECODE: "1",
    CODEX_THREAD_ID: "t",
    CODEX_HOME: "/real/codex",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    CLAUDE_CODE_SESSION_ID: "s",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s",
    MUSE_PLUGIN_ROOT: "/p",
    MURMUR_STATE_DIR: "/real/murmur2",
    XDG_CONFIG_HOME: "/home/real/.config",
  };
  const dir = "/tmp/mu-eval-1-2-abc";
  const live = sandboxEnv(dir, surface, "sock", base, { live: true });

  it("keeps the caller's HOME, config and auth variables", () => {
    expect(live.HOME).toBe("/home/real");
    expect(live.ANTHROPIC_SOMETHING).toBe("keep");
    expect(live.CLAUDE_CODE_USE_VERTEX).toBe("1");
    expect(live.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(live.CODEX_HOME).toBe("/real/codex");
    expect(live.XDG_CONFIG_HOME).toBe("/home/real/.config");
    expect(live.XDG_STATE_HOME).toBeUndefined();
  });

  it("drops mu's, tmux's, murmur's and every harness marker variable", () => {
    expect(live.TMUX).toBeUndefined();
    expect(live.CLAUDECODE).toBeUndefined();
    expect(live.CODEX_THREAD_ID).toBeUndefined();
    expect(live.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(live.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
    expect(live.MUSE_PLUGIN_ROOT).toBeUndefined();
    expect(LIVE_DROP.test("MU_NUDGE")).toBe(true);
    expect(LIVE_DROP.test("CLAUDE_CODE_USE_BEDROCK")).toBe(false);
    expect(LIVE_DROP.test("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("owns mu's DB and state, murmur's state, the tmux server and TMPDIR", () => {
    expect(live).toMatchObject({
      MU_DB_PATH: `${dir}/state/mu.db`,
      MU_STATE_DIR: `${dir}/state`,
      MURMUR_STATE_DIR: `${dir}/murmur2`,
      MU_TMUX_SOCKET: "sock",
      TMUX_TMPDIR: `${dir}/tmux-tmp`,
      TMPDIR: dir,
      EVAL_LIVE: "1",
      EVAL_CALLER_PATH: "/opt/me/bin:/usr/bin",
    });
    expect(live.PATH).toBe(`${dir}/bin:/opt/me/bin:/usr/bin`);
  });

  it("a fake run keeps its own HOME and gets murmur's state too", () => {
    const fake = sandboxEnv(dir, surface, "sock", base);
    expect(fake.HOME).toBe(`${dir}/home`);
    expect(fake.MURMUR_STATE_DIR).toBe(`${dir}/murmur2`);
    expect(fake.EVAL_LIVE).toBeUndefined();
  });
});

describe("the ssh host's environment", () => {
  const shim = { PATH: "/sb/bin", HOME: "/home/real", MURMUR_STATE_DIR: "/sb/murmur2" };
  it("murmur's state on the host is its own", () => {
    expect(remoteEnv(shim, "/sb/hosts/dev", "dev", "s").MURMUR_STATE_DIR).toBe(
      "/sb/hosts/dev/murmur2",
    );
  });
  it("the host's HOME is its own, live or fake (mu's remote worktrees stay in the sandbox)", () => {
    expect(remoteEnv(shim, "/sb/hosts/dev", "dev", "s").HOME).toBe("/sb/hosts/dev/home");
    expect(remoteEnv({ ...shim, EVAL_LIVE: "1" }, "/sb/hosts/dev", "dev", "s").HOME).toBe(
      "/sb/hosts/dev/home",
    );
  });

  it("a live host's HOME links the caller's harness config and auth, nothing else", () => {
    const caller = tmp("caller-home-");
    mkdirSync(join(caller, ".claude"));
    writeFileSync(join(caller, ".claude.json"), "{}");
    mkdirSync(join(caller, ".local", "share", "muse"), { recursive: true });
    mkdirSync(join(caller, ".local", "state", "mu-next"), { recursive: true });
    mkdirSync(join(caller, "src"));
    const host = join(tmp("host-"), "home");
    mkdirSync(host);
    linkHostHome(host, caller);
    expect(lstatSync(join(host, ".claude")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(host, ".claude.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(host, ".local", "share")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(host, ".local")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(host, ".local", "state"))).toBe(false);
    expect(existsSync(join(host, "src"))).toBe(false);
    expect(HOST_HOME_LINKS).not.toContain(".local/state");
  });
});

describe("the mu skill a live pane AUT reads", () => {
  const surfaceSkill = tmp("surface-skill-");
  writeFileSync(join(surfaceSkill, "SKILL.md"), "surface");
  const home = tmp("home-");
  const codexDir = join(home, ".codex");

  it("claude: the project copy, unless a different personal mu skill wins", () => {
    const o = { home, codexDir, codexHooks: "global" as const };
    expect(autSkill("claude", surfaceSkill, o)).toBeNull();
    mkdirSync(join(home, ".claude", "skills", "mu"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "mu", "SKILL.md"), "surface");
    expect(autSkill("claude", surfaceSkill, o)).toBeNull();
    writeFileSync(join(home, ".claude", "skills", "mu", "SKILL.md"), "older");
    expect(autSkill("claude", surfaceSkill, o)).toMatch(/takes precedence/);
  });

  it("codex: the surface's in codex-home; the user's own under global", () => {
    expect(
      autSkill("codex", surfaceSkill, { home, codexDir, codexHooks: "codex-home" }),
    ).toBeNull();
    expect(autSkill("codex", surfaceSkill, { home, codexDir, codexHooks: "global" })).toMatch(
      /does not exist.*codex-home/,
    );
    expect(autSkill("pi", surfaceSkill, { home, codexDir, codexHooks: "global" })).toBeNull();
  });

  it("cursor-agent: the project copy, noted when a personal mu skill it also loads differs", () => {
    const h = tmp("home-cursor-");
    const o = { home: h, codexDir: join(h, ".codex"), codexHooks: "global" as const };
    expect(autSkill("cursor-agent", surfaceSkill, o)).toBeNull();
    for (const d of [".cursor", ".codex"]) {
      mkdirSync(join(h, d, "skills", "mu"), { recursive: true });
      writeFileSync(join(h, d, "skills", "mu", "SKILL.md"), d === ".cursor" ? "surface" : "older");
    }
    const note = autSkill("cursor-agent", surfaceSkill, o) ?? "";
    expect(note).toMatch(/^cursor-agent AUT: .*\.codex\/skills\/mu differs/);
    expect(note).not.toContain(".cursor/skills/mu differs");
    expect(note).toContain(AUT_PROJECT_SKILL["cursor-agent"]);
    // ~/.agents and ~/.grok are personal skill dirs of cursor-agent's too
    for (const d of [".agents", ".grok"]) {
      mkdirSync(join(h, d, "skills", "mu"), { recursive: true });
      writeFileSync(join(h, d, "skills", "mu", "SKILL.md"), "older");
    }
    const all = autSkill("cursor-agent", surfaceSkill, o) ?? "";
    expect(all).toContain(join(h, ".agents", "skills", "mu"));
    expect(all).toContain(join(h, ".grok", "skills", "mu"));
  });

  it("muse: always noted (its personal skills live behind muse skills)", () => {
    const o = { home, codexDir, codexHooks: "global" as const };
    expect(autSkill("muse", surfaceSkill, o)).toMatch(/^muse AUT: .*\.agents\/skills\/mu/);
  });
});

describe("tools and options", () => {
  const surface: Surface = {
    name: "s",
    root: "/s",
    cli: "/s/dist/cli.js",
    extension: "/s/e.js",
    skillDir: "/s/skills/mu",
  };

  it("murmur is required; muzzle is optional", () => {
    expect(() => resolveTools(surface, {})).toThrow(/EVAL_MURMUR/);
    expect(() => resolveTools(surface, { EVAL_MURMUR: "/nope" })).toThrow(/build murmur/);
    const m = tmp("murmur-");
    mkdirSync(join(m, "dist"));
    writeFileSync(join(m, "dist", "cli.js"), "");
    expect(resolveTools(surface, { EVAL_MURMUR: m })).toMatchObject({
      murmur: join(m, "dist", "cli.js"),
      muzzle: null,
    });
    expect(() => resolveTools(surface, { EVAL_MURMUR: m, EVAL_MUZZLE: "/nope/muzzle" })).toThrow(
      /EVAL_MUZZLE/,
    );
  });

  it("which skips the sandbox bin", () => {
    const a = tmp("which-a-");
    const b = tmp("which-b-");
    for (const d of [a, b]) writeFileSync(join(d, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(which("claude", `${a}:${b}`, [a])).toBe(join(b, "claude"));
    expect(which("nope-x", `${a}:${b}`)).toBeNull();
  });

  it("AUT harnesses, check harnesses and live runs", () => {
    expect(parseAutHarness("codex")).toBe("codex");
    expect(parseAutHarness("muse")).toBe("muse");
    expect(parseAutHarness("cursor-agent")).toBe("cursor-agent");
    expect(() => parseAutHarness("cursor")).toThrow();
    const pi = { id: "x" } as Scenario;
    const hooked = { id: "e", hookHarnesses: { workers: ["claude"] } } as Scenario;
    expect(checkHarnesses(pi)).toEqual(["pi"]);
    expect(checkHarnesses(hooked)).toEqual(["pi", "claude", "codex", "cursor-agent", "muse"]);
    expect(checkHarnesses(hooked, ["claude"])).toEqual(["claude"]);
    expect(checkHarnesses(pi, ["claude"])).toEqual([]);
    expect(isLiveRun(pi, "pi")).toBe(false);
    expect(isLiveRun(pi, "claude")).toBe(true);
    expect(isLiveRun(hooked, "pi")).toBe(true);
  });

  it("a live pane AUT's command: mu's preset, a model, or the user's launcher beside fake workers", () => {
    const a = tmp("aut-");
    writeFileSync(join(a, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const o = { harness: "codex" as const, live: true, fakeWorkers: false, env: { PATH: a } };
    expect(autCommand({ ...o, model: "default" })).toBeUndefined();
    expect(autCommand({ ...o, model: "gpt-x" })).toBe("codex --model gpt-x");
    expect(autCommand({ ...o, model: "default", fakeWorkers: true })).toBe(join(a, "codex"));
    expect(autCommand({ ...o, model: "m", live: false })).toBeUndefined();
    expect(autCommand({ ...o, model: "m", env: { EVAL_AUT_COMMAND: "codex -p x" } })).toBe(
      "codex -p x",
    );
  });

  it("a cursor-agent or Muse AUT's command carries the trust and approval flags an orchestrator needs", () => {
    const a = tmp("aut-");
    for (const h of ["cursor-agent", "muse"])
      writeFileSync(join(a, h), "#!/bin/sh\n", { mode: 0o755 });
    const live = { live: true, fakeWorkers: false, env: { PATH: a } };
    expect(autCommand({ ...live, harness: "cursor-agent", model: "default" })).toBe(
      "cursor-agent --trust --sandbox enabled",
    );
    expect(autCommand({ ...live, harness: "cursor-agent", model: "gpt-x" })).toBe(
      "cursor-agent --trust --sandbox enabled --model gpt-x",
    );
    expect(autCommand({ ...live, harness: "muse", model: "default" })).toBe(
      "muse --trust-workspace --approval-mode never",
    );
    expect(autCommand({ ...live, harness: "muse", model: "default", fakeWorkers: true })).toBe(
      `${join(a, "muse")} --trust-workspace --approval-mode never`,
    );
    // check (fake harnesses): the same flags, never the faux model
    expect(
      autCommand({ ...live, live: false, harness: "cursor-agent", model: "evalfaux/aut" }),
    ).toBe("cursor-agent --trust --sandbox enabled");
    expect(
      autCommand({
        ...live,
        harness: "muse",
        model: "x",
        env: { EVAL_AUT_COMMAND: "muse --yolo" },
      }),
    ).toBe("muse --yolo");
    expect(AUT_FLAGS.claude).toEqual([]);
    expect(AUT_FLAGS.codex).toEqual([]);
  });

  it("a replacement case's metrics add up", () => {
    const a: RunMetrics = {
      ...emptyRun(),
      turns: 2,
      muCalls: 3,
      events: [{ t: 1, kind: "prompt" }],
    };
    const b: RunMetrics = {
      ...emptyRun(),
      turns: 1,
      muCalls: 4,
      aborted: "timeout",
      finalText: "b",
    };
    expect(mergeMetrics(a, b)).toMatchObject({
      turns: 3,
      muCalls: 7,
      aborted: "timeout",
      finalText: "b",
    });
  });
});

describe("murmur's pane report and the observer's records", () => {
  it("reads murmur pane --json", () => {
    expect(
      parsePaneJson(
        '{"state":"idle","agent":{"activity":"stopped","run_count":2,"last_text":"ok","session_id":"s"}}',
      ),
    ).toEqual({ state: "idle", activity: "stopped", runCount: 2, lastText: "ok", sessionId: "s" });
    expect(parsePaneJson("nope")).toBeNull();
  });

  it("normalises each harness's events and copies no account field", () => {
    const meta = { ms: 5, agent: "w1", host: null, cwd: "/w" };
    expect(
      observerRecord(
        "claude",
        { hook_event_name: "UserPromptSubmit", prompt: "go", session_id: "s" },
        meta,
      ),
    ).toMatchObject({
      kind: "prompt",
      text: "go",
      session: "s",
    });
    expect(
      observerRecord("cursor-agent", { hook_event_name: "stop", status: "aborted" }, meta).kind,
    ).toBe("interrupt");
    expect(
      observerRecord("cursor-agent", { hook_event_name: "stop", status: "error" }, meta).kind,
    ).toBe("failed");
    expect(
      observerRecord("codex", { hook_event_name: "Stop", stop_hook_active: true }, meta).resumed,
    ).toBe(true);
    const rec = observerRecord(
      "cursor-agent",
      { hook_event_name: "afterAgentResponse", text: "t", user_email: "someone@example.com" },
      meta,
    );
    expect(JSON.stringify(rec)).not.toContain("example.com");
    expect(rec.kind).toBe("text");
  });

  it("drops codex's title-generation session (transcript_path null), as mu and murmur do", () => {
    const meta = { ms: 1, agent: "w1", host: null, cwd: "/r" };
    const title = { hook_event_name: "UserPromptSubmit", prompt: "title", transcript_path: null };
    expect(observerRecord("codex", title, meta).kind).toBe("other");
    const real = { ...title, transcript_path: "/h/.codex/sessions/x.jsonl" };
    expect(observerRecord("codex", real, meta).kind).toBe("prompt");
  });

  it("drops claude's <task-notification> turns, which the harness gives itself", () => {
    const meta = { ms: 1, agent: "w1", host: null, cwd: "/r" };
    const n = {
      hook_event_name: "UserPromptSubmit",
      prompt: "<task-notification> <task-id>b1</task-id>",
    };
    expect(observerRecord("claude", n, meta).kind).toBe("other");
    const real = { hook_event_name: "UserPromptSubmit", prompt: "run eval-worker" };
    expect(observerRecord("claude", real, meta).kind).toBe("prompt");
  });

  it("reads the log: harness, prompts and reports per agent", () => {
    const meta = (ms: number, agent: string) => ({ ms, agent, host: null, cwd: "/w" });
    const log = [
      observerRecord("codex", { hook_event_name: "UserPromptSubmit", prompt: "a" }, meta(1, "w1")),
      observerRecord(
        "codex",
        { hook_event_name: "Stop", last_assistant_message: "VERDICT: REFUTED" },
        meta(2, "w1"),
      ),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const recs = parseHookLog(`${log}\nnot json\n`);
    expect(harnessOf(recs, "w1")).toBe("codex");
    expect(harnessOf(recs, "w2")).toBeNull();
    expect(promptsTo(recs, "w1")).toHaveLength(1);
    expect(reportedAt(recs, "w1", /REFUTED/)).toBe(2);
  });

  it("drops the claude echo of a cursor-agent session (it runs claude's hooks too)", () => {
    const rec = (harness: string, session: string, agent: string, ms: number) =>
      JSON.stringify({
        ms,
        harness,
        event: "beforeSubmitPrompt",
        kind: "prompt",
        agent,
        host: null,
        cwd: "/w",
        session,
        turn: "t",
        text: "go",
      });
    const recs = parseHookLog(
      [
        rec("claude", "s1", "w1", 1),
        rec("cursor-agent", "s1", "w1", 1),
        rec("claude", "s2", "w2", 2),
      ].join("\n"),
    );
    expect(harnessOf(recs, "w1")).toBe("cursor-agent");
    expect(promptsTo(recs, "w1")).toHaveLength(1);
    expect(harnessOf(recs, "w2")).toBe("claude");
  });

  it("families: claude anthropic, codex openai, pi by its model", () => {
    expect(harnessFamily("claude")).toBe("anthropic");
    expect(harnessFamily("codex")).toBe("openai");
    expect(harnessFamily("pi", "anthropic/claude-x")).toBe("anthropic");
    expect(modelFamily("evalfaux/aut")).toBe("evalfaux");
    expect(modelFamily("gpt-6")).toBe("openai");
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
