// Remote command gates (v_remote_gates): `spawn --host <h> --command 'npm test'`
// (a non-pi command) is a gate whose NUMERIC exit `mu wait` returns, without pi
// or murmur. Fake sh templates stand in for ssh and EXECUTE the filled wrapper
// (the "remote" home is a temp dir), the mux is the fake tmux harness whose
// respawn-pane runs the real command line and keeps its exit like remain-on-exit
// does. No real host, no real tmux: test/remote-gates.integration.test.ts has one.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanGateResult, readGate } from "../src/agents/gate.js";
import { expectsCtl } from "../src/agents/transport.js";
import {
  closeAgent,
  getAgent,
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, HostProfileError, listHostChannels } from "../src/hosts.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { type AgentReading, waitForEvents } from "../src/wait.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let home: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
/** When set, the pane-exit probe fails like a broken socket (unknown, never dead). */
let probeFails = false;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["MU_DB_PATH", "MU_STATE_DIR", "MU_SYNC_DIR", "MU_SPAWN_CTL_MS"];

const SIG: Record<string, number> = { SIGKILL: 9, SIGTERM: 15, SIGHUP: 1 };
const isPaneCall = (a: readonly string[]): boolean =>
  ["new-session", "new-window", "split-window"].includes(a[0] ?? "");

/** tmux whose respawn-pane really runs the command and keeps its exit (a retained pane). */
function installTmux(): void {
  const fake = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    if (probeFails && args.join(" ").includes("pane_dead")) {
      return { stdout: "", stderr: "error connecting to socket (Permission denied)", exitCode: 1 };
    }
    const res = await fake(args);
    if (args[0] === "respawn-pane" && res.exitCode === 0) {
      const id = args[args.indexOf("-t") + 1] ?? "";
      const pane = state.panes.get(id);
      if (pane !== undefined) {
        const r = spawnSync("/bin/sh", ["-c", args.at(-1) ?? ""], { encoding: "utf8" });
        pane.scrollback = `${r.stdout}${r.stderr}`;
        pane.exit =
          r.signal !== null
            ? { code: null, signal: SIG[r.signal] ?? 1 }
            : { code: r.status, signal: null };
      }
    }
    return res;
  });
}

const gateFiles = (): string[] => {
  const d = join(home, ".local/state/mu-next/remote-gates");
  return existsSync(d) ? readdirSync(d) : [];
};
const channels = (host = "dev") => listHostChannels(db, host);
const spawnGate = (over: Partial<Parameters<typeof spawnAgent>[1]> = {}) =>
  spawnAgent(db, {
    name: "gate-1",
    workstream: "auth",
    host: "dev",
    command: "exit 23",
    ...over,
  });
const ref = (name = "gate-1") => ({ kind: "agent" as const, workstream: "auth", id: name });
const waitOpts = (over = {}) => ({
  callers: [] as string[],
  pollMs: 1,
  sync: false,
  timeoutMs: 2000,
  ...ctlAgentHooks(db),
  ...over,
});
const agentRow = (name = "gate-1") => {
  const a = getAgent(db, name, "auth");
  if (a === undefined) throw new Error(`no agent ${name}`);
  return a;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrg-"));
  home = join(dir, "home");
  mkdirSync(home);
  mkdirSync(join(dir, "repo"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.MU_DB_PATH = join(dir, "mu.db");
  process.env.MU_STATE_DIR = join(dir, "state");
  process.env.MU_SYNC_DIR = "";
  process.env.MU_SPAWN_CTL_MS = "300";
  probeFails = false;
  db = openDb({ path: join(dir, "mu.db") });
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({
    ok: false,
    binary: c.trim().split(/\s+/)[0] ?? c,
    envVarChecked: "MU_PI_COMMAND",
  }));
  ensureWorkstream(db, "auth");
  const exec = `HOME='${home}' /bin/sh -c {cmd}`;
  const profile = (name: string, shell: string, max: number | null) =>
    addHost(db, {
      name,
      shell,
      exec,
      fetch: "true",
      repo: join(dir, "repo"),
      max_sessions: max,
    });
  profile("dev", `HOME='${home}' /bin/sh -c {cmd}`, 1);
  // A shell template that swallows the remote command's status (always exits 0).
  profile("swallow", `HOME='${home}' /bin/sh -c {cmd}; exit 0`, null);
  // A transport that dies without running anything (255, like ssh failing to connect).
  profile("broken", "exit 255", null);
  // A transport killed by a signal.
  profile("killed", "kill -9 $$", null);
  state = freshMockState();
  installTmux();
});

afterEach(() => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  db.close();
  rmFixtureDir(dir);
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the discriminator: decided before any effect", () => {
  it("the README form (--host with a non-pi --command, no --cli) is a gate: marker, no ctl", async () => {
    const a = await spawnGate({ command: "mytest --all" });
    expect(a.gateToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.ctl).toBe("skipped");
    expect(getAgent(db, "gate-1", "auth")?.gateToken).toBe(a.gateToken);
    // Not even a forwarded socket file at the derived path makes it a pi worker.
    expect(expectsCtl(agentRow(), join(dir, "any-existing-file"))).toBe(false);
    writeFileSync(join(dir, "fwd.sock"), "");
    expect(expectsCtl(agentRow(), join(dir, "fwd.sock"))).toBe(false);
  });

  it("pi stays a worker: explicit --cli pi, and a pi or pi-meta argv0", async () => {
    mux.restore();
    installTmux();
    for (const [name, over] of [
      ["w1", { cli: "pi", command: "my-pi-wrapper" }],
      ["w2", { command: "pi --model x" }],
      ["w3", { command: "/usr/bin/pi-meta" }],
    ] as const) {
      const a = await spawnGate({ name, host: "swallow", ctl: false, ...over });
      expect(a.gateToken).toBeNull();
    }
    // A worker's pane is not retained.
    expect(mux.calls.some((c) => c[0] === "respawn-pane")).toBe(false);
  });

  it("--worktree with a gate is refused before any effect", async () => {
    const err = await spawnGate({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostProfileError);
    expect((err as Error).message).toMatch(/gate/);
    expect(mux.calls).toEqual([]);
    expect(channels()).toEqual([]);
    expect(getAgent(db, "gate-1", "auth")).toBeUndefined();
  });
});

describe("retention is armed before the command can run", () => {
  it("sets remain-on-exit on THIS pane, then respawns into the real command; no session or global default", async () => {
    await spawnGate({ command: "true" });
    const calls = mux.calls;
    const create = calls.findIndex(isPaneCall);
    const set = calls.findIndex((c) => c[0] === "set-option");
    const respawn = calls.findIndex((c) => c[0] === "respawn-pane");
    expect(create).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(create);
    expect(respawn).toBeGreaterThan(set);
    const opt = calls[set] ?? [];
    expect(opt).toEqual([
      "set-option",
      "-p",
      "-t",
      expect.stringMatching(/^%\d+$/),
      "remain-on-exit",
      "on",
    ]);
    expect(opt).not.toContain("-g");
    // The placeholder, never the user's command, runs at creation.
    expect(calls[create]?.at(-1)).not.toContain("remote-gates");
    expect(calls[respawn]?.at(-1)).toContain("remote-gates");
  });
});

describe("the remote command's numeric exit is the result", () => {
  it.each([0, 23, 1, 255])("exit %i comes back exactly", async (code) => {
    await spawnGate({ command: `exit ${code}` });
    const r = await waitForEvents(db, [ref()], waitOpts());
    expect(r.event).toMatchObject({ kind: "exited", ref: { id: "gate-1" } });
    expect(r.exit).toBe(code);
    expect(r.refs[0]).toMatchObject({ exit: code, fired: true, dead: false });
  });

  it("an immediate exit before spawn returned is still a result (no busy-first)", async () => {
    const a = await spawnGate({ command: "exit 0" });
    // The pane already ended when spawnAgent returned: nothing rolled it back.
    expect(getAgent(db, "gate-1", "auth")?.incarnation).toBe(a.incarnation);
    const r = await waitForEvents(db, [ref()], waitOpts());
    expect(r.event.kind).toBe("exited");
    expect(r.exit).toBe(0);
  });

  it("noisy and identical stdout cannot change it: only the status record counts", async () => {
    await spawnGate({ name: "a", command: "echo SUCCESS; echo 'MU_GATE x 0'; exit 0" });
    await spawnGate({ name: "b", command: "echo SUCCESS; echo 'MU_GATE x 0'; exit 23" });
    const ra = await waitForEvents(db, [ref("a")], waitOpts());
    const rb = await waitForEvents(db, [ref("b")], waitOpts());
    expect([ra.exit, rb.exit]).toEqual([0, 23]);
  });

  it("a shell template that swallows the status (pane exit 0) still reports the command's 23", async () => {
    await spawnGate({ host: "swallow", command: "exit 23" });
    expect(agentRow().host).toBe("swallow");
    expect(state.panes.get(agentRow().paneId)?.exit).toEqual({ code: 0, signal: null });
    const r = await waitForEvents(db, [ref()], waitOpts());
    expect(r.exit).toBe(23);
  });

  it("the command runs in its own sh -c: a quoted command with spaces and quotes survives", async () => {
    await spawnGate({ command: `[ "$(echo 'a b')" = "a b" ] && exit 9` });
    expect((await waitForEvents(db, [ref()], waitOpts())).exit).toBe(9);
  });
});

describe("no usable record is never success", () => {
  it("a transport that died without running the command (no record) is dead, exit 6", async () => {
    await spawnGate({ host: "broken", command: "exit 0" });
    const r = await waitForEvents(db, [ref()], waitOpts());
    expect(r.event.kind).toBe("dead");
    expect(r.exit).toBe(6);
    expect(r.refs[0]).toMatchObject({ dead: true, fired: false });
  });

  it("a transport killed by a signal is dead", async () => {
    await spawnGate({ host: "killed", command: "exit 0" });
    expect(state.panes.get(agentRow().paneId)?.exit).toEqual({ code: null, signal: 9 });
    const r = await waitForEvents(db, [ref()], waitOpts());
    expect(r.exit).toBe(6);
  });

  it.each([
    ["malformed", "MU_GATE not-a-record\n"],
    ["a status over 255", "TOKEN 999\n"],
    ["a non-numeric status", "TOKEN abc\n"],
    ["two lines", "MU_GATE TOKEN 0\nMU_GATE TOKEN 0\n"],
    ["another gate's token", "MU_GATE 11111111-1111-1111-1111-111111111111 0\n"],
  ])("a %s record is dead, never 0", async (_n, body) => {
    const a = await spawnGate({ command: "exit 0" });
    const token = a.gateToken as string;
    const file = join(home, ".local/state/mu-next/remote-gates", token);
    writeFileSync(
      file,
      body.replace("TOKEN", `MU_GATE ${token}`).replace("MU_GATE MU_GATE", "MU_GATE"),
    );
    const g = await readGate(db, agentRow());
    expect(g.kind === "exited" && g.code === 0).toBe(false);
    expect(g.kind).toBe("dead");
  });

  it("a record in the right place but with the wrong token never counts (name reuse)", async () => {
    const a = await spawnGate({ command: "exit 0" });
    const token = a.gateToken as string;
    const dirp = join(home, ".local/state/mu-next/remote-gates");
    writeFileSync(
      join(dirp, token),
      `MU_GATE ${"2".repeat(8)}-2222-2222-2222-${"2".repeat(12)} 0\n`,
    );
    expect((await readGate(db, agentRow())).kind).toBe("dead");
  });

  it("a host that cannot take the record refuses to run the command at all", async () => {
    // HOME is a plain file: mkdir -p fails, the wrapper exits 126 before the command.
    const bad = join(dir, "homefile");
    writeFileSync(bad, "");
    addHost(db, {
      name: "nohome",
      shell: `HOME='${bad}' /bin/sh -c {cmd}`,
      exec: `HOME='${bad}' /bin/sh -c {cmd}`,
      fetch: "true",
      repo: join(dir, "repo"),
      max_sessions: null,
    });
    await spawnGate({ host: "nohome", command: "touch ran; exit 0" });
    expect(existsSync(join(dir, "repo", "ran"))).toBe(false);
    expect((await waitForEvents(db, [ref()], waitOpts())).exit).toBe(6);
  });
});

describe("the channel (max-sessions 1)", () => {
  it("the running gate holds the only channel; a proven exit frees it BEFORE the result read", async () => {
    // Pane still running: attached to the one channel, nothing read.
    const a = await spawnGate({ command: "exit 23" });
    const pane = state.panes.get(a.paneId);
    if (pane === undefined) throw new Error("pane");
    const exited = pane.exit;
    delete pane.exit;
    expect(channels().map((c) => c.kind)).toEqual(["attached"]);
    expect((await readGate(db, agentRow())).kind).toBe("running");
    expect(channels()).toHaveLength(1);
    // The pane ends: the read frees the channel by id + pane, then its exec admits at cap 1.
    pane.exit = exited;
    expect(await readGate(db, agentRow())).toEqual({ kind: "exited", code: 23 });
    expect(channels()).toEqual([]);
  });

  it("a second gate admits after the first ended, without anyone having waited", async () => {
    await spawnGate({ name: "g1", command: "exit 0" });
    expect(channels()).toHaveLength(1);
    // Admission treats the retained dead pane as transport-dead and reclaims it.
    await spawnGate({ name: "g2", command: "exit 5" });
    expect(channels().map((c) => c.holder)).toEqual(
      ["spawn:auth/g2"].map(() => expect.any(String)),
    );
    expect(channels()).toHaveLength(1);
    expect((await waitForEvents(db, [ref("g1")], waitOpts())).exit).toBe(0);
  });

  it("an unknown probe keeps the lease and reads unknown, never dead or a result", async () => {
    await spawnGate({ command: "exit 0" });
    probeFails = true;
    const g = await readGate(db, agentRow());
    expect(g.kind).toBe("unknown");
    expect(channels()).toHaveLength(1);
    probeFails = false;
    expect((await readGate(db, agentRow())).kind).toBe("exited");
  });

  it("an unreadable result (the exec fails) is unknown and retried, not a verdict", async () => {
    await spawnGate({ command: "exit 0" });
    // Break the exec: HOME unreadable would still run; replace the profile exec with a failing one.
    db.prepare("UPDATE host_profiles SET exec = 'exit 255' WHERE name = 'dev'").run();
    const g = await readGate(db, agentRow());
    expect(g.kind).toBe("unknown");
  });
});

describe("repeat, resume, replacement and close", () => {
  it("repeated waits reproduce the same result: reading never removes the record", async () => {
    await spawnGate({ command: "exit 23" });
    for (let i = 0; i < 3; i++) {
      expect((await waitForEvents(db, [ref()], waitOpts())).exit).toBe(23);
    }
    expect(gateFiles()).toHaveLength(1);
  });

  it("an owned cursor consumes the result once", async () => {
    await spawnGate({ command: "exit 23" });
    registerOwnedWait(db, "orch", [ref()]);
    const first = await waitForEvents(db, [], waitOpts({ callers: ["orch"] }));
    expect(first.event.kind).toBe("exited");
    expect(first.exit).toBe(23);
    // Delivered and consumed: the registration ended, nothing is owed again.
    await expect(
      waitForEvents(db, [], waitOpts({ callers: ["orch"], timeoutMs: 50 })),
    ).rejects.toThrow(/nothing to wait for/);
  });

  it("a replaced agent is never read as the old gate's result", async () => {
    const a = await spawnGate({ command: "exit 23" });
    const old = agentRow();
    db.prepare("DELETE FROM agents WHERE id = ?").run(a.incarnation);
    insertAgent(db, {
      name: "gate-1",
      workstream: "auth",
      paneId: old.paneId,
      host: "dev",
      gateToken: old.gateToken,
    });
    const g = await readGate(db, old);
    expect(g).toMatchObject({ kind: "dead", reason: "the agent was replaced" });
  });

  it("close removes only its own token's record; a replacement's survives", async () => {
    const a = await spawnGate({ name: "g1", command: "exit 1" });
    const b = await spawnGate({ name: "g2", command: "exit 2" });
    expect(gateFiles().sort()).toEqual([a.gateToken, b.gateToken].sort());
    await closeAgent(db, "g1", { workstream: "auth" });
    expect(gateFiles()).toEqual([b.gateToken]);
    expect(getAgent(db, "g1", "auth")).toBeUndefined();
    // Cleaning an already-clean token is a no-op that does not touch the other.
    await cleanGateResult(db, a);
    expect(gateFiles()).toEqual([b.gateToken]);
  });

  it("close of a gate never removes a remote worktree or runs a worktree command", async () => {
    await spawnGate({ command: "exit 0" });
    await closeAgent(db, "gate-1", { workstream: "auth" });
    expect(readdirSync(join(dir, "repo"))).toEqual([]);
    expect(channels()).toEqual([]);
  });
});

describe("the legacy agent wait adapter", () => {
  it("a nonzero gate exit reads dead there, 0 reads fired; the status rides along", async () => {
    const { waitForAgents } = await import("../src/agents/wait.js");
    await spawnGate({ name: "ok", command: "exit 0" });
    await spawnGate({ name: "bad", command: "exit 23", host: "swallow" });
    const readStatuses = async (refs: readonly { workstreamName: string; name: string }[]) => {
      const out = new Map();
      const obs = await (await import("../src/agents/observe.js")).observeAgentStates(
        db,
        refs.map((r) => agentRow(r.name)),
      );
      for (const [k, o] of obs)
        out.set(k, (await import("../src/agents/observe.js")).toStatusSnapshot(o));
      return out;
    };
    const res = await waitForAgents(
      db,
      [
        { workstreamName: "auth", name: "ok" },
        { workstreamName: "auth", name: "bad" },
      ],
      { readStatuses, pollMs: 1, timeoutMs: 1000 },
    );
    expect(res.agents.map((a) => [a.name, a.fired, a.dead, a.exit])).toEqual([
      ["ok", true, false, 0],
      ["bad", false, true, 23],
    ]);
  });
});

describe("the CLI: the exact README form", () => {
  // Commander defaults --cli to "pi" (src/cli/agents.ts), so the CLI cannot yet tell an omitted --cli
  // from an explicit one: dropping that default is f_gates_cli_flags (worker-4 owns the file). The SDK
  // form with --cli omitted is pinned above; the CLI form below names --cli sh.
  it("`mu agent spawn gate-1 --host dev --cli sh --command '...'`, then `mu wait agent:auth/gate-1` exits with the command's status", async () => {
    // The fake host runs the command text itself (never a real `npm test`).
    const spawned = await runCliJson(
      [
        "agent",
        "spawn",
        "gate-1",
        "-w",
        "auth",
        "--host",
        "dev",
        "--cli",
        "sh",
        "--command",
        "exit 23",
        "--json",
      ],
      join(dir, "mu.db"),
    );
    expect(spawned.exitCode).toBeNull();
    const waited = await runCliJson(
      ["wait", "agent:auth/gate-1", "-w", "auth"],
      join(dir, "mu.db"),
    );
    expect(waited.exitCode).toBe(23);
    expect(waited.data).toMatchObject({
      exit: 23,
      firing: { kind: "exited", ref: "agent:auth/gate-1" },
      snapshots: [{ ref: "agent:auth/gate-1", exit: 23, fired: true, dead: false }],
    });
  });

  it("--all: each gate's code is exposed and the first nonzero is the exit", async () => {
    await spawnGate({ name: "g1", command: "exit 0" });
    await spawnGate({ name: "g2", command: "exit 23" });
    const r = await runCliJson(
      ["wait", "agent:auth/g1", "agent:auth/g2", "--all", "-w", "auth"],
      join(dir, "mu.db"),
    );
    expect(r.exitCode).toBe(23);
    const snaps = (r.data as { snapshots: { ref: string; exit: number }[] }).snapshots;
    expect(Object.fromEntries(snaps.map((s) => [s.ref, s.exit]))).toEqual({
      "agent:auth/g1": 0,
      "agent:auth/g2": 23,
    });
  });
});

describe("wait readings that carry no gate fields are unchanged", () => {
  it("a pi-style dead reading is still exit 6", async () => {
    insertAgent(db, { name: "p", workstream: "auth", paneId: "%99", cli: "pi" });
    const reading: AgentReading = { status: null };
    const r = await waitForEvents(db, [ref("p")], {
      callers: [],
      pollMs: 1,
      sync: false,
      timeoutMs: 500,
      readAgents: async () => new Map([["auth/p", reading]]),
    });
    expect(r.exit).toBe(6);
    expect(r.event.kind).toBe("dead");
  });
});
