// `mu doctor`'s hooks step (spec D13: each tool's doctor checks its own
// entries): mu's `mu hook stop` entry for claude, codex and cursor-agent, read
// through `mu init`'s matcher. Missing, drifted and foreign entries are warn
// rows; a harness not set up here is not reported. Every case runs in a temp
// HOME.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkMuHooks, muHookCommand, runInit } from "../src/mu-init.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

const root = join(import.meta.dirname, "..");
let tmp: string;
let home: string;

function write(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

const stop = (...commands: unknown[]) => ({
  hooks: {
    Stop: [{ hooks: commands.map((c) => ({ type: "command", command: c, timeout: 600 })) }],
  },
});

const rows = (env: NodeJS.ProcessEnv = {}) =>
  Object.fromEntries(checkMuHooks(home, env).map((r) => [r.name, r]));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-doctor-hooks-"));
  home = join(tmp, "home");
  mkdirSync(home);
});
afterEach(() => rmFixtureDir(tmp));

describe("checkMuHooks", () => {
  it("nothing set up here: no rows", () => {
    expect(checkMuHooks(home, {})).toEqual([]);
  });

  it("ok after mu init, for the three harnesses mu writes, never muse or pi", () => {
    for (const d of [".claude", ".codex", ".cursor", ".config/muse"])
      mkdirSync(join(home, d), { recursive: true });
    runInit({ home, packageRoot: root, env: {} });
    const r = checkMuHooks(home, {});
    expect(r.map((x) => [x.name, x.severity])).toEqual([
      ["claude", "ok"],
      ["codex", "ok"],
      ["cursor-agent", "ok"],
    ]);
  });

  it("missing: a set-up harness with no entry, or no file", () => {
    mkdirSync(join(home, ".codex"));
    write(join(home, ".claude", "settings.json"), stop("murmur hook claude"));
    const r = rows();
    expect(r.claude).toMatchObject({ severity: "warn" });
    expect(r.claude?.detail).toMatch(
      /^missing: no `mu hook stop claude --timeout 600 \|\| true` on Stop/,
    );
    expect(r.codex?.detail).toMatch(/^missing:/);
    expect(r.claude?.remediation?.join("\n")).toContain("mu init --harness claude");
  });

  it("drifted: an older form, a changed timeout, or a duplicate", () => {
    write(join(home, ".claude", "settings.json"), stop("mu hook stop claude || true"));
    write(join(home, ".codex", "hooks.json"), stop(muHookCommand("codex"), muHookCommand("codex")));
    const r = rows();
    expect(r.claude).toMatchObject({ severity: "warn" });
    expect(r.claude?.detail).toMatch(/^drifted: .*updated Stop/);
    expect(r.codex?.detail).toMatch(/^drifted: .*removed a duplicate Stop entry/);
    // read-only: the file is as it was
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(
      JSON.stringify(stop("mu hook stop claude || true"), null, 2),
    );
  });

  it("foreign: an entry mu did not write that runs mu hook stop", () => {
    write(join(home, ".claude", "settings.json"), stop("/opt/bin/mu hook stop claude"));
    write(
      join(home, ".codex", "hooks.json"),
      stop("wrap mu hook stop codex", muHookCommand("codex")),
    );
    const r = rows();
    expect(r.claude).toMatchObject({ severity: "warn" });
    expect(r.claude?.detail).toMatch(/^foreign: .*`\/opt\/bin\/mu hook stop claude`\)$/);
    expect(r.codex?.detail).toMatch(/^foreign: .*, beside mu's own$/);
  });

  it("a file it cannot read as a hook config is a warn row", () => {
    write(join(home, ".cursor", "hooks.json"), "{ not json");
    expect(rows()["cursor-agent"]).toMatchObject({ severity: "warn" });
    expect(rows()["cursor-agent"]?.detail).toMatch(/cannot check it: it is not valid JSON/);
  });

  it("reads claude's and codex's file where CLAUDE_CONFIG_DIR and CODEX_HOME move them", () => {
    const env = { CLAUDE_CONFIG_DIR: join(tmp, "claude-cfg"), CODEX_HOME: join(tmp, "codex-home") };
    write(join(home, ".claude", "settings.json"), stop(muHookCommand("claude")));
    write(join(env.CODEX_HOME, "hooks.json"), stop(muHookCommand("codex")));
    const r = rows(env);
    // ~/.claude's entry is not the one claude reads
    expect(r.claude).toBeUndefined();
    expect(r.codex).toMatchObject({ severity: "ok" });
    expect(r.codex?.detail).toContain(join(env.CODEX_HOME, "hooks.json"));
    mkdirSync(env.CLAUDE_CONFIG_DIR);
    expect(rows(env).claude?.detail).toMatch(/^missing:/);
  });
});

describe("mu doctor: the hooks section", () => {
  it("lists each set-up harness's row, human and --json, and a warn keeps exit 0", async () => {
    write(join(home, ".claude", "settings.json"), stop("murmur hook claude"));
    await withEnv("MU_INIT_HOME", home, async () => {
      const human = await runCli(["doctor"], join(tmp, "mu.db"));
      expect(human.exitCode ?? 0).toBe(0);
      expect(plain(human.stdout)).toMatch(
        /\nhooks\n\s+claude\s+: WARN missing: no `mu hook stop claude/,
      );
      const j = await runCliJson(["doctor", "--json"], join(tmp, "mu.db"));
      expect(j.data.hooks).toEqual([expect.objectContaining({ name: "claude", severity: "warn" })]);
    });
  });

  it("says so when no harness is set up here", async () => {
    await withEnv("MU_INIT_HOME", home, async () => {
      const human = await runCli(["doctor"], join(tmp, "mu.db"));
      expect(plain(human.stdout)).toMatch(
        /\nhooks\n\s+mu hook stop\s+: ok no claude, codex or cursor-agent config here/,
      );
    });
  });
});
