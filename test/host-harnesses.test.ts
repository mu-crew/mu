// What a host can run (spec D17, U21): `host check` probes each harness's
// literal launcher through the profile's own shell mode, reads each hook
// harness's config for murmur's and mu's entries, and records the result and
// its time on the profile (`host_profiles.capabilities`). The pi steps run
// only on a host with pi, so a claude-only host passes, and a spawn for a
// harness the host lacks is refused with a typed error before any effect.
// Fake templates through /bin/sh; the "host" is a temp HOME and a bin of shims.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCommandGate, spawnAgent } from "../src/agents/spawn.js";
import { getAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  HostHarnessMissingError,
  harnessProbeScript,
  hostCapabilities,
  parseHarnessProbe,
  recordHostCapabilities,
  refuseMissingHarness,
} from "../src/host-harnesses.js";
import { addHost, checkHost, getHost, listHostChannels } from "../src/hosts.js";
import { rmFixtureDir } from "./_fs.js";
import { fakePlugin, linkSeam } from "./_plugin.js";
import { registerFixturePlugin } from "./_plugin-handshake.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let bin: string;
let home: string;
let cmds: string;
let oldPath: string | undefined;
let oldShell: string | undefined;

function shim(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** A hook config file under the fake host's HOME. */
function config(rel: string, commands: string[]): void {
  const path = join(home, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  const hooks = { Stop: [{ hooks: commands.map((command) => ({ type: "command", command })) }] };
  writeFileSync(path, JSON.stringify({ hooks }, null, 2));
}

/**
 * codex's own record that it trusts hooks: one `[hooks.state."<codex home>/hooks.json:<event>:<group>:<handler>"]`
 * table with a `trusted_hash` per handler, in config.toml beside hooks.json (codex 0.150+).
 */
function trust(codexHome: string, keys: string[], file = join(codexHome, "config.toml")): void {
  mkdirSync(codexHome, { recursive: true });
  const tables = keys.map(
    (k) => `[hooks.state."${codexHome}/hooks.json:${k}"]\ntrusted_hash = "sha256:00"\n`,
  );
  writeFileSync(file, `model = "x"\n\n[hooks.state]\n\n${tables.join("\n")}`);
}

type Step = { step: string; ok: boolean | null; detail: string };
const stepsOf = (r: { steps: Step[] }) => r.steps.map((s) => [s.step, s.ok]);
const stepOf = (r: { steps: Step[] }, name: string) => r.steps.find((s) => s.step === name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-host-harness-"));
  dbPath = join(dir, "mu.db");
  bin = join(dir, "bin");
  home = join(dir, "home");
  cmds = join(dir, "cmds");
  mkdirSync(bin);
  mkdirSync(home);
  // A login shell that runs no rc file, so nothing this machine has installed leaks in.
  shim("login-sh", '[ "$1" = -ilc ] && shift\nexec /bin/sh -c "$1"');
  oldPath = process.env.PATH;
  oldShell = process.env.SHELL;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.SHELL = join(bin, "login-sh");
  db = openDb({ path: dbPath });
  // A lease profile: the job's bare `sh -c`, with the host's own HOME.
  addHost(db, {
    name: "dev",
    shell: "c --job-file {job_file} -L {local_sock}:{remote_sock} -- env {env} sh -c {cmd}",
    exec: `printf '%s\\n' {cmd} >> ${cmds}; HOME=${home} sh -c {cmd}`,
    fetch: "true",
    repo: null,
    max_sessions: null,
    transport: "lease",
    stop: "echo {job}",
  });
});

afterEach(() => {
  process.env.PATH = oldPath;
  if (oldShell === undefined) {
    const k = "SHELL";
    delete process.env[k];
  } else process.env.SHELL = oldShell;
  db.close();
  rmFixtureDir(dir);
});

describe("the harness probe in host check", () => {
  it("a mule plugin profile without pi says pi is not needed for a remote workspace (--mule)", async () => {
    // No harness shim: the fake plugin's link.exec runs with this process's HOME, so a hooks
    // step would read the machine's real harness config.
    const f = fakePlugin(dir, { home, seams: linkSeam() }, "mule");
    await registerFixturePlugin(db, f);
    addHost(db, { name: "m", plugin: "mule", fetch: "true", repo: null, max_sessions: null });
    const r = await checkHost(db, "m");
    expect(r.ok).toBe(true);
    expect(stepOf(r, "pi")).toMatchObject({
      ok: null,
      detail: expect.stringContaining("not needed for a remote workspace (--mule)"),
    });
    expect(stepOf(r, "extension")?.ok).toBeNull();
  });

  it("a mule plugin profile with no remote harness still passes: harnesses are for --host spawns", async () => {
    const f = fakePlugin(dir, { home, seams: linkSeam() }, "mule");
    await registerFixturePlugin(db, f);
    addHost(db, { name: "m", plugin: "mule", fetch: "true", repo: null, max_sessions: null });
    const r = await checkHost(db, "m");
    expect(r.ok).toBe(true);
    expect(stepOf(r, "harnesses")).toMatchObject({
      ok: null,
      detail: expect.stringContaining("not needed for a remote workspace (--mule)"),
    });
  });

  it("a claude-only host passes: pi steps skipped, claude and its hooks found, the probe recorded", async () => {
    shim("claude", "exit 0");
    config(".claude/settings.json", ["murmur hook claude", "mu hook stop claude --timeout 600"]);
    const before = Date.now();
    const r = await checkHost(db, "dev");
    expect(r.ok).toBe(true);
    expect(stepsOf(r)).toEqual([
      ["shell", true],
      ["stop", true],
      ["reachable", true],
      ["repo", null],
      ["harnesses", true],
      ["hooks", true],
      ["pi", null],
      ["extension", null],
    ]);
    expect(stepOf(r, "harnesses")?.detail).toBe(
      `claude (${join(bin, "claude")}); not found: codex, cursor-agent, muse, pi`,
    );
    expect(stepOf(r, "pi")?.detail).toBe("skipped: the host has no pi");
    expect(r.warnings).toEqual([]);
    // pi was never asked for.
    expect(readFileSync(cmds, "utf8")).not.toContain("pi --version");
    const caps = hostCapabilities(getHost(db, "dev"));
    expect(caps).toMatchObject({
      shell: "sh",
      harnesses: {
        claude: { command: join(bin, "claude"), murmurHooks: true, muHooks: true },
        codex: { command: null, murmurHooks: false, muHooks: false },
        muse: { command: null, muHooks: null },
        pi: { command: null, murmurHooks: null, muHooks: null },
      },
    });
    expect(Date.parse(caps?.probedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);
    expect(r.capabilities).toEqual(caps);
  });

  it("a hook harness without murmur's entries fails the hooks step; without mu's only warns", async () => {
    shim("claude", "exit 0");
    shim("codex", "exit 0");
    config(".claude/settings.json", ["murmur hook claude"]);
    config(".codex/hooks.json", ["murmur notify", "mu hook stop codex"]);
    const r = await checkHost(db, "dev");
    expect(r.ok).toBe(false);
    expect(stepOf(r, "hooks")).toMatchObject({ ok: false });
    expect(stepOf(r, "hooks")?.detail).toMatch(
      /codex: no `murmur hook codex` entry in \$\{CODEX_HOME:-~\/\.codex\}\/hooks\.json/,
    );
    expect(stepOf(r, "hooks")?.detail).not.toContain("claude:");
    expect(r.warnings).toEqual([expect.stringContaining("claude: no `mu hook stop claude` entry")]);
  });

  it("codex with no hook trust recorded warns with a fix that runs on any codex; it never fails the step", async () => {
    shim("codex", "exit 0");
    config(".codex/hooks.json", ["murmur hook codex", "mu hook stop codex"]);
    // The folder trust got written, the hook trust did not (bug 7: "Trust all" left no hashes).
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '[projects."/w"]\ntrust_level = "trusted"\n',
    );
    const r = await checkHost(db, "dev");
    expect(stepOf(r, "hooks")).toMatchObject({ ok: true });
    const warning = r.warnings.find((w) => w.includes("trusted hook")) ?? "";
    expect(warning).toContain("records no trusted hook");
    expect(warning).toContain("run `codex` once");
    expect(warning).not.toContain("--no-daemon");
    expect(warning).toContain("mu cannot check each hook's trust");
    expect(hostCapabilities(getHost(db, "dev"))?.harnesses.codex.trustedHashes).toBe(0);
  });

  it("any recorded trust is no warning, whatever its TOML quoting (review repro): mu does not judge per hook", async () => {
    shim("codex", "exit 0");
    config(".codex/hooks.json", ["murmur hook codex"]);
    const codexHome = join(home, ".codex");
    for (const key of [
      `[hooks.state."${codexHome}/hooks.json:stop:0:0"]`,
      `[hooks.state.'${codexHome}/hooks.json:stop:0:0']`,
    ]) {
      writeFileSync(join(codexHome, "config.toml"), `${key}\ntrusted_hash = "sha256:00"\n`);
      const r = await checkHost(db, "dev");
      expect(stepOf(r, "hooks")).toMatchObject({ ok: true });
      expect(r.warnings.filter((w) => w.includes("trusted hook"))).toEqual([]);
    }
  });

  it("reads codex's config.toml where CODEX_HOME moves it; no codex, no trust line", () => {
    const probe = (env: Record<string, string>, path = `${bin}:/usr/bin:/bin`) =>
      parseHarnessProbe(
        execFileSync("/bin/sh", ["-c", harnessProbeScript()], {
          env: { HOME: home, PATH: path, ...env },
          encoding: "utf8",
        }),
        "sh",
      )?.harnesses.codex.trustedHashes;
    shim("codex", "exit 0");
    trust(join(home, "moved"), ["stop:0:0", "stop:0:1"]);
    expect(probe({ CODEX_HOME: join(home, "moved") })).toBe(2);
    expect(probe({})).toBe(0);
    expect(probe({}, "/usr/bin:/bin")).toBeUndefined();
  });

  it("records --no-daemon only for a codex whose --help lists it (0.155 has none and refuses it)", () => {
    const probe = () =>
      parseHarnessProbe(
        execFileSync("/bin/sh", ["-c", harnessProbeScript()], {
          env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
          encoding: "utf8",
        }),
        "sh",
      )?.harnesses;
    shim("codex", '[ "$1" = --help ] && printf "Usage: codex\\n  -m, --model <MODEL>\\n"; exit 0');
    expect(probe()?.codex.launchFlags).toEqual([]);
    shim(
      "codex",
      '[ "$1" = --help ] && printf "Usage: codex\\n      --no-daemon  Run in-process\\n"; exit 0',
    );
    expect(probe()?.codex.launchFlags).toEqual(["--no-daemon"]);
    // A longer flag is not the flag; no codex, no line; other rows have none to probe.
    shim("codex", '[ "$1" = --help ] && printf "      --no-daemon-x\\n"; exit 0');
    expect(probe()?.codex.launchFlags).toEqual([]);
    expect(probe()?.claude.launchFlags).toBeUndefined();
  });

  it("a longer harness name in a config is not the harness's entry; muse is never asked for mu's", async () => {
    shim("muse", "exit 0");
    config(".config/muse/settings.json", ["murmur hook muse-x"]);
    const r = await checkHost(db, "dev");
    expect(stepOf(r, "hooks")).toMatchObject({ ok: false });
    config(".config/muse/settings.json", ["/opt/bin/murmur hook muse"]);
    const ok = await checkHost(db, "dev");
    expect(stepOf(ok, "hooks")).toMatchObject({ ok: true, detail: "muse: murmur hook muse" });
    expect(ok.warnings).toEqual([]);
    expect(hostCapabilities(getHost(db, "dev"))?.harnesses.muse).toEqual({
      command: join(bin, "muse"),
      murmurHooks: true,
      muHooks: null,
    });
  });

  it("a host with pi and claude runs the pi steps too", async () => {
    shim("claude", "exit 0");
    config(".claude/settings.json", ["murmur hook claude", "mu hook stop claude"]);
    shim(
      "pi",
      'if [ "$1" = "--version" ]; then echo 0.99.1; elif [ "$1" = list ]; then echo "  npm:@mu-crew/mu"; fi',
    );
    const r = await checkHost(db, "dev");
    expect(r.ok).toBe(true);
    expect(stepOf(r, "pi")).toMatchObject({ ok: true, detail: "0.99.1" });
    expect(stepOf(r, "extension")).toMatchObject({ ok: true });
  });

  it("a session profile probes through the login shell and records it", async () => {
    addHost(db, {
      name: "sess",
      shell: "ssh -o ControlMaster=no -o ControlPath=none h {local_sock}:{remote_sock}",
      exec: `printf '%s\\n' {cmd} >> ${cmds}; HOME=${home} sh -c {cmd}`,
      fetch: "true",
      repo: null,
      max_sessions: null,
    });
    shim("codex", "exit 0");
    config(".codex/hooks.json", ["murmur hook codex", "mu hook stop codex"]);
    const r = await checkHost(db, "sess");
    expect(stepOf(r, "harnesses")).toMatchObject({ ok: true });
    const handed = readFileSync(cmds, "utf8");
    expect(handed).toMatch(/-ilc/);
    expect(handed).toContain("MU_HARNESS");
    expect(hostCapabilities(getHost(db, "sess"))?.shell).toBe("login");
  });

  it("an answer with no harness report still runs the pi steps, and records nothing", async () => {
    shim(
      "pi",
      'if [ "$1" = "--version" ]; then echo 0.99.1; elif [ "$1" = list ]; then echo "  npm:@mu-crew/mu"; fi',
    );
    // The host answers the probe exit 0 with something else; every other command runs.
    db.prepare("UPDATE host_profiles SET exec = ? WHERE name = 'dev'").run(
      `case {cmd} in *MU_HARNESS*) echo welcome ;; *) HOME=${home} sh -c {cmd} ;; esac`,
    );
    const r = await checkHost(db, "dev");
    expect(stepOf(r, "harnesses")).toEqual({
      step: "harnesses",
      ok: false,
      detail: "the host printed no harness report",
    });
    expect(stepOf(r, "hooks")).toMatchObject({ ok: null, detail: "skipped: no harness report" });
    expect(stepOf(r, "pi")).toMatchObject({ ok: true, detail: "0.99.1" });
    expect(stepOf(r, "extension")).toMatchObject({ ok: true });
    expect(r.capabilities).toBeUndefined();
    expect(getHost(db, "dev").capabilities ?? null).toBeNull();
  });

  it("an unreachable host records nothing", async () => {
    db.prepare("UPDATE host_profiles SET exec = 'exit 255'").run();
    const r = await checkHost(db, "dev");
    expect(stepOf(r, "harnesses")).toMatchObject({ ok: null });
    expect(getHost(db, "dev").capabilities ?? null).toBeNull();
    expect(r.capabilities).toBeUndefined();
  });
});

describe("the probe's record", () => {
  it("parses the script's answer, rc noise and all; a missing harness line is no answer", () => {
    const out = [
      "welcome to the host",
      "MU_HARNESS claude 1 0 /usr/bin/claude",
      "MU_HARNESS codex 0 0 ",
      "MU_HARNESS cursor-agent 0 0 /opt/my tools/cursor-agent",
      "MU_HARNESS muse 1 - ",
      "MU_HARNESS pi - - /usr/local/bin/pi",
    ].join("\n");
    const caps = parseHarnessProbe(out, "login", new Date("2026-11-05T10:00:00Z"));
    expect(caps).toEqual({
      probedAt: "2026-11-05T10:00:00.000Z",
      shell: "login",
      harnesses: {
        claude: { command: "/usr/bin/claude", murmurHooks: true, muHooks: false },
        codex: { command: null, murmurHooks: false, muHooks: false },
        "cursor-agent": {
          command: "/opt/my tools/cursor-agent",
          murmurHooks: false,
          muHooks: false,
        },
        muse: { command: null, murmurHooks: true, muHooks: null },
        pi: { command: "/usr/local/bin/pi", murmurHooks: null, muHooks: null },
      },
    });
    expect(parseHarnessProbe(out.split("\n").slice(0, 3).join("\n"), "sh")).toBeUndefined();
    expect(hostCapabilities({ capabilities: JSON.stringify(caps) })).toEqual(caps);
    expect(hostCapabilities({ capabilities: "{not json" })).toBeUndefined();
    expect(hostCapabilities({ capabilities: null })).toBeUndefined();
  });

  it("reads claude's and codex's file where CLAUDE_CONFIG_DIR and CODEX_HOME move it, in the host's shell", () => {
    const probe = (env: Record<string, string>) =>
      parseHarnessProbe(
        execFileSync("/bin/sh", ["-c", harnessProbeScript()], {
          env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
          encoding: "utf8",
        }),
        "sh",
      );
    config(".claude/settings.json", ["murmur hook claude"]);
    config(".codex/hooks.json", ["murmur hook codex"]);
    config("moved-codex/hooks.json", ["murmur hook codex", "mu hook stop codex"]);
    const moved = probe({ CODEX_HOME: join(home, "moved-codex"), CLAUDE_CONFIG_DIR: "" });
    // an empty CLAUDE_CONFIG_DIR is unset: claude's stays under HOME
    expect(moved?.harnesses.claude.murmurHooks).toBe(true);
    expect(moved?.harnesses.codex).toMatchObject({ murmurHooks: true, muHooks: true });
    const elsewhere = probe({ CLAUDE_CONFIG_DIR: join(home, "nowhere") });
    expect(elsewhere?.harnesses.claude.murmurHooks).toBe(false);
    expect(elsewhere?.harnesses.codex).toMatchObject({ murmurHooks: true, muHooks: false });
  });

  it("the script never exits 3 (that is a hand-back)", () => {
    expect(harnessProbeScript()).not.toMatch(/exit 3/);
  });

  it("is stored only on the profile it was probed through", () => {
    const caps = parseHarnessProbe(
      ["claude", "codex", "cursor-agent", "muse", "pi"]
        .map((h) => `MU_HARNESS ${h} - - `)
        .join("\n"),
      "sh",
    );
    if (caps === undefined) throw new Error("no caps");
    const p = getHost(db, "dev");
    expect(recordHostCapabilities(db, { ...p, exec: "something else" }, caps)).toBe(false);
    expect(getHost(db, "dev").capabilities ?? null).toBeNull();
    expect(recordHostCapabilities(db, p, caps)).toBe(true);
    expect(hostCapabilities(getHost(db, "dev"))).toEqual(caps);
  });
});

describe("a spawn for a harness the host lacks", () => {
  const probeClaudeOnly = async (): Promise<void> => {
    shim("claude", "exit 0");
    config(".claude/settings.json", ["murmur hook claude"]);
    await checkHost(db, "dev");
  };

  it("fails with the typed error naming host and harness, before any effect", async () => {
    await probeClaudeOnly();
    const execs = readFileSync(cmds, "utf8");
    for (const cli of ["codex", "pi"]) {
      const err = await spawnAgent(db, {
        name: "worker-1",
        workstream: "auth",
        cli,
        host: "dev",
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HostHarnessMissingError);
      expect(err).toMatchObject({ host: "dev", harness: cli });
      expect((err as Error).message).toContain(`host dev has no ${cli}`);
    }
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(listHostChannels(db, "dev")).toEqual([]);
    expect(readFileSync(cmds, "utf8")).toBe(execs);
  });

  it("the CLI exits 2 with the message", async () => {
    await probeClaudeOnly();
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--cli", "codex", "--host", "dev", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(2);
    expect(String(r.doc.message)).toContain("host dev has no codex");
  });

  it("refuses only what the probe tried: an unprobed host, a wrapper, a gate and a found harness pass", async () => {
    const unprobed = getHost(db, "dev");
    expect(() => refuseMissingHarness(unprobed, "codex", "codex")).not.toThrow();
    await probeClaudeOnly();
    const p = getHost(db, "dev");
    expect(() => refuseMissingHarness(p, "codex", "codex --model x")).toThrow(
      HostHarnessMissingError,
    );
    expect(() => refuseMissingHarness(p, "codex", "codex-big")).not.toThrow();
    expect(() => refuseMissingHarness(p, "codex", "/opt/codex/bin/codex")).not.toThrow();
    expect(() => refuseMissingHarness(p, "claude", "claude")).not.toThrow();
    expect(() => refuseMissingHarness(p, undefined, "npm test")).not.toThrow();
  });
});

describe("isCommandGate: harness launchers are agents (spec D17)", () => {
  const gate = (cli: string | undefined, command: string) =>
    isCommandGate({ host: "dev", ...(cli !== undefined ? { cli } : {}), command });

  it("a command or cli key that maps to a hook harness row is a worker", () => {
    expect(gate(undefined, "claude --model opus")).toBe(false);
    expect(gate(undefined, "/usr/local/bin/codex")).toBe(false);
    expect(gate(undefined, "cursor-agent")).toBe(false);
    expect(gate("claude-big", "my-wrapper --x")).toBe(false);
    expect(gate("muse", "launch.sh")).toBe(false);
  });

  it("pi keeps its rule; anything else with --command is still a gate", () => {
    expect(gate("pi", "anything")).toBe(false);
    expect(gate(undefined, "pi-meta --no-solo")).toBe(false);
    expect(gate(undefined, "npm test")).toBe(true);
    expect(gate("pi-meta", "npm test")).toBe(true);
    expect(gate("tests", "make check")).toBe(true);
    expect(isCommandGate({ cli: "claude", command: "npm test" })).toBe(false);
    expect(isCommandGate({ host: "dev", cli: "claude" })).toBe(false);
  });
});

describe("host show and list name what the probe found", () => {
  it("--json carries the parsed record; the table has a harnesses column", async () => {
    const unprobed = await runCliJson(["host", "show", "dev", "--json"], dbPath);
    expect(unprobed.data.host.capabilities).toBeNull();
    shim("claude", "exit 0");
    config(".claude/settings.json", ["murmur hook claude"]);
    await checkHost(db, "dev");
    const shown = await runCliJson(["host", "show", "dev", "--json"], dbPath);
    expect(shown.data.host.capabilities.harnesses.claude.command).toBe(join(bin, "claude"));
    const listed = await runCliJson(["host", "list", "--json"], dbPath);
    expect(JSON.stringify(listed.data)).toContain(join(bin, "claude"));
    expect((await runCli(["host", "list"], dbPath)).stdout).toMatch(/HARNESSES[\s\S]*claude/);
    expect((await runCli(["host", "show", "dev"], dbPath)).stdout).toContain(
      "harnesses: claude (probed ",
    );
  });
});
