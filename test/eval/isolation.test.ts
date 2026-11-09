// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  type HookTools,
  murmurShim,
  muzzleShim,
  writeToolShims,
} from "../../tools/eval/harness.ts";
import {
  ISOLATION_VARS,
  judgeRealState,
  pinScript,
  realStatePaths,
  settleWatch,
  shellStartupEnv,
  watchRealState,
  writeShellStartup,
} from "../../tools/eval/isolation.ts";
import { muShim, sandboxEnv, writeIsolatedShims } from "../../tools/eval/sandbox.ts";
import { remoteEnv } from "../../tools/eval/ssh-args.ts";
import type { Surface } from "../../tools/eval/types.ts";

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
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

const WATCHED = [...ISOLATION_VARS, "MU_PI_COMMAND", "MU_CLAUDE_COMMAND", "PATH"];

/** A node script that prints the watched variables as JSON: the build a shim runs. */
function envPrinter(d: string): string {
  const cli = join(d, "print-env.js");
  writeFileSync(
    cli,
    `const k = ${JSON.stringify(WATCHED)};\nprocess.stdout.write(JSON.stringify(Object.fromEntries(k.map((x) => [x, process.env[x] ?? null]))) + "\\n");\n`,
  );
  return cli;
}

/** A live sandbox's env (a sandbox dir that is never created) and its pins. */
function liveSandbox(extra: Record<string, string> = {}) {
  const dir = tmp("iso-sb-");
  const env = {
    ...sandboxEnv(
      dir,
      surface,
      "mu-eval-sock",
      { PATH: "/usr/bin:/bin", HOME: "/home/real" },
      {
        live: true,
      },
    ),
    ...extra,
  };
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  return { dir, env, bin, pin: pinScript(env, bin) };
}

/** The env a user's shell rc and tmux's global env hand a harness's shell tool. */
const hostile = (other: string): Record<string, string> => ({
  PATH: `/usr/local/bin:${process.env.PATH ?? ""}`,
  HOME: "/home/real",
  MU_SYNC_DIR: join(other, "mu"),
  MU_DB_PATH: join(other, "mu.db"),
  MU_STATE_DIR: join(other, "state"),
  MU_TMUX_SOCKET: "default",
  MU_MUX: "herdr",
  MURMUR_STATE_DIR: join(other, "murmur2"),
  TMUX_TMPDIR: "/tmp",
  PI_CODING_AGENT_DIR: join(other, "pi"),
  MU_PI_COMMAND: "/real/pi-launcher",
});

const run = (shim: string, env: Record<string, string>): Record<string, string | null> => {
  const r = spawnSync(shim, ["state"], { encoding: "utf8", env });
  expect(r.stderr).toBe("");
  return JSON.parse(r.stdout) as Record<string, string | null>;
};

describe("the sandbox shims pin its isolation variables", () => {
  it("mu: a hostile caller env (MU_SYNC_DIR=<other dir>, ...) never reaches the build", () => {
    const sb = liveSandbox();
    const shim = join(sb.bin, "mu");
    writeFileSync(shim, muShim(envPrinter(sb.dir), sb.pin), { mode: 0o755 });
    const got = run(shim, hostile(tmp("iso-real-")));
    for (const k of ISOLATION_VARS) expect(got[k]).toBe(sb.env[k]);
    expect(got.MU_SYNC_DIR).toBe(join(sb.dir, "sync"));
    expect(got.MU_PI_COMMAND).toBeNull();
    expect(got.PATH?.split(":")[0]).toBe(sb.bin);
  });

  it("murmur and muzzle pin the same, so what they run stays in the sandbox", () => {
    const sb = liveSandbox();
    const printer = envPrinter(sb.dir);
    const tools: HookTools = {
      node: process.execPath,
      mu: "/unused",
      murmur: printer,
      muzzle: null,
      observer: "/unused",
    };
    const murmur = join(sb.bin, "murmur");
    writeFileSync(murmur, murmurShim(tools, sb.pin), { mode: 0o755 });
    const muzzle = join(sb.bin, "muzzle");
    // the muzzle binary stands in as node running the printer
    const fakeMuzzle = join(sb.dir, "fake-muzzle");
    writeFileSync(fakeMuzzle, `#!/bin/sh\nexec '${process.execPath}' '${printer}'\n`, {
      mode: 0o755,
    });
    writeFileSync(muzzle, muzzleShim(fakeMuzzle, "/sb/state", sb.pin), { mode: 0o755 });
    for (const shim of [murmur, muzzle]) {
      const got = run(shim, hostile(tmp("iso-real-")));
      for (const k of ISOLATION_VARS) expect(got[k]).toBe(sb.env[k]);
      expect(got.MU_PI_COMMAND).toBeNull();
      expect(got.PATH?.split(":")[0]).toBe(sb.bin);
    }
  });

  it("a blank sandbox value stays blank; a command the sandbox set stays; PATH is not doubled", () => {
    const sb = liveSandbox({ MU_MUX: "", MU_CLAUDE_COMMAND: "claude --x" });
    const shim = join(sb.bin, "mu");
    writeFileSync(shim, muShim(envPrinter(sb.dir), sb.pin), { mode: 0o755 });
    const got = run(shim, {
      ...hostile(tmp("iso-real-")),
      PATH: `${sb.bin}:${process.env.PATH ?? ""}`,
    });
    expect(got.MU_MUX).toBe("");
    expect(got.MU_CLAUDE_COMMAND).toBe("claude --x");
    expect(got.PATH).toBe(`${sb.bin}:${process.env.PATH ?? ""}`);
  });

  it("createSandbox's and setupHarnesses' writers bake the pins into bin/mu, murmur, muzzle and tmux", () => {
    const sb = liveSandbox();
    const printer = envPrinter(sb.dir);
    writeIsolatedShims({
      dir: sb.dir,
      binDir: sb.bin,
      env: sb.env,
      cli: printer,
      live: true,
      tmuxBin: "/usr/bin/tmux",
      tmuxSocket: "mu-eval-sock",
    });
    const fakeMuzzle = join(sb.dir, "fake-muzzle");
    writeFileSync(fakeMuzzle, `#!/bin/sh\nexec '${process.execPath}' '${printer}'\n`, {
      mode: 0o755,
    });
    const tools: HookTools = {
      node: process.execPath,
      mu: "/unused",
      murmur: printer,
      muzzle: fakeMuzzle,
      observer: "/unused",
    };
    writeToolShims({ env: sb.env, binDir: sb.bin }, tools, "/sb/state");
    for (const name of ["mu", "murmur", "muzzle"]) {
      const got = run(join(sb.bin, name), hostile(tmp("iso-real-")));
      expect(got.MU_SYNC_DIR).toBe(join(sb.dir, "sync"));
      expect(got.MU_DB_PATH).toBe(sb.env.MU_DB_PATH);
      expect(got.PATH?.split(":")[0]).toBe(sb.bin);
    }
    expect(readFileSync(join(sb.bin, "tmux"), "utf8")).toContain(
      `export TMUX_TMPDIR=${JSON.stringify(sb.env.TMUX_TMPDIR)}`,
    );
    // live: the shell startup files and claude's env file, with the unaliasing
    const claudeEnv = readFileSync(join(sb.dir, "shell", "claude-env.sh"), "utf8");
    expect(claudeEnv).toContain(`export MU_SYNC_DIR='${join(sb.dir, "sync")}'`);
    expect(claudeEnv).toContain("unalias");
    expect(existsSync(join(sb.dir, "shell", "zdotdir", ".zshrc"))).toBe(true);
    // not live: no shell startup files
    const fake = liveSandbox();
    writeIsolatedShims({
      dir: fake.dir,
      binDir: fake.bin,
      env: fake.env,
      cli: printer,
      live: false,
      tmuxBin: "/usr/bin/tmux",
      tmuxSocket: "s",
    });
    expect(existsSync(join(fake.dir, "shell"))).toBe(false);
  });

  it("on the eval ssh host (EVAL_HOST) the host's own env stays", () => {
    const sb = liveSandbox();
    const shim = join(sb.bin, "mu");
    writeFileSync(shim, muShim(envPrinter(sb.dir), sb.pin), { mode: 0o755 });
    const env = { PATH: process.env.PATH ?? "", EVAL_HOST: "dev", MURMUR_STATE_DIR: "/h/murmur2" };
    const got = run(shim, env);
    expect(got.MURMUR_STATE_DIR).toBe("/h/murmur2");
    expect(got.MU_DB_PATH).toBeNull();
  });
});

const hasZsh = spawnSync("zsh", ["-fc", "true"]).status === 0;

describe("a live sandbox's shell startup", () => {
  it("sets ZDOTDIR, the user's own ZDOTDIR and claude's env file; the ssh host drops them", () => {
    const env = shellStartupEnv("/sb", { HOME: "/home/real" });
    expect(env).toEqual({
      ZDOTDIR: "/sb/shell/zdotdir",
      EVAL_USER_ZDOTDIR: "/home/real",
      CLAUDE_ENV_FILE: "/sb/shell/claude-env.sh",
    });
    expect(
      shellStartupEnv("/sb", { HOME: "/h", ZDOTDIR: "/h/.config/zsh" }).EVAL_USER_ZDOTDIR,
    ).toBe("/h/.config/zsh");
    const sb = liveSandbox();
    expect(sb.env.ZDOTDIR).toBe(join(sb.dir, "shell", "zdotdir"));
    const host = remoteEnv(sb.env, "/sb/hosts/dev", "dev", "h");
    expect(host.ZDOTDIR).toBeUndefined();
    expect(host.EVAL_USER_ZDOTDIR).toBeUndefined();
    expect(host.CLAUDE_ENV_FILE).toBeUndefined();
  });

  it.skipIf(!hasZsh)(
    "a zsh that sources the user's rc (which exports MU_SYNC_DIR and puts /usr/local/bin first) ends with the pins",
    () => {
      const sb = liveSandbox();
      writeShellStartup(sb.dir, sb.pin);
      const home = tmp("iso-home-");
      writeFileSync(
        join(home, ".zshenv"),
        'export MU_SYNC_DIR="$HOME/mu"; export PATH="/usr/local/bin:$PATH"; export ENV_RAN=1\n',
      );
      writeFileSync(
        join(home, ".zshrc"),
        'export MU_SYNC_DIR="$HOME/mu"; export MU_PI_COMMAND=/real/pi; export RC_RAN=1\n',
      );
      const env = {
        HOME: home,
        PATH: "/usr/bin:/bin",
        ZDOTDIR: sb.env.ZDOTDIR ?? "",
        EVAL_USER_ZDOTDIR: home,
      };
      const show = 'print -r -- "$ENV_RAN|$RC_RAN|$MU_SYNC_DIR|$MU_PI_COMMAND|$path[1]"';
      // a login shell (codex's), then an interactive one (claude's snapshot reads $ZDOTDIR/.zshrc)
      const login = spawnSync("zsh", ["-l", "-c", show], { encoding: "utf8", env });
      expect(login.stdout.trim()).toBe(`1||${join(sb.dir, "sync")}||${sb.bin}`);
      const inter = spawnSync("zsh", ["-i", "-c", show], { encoding: "utf8", env });
      expect(inter.stdout.trim().split("\n").at(-1)).toBe(`1|1|${join(sb.dir, "sync")}||${sb.bin}`);
    },
  );

  it.skipIf(!hasZsh)(
    "claude's snapshot sources $HOME/.zshrc itself; CLAUDE_ENV_FILE, sourced after it, restores bin/ first and drops mu aliases",
    () => {
      const sb = liveSandbox();
      writeShellStartup(sb.dir, sb.pin);
      for (const n of ["mu", "murmur", "muzzle", "tmux"])
        writeFileSync(join(sb.bin, n), "#!/bin/sh\n", { mode: 0o755 });
      const home = tmp("iso-home-");
      writeFileSync(
        join(home, ".zshrc"),
        [
          'export PATH="/usr/local/bin:$PATH"',
          'export MU_SYNC_DIR="$HOME/mu"',
          "alias mu=/usr/local/bin/mu",
          "alias -g muzzle=/usr/local/bin/muzzle",
          'murmur() { /usr/local/bin/murmur "$@"; }',
          "",
        ].join("\n"),
      );
      const env = {
        HOME: home,
        PATH: "/usr/bin:/bin",
        ZDOTDIR: sb.env.ZDOTDIR ?? "",
        EVAL_USER_ZDOTDIR: home,
        CLAUDE_ENV_FILE: sb.env.CLAUDE_ENV_FILE ?? "",
      };
      const show = 'print -r -- "$MU_SYNC_DIR|$path[1]"; whence -w mu murmur muzzle';
      // the snapshot alone: the user's rc wins, whatever ZDOTDIR says
      const snap = spawnSync("zsh", ["-l", "-c", `source "$HOME/.zshrc"; ${show}`], {
        encoding: "utf8",
        env,
      });
      expect(snap.stdout.split("\n")[0]).toBe(`${join(home, "mu")}|/usr/local/bin`);
      // then claude sources CLAUDE_ENV_FILE before the command
      const cmd = spawnSync(
        "zsh",
        ["-l", "-c", `source "$HOME/.zshrc"; source "$CLAUDE_ENV_FILE"\n${show}`],
        { encoding: "utf8", env },
      );
      expect(cmd.stdout.trim().split("\n")).toEqual([
        `${join(sb.dir, "sync")}|${sb.bin}`,
        "mu: command",
        "murmur: command",
        "muzzle: command",
      ]);
    },
  );
});

describe("the real-state watch of a live run", () => {
  it("watches the rig's own MU_SYNC_DIR and ~/mu, the DBs it and the defaults name, and murmur's and muzzle's state", () => {
    const p = realStatePaths({ MU_SYNC_DIR: "/s/sync/", MU_DB_PATH: "/s/db/mu.db" }, "/home/u");
    expect(p.syncDirs).toEqual(["/s/sync", "/home/u/mu"]);
    expect(p.dbFiles).toEqual([
      "/s/db/mu.db",
      "/s/db/mu.db-wal",
      "/home/u/.local/state/mu5/mu.db",
      "/home/u/.local/state/mu5/mu.db-wal",
      "/home/u/.local/state/mu-next/mu.db",
      "/home/u/.local/state/mu-next/mu.db-wal",
      "/home/u/.local/state/mu/mu.db",
      "/home/u/.local/state/mu/mu.db-wal",
    ]);
    expect(p.stateDirs).toEqual(["/home/u/.local/state/murmur2", "/home/u/.local/state/muzzle"]);
    expect(realStatePaths({ MU_SYNC_DIR: "" }, "/home/u").syncDirs).toEqual(["/home/u/mu"]);
    // no MU_DB_PATH or MU_STATE_DIR: this build's DB is mu 5's default, listed once
    expect(realStatePaths({ XDG_STATE_HOME: "/x" }, "/home/u").dbFiles).toEqual([
      "/x/mu5/mu.db",
      "/x/mu5/mu.db-wal",
      "/x/mu-next/mu.db",
      "/x/mu-next/mu.db-wal",
      "/x/mu/mu.db",
      "/x/mu/mu.db-wal",
    ]);
    expect(
      realStatePaths({ MURMUR_STATE_DIR: "/m", XDG_STATE_HOME: "/x" }, "/home/u").stateDirs,
    ).toEqual(["/m", "/x/murmur2", "/home/u/.local/state/murmur2", "/x/muzzle"]);
  });

  /** A fake real HOME: a sync dir with the user's own segment, a DB, murmur state. */
  function fakeReal() {
    const home = tmp("iso-realhome-");
    const sync = join(home, "mu");
    mkdirSync(sync);
    writeFileSync(join(sync, "laptop.jsonl"), "{}\n");
    const db = join(home, "real.db");
    writeFileSync(db, "x");
    const murmur = join(home, ".local", "state", "murmur2");
    mkdirSync(murmur, { recursive: true });
    return { home, sync, db, murmur, env: { MU_SYNC_DIR: sync, MU_DB_PATH: db } };
  }

  it("a new segment in a fake real sync dir is destructive; the user's own writes are notes; neither is touched", () => {
    const r = fakeReal();
    const clean = watchRealState(r.env, r.home);
    expect(clean.check()).toEqual({ added: [], changed: [], removed: [] });
    expect(judgeRealState(clean.paths, clean.check()).report).toBe("");

    const w = watchRealState(r.env, r.home);
    const leaked = join(r.sync, "0a1b2c.jsonl");
    writeFileSync(leaked, '{"op":1}\n');
    writeFileSync(join(r.sync, "laptop.jsonl"), "{}\n{}\n");
    writeFileSync(r.db, "xy");
    writeFileSync(join(r.murmur, "inbox.json"), "{}");
    const v = judgeRealState(w.paths, w.check());
    expect(v.destructive).toEqual([
      expect.stringMatching(new RegExp(`^contamination: ${leaked}: a new sync segment appeared`)),
    ]);
    expect(v.notes).toEqual([
      expect.stringContaining(`${join(r.murmur, "inbox.json")} appeared`),
      expect.stringContaining(`${join(r.sync, "laptop.jsonl")} changed`),
      expect.stringContaining(`${r.db} changed`),
    ]);
    expect(v.report).toContain("CONTAMINATED");
    for (const p of [leaked, r.db, join(r.sync, "laptop.jsonl")]) expect(v.report).toContain(p);
    // the watch only reads
    expect(existsSync(leaked)).toBe(true);
  });

  it("only the user's own writes: noted on stderr, not contamination", () => {
    const r = fakeReal();
    const w = watchRealState(r.env, r.home);
    writeFileSync(r.db, "xyz");
    const v = judgeRealState(w.paths, w.check());
    expect(v.destructive).toEqual([]);
    expect(v.report).not.toContain("CONTAMINATED");
    expect(v.report).toContain(r.db);
  });

  it("settleWatch adds the entries to the run's verdict", () => {
    const r = fakeReal();
    const w = watchRealState(r.env, r.home);
    writeFileSync(join(r.sync, "0a1b2c.jsonl"), "{}\n");
    const verdict = { destructive: [] as string[], notes: [] as string[] };
    const err = process.stderr.write;
    let printed = "";
    process.stderr.write = ((c: string) => {
      printed += c;
      return true;
    }) as typeof process.stderr.write;
    try {
      settleWatch(w, verdict);
    } finally {
      process.stderr.write = err;
    }
    expect(verdict.destructive).toHaveLength(1);
    expect(printed).toContain("CONTAMINATED");
  });

  it("an interrupted run (SIGINT, as the sandbox's handler exits) still reports from the exit listener", async () => {
    const r = fakeReal();
    const d = tmp("iso-child-");
    const script = join(d, "child.mjs");
    const iso = pathToFileURL(join(import.meta.dirname, "../../tools/eval/isolation.ts")).href;
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
import { armWatch, watchRealState } from ${JSON.stringify(iso)};
const [sync, home] = process.argv.slice(2);
// as sandbox.ts's installHandlers: clean up, then exit
process.on("SIGINT", () => process.exit(130));
armWatch(watchRealState({ MU_SYNC_DIR: sync }, home));
writeFileSync(sync + "/0a1b2c.jsonl", "{}\\n");
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, [script, r.sync, r.home], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    await new Promise<void>((res, rej) => {
      child.stdout.on("data", (b: Buffer) => {
        if (b.toString().includes("ready")) res();
      });
      child.on("exit", () => rej(new Error(`child exited early: ${stderr}`)));
    });
    const code = await new Promise<number | null>((res) => {
      child.on("exit", (c) => res(c));
      child.kill("SIGINT");
    });
    expect(code).toBe(130);
    expect(stderr).toContain("CONTAMINATED");
    expect(stderr).toContain(join(r.sync, "0a1b2c.jsonl"));
    expect(stderr).toContain("interrupted");
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
