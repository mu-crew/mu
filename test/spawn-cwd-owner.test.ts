// followup_spawn_cwd_owner: a remote `agent spawn --host` that is not `--worktree` refuses
// (RemotePathOwnedError, exit 4) when the cwd prepare's exec resolved is exactly another
// agent's MANAGED remote worktree on that host profile, or the canonical or aside path of any
// remote_recovery record there. Checked before any pane (stage a), and again atomically with
// the row's insert (stage b) for an owner that lands while the pane opens. Unmanaged checkouts
// stay shareable. Fake sh templates stand in for the host, the fake tmux for the mux.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCommandGate } from "../src/agents/spawn.js";
import {
  deleteAgent,
  getAgent,
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
import { carrierJobFilePath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, listHostChannels } from "../src/hosts.js";
import { muxByName } from "../src/mux/index.js";
import { attachShellLine } from "../src/mux/types.js";
import {
  listRemoteRecoveries,
  RemotePathOwnedError,
  type RemoteRecovery,
  selectRemoteRecovery,
} from "../src/remote-recovery.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
/** What the fake host's `pwd -P` answers for every --cwd. */
const P = "/home/u/.local/state/mu-next/remote-worktrees/other/w-9";

let dir: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let execLog: string;
let saved: Record<string, string | undefined>;
/** Runs before every tmux call: a race lands here (timing only). */
let beforeTmux: ((args: readonly string[]) => void) | undefined;

const ENV_KEYS = [
  "MU_SPAWN_CTL_MS",
  "MU_SPAWN_LIVENESS_MS",
  "MU_SPAWN_JOB_MS",
  "MU_DB_PATH",
  "MU_STATE_DIR",
  "MU_SYNC_DIR",
];

const execCalls = (): string[] =>
  readdirSync(execLog).map((f) => readFileSync(join(execLog, f), "utf8"));
const setCwd = (p: string): void => writeFileSync(join(dir, "cwd"), p);
const isPaneCall = (a: readonly string[]): boolean =>
  ["new-session", "new-window", "split-window"].includes(a[0] ?? "");
const paneCalls = (): (readonly string[])[] => mux.calls.filter(isPaneCall);
const livePanes = (): string[] => [...state.panes.keys()];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mco-"));
  db = openDb({ path: join(dir, "mu.db") });
  execLog = join(dir, "execlog");
  mkdirSync(execLog);
  beforeTmux = undefined;
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // No ctl handshake, no liveness poll: a lease spawn still waits for its job file.
  process.env.MU_SPAWN_CTL_MS = "0";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  process.env.MU_SPAWN_JOB_MS = "2000";
  process.env.MU_DB_PATH = join(dir, "mu.db");
  process.env.MU_STATE_DIR = join(dir, "state");
  process.env.MU_SYNC_DIR = join(dir, "sync");
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: false, binary: c, envVarChecked: "X" }));
  ensureWorkstream(db, "auth");
  ensureWorkstream(db, "other");
  setCwd(P);
  const fakeExec = join(dir, "fake-exec.sh");
  writeFileSync(
    fakeExec,
    `#!/bin/sh
n=$(ls '${execLog}' | wc -l)
printf '%s' "$1" > '${execLog}'/$n
case "$1" in
  *MU_CWD*) echo "MU_CWD $(cat '${dir}/cwd')" ;;
esac
`,
  );
  chmodSync(fakeExec, 0o755);
  const stop = join(dir, "fake-stop.sh");
  writeFileSync(stop, `#!/bin/sh\nexit "$(cat '${dir}/stop-exit' 2>/dev/null || echo 0)"\n`);
  chmodSync(stop, 0o755);
  const common = {
    shell: "echo J={job_file} L={local_sock} R={remote_sock} C={cwd} {env} -- {cmd}",
    exec: `/bin/sh ${fakeExec} {cmd}`,
    fetch: "true",
    repo: "/srv/repo",
    max_sessions: null,
  };
  addHost(db, { ...common, name: "dev", shell: common.shell.replace("J={job_file} ", "") });
  addHost(db, { ...common, name: "far", shell: common.shell.replace("J={job_file} ", "") });
  addHost(db, { ...common, name: "lz", transport: "lease", stop: `/bin/sh ${stop} {job}` });
  state = freshMockState();
  const fake = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    beforeTmux?.(args);
    const res = await fake(args);
    // A lease pane is a carrier: it publishes its job file at once.
    if (isPaneCall(args)) {
      // A split of the agent's existing window names no window: only worker-1 runs on lz.
      const n = args.indexOf("-n");
      const name = (n >= 0 ? args[n + 1] : undefined) ?? "worker-1";
      const file = carrierJobFilePath("auth", name, dir);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "job-1\n");
    }
    return res;
  });
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

const spawn = (over: Partial<Parameters<typeof spawnAgent>[1]> = {}) =>
  spawnAgent(db, { name: "worker-1", workstream: "auth", host: "dev", cwd: "~/x", ...over });
const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e,
  );

/** A managed remote worktree agent of workstream `other` at P (host, cwd and base recorded). */
const managedOwner = (host = "dev", repo: string | null = "/srv/repo") =>
  insertAgent(db, {
    ...{ name: "w-9", workstream: "other", paneId: "%90", host, cwd: P, base: SHA },
    ...{ repo, collectedHead: SHA2 },
  });
/** A removed managed agent's record at `cwd` (its row deleted: the trigger keeps the tree). */
const recorded = (cwd = P, name = "w-9", host = "dev"): RemoteRecovery => {
  insertAgent(db, {
    ...{ name, workstream: "other", paneId: "%91", host, cwd, base: SHA, repo: "/srv/repo" },
  });
  deleteAgent(db, name, "other");
  const rec = listRemoteRecoveries(db).at(-1);
  if (rec === undefined) throw new Error("no record");
  return rec;
};
const rowOf = (name: string, ws: string) =>
  db
    .prepare(
      "SELECT a.* FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE a.name = ? AND w.name = ?",
    )
    .get(name, ws);

/** Refused before any pane: no pane call, only prepare's exec ran, nothing held or registered. */
const refusedBeforePane = async (p: Promise<unknown>, host = "dev"): Promise<Error> => {
  const e = await failure(p);
  expect(e).toBeInstanceOf(RemotePathOwnedError);
  expect(paneCalls()).toEqual([]);
  expect(execCalls()).toHaveLength(1);
  expect(execCalls()[0]).toContain("MU_CWD");
  expect(listHostChannels(db, host)).toEqual([]);
  expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  expect((e as Error).message).toContain("The agent was not started");
  return e as Error;
};

describe("stage a: refused after prepare resolved the path, before any pane", () => {
  it("another workstream's managed tree: refused, its owner untouched, both ways out named", async () => {
    managedOwner();
    const before = rowOf("w-9", "other");
    const e = await refusedBeforePane(spawn());
    expect(e.message).toContain(`${P} on dev is the managed remote worktree of other/w-9`);
    expect((e as RemotePathOwnedError).next).toEqual([
      "mu agent close w-9 -w other",
      `mu agent spawn worker-1 -w auth --host dev --worktree --root /srv/repo --from ${SHA2}`,
    ]);
    expect(rowOf("w-9", "other")).toEqual(before);
  });

  it("a recovery's canonical path, its aside, and an OLDER record: each refused, records unchanged", async () => {
    const old = recorded(P, "w-8");
    recorded("/elsewhere", "w-7"); // a newer record of another path
    const recs = listRemoteRecoveries(db);
    let e = await refusedBeforePane(spawn());
    expect(e.message).toContain(
      `the worktree of recovery ${old.agentId} (removed agent other/w-8)`,
    );
    expect(listRemoteRecoveries(db)).toEqual(recs);
    setCwd(old.aside);
    e = (await failure(spawn())) as Error;
    expect(e).toBeInstanceOf(RemotePathOwnedError);
    expect(e.message).toContain(`is the parked aside of the worktree of recovery ${old.agentId}`);
    expect(paneCalls()).toEqual([]);
    expect(listRemoteRecoveries(db)).toEqual(recs);
  });

  it("a lease profile: refused before the carrier, its reservation released", async () => {
    managedOwner("lz");
    await refusedBeforePane(spawn({ host: "lz" }), "lz");
    expect(getCarrierJobByName(db, "auth", "worker-1")).toBeUndefined();
  });
});

describe("what stays allowed", () => {
  it("the same path on another host profile", async () => {
    managedOwner("far");
    recorded(P, "w-8", "far");
    await spawn();
    expect(getAgent(db, "worker-1", "auth")).toMatchObject({ host: "dev", cwd: P });
  });

  it("two --cwd agents in one unmanaged checkout, both admitted (no name-based refusal)", async () => {
    setCwd("/srv/repo");
    await spawn();
    await spawn({ name: "worker-2" });
    expect(getAgent(db, "worker-2", "auth")).toMatchObject({ cwd: "/srv/repo", base: null });
  });

  it("a same-name respawn at an unrelated path while its recovery exists", async () => {
    recorded(P, "worker-1");
    db.prepare("UPDATE remote_recovery SET workstream = 'auth' WHERE name = 'worker-1'").run();
    setCwd("/srv/repo");
    await spawn();
    expect(getAgent(db, "worker-1", "auth")?.cwd).toBe("/srv/repo");
  });

  it("a descendant of a managed tree is out of scope", async () => {
    managedOwner();
    setCwd(`${P}/sub`);
    await spawn();
    expect(getAgent(db, "worker-1", "auth")?.cwd).toBe(`${P}/sub`);
  });
});

describe("stage b: an owner landing while the pane opens is refused at the insert", () => {
  const atPaneCreation = (intrude: () => void): void => {
    let done = false;
    beforeTmux = (a) => {
      if (isPaneCall(a) && !done) {
        done = true;
        intrude();
      }
    };
  };

  it("a managed owner: the pane is killed and said so, no row, the owner and channels untouched", async () => {
    atPaneCreation(() => managedOwner());
    const e = (await failure(spawn())) as Error;
    expect(e).toBeInstanceOf(RemotePathOwnedError);
    expect(paneCalls()).toHaveLength(1);
    expect(e.message).toMatch(
      /Found after its pane opened: tmux pane %\d+ was killed; no agent was registered$/,
    );
    expect(livePanes()).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(getAgent(db, "w-9", "other")).toMatchObject({ cwd: P, base: SHA });
    expect(listHostChannels(db, "dev")).toEqual([]);
  });

  it("a recovery record: refused, the record unchanged", async () => {
    let rec: RemoteRecovery | undefined;
    atPaneCreation(() => {
      rec = recorded();
    });
    const e = (await failure(spawn())) as Error;
    expect(e).toBeInstanceOf(RemotePathOwnedError);
    expect(e.message).toContain(`recovery ${rec?.agentId}`);
    expect(e.message).toContain("was killed");
    expect(listRemoteRecoveries(db)).toEqual([rec]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("the kill unproven: exit 4 naming the pane, the backend and its kill; the channel kept", async () => {
    atPaneCreation(() => managedOwner());
    const was = beforeTmux;
    beforeTmux = (a) => {
      was?.(a);
      if (a[0] === "kill-pane") throw new Error("tmux transport broke");
    };
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--host", "dev", "--cwd", "~/x", "--json"],
      join(dir, "mu.db"),
    );
    expect(r.exitCode).toBe(4);
    expect(r.doc).toMatchObject({ error: "RemotePathOwnedError" });
    const msg = String((r.doc as Record<string, unknown>).message);
    const [pane] = livePanes();
    expect(pane).toMatch(/^%\d+$/);
    expect(msg).toContain(
      `tmux pane ${pane} (host dev) is not proven gone and may still run its transport`,
    );
    // The exact argv the backend's own kill sends (the executor's), behind tmux's global flags.
    const kill = mux.calls.find((c) => c[0] === "kill-pane");
    expect(kill).toEqual(["kill-pane", "-t", pane]);
    expect(msg).toMatch(new RegExp(`Kill it: tmux (-L \\S+ -f /dev/null )?kill-pane -t ${pane}$`));
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(getAgent(db, "w-9", "other")).toMatchObject({ cwd: P, base: SHA });
    // The pane is not proven gone: the spawn's channel is not released early.
    expect(listHostChannels(db, "dev").map((c) => c.holder)).toEqual(["spawn:auth/worker-1"]);
  });

  it("a pane id another agent's row now holds: left alone, never reported killed nor its kill offered", async () => {
    atPaneCreation(() => {
      insertAgent(db, {
        name: "w-9",
        workstream: "other",
        host: "dev",
        cwd: P,
        paneId: "%1",
        base: SHA,
      });
    });
    const e = (await failure(spawn())) as Error;
    expect(e).toBeInstanceOf(RemotePathOwnedError);
    expect(livePanes()).toEqual(["%1"]);
    expect(mux.calls.filter((a) => a[0] === "kill-pane")).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(getAgent(db, "w-9", "other")?.paneId).toBe("%1");
    expect(e.message).toMatch(
      /tmux pane %1 now belongs to other\/w-9 and was left alone; this spawn's transport may still run in it\. No agent was registered$/,
    );
    expect(e.message).not.toContain("killed");
    expect(e.message).not.toContain("kill-pane");
  });

  it("a lease spawn whose stop fails keeps its reservation; a clean stop releases it", async () => {
    atPaneCreation(() => managedOwner("lz"));
    writeFileSync(join(dir, "stop-exit"), "1");
    let e = (await failure(spawn({ host: "lz" }))) as Error;
    expect(e).toBeInstanceOf(RemotePathOwnedError);
    expect(getCarrierJobByName(db, "auth", "worker-1")).toMatchObject({
      job: "job-1",
      launch: "intent",
    });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    db.prepare("DELETE FROM carrier_jobs").run();
    deleteAgent(db, "w-9", "other", undefined, { preserve: false });
    writeFileSync(join(dir, "stop-exit"), "0");
    atPaneCreation(() => managedOwner("lz"));
    e = (await failure(spawn({ host: "lz" }))) as Error;
    expect(e).toBeInstanceOf(RemotePathOwnedError);
    expect(e.message).toContain("was killed");
    expect(getCarrierJobByName(db, "auth", "worker-1")).toBeUndefined();
  });
});

describe("the refusal's way out", () => {
  /** argv of each `mu ...` line as /bin/sh parses it. */
  const argvOf = (line: string): string[] =>
    execFileSync("/bin/sh", ["-c", `mu() { printf '%s\\n' "$@"; }; ${line}`], { encoding: "utf8" })
      .split("\n")
      .slice(0, -1);

  it("CLI exit 4; the agent commands paste through /bin/sh with a repo path holding a space", async () => {
    managedOwner("dev", "/srv/my repo");
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--host", "dev", "--cwd", "~/x", "--json"],
      join(dir, "mu.db"),
    );
    expect(r.exitCode).toBe(4);
    expect(r.doc).toMatchObject({ error: "RemotePathOwnedError" });
    const e = (await failure(spawn())) as RemotePathOwnedError;
    const [close = "", own = ""] = e.next;
    expect(e.message).toContain(close);
    expect(e.message).toContain(own);
    expect(argvOf(close)).toEqual(["agent", "close", "w-9", "-w", "other"]);
    expect(argvOf(own)).toEqual(
      ["agent", "spawn", "worker-1", "-w", "auth", "--host", "dev", "--worktree"].concat([
        "--root",
        "/srv/my repo",
        "--from",
        SHA2,
      ]),
    );
  });

  it("a command gate: the owner's close and the gate in an unmanaged checkout, never --worktree", async () => {
    managedOwner("dev", "/srv/my repo");
    const e = (await refusedBeforePane(spawn({ command: "npm test" }))) as RemotePathOwnedError;
    const [close = "", gate = ""] = e.next;
    expect(e.next).toHaveLength(2);
    expect(e.message).toContain(close);
    expect(e.message).toContain(`run the gate in an unmanaged checkout: ${gate}`);
    expect(argvOf(close)).toEqual(["agent", "close", "w-9", "-w", "other"]);
    const argv = argvOf(gate);
    expect(argv).toEqual(
      ["agent", "spawn", "worker-1", "-w", "auth", "--host", "dev"].concat([
        "--cwd",
        "/srv/my repo",
        "--command",
        "npm test",
      ]),
    );
    const flag = (f: string) => argv[argv.indexOf(f) + 1];
    expect(isCommandGate({ host: flag("--host"), command: flag("--command") })).toBe(true);
  });

  it("several records of one name (one on another profile): collect and close select the reported one", async () => {
    recorded("/a", "w-9", "far");
    const here = recorded(P, "w-9", "dev");
    recorded("/b", "w-9", "dev");
    const e = (await failure(spawn())) as RemotePathOwnedError;
    expect(e.next).toHaveLength(2);
    for (const [i, line] of e.next.entries()) {
      expect(e.message).toContain(line);
      const argv = argvOf(line);
      expect(argv.slice(0, 5)).toEqual([
        "agent",
        i === 0 ? "collect" : "close",
        "w-9",
        "-w",
        "other",
      ]);
      expect(argv.slice(5, 6)).toEqual(["--recovery"]);
      expect(selectRemoteRecovery(db, "other", "w-9", Number(argv[6]))).toEqual(here);
    }
  });
});

describe("killPaneCommand: each backend's own kill, on the server mu drives", () => {
  const line = (b: "tmux" | "herdr" | "rex", id: string): string =>
    attachShellLine([muxByName(b).killPaneCommand(id)]);

  it("tmux kill-pane, herdr pane close, rex block close, each with its server selector", async () => {
    await withEnv("MU_TMUX_SOCKET", "priv", async () => {
      expect(line("tmux", "%3")).toBe("tmux -L priv -f /dev/null kill-pane -t %3");
    });
    await withEnv("MU_HERDR_SESSION", "s1", async () => {
      expect(line("herdr", "w1:p2")).toBe("herdr --session s1 pane close w1:p2");
    });
    await withEnv("REX_BIN_DIR", undefined, () =>
      withEnv("MU_REX_SERVER", "/tmp/rx sock", async () => {
        expect(line("rex", "blk-1")).toBe("rex -S '/tmp/rx sock' block close blk-1");
      }),
    );
  });
});
