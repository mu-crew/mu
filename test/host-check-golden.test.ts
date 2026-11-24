// `mu host check` output, byte for byte, for every profile shape: session, lease (good
// and bad templates), unreachable, hand-backs at each stage, harness and pi skips, repo
// skips and failures, `--agent` on both transports. Human and `--json`, stdout, stderr and
// exit code, against fixtures under test/fixtures/host-check/ captured before the check
// steps moved onto the link and the job kinds (spec 2026-11-09-mu-plugins.md, P5).
// Fake templates through /bin/sh; no real git (a spy on PATH proves it), no ssh.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addHost } from "../src/hosts.js";
import { filledReservation } from "./_carrier.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let home: string;
let gitLog: string;
let oldPath: string | undefined;
let oldShell: string | undefined;

const WS = "auth";

function shim(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** A PATH holding exactly `harnesses` (plus the git spy and the login shell). */
function usePath(harnesses: ("pi" | "claude")[]): void {
  const bin = join(dir, `bin-${harnesses.join("-") || "none"}`);
  mkdirSync(bin, { recursive: true });
  shim(bin, "git", `echo "$@" >> ${gitLog}\nexit 0`);
  shim(bin, "login-sh", '[ "$1" = -ilc ] && shift\nexec /bin/sh -c "$1"');
  if (harnesses.includes("pi")) {
    shim(
      bin,
      "pi",
      'if [ "$1" = "--version" ]; then echo 0.99.1; elif [ "$1" = list ]; then echo "  npm:@mu-crew/mu"; fi',
    );
  }
  if (harnesses.includes("claude")) shim(bin, "claude", "exit 0");
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.SHELL = join(bin, "login-sh");
}

/**
 * An exec template: `cases` (sh `case` arms over the command) first, then the repo step's
 * `git -C <root> rev-parse` answered without git (a root naming `missing` is not a repo),
 * then everything else under a plain sh with HOME pinned to the fixture's.
 */
const execT = (cases = ""): string =>
  `case {cmd} in ${cases} 'git -C'*missing*) echo 'fatal: not a git repository' >&2; exit 128;; 'git -C'*) exit 0;; esac; env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME=${home} sh -c {cmd}`;

const LEASE_SHELL =
  "c --job-file {job_file} -L {local_sock}:{remote_sock} -- env {env} sh -c {cmd}";
const QUIET_SHELL = "ssh -o ControlMaster=no -o ControlPath=none h {local_sock}:{remote_sock}";

function session(name: string, o: { exec?: string; shell?: string; repo?: string | null } = {}) {
  addHost(db, {
    name,
    shell: o.shell ?? QUIET_SHELL,
    exec: o.exec ?? execT(),
    fetch: "true",
    repo: o.repo === undefined ? dir : o.repo,
    max_sessions: 1,
  });
}

function lease(name: string, o: { exec?: string; shell?: string; stop?: string } = {}) {
  addHost(db, {
    name,
    shell: o.shell ?? LEASE_SHELL,
    exec: o.exec ?? execT(),
    fetch: "true",
    repo: dir,
    max_sessions: 1,
    transport: "lease",
    stop: o.stop ?? "echo {job}",
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-check-golden-"));
  dbPath = join(dir, "mu.db");
  home = join(dir, "home");
  gitLog = join(dir, "git-log");
  mkdirSync(join(home, ".claude"), { recursive: true });
  oldPath = process.env.PATH;
  oldShell = process.env.SHELL;
  usePath(["pi"]);
  db = openDb({ path: dbPath });
});

afterEach(() => {
  process.env.PATH = oldPath;
  if (oldShell === undefined) {
    const k = "SHELL";
    delete process.env[k];
  } else process.env.SHELL = oldShell;
  const ranGit = existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "";
  db.close();
  rmFixtureDir(dir);
  expect(ranGit).toBe("");
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** One invocation, human then `--json`, with the fixture dir and probe times masked. */
async function render(args: string[]): Promise<string> {
  const real = realpathSync(dir);
  const mask = (s: string): string =>
    s
      .split(real)
      .join("<DIR>")
      .split(dir)
      .join("<DIR>")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<TIME>")
      .replace(ANSI, "");
  const out: string[] = [];
  for (const argv of [args, [...args, "--json"]]) {
    const r = await runCli(["host", "check", ...argv], dbPath);
    expect(r.error).toBeUndefined();
    out.push(
      `$ mu host check ${argv.join(" ")}`,
      `exit: ${r.exitCode ?? 0}`,
      "--- stdout",
      mask(r.stdout).trimEnd(),
      "--- stderr",
      mask(r.stderr).trimEnd(),
      "",
    );
  }
  return out.join("\n");
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "host-check");
/** Set to a directory to (re)capture the fixtures there; copy them in by hand. */
const CAPTURE = process.env.HOST_CHECK_GOLDEN_OUT;

const golden = async (name: string, args: string[]): Promise<void> => {
  const text = await render(args);
  if (CAPTURE !== undefined) {
    writeFileSync(join(CAPTURE, `${name}.txt`), text);
    return;
  }
  expect(text).toBe(readFileSync(join(FIXTURES, `${name}.txt`), "utf8"));
};

const agent = ["--agent", "worker-1", "-w", WS];

describe("host check golden output", () => {
  it("session: everything passes, pi only", async () => {
    session("dev");
    await golden("session-pass", ["dev"]);
  });

  it("session: a shell that can ride a shared master warns", async () => {
    session("dev", { shell: "ssh h {local_sock}:{remote_sock}" });
    await golden("session-master-warning", ["dev"]);
  });

  it("session --agent: no forwarded socket fails ctl", async () => {
    session("dev");
    await golden("session-agent-no-socket", ["dev", ...agent]);
  });

  it("session: claude with murmur's hook and no mu stop hook; pi too", async () => {
    usePath(["pi", "claude"]);
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{"hooks":{"Stop":[{"hooks":[{"command":"murmur hook claude"}]}]}}',
    );
    session("dev");
    await golden("session-claude-hooks", ["dev"]);
  });

  it("session: claude without murmur's hook fails hooks", async () => {
    usePath(["pi", "claude"]);
    session("dev");
    await golden("session-claude-no-hooks", ["dev"]);
  });

  it("session: no pi skips pi and extension", async () => {
    usePath(["claude"]);
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{"hooks":{"Stop":[{"hooks":[{"command":"murmur hook claude"},{"command":"mu hook stop claude"}]}]}}',
    );
    session("dev");
    await golden("session-no-pi", ["dev"]);
  });

  it("session: no harness at all", async () => {
    usePath([]);
    session("dev");
    await golden("session-no-harness", ["dev"]);
  });

  it("session: the probe printed no report", async () => {
    session("dev", { exec: execT("*MU_HARNESS*) exit 0;;") });
    await golden("session-no-report", ["dev"]);
  });

  it("session: no repo anywhere skips repo; --root on a non-repo fails it", async () => {
    session("dev", { repo: null });
    await golden("session-no-repo", ["dev"]);
    await golden("session-root-not-a-repo", ["dev", "--root", "/srv/missing"]);
  });

  it("session: a broken pi and an extension-less pi list", async () => {
    session("dev", {
      exec: execT(
        `*"pi --version"*) echo 'pi: boom' >&2; exit 127;; *"pi list"*) echo other; exit 0;;`,
      ),
    });
    await golden("session-pi-broken", ["dev"]);
  });

  it("session: unreachable (exit 255) skips the rest", async () => {
    session("dev", { exec: "echo 'ssh: connect to host h: refused' >&2; exit 255" });
    await golden("session-unreachable", ["dev"]);
    await golden("session-unreachable-agent", ["dev", ...agent]);
  });

  it("session: a hand-back at the first step", async () => {
    session("dev", { exec: "echo 'handed back' >&2; exit 3" });
    await golden("session-handback-first", ["dev", ...agent]);
  });

  it("session: a hand-back at the repo step", async () => {
    session("dev", { exec: execT("'git -C'*) exit 3;;") });
    await golden("session-handback-repo", ["dev", ...agent]);
  });

  it("session: a hand-back at the harness probe", async () => {
    session("dev", { exec: execT("*MU_HARNESS*) exit 3;;") });
    await golden("session-handback-harnesses", ["dev", ...agent]);
  });

  it("session: a hand-back at pi", async () => {
    session("dev", { exec: execT(`*"pi --version"*) exit 3;;`) });
    await golden("session-handback-pi", ["dev", ...agent]);
  });

  it("lease: everything passes, with attach", async () => {
    lease("box");
    db.prepare("UPDATE host_profiles SET attach = ?").run(
      "c --attach {job} --job-file {job_file} {local_sock}:{remote_sock}",
    );
    await golden("lease-pass-attach", ["box"]);
  });

  it("lease --agent: a recorded handle, then one whose stop template drifted, then none", async () => {
    lease("box");
    filledReservation(db, {
      workstream: WS,
      name: "worker-1",
      host: "box",
      job: "mule-42",
      hostStop: "echo {job}",
    });
    filledReservation(db, {
      workstream: WS,
      name: "worker-2",
      host: "box",
      job: "mule-43",
      hostStop: "older {job}",
    });
    await golden("lease-agent-job", ["box", ...agent]);
    await golden("lease-agent-drift", ["box", "--agent", "worker-2", "-w", WS]);
    await golden("lease-agent-no-job", ["box", "--agent", "worker-3", "-w", WS]);
  });

  it("lease: bad shell, stop and attach templates", async () => {
    lease("box");
    db.prepare(
      "UPDATE host_profiles SET shell = 'c -L {local_sock}:{remote_sock}', stop = 'echo nothing', attach = 'c {job} {local_sock}:{remote_sock}'",
    ).run();
    await golden("lease-bad-templates", ["box"]);
    db.prepare("UPDATE host_profiles SET shell = 'c {nope}', stop = 'echo {job} {env}'").run();
    await golden("lease-unparsable-templates", ["box"]);
  });

  it("lease: no harness, then no pi", async () => {
    lease("box");
    usePath([]);
    await golden("lease-no-harness", ["box"]);
    usePath(["claude"]);
    await golden("lease-no-pi", ["box"]);
  });

  it("lease: unreachable and a first-step hand-back, with --agent", async () => {
    lease("box", { exec: "echo 'mule: no route' >&2; exit 255" });
    await golden("lease-unreachable-agent", ["box", ...agent]);
    db.prepare("UPDATE host_profiles SET exec = ?").run("echo 'mule: handed back' >&2; exit 3");
    await golden("lease-handback-first-agent", ["box", ...agent]);
  });

  it("lease: a hand-back at the extension step, with --agent", async () => {
    lease("box", { exec: execT(`*"pi list"*) exit 3;;`) });
    filledReservation(db, {
      workstream: WS,
      name: "worker-1",
      host: "box",
      job: "mule-42",
      hostStop: "echo {job}",
    });
    await golden("lease-handback-extension-agent", ["box", ...agent]);
  });

  it("an unknown host", async () => {
    await golden("unknown-host", ["nope"]);
  });
});
