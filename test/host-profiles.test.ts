// Host profiles (v_host_profiles): the template grammar, profile storage and
// the print-only `host init`. mu stays ssh-free: every test runs fake
// templates through /bin/sh, never ssh.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  addHost,
  expandHostTemplate,
  getHost,
  HostExistsError,
  HostNotFoundError,
  HostTemplateError,
  hostEnvWords,
  hostStarter,
  listHosts,
  removeHost,
  validateHostTemplate,
} from "../src/hosts.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-host-prof-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

const V = { env: "", cmd: "", local_sock: "/l.sock", remote_sock: "/r.sock", cwd: "/w" };
/** Run an expanded template through /bin/sh, like the real thing. */
const sh = (expanded: string): string =>
  execFileSync("/bin/sh", ["-c", expanded], { encoding: "utf8" });

const NASTY = [
  "plain",
  "has space",
  "it's quoted",
  'say "hi"',
  "$HOME `id` $(id)",
  "back\\slash",
  "line\nbreak",
  "{cmd} {env} {{x}}",
  "semi; echo pwned",
  "-n",
];

describe("template grammar", () => {
  it.each(NASTY)("unquoted: %j reaches the program as ONE exact word", (value) => {
    expect(sh(expandHostTemplate("printf %s {cmd}", { ...V, cmd: value }))).toBe(value);
  });

  // Quote characters never imply a second shell (finding_host_template_quote_context):
  // an ordinary quoted local argument receives the value itself.
  it.each(NASTY)("inside single quotes, one layer: %j is the argument itself", (value) => {
    expect(sh(expandHostTemplate("printf %s '{cwd}'", { ...V, cwd: value }))).toBe(value);
  });

  it.each(NASTY)("inside double quotes, one layer: %j is the argument itself", (value) => {
    expect(sh(expandHostTemplate('printf %s "{cwd}"', { ...V, cwd: value }))).toBe(value);
  });

  it.each(NASTY)("sh -c '...{cmd:sh}' (two layers, asked for): %j stays atomic", (value) => {
    expect(sh(expandHostTemplate("sh -c 'printf %s {cmd:sh}'", { ...V, cmd: value }))).toBe(value);
  });

  it.each(NASTY)('sh -c "...{cmd:sh}" (two layers, asked for): %j stays atomic', (value) => {
    expect(sh(expandHostTemplate('sh -c "printf %s {cmd:sh}"', { ...V, cmd: value }))).toBe(value);
  });

  it.each(NASTY)("unquoted {cmd:sh}: %j is one word quoted for the second shell", (value) => {
    // The program receives the second shell's text; running that text recovers the value.
    const text = sh(expandHostTemplate("printf %s {cmd:sh}", { ...V, cmd: value }));
    expect(sh(`printf %s ${text}`)).toBe(value);
  });

  it("refuses an unknown modifier, and {env:sh}", () => {
    expect(() => expandHostTemplate("{cmd:zsh}", V)).toThrow(/modifier/);
    expect(() => expandHostTemplate("{cmd:}", V)).toThrow(HostTemplateError);
    expect(() => expandHostTemplate("{env:sh}", V)).toThrow(/env:sh/);
  });

  it("one pass: braces inside a replacement are never rescanned", () => {
    const out = expandHostTemplate("{cmd} {cwd}", { ...V, cmd: "{cwd}", cwd: "{cmd}" });
    expect(out).toBe("'{cwd}' '{cmd}'");
  });

  it("every placeholder expands; each is replaced once per occurrence", () => {
    const out = expandHostTemplate("{local_sock}:{remote_sock} {cwd} {cwd}", V);
    expect(out).toBe("'/l.sock':'/r.sock' '/w' '/w'");
  });

  it("{{ and }} are literal braces", () => {
    expect(sh(expandHostTemplate("sh -c 'printf %s {{{cmd:sh}}}'", { ...V, cmd: "x" }))).toBe(
      "{x}",
    );
  });

  it.each(["{nope}", "{CMD}", "{}", "{ cmd}", "{cmd", "cmd}", "$" + "{HOME}"])(
    "rejects %j (unknown placeholder or stray brace)",
    (t) => {
      expect(() => expandHostTemplate(t, V)).toThrow(HostTemplateError);
    },
  );

  it("a placeholder with no value in this context is refused, not blanked", () => {
    expect(() => expandHostTemplate("ssh dev {cmd}", { cwd: "/w" })).toThrow(/\{cmd\}/);
  });

  it("refuses a placeholder inside $(...) or backticks within double quotes, and after a backslash", () => {
    expect(() => expandHostTemplate('echo "$(echo {cmd})"', V)).toThrow(HostTemplateError);
    expect(() => expandHostTemplate('echo "`echo {cmd}`"', V)).toThrow(HostTemplateError);
    expect(() => expandHostTemplate("echo \\{cmd}", V)).toThrow(HostTemplateError);
  });

  it("a NUL byte in a value is refused", () => {
    expect(() => expandHostTemplate("{cmd}", { ...V, cmd: "a\0b" })).toThrow(HostTemplateError);
  });

  it("validateHostTemplate accepts what expand accepts and rejects the rest", () => {
    expect(() => validateHostTemplate("ssh dev {cmd}")).not.toThrow();
    expect(() => validateHostTemplate("ssh {host} {cmd}")).toThrow(HostTemplateError);
  });
});

describe("{env}: whitelisted remote identity only", () => {
  const ids = {
    MU_MANAGED_AGENT: "1",
    MU_AGENT_NAME: "worker-1",
    MU_WORKSTREAM: "auth",
    MU_CTL_SOCK: "/tmp/mu-1000/auth/worker-1.sock",
  };

  const WEIRD = [
    "has space",
    "it's",
    "$HOME",
    "line\nbreak",
    'q"uote',
    "`id`",
    "back\\slash",
    "semi; echo pwned",
    "",
    "{cmd}",
  ];

  it.each(WEIRD)(
    "a MU_CTL_SOCK of %j round-trips through the local shell (unquoted {env})",
    (v) => {
      const env = hostEnvWords({ ...ids, MU_CTL_SOCK: v });
      const out = sh(`env -i ${expandHostTemplate("{env}", { ...V, env })} printenv MU_CTL_SOCK`);
      expect(out).toBe(`${v}\n`);
    },
  );

  it.each(WEIRD)("%j round-trips through {env} written inside a second shell's text", (v) => {
    const env = hostEnvWords({ MU_CTL_SOCK: v });
    for (const q of ["'", '"']) {
      const t = `sh -c ${q}env -i {env} printenv MU_CTL_SOCK${q}`;
      expect(sh(expandHostTemplate(t, { ...V, env }))).toBe(`${v}\n`);
    }
  });

  it("empty env is a valid fragment that expands to nothing", () => {
    expect(hostEnvWords({})).toBe("");
    expect(sh(expandHostTemplate("env -i {env} printenv", { ...V, env: "" }))).toBe("");
  });

  it("builds assignment words that really are the only variables a command sees", () => {
    const env = hostEnvWords(ids);
    const out = sh(expandHostTemplate("env -i {env} printenv", { ...V, env }));
    expect(out.trim().split("\n").sort()).toEqual(
      Object.entries(ids)
        .map(([k, v]) => `${k}=${v}`)
        .sort(),
    );
  });

  it.each(["MU_DB_PATH", "MU_SYNC_DIR", "MU_STATE_DIR", "PATH", "LD_PRELOAD"])(
    "refuses the non-whitelisted key %s (no local DB, state or sync forwarded)",
    (k) => {
      expect(() => hostEnvWords({ ...ids, [k]: "/x" })).toThrow(HostTemplateError);
    },
  );

  it("expand refuses an {env} value that is not whitelisted assignment words", () => {
    expect(() => expandHostTemplate("{env}", { ...V, env: "MU_DB_PATH=/x" })).toThrow(
      HostTemplateError,
    );
    expect(() => expandHostTemplate("{env}", { ...V, env: "MU_AGENT_NAME=a; rm -rf /" })).toThrow(
      HostTemplateError,
    );
    expect(() =>
      expandHostTemplate("{env}", { ...V, env: "MU_AGENT_NAME='a' MU_DB_PATH='/x'" }),
    ).toThrow(HostTemplateError);
    expect(() => expandHostTemplate("{env}", { ...V, env: "MU_AGENT_NAME='a'; rm -rf /" })).toThrow(
      HostTemplateError,
    );
    expect(() => hostEnvWords({ MU_AGENT_NAME: "a\0b" })).toThrow(HostTemplateError);
  });
});

describe("profile storage", () => {
  const base = {
    name: "dev",
    shell: "sh -c {cmd}",
    exec: "sh -c {cmd}",
    fetch: "true",
    repo: "/r",
    max_sessions: null,
  };

  it("add / get / list / remove round-trips the exact fields", () => {
    expect(addHost(db, { ...base, max_sessions: 2 })).toEqual({ ...base, max_sessions: 2 });
    addHost(db, { ...base, name: "aaa" });
    expect(getHost(db, "dev")).toEqual({ ...base, max_sessions: 2 });
    expect(listHosts(db).map((h) => h.name)).toEqual(["aaa", "dev"]);
    expect(removeHost(db, "dev")).toBe(true);
    expect(removeHost(db, "dev")).toBe(false);
    expect(() => getHost(db, "dev")).toThrow(HostNotFoundError);
  });

  it("refuses a duplicate name and leaves the first profile alone", () => {
    addHost(db, base);
    expect(() => addHost(db, { ...base, repo: "/other" })).toThrow(HostExistsError);
    expect(getHost(db, "dev").repo).toBe("/r");
  });

  it("rejects a bad template, name or cap with nothing stored", () => {
    expect(() => addHost(db, { ...base, shell: "ssh {nope}" })).toThrow(HostTemplateError);
    expect(() => addHost(db, { ...base, name: "Bad Name" })).toThrow(/host name/);
    expect(() => addHost(db, { ...base, max_sessions: 0 })).toThrow(/max-sessions/);
    expect(() => addHost(db, { ...base, repo: "" })).toThrow(/repo/);
    expect(listHosts(db)).toEqual([]);
  });

  it("host profiles leave no ops (machine-local)", () => {
    const before = (db.prepare("SELECT COUNT(*) AS c FROM ops").get() as { c: number }).c;
    addHost(db, base);
    removeHost(db, "dev");
    expect((db.prepare("SELECT COUNT(*) AS c FROM ops").get() as { c: number }).c).toBe(before);
  });
});

describe("mu host (CLI)", () => {
  const add = [
    "host",
    "add",
    "dev",
    "--shell",
    "sh -c {cmd}",
    "--exec",
    "sh -c {cmd}",
    "--fetch",
    "true",
    "--repo",
    "/r",
  ];

  it("add, list, show, rm", async () => {
    const a = await runCliJson([...add, "--max-sessions", "2", "--json"], dbPath);
    expect(a.exitCode).toBeNull();
    expect(a.data).toMatchObject({ host: { name: "dev", max_sessions: 2, repo: "/r" } });
    const l = await runCliJson(["host", "list", "--json"], dbPath);
    expect(l.data.items.map((h: { name: string }) => h.name)).toEqual(["dev"]);
    const s = await runCliJson(["host", "show", "dev", "--json"], dbPath);
    expect(s.data.host).toMatchObject({ shell: "sh -c {cmd}" });
    expect(s.data.channels).toEqual([]);
    const human = await runCli(["host", "list"], dbPath);
    expect(human.stdout).toContain("dev");
    const r = await runCliJson(["host", "rm", "dev", "--json"], dbPath);
    expect(r.data).toMatchObject({ removed: true });
  });

  it("maps typed errors to exit codes: unknown 3, duplicate 4, bad template 2", async () => {
    expect((await runCli(["host", "show", "nope"], dbPath)).exitCode).toBe(3);
    await runCli(add, dbPath);
    expect((await runCli(add, dbPath)).exitCode).toBe(4);
    const bad = [
      "host",
      "add",
      "x",
      "--shell",
      "ssh {nope}",
      "--exec",
      "e",
      "--fetch",
      "f",
      "--repo",
      "/r",
    ];
    const r = await runCli(bad, dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("{nope}");
  });

  it("rm refuses a host that still holds a channel", async () => {
    await runCli(add, dbPath);
    db.prepare(
      "INSERT INTO host_channels (host, holder, kind, token, pid, opened_at) VALUES ('dev', 'exec:x', 'transient', 't', ?, 'n')",
    ).run(process.pid);
    const r = await runCli(["host", "rm", "dev"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("exec:x");
  });
});

describe("host init --ssh prints a starter and never runs it", () => {
  it("prints templates that validate, and executes nothing (an ssh on PATH is never called)", async () => {
    const bin = join(dir, "bin");
    const marker = join(dir, "ssh-ran");
    execFileSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const r = await runCli(["host", "init", "dev", "--ssh"], dbPath);
      expect(r.exitCode).toBeNull();
      expect(r.stdout).toContain("mu host add dev");
      expect(r.stdout).toContain("{local_sock}:{remote_sock}");
      expect(r.stdout).toContain("ssh");
    } finally {
      process.env.PATH = oldPath;
    }
    expect(existsSync(marker)).toBe(false);
    expect(listHosts(db)).toEqual([]);
  });

  it("the starter's fields all pass the grammar, with the host name as the ssh target", () => {
    const s = hostStarter("dev");
    for (const t of [s.shell, s.exec, s.fetch]) expect(() => validateHostTemplate(t)).not.toThrow();
    expect(s.shell).toContain("-L {local_sock}:{remote_sock}");
    expect(s.shell).toContain("dev");
  });

  it("the expanded starter, run through a local ssh stand-in, hands the remote shell the cd, whitelisted env and command", () => {
    const fake = join(dir, "bin2");
    execFileSync("mkdir", ["-p", fake]);
    // Not ssh: skips every option and the host, then runs the last argument in a clean environment, as a remote login shell would (ssh forwards no local variables).
    writeFileSync(
      join(fake, "ssh"),
      '#!/bin/sh\nfor last; do :; done\nexec env -i PATH="$PATH" SHELL="$SHELL" /bin/sh -c "$last"\n',
    );
    chmodSync(join(fake, "ssh"), 0o755);
    const work = join(dir, "work dir");
    execFileSync("mkdir", ["-p", work]);
    const env = hostEnvWords({
      MU_MANAGED_AGENT: "1",
      MU_AGENT_NAME: "w-1",
      MU_WORKSTREAM: "auth",
    });
    const cmd = 'printf \'%s|%s|%s\' "$PWD" "$MU_AGENT_NAME" "$(printenv MU_DB_PATH || echo none)"';
    const line = expandHostTemplate(hostStarter("dev").shell, { ...V, env, cmd, cwd: work });
    const out = execFileSync("/bin/sh", ["-c", line], {
      encoding: "utf8",
      env: {
        PATH: `${fake}:${process.env.PATH}`,
        SHELL: "/bin/sh",
        MU_DB_PATH: "/secret/local.db",
      },
    });
    expect(out).toBe(`${work}|w-1|none`);
  });

  it("needs --ssh (it is the only starter) and a safe host name", async () => {
    expect((await runCli(["host", "init", "dev"], dbPath)).exitCode).toBe(2);
    expect((await runCli(["host", "init", "dev;rm", "--ssh"], dbPath)).exitCode).toBe(2);
  });
});
