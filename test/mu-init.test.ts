// `mu init` (spec D13, D17, U23): mu's `mu hook stop` entry in claude's,
// codex's and cursor-agent's own hook config, merge-safe, and mu's skill in
// each harness's own skill directory. Only entries and copies mu wrote are
// touched; nothing is written where pi reads skills (`~/.agents/skills`,
// `~/.pi/agent/skills`), so pi still lists exactly one `mu` skill. Every case
// runs in a temp HOME.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harnessProbeScript, parseHarnessProbe } from "../src/host-harnesses.js";
import {
  initRefused,
  isMuWrittenHook,
  muHookCommand,
  piSkillDirs,
  runInit,
  SKILL_MARKER,
  setInitBeforeCommitForTests,
} from "../src/mu-init.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

const root = join(import.meta.dirname, "..");
const shippedSkill = readFileSync(join(root, "skills", "mu", "SKILL.md"), "utf8");

let tmp: string;
let home: string;

const at = (...p: string[]) => join(home, ...p);
const read = (...p: string[]) => readFileSync(at(...p), "utf8");
const json = (...p: string[]) => JSON.parse(read(...p)) as Record<string, unknown>;
const write = (rel: string[], value: unknown) => {
  mkdirSync(join(at(...rel), ".."), { recursive: true });
  writeFileSync(at(...rel), typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

/** Every handler command on one event of a grouped (claude/codex) config. */
function grouped(doc: Record<string, unknown>, event: string): string[] {
  const hooks = doc.hooks as Record<string, { hooks: { command: string }[] }[]>;
  return (hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
}

/** Every `mu` skill directory a harness's skill dirs hold under this HOME. */
function muSkills(...dirs: string[][]): string[] {
  return dirs.map((d) => at(...d, "mu")).filter((d) => existsSync(join(d, "SKILL.md")));
}

/** Every file under the HOME, relative, sorted. */
function tree(dir = home, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? tree(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    )
    .sort();
}

const state = (r: ReturnType<typeof runInit>, kind: "hooks" | "skills") =>
  Object.fromEntries(r[kind].map((i) => [i.harness, i.state]));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-init-"));
  home = join(tmp, "home");
  mkdirSync(home);
});
afterEach(() => {
  setInitBeforeCommitForTests(undefined);
  rmFixtureDir(tmp);
});

describe("mu init: hook entries", () => {
  it("twice: one mu entry per harness, foreign entries intact, nothing rewritten the second time", async () => {
    const claude = {
      model: "opus",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "murmur hook claude" }] }],
        Stop: [
          { hooks: [{ type: "command", command: "murmur hook claude" }] },
          { hooks: [{ type: "command", command: "museum hook claude", timeout: 5 }] },
        ],
      },
    };
    write([".claude", "settings.json"], claude);
    write([".codex", "hooks.json"], {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "murmur hook codex" }] }] },
    });
    write([".cursor", "hooks.json"], {
      version: 1,
      hooks: { stop: [{ command: "muzzle hook cursor" }] },
    });
    const muse = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "murmur hook muse" }] }] },
    };
    write([".config", "muse", "settings.json"], muse);
    const museBefore = read(".config", "muse", "settings.json");

    // A temp HOME, as the real default (`MU_INIT_HOME` unset) resolves it.
    let first: ReturnType<typeof runInit> | undefined;
    await withEnv("MU_INIT_HOME", undefined, () =>
      withEnv("HOME", home, async () => {
        first = runInit({ packageRoot: root });
      }),
    );
    expect(first?.home).toBe(home);
    if (first === undefined) return;
    expect(state(first, "hooks")).toEqual({
      claude: "written",
      codex: "written",
      "cursor-agent": "written",
      muse: "none",
      pi: "none",
    });

    const doc = json(".claude", "settings.json");
    expect(doc.model).toBe("opus");
    expect((doc.hooks as Record<string, unknown>).SessionStart).toEqual(claude.hooks.SessionStart);
    expect(grouped(doc, "Stop")).toEqual([
      "murmur hook claude",
      "museum hook claude",
      muHookCommand("claude"),
    ]);
    const stop = (doc.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>).Stop ?? [];
    expect(stop[1]?.hooks[0]).toEqual({
      type: "command",
      command: "museum hook claude",
      timeout: 5,
    });
    expect(stop[2]?.hooks[0]).toEqual({
      type: "command",
      command: "mu hook stop claude --timeout 600 || true",
      timeout: 600,
    });
    expect(grouped(json(".codex", "hooks.json"), "Stop")).toEqual([
      "murmur hook codex",
      muHookCommand("codex"),
    ]);
    expect(json(".cursor", "hooks.json")).toEqual({
      version: 1,
      hooks: {
        stop: [
          { command: "muzzle hook cursor" },
          { command: muHookCommand("cursor-agent"), timeout: 600, loop_limit: null },
        ],
      },
    });
    // Muse Code ignores a stop block's reason: no entry.
    expect(read(".config", "muse", "settings.json")).toBe(museBefore);

    const files = [".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json"];
    const before = files.map((f) => read(f));
    const second = runInit({ home, packageRoot: root });
    expect(state(second, "hooks")).toEqual({
      claude: "unchanged",
      codex: "unchanged",
      "cursor-agent": "unchanged",
      muse: "none",
      pi: "none",
    });
    expect(files.map((f) => read(f))).toEqual(before);
  });

  it("writes entries the host probe recognises as mu's", () => {
    runInit({ home, packageRoot: root, harnesses: ["claude", "codex", "cursor-agent"] });
    const out = execFileSync("/bin/sh", ["-c", harnessProbeScript()], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    const caps = parseHarnessProbe(out, "sh");
    expect(caps?.harnesses.claude.muHooks).toBe(true);
    expect(caps?.harnesses.codex.muHooks).toBe(true);
    expect(caps?.harnesses["cursor-agent"].muHooks).toBe(true);
    expect(caps?.harnesses.muse.muHooks).toBeNull();
  });

  it("adds none beside an entry mu did not write that already runs mu hook stop", () => {
    const text = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "/opt/mu/bin/mu hook stop claude --timeout 300" }],
          },
        ],
      },
    });
    write([".claude", "settings.json"], text);
    const r = runInit({ home, packageRoot: root, harnesses: ["claude"] });
    expect(r.hooks.find((i) => i.harness === "claude")).toMatchObject({ state: "kept" });
    expect(read(".claude", "settings.json")).toBe(text);
  });

  it("removes its own entry when one it did not write also runs mu hook stop", () => {
    const foreign = { type: "command", command: "/opt/mu/bin/mu hook stop claude" };
    write([".claude", "settings.json"], {
      hooks: {
        Stop: [
          { hooks: [foreign] },
          { hooks: [{ type: "command", command: muHookCommand("claude"), timeout: 600 }] },
        ],
      },
    });
    const r = runInit({ home, packageRoot: root, harnesses: ["claude"] });
    expect(r.hooks.find((i) => i.harness === "claude")).toMatchObject({
      state: "written",
      detail: expect.stringMatching(/^removed its Stop entry: .*\/opt\/mu\/bin\/mu hook stop/),
    });
    expect((json(".claude", "settings.json").hooks as Record<string, unknown>).Stop).toEqual([
      { hooks: [foreign] },
    ]);
    const after = read(".claude", "settings.json");
    const again = runInit({ home, packageRoot: root, harnesses: ["claude"] });
    expect(again.hooks.find((i) => i.harness === "claude")?.state).toBe("kept");
    expect(read(".claude", "settings.json")).toBe(after);
  });

  it("keeps one entry it wrote, drops its duplicates, and updates an older form in place", () => {
    write([".claude", "settings.json"], {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "mu hook stop claude || true", note: "mine" }] },
          { hooks: [{ type: "command", command: muHookCommand("claude"), timeout: 600 }] },
          {
            hooks: [
              { type: "command", command: "murmur hook claude" },
              { type: "command", command: muHookCommand("claude"), timeout: 600 },
            ],
          },
        ],
      },
    });
    const r = runInit({ home, packageRoot: root, harnesses: ["claude"] });
    expect(r.hooks.find((i) => i.harness === "claude")?.state).toBe("written");
    const stop = (json(".claude", "settings.json").hooks as Record<string, unknown[]>).Stop;
    expect(stop).toEqual([
      {
        hooks: [{ type: "command", command: muHookCommand("claude"), note: "mine", timeout: 600 }],
      },
      { hooks: [{ type: "command", command: "murmur hook claude" }] },
    ]);
  });

  it("recognises only the forms it writes, per harness", () => {
    expect(isMuWrittenHook(muHookCommand("claude"), "claude")).toBe(true);
    expect(isMuWrittenHook("  mu hook stop codex || true ", "codex")).toBe(true);
    expect(isMuWrittenHook(muHookCommand("claude"), "codex")).toBe(false);
    expect(isMuWrittenHook("mu hook stop claude --timeout 600", "claude")).toBe(false);
    expect(isMuWrittenHook("murmur hook claude", "claude")).toBe(false);
  });

  it("refuses a file it cannot read as a hook config, and still writes the others", () => {
    write([".claude", "settings.json"], "{ not json");
    write([".codex", "hooks.json"], { hooks: { Stop: { not: "a list" } } });
    mkdirSync(at(".cursor"));
    const r = runInit({ home, packageRoot: root });
    expect(state(r, "hooks")).toMatchObject({
      claude: "refused",
      codex: "refused",
      "cursor-agent": "written",
    });
    expect(initRefused(r)).toBe(true);
    expect(read(".claude", "settings.json")).toBe("{ not json");
  });

  it("writes through a symlinked config to its target and keeps the target's mode", () => {
    const target = join(tmp, "dotfiles", "claude-settings.json");
    mkdirSync(join(tmp, "dotfiles"));
    writeFileSync(target, JSON.stringify({ theme: "dark" }));
    chmodSync(target, 0o644);
    mkdirSync(at(".claude"));
    symlinkSync(target, at(".claude", "settings.json"));
    const r = runInit({ home, packageRoot: root, harnesses: ["claude"] });
    expect(r.hooks.find((i) => i.harness === "claude")?.state).toBe("written");
    expect(lstatSync(at(".claude", "settings.json")).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    const doc = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    expect(doc.theme).toBe("dark");
    expect(grouped(doc, "Stop")).toEqual([muHookCommand("claude")]);
  });

  it("plans again when another writer changes the file between read and write", () => {
    write([".claude", "settings.json"], { hooks: {} });
    let raced = false;
    setInitBeforeCommitForTests((path) => {
      if (raced) return;
      raced = true;
      writeFileSync(path, JSON.stringify({ theme: "dark", hooks: {} }));
    });
    const r = runInit({ home, packageRoot: root, harnesses: ["claude"] });
    expect(r.hooks.find((i) => i.harness === "claude")?.state).toBe("written");
    const doc = json(".claude", "settings.json");
    expect(doc.theme).toBe("dark");
    expect(grouped(doc, "Stop")).toEqual([muHookCommand("claude")]);
  });

  it("writes only for harnesses set up here unless --harness names them", () => {
    mkdirSync(at(".codex"));
    const r = runInit({ home, packageRoot: root });
    expect(state(r, "hooks")).toMatchObject({ claude: "skipped", codex: "written" });
    expect(state(r, "skills")).toMatchObject({ claude: "skipped", codex: "written" });
    expect(existsSync(at(".claude"))).toBe(false);
    expect(existsSync(at(".cursor"))).toBe(false);
    const named = runInit({ home, packageRoot: root, harnesses: ["claude"] });
    expect(grouped(json(".claude", "settings.json"), "Stop")).toEqual([muHookCommand("claude")]);
    // codex is set up here; --harness left it out, and says so.
    expect(named.hooks.find((i) => i.harness === "codex")).toMatchObject({
      state: "skipped",
      detail: "not named in --harness",
    });
  });
});

describe("mu init: the skill", () => {
  it("twice: one copy per harness, nothing where pi reads skills", () => {
    for (const d of [".claude", ".codex", ".cursor", ".pi"]) mkdirSync(at(d));
    const first = runInit({ home, packageRoot: root });
    expect(state(first, "skills")).toEqual({
      claude: "written",
      codex: "written",
      "cursor-agent": "covered",
      muse: "none",
      pi: "none",
    });
    expect(read(".claude", "skills", "mu", "SKILL.md")).toBe(shippedSkill);
    expect(read(".codex", "skills", "mu", "recipes", "worker.md")).toBe(
      readFileSync(join(root, "skills", "mu", "recipes", "worker.md"), "utf8"),
    );
    const files = tree();
    const second = runInit({ home, packageRoot: root });
    expect(state(second, "skills")).toMatchObject({
      claude: "unchanged",
      codex: "unchanged",
      "cursor-agent": "covered",
    });
    expect(tree()).toEqual(files);
    // One copy in each of claude's and codex's dirs; cursor-agent reads those
    // (its third-party skills) and gets none of its own.
    expect(muSkills([".claude", "skills"])).toHaveLength(1);
    expect(muSkills([".codex", "skills"])).toHaveLength(1);
    expect(existsSync(at(".cursor", "skills", "mu"))).toBe(false);
    // pi reads only its own dirs and the package: no mu skill there.
    for (const d of piSkillDirs(home)) expect(existsSync(d)).toBe(false);
    expect(files.some((f) => f.startsWith(".agents/"))).toBe(false);
  });

  it("gives cursor-agent its own copy only while no other harness dir holds one", () => {
    mkdirSync(at(".cursor"));
    const alone = runInit({ home, packageRoot: root });
    expect(state(alone, "skills")["cursor-agent"]).toBe("written");
    expect(read(".cursor", "skills", "mu", "SKILL.md")).toBe(shippedSkill);

    mkdirSync(at(".claude"));
    const both = runInit({ home, packageRoot: root });
    expect(state(both, "skills")).toMatchObject({ claude: "written", "cursor-agent": "written" });
    expect(both.skills.find((i) => i.harness === "cursor-agent")?.detail).toMatch(/^removed/);
    expect(muSkills([".cursor", "skills"], [".claude", "skills"], [".codex", "skills"])).toEqual([
      at(".claude", "skills", "mu"),
    ]);
  });

  it("leaves a skill it did not write, or one edited since, as found", () => {
    write([".claude", "skills", "mu", "SKILL.md"], "my own mu skill\n");
    mkdirSync(at(".codex"));
    runInit({ home, packageRoot: root });
    const edited = at(".codex", "skills", "mu", "SKILL.md");
    writeFileSync(edited, "edited\n");
    const r = runInit({ home, packageRoot: root });
    expect(state(r, "skills")).toMatchObject({ claude: "kept", codex: "kept" });
    expect(read(".claude", "skills", "mu", "SKILL.md")).toBe("my own mu skill\n");
    expect(readFileSync(edited, "utf8")).toBe("edited\n");
    expect(existsSync(at(".claude", "skills", "mu", SKILL_MARKER))).toBe(false);
  });

  it("leaves a skill linked into ~/.agents/skills (an old skills install) as found", () => {
    write([".agents", "skills", "mu", "SKILL.md"], "installed by npx skills\n");
    mkdirSync(at(".claude", "skills"), { recursive: true });
    symlinkSync(at(".agents", "skills", "mu"), at(".claude", "skills", "mu"), "dir");
    const r = runInit({ home, packageRoot: root });
    expect(r.skills.find((i) => i.harness === "claude")).toMatchObject({
      state: "kept",
      detail: expect.stringContaining("pi lists it"),
    });
    expect(initRefused(r)).toBe(false);
    expect(lstatSync(at(".claude", "skills", "mu")).isSymbolicLink()).toBe(true);
    expect(readdirSync(at(".agents", "skills", "mu"))).toEqual(["SKILL.md"]);
  });

  it("clears staging copies a dead init left beside the skill", () => {
    const dead = spawnSync("true").pid;
    mkdirSync(at(".claude"));
    for (const kind of ["tmp", "old"]) {
      write([".claude", "skills", `.mu.mu-${dead}.${kind}`, "SKILL.md"], "---\nname: mu\n---\n");
    }
    runInit({ home, packageRoot: root });
    expect(readdirSync(at(".claude", "skills"))).toEqual(["mu"]);
  });

  it("replaces its own unedited copy with the skill a newer mu ships", () => {
    mkdirSync(at(".claude"));
    runInit({ home, packageRoot: root });
    const next = join(tmp, "next");
    mkdirSync(join(next, "skills", "mu"), { recursive: true });
    writeFileSync(join(next, "skills", "mu", "SKILL.md"), "the next skill\n");
    const r = runInit({ home, packageRoot: next });
    expect(r.skills.find((i) => i.harness === "claude")).toMatchObject({
      state: "written",
      detail: "updated",
    });
    expect(readdirSync(at(".claude", "skills", "mu")).sort()).toEqual([SKILL_MARKER, "SKILL.md"]);
    expect(read(".claude", "skills", "mu", "SKILL.md")).toBe("the next skill\n");
    expect(readdirSync(at(".claude", "skills"))).toEqual(["mu"]);
  });

  it("refuses a harness skill dir that resolves into ~/.agents/skills", () => {
    mkdirSync(at(".agents", "skills"), { recursive: true });
    mkdirSync(at(".claude"));
    symlinkSync(at(".agents", "skills"), at(".claude", "skills"), "dir");
    const r = runInit({ home, packageRoot: root });
    expect(r.skills.find((i) => i.harness === "claude")?.state).toBe("refused");
    expect(readdirSync(at(".agents", "skills"))).toEqual([]);
  });
});

describe("mu init: CLI", () => {
  it("prints the result as one document under --json", async () => {
    mkdirSync(at(".claude"));
    await withEnv("MU_INIT_HOME", home, async () => {
      const r = await runCliJson(["init", "--json"], join(tmp, "mu.db"));
      expect(r.exitCode ?? 0).toBe(0);
      expect(r.data.home).toBe(home);
      expect(r.data.hooks.find((i: { harness: string }) => i.harness === "claude").state).toBe(
        "written",
      );
      const human = await runCli(["init"], join(tmp, "mu.db"));
      expect(human.stdout).toMatch(/hook claude: .* unchanged/);
    });
  });

  it("refuses an unknown --harness before writing anything", async () => {
    await withEnv("MU_INIT_HOME", home, async () => {
      const r = await runCli(["init", "--harness", "claude,claud"], join(tmp, "mu.db"));
      expect(r.exitCode).toBe(2);
      expect(tree()).toEqual([]);
    });
  });

  it("exits 1 when a file is left untouched", async () => {
    write([".claude", "settings.json"], "[]");
    await withEnv("MU_INIT_HOME", home, async () => {
      const r = await runCli(["init"], join(tmp, "mu.db"));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/hook claude: .* refused: left untouched: it is not a JSON object/);
      const j = await runCliJson(["init", "--json"], join(tmp, "mu.db"));
      expect(j.exitCode).toBe(1);
      expect(j.doc).toMatchObject({ ok: false, error: "InitRefusedError" });
      expect(j.data.hooks.find((i: { harness: string }) => i.harness === "claude")).toMatchObject({
        state: "refused",
      });
    });
  });
});
