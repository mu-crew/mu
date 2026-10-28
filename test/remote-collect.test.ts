// `agent collect` and the remote half of `agent close` (v_remote_collect), fast
// tier: no real git, no real host. The profile's exec template is a canned sh
// shim (it answers the two tagged lines mu's remote scripts end in and logs
// what it was asked), the mux is the fake tmux, the lease rows are real SQLite.
// What this pins: the ORDER (the pane dies, and frees the only channel, before
// any remote command), the refusals, and that nothing remote runs for a row
// without a remote worktree. The real-git twin is remote-collect.integration.test.ts.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentNotFoundError, AgentPaneStillAliveError } from "../src/agents/errors.js";
import { closeAgent, getAgent, insertAgent, previewClose } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  addHost,
  admitHostChannel,
  bindHostChannel,
  HostChannelBusyError,
  HostHandbackError,
  listHostChannels,
} from "../src/hosts.js";
import { resetMux } from "../src/mux.js";
import { RemoteCloseRefusedError } from "../src/remote-agent.js";
import { collectRemoteAgent, RemoteCollectUnsupportedError } from "../src/remote-collect.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

const BASE = "b".repeat(40);
const COLLECTED = "c".repeat(40);
const OTHER = "d".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/auth/worker-1";

let dir: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let execLog: string;
let fetchLog: string;

const execCalls = (): string[] =>
  readdirSync(execLog)
    .sort((a, b) => Number(a) - Number(b))
    .map((f) => readFileSync(join(execLog, f), "utf8"));
const fetchCalls = (): number => readdirSync(fetchLog).length;
/** What the canned exec answers to the observe script / the remove script. */
const answer = (observe: string, remove = "MU_RM removed", observeExit = 0): void => {
  writeFileSync(join(dir, "observe"), `${observe}\n`);
  writeFileSync(join(dir, "remove"), `${remove}\n`);
  writeFileSync(join(dir, "observe-exit"), String(observeExit));
};
const channels = () => listHostChannels(db, "dev");

/** A remote worker row whose live pane holds the host's attached channel, as a real spawn leaves it. */
async function remoteAgent(
  over: {
    base?: string | null;
    collectedHead?: string | null;
    host?: string;
    name?: string;
    repo?: string | null;
  } = {},
) {
  const name = over.name ?? "worker-1";
  const pane = `%${state.nextPaneId++}`;
  state.panes.set(pane, { windowId: "@1", paneId: pane, command: "ssh" });
  const row = insertAgent(db, {
    name,
    workstream: "auth",
    paneId: pane,
    cwd: WT,
    base: over.base === undefined ? BASE : over.base,
    host: over.host ?? "dev",
    repo: over.repo === undefined ? "/srv/repo" : over.repo,
    collectedHead: over.collectedHead ?? null,
  });
  const { lease } = await admitHostChannel(db, over.host ?? "dev", `spawn:auth/${name}`);
  expect(bindHostChannel(db, lease, { agentId: row.incarnation, paneId: pane })).toBe(true);
  return row;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrc-"));
  db = openDb({ path: join(dir, "mu.db") });
  execLog = join(dir, "execlog");
  fetchLog = join(dir, "fetchlog");
  mkdirSync(execLog);
  mkdirSync(fetchLog);
  answer(`MU_STATE clean ${BASE}`);
  const fakeExec = join(dir, "fake-exec.sh");
  writeFileSync(
    fakeExec,
    `#!/bin/sh
n=$(ls '${execLog}' | wc -l)
printf '%s' "$1" > '${execLog}'/$n
case "$1" in
  *MU_STATE*) cat '${dir}/observe'; [ -f '${dir}/handback' ] && { echo "touch your key" >&2; exit 3; }; exit $(cat '${dir}/observe-exit') ;;
  *MU_RM*) cat '${dir}/remove' ;;
esac
`,
  );
  chmodSync(fakeExec, 0o755);
  const fakeFetch = join(dir, "fake-fetch.sh");
  writeFileSync(fakeFetch, `#!/bin/sh\nprintf x > '${fetchLog}'/$$\n`);
  for (const [name, cap] of [
    ["dev", 1],
    ["wide", null],
  ] as const) {
    addHost(db, {
      name,
      shell: "true",
      exec: `/bin/sh ${fakeExec} {cmd}`,
      fetch: `/bin/sh ${fakeFetch} {cwd}`,
      repo: "/srv/repo",
      max_sessions: cap,
    });
  }
  ensureWorkstream(db, "auth");
  state = freshMockState();
  mux = installMux("tmux", mockTmux(state).executor);
});

afterEach(() => {
  mux.restore();
  db.close();
  rmFixtureDir(dir);
});

function withEnvSync(key: string, value: string, fn: () => void): void {
  process.env[key] = value;
  fn();
}

describe("agent collect: admission and refusals", () => {
  it("at --max-sessions 1 beside the live pane: the one-line refusal names the holder, no fetch runs", async () => {
    await remoteAgent();
    const err = await collectRemoteAgent(db, {
      workstream: "auth",
      name: "worker-1",
      repo: dir,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostChannelBusyError);
    expect((err as Error).message).toMatch(/spawn:auth\/worker-1/);
    expect((err as Error).message).not.toContain("\n");
    expect(fetchCalls()).toBe(0);
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).toBeNull();
  });

  it("a local agent, a --cwd-only remote agent and an unknown name are refused before any effect", async () => {
    insertAgent(db, { name: "local-1", workstream: "auth", paneId: "%90" });
    await remoteAgent({ base: null, name: "worker-2", host: "wide" });
    for (const name of ["local-1", "worker-2"]) {
      const err = await collectRemoteAgent(db, { workstream: "auth", name, repo: dir }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RemoteCollectUnsupportedError);
    }
    await expect(
      collectRemoteAgent(db, { workstream: "auth", name: "ghost", repo: dir }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    expect(fetchCalls()).toBe(0);
  });

  it("the CLI maps a full host to exit 4 and a local agent to exit 2", async () => {
    await remoteAgent();
    insertAgent(db, { name: "local-1", workstream: "auth", paneId: "%90" });
    const dbPath = join(dir, "mu.db");
    const busy = await runCliJson(["agent", "collect", "worker-1", "-w", "auth", "--json"], dbPath);
    expect(busy.exitCode).toBe(4);
    const local = await runCliJson(["agent", "collect", "local-1", "-w", "auth", "--json"], dbPath);
    expect(local.exitCode).toBe(2);
  });
});

describe("agent close of a remote worktree row", () => {
  const close = (
    over: Parameters<typeof closeAgent>[2] extends infer O ? Partial<O> : never = {},
  ) => closeAgent(db, "worker-1", { workstream: "auth", ...over });

  it("kills the pane FIRST (the only channel), then checks, then removes without --force", async () => {
    await remoteAgent();
    // At cap 1 the live pane holds the only channel: a remote command before the kill would be refused.
    const r = await close();
    expect(r).toMatchObject({ killedPane: true, deletedRow: true });
    expect(r.worktree).toMatchObject({ path: WT, action: "removed" });
    const calls = execCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("MU_STATE");
    expect(calls[1]).toContain("worktree remove");
    expect(calls[1]).not.toContain("--force");
    expect(calls[1]).toContain(BASE);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(channels()).toEqual([]);
  });

  it("a remote row with no recorded repo is never closed against a guessed one", async () => {
    await remoteAgent({ repo: null });
    await expect(close()).rejects.toThrow(/no remote worktree/);
    expect(execCalls()).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("the close runs against the row's repo, not the profile's", async () => {
    await remoteAgent({ repo: "/srv/per-spawn" });
    await close();
    for (const c of execCalls()) {
      expect(c).toContain("/srv/per-spawn");
      expect(c).not.toContain("/srv/repo");
    }
  });

  it("HEAD at the last collected HEAD is removable", async () => {
    await remoteAgent({ collectedHead: COLLECTED });
    answer(`MU_STATE clean ${COLLECTED}`);
    expect((await close()).worktree).toMatchObject({ action: "removed" });
    expect(execCalls()[1]).toContain(COLLECTED);
  });

  it("an uncollected HEAD refuses with one line, keeps the row, runs no removal; --discard does not override", async () => {
    await remoteAgent({ collectedHead: COLLECTED });
    answer(`MU_STATE clean ${OTHER}`);
    for (const over of [{}, { discard: true }]) {
      const err = await close(over).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteCloseRefusedError);
      expect((err as Error).message).not.toContain("\n");
      expect((err as Error).message).toContain(OTHER.slice(0, 12));
    }
    expect(execCalls().filter((c) => c.includes("worktree remove"))).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("dirty refuses, also with --keep-branch and --discard (a branch keeps commits, not files)", async () => {
    await remoteAgent();
    answer(`MU_STATE dirty ${BASE}`);
    for (const over of [{}, { keepBranch: true }, { discard: true }]) {
      await expect(close(over)).rejects.toBeInstanceOf(RemoteCloseRefusedError);
    }
    expect(execCalls().filter((c) => c.includes("worktree remove"))).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("--keep-branch at an unmerged HEAD names mu/<ws>/<agent>-<sha12> at the observed HEAD, then removes", async () => {
    await remoteAgent();
    answer(`MU_STATE clean ${OTHER}`);
    const r = await close({ keepBranch: true });
    const branch = `mu/auth/worker-1-${OTHER.slice(0, 12)}`;
    expect(r.worktree).toMatchObject({ path: WT, action: "kept-branch", branch });
    const rm = execCalls()[1] ?? "";
    expect(rm).toContain(branch);
    expect(rm).toContain(OTHER);
    expect(rm).not.toContain("--force");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("a removal that finds HEAD moved or a branch in the way refuses and keeps the row", async () => {
    for (const refusal of ["MU_RM moved", "MU_RM dirty", "MU_RM branch-collision"]) {
      await remoteAgent({ name: "worker-1" });
      answer(`MU_STATE clean ${OTHER}`, refusal);
      await expect(close({ keepBranch: true })).rejects.toBeInstanceOf(RemoteCloseRefusedError);
      expect(getAgent(db, "worker-1", "auth")).toBeDefined();
      db.prepare("DELETE FROM agents").run();
      db.prepare("DELETE FROM host_channels").run();
    }
  });

  it("a holder, an unprovable host and a stuck move-back each refuse in one line and keep the row", async () => {
    for (const [out, reason, text] of [
      ["MU_RM held 4242", "held", /process 4242/],
      ["MU_RM unproven", "unreadable", /neither \/proc nor lsof/],
      ["MU_RM stuck", "unreadable", /close again to resume/],
    ] as const) {
      await remoteAgent({ name: "worker-1" });
      answer(`MU_STATE clean ${BASE}`, out);
      const err = await close().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteCloseRefusedError);
      expect((err as RemoteCloseRefusedError).reason).toBe(reason);
      expect((err as Error).message).toMatch(text);
      expect((err as Error).message).not.toContain("\n");
      expect(getAgent(db, "worker-1", "auth")).toBeDefined();
      db.prepare("DELETE FROM agents").run();
      db.prepare("DELETE FROM host_channels").run();
    }
  });

  it("with no multiplexer to ask, the pane is never presumed dead: its channel stays and no exec runs", async () => {
    await remoteAgent();
    mux.restore();
    withEnvSync("MU_MUX", "nonsense", () => resetMux());
    const err = await close().catch((e: unknown) => e);
    // Refused before anything is freed: an unknown pane is not a dead one (rr_r3_close_unknown_probe).
    expect(err).toBeInstanceOf(AgentPaneStillAliveError);
    expect((err as AgentPaneStillAliveError).state).toBe("unknown");
    expect(execCalls()).toEqual([]);
    expect(channels()).toHaveLength(1);
    expect(channels()[0]).toMatchObject({ kind: "attached" });
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    mux = installMux("tmux", mockTmux(state).executor);
  });

  it("an observation that fails or says nothing refuses; nothing is removed", async () => {
    await remoteAgent();
    answer("noise", "MU_RM removed", 0);
    await expect(close()).rejects.toBeInstanceOf(RemoteCloseRefusedError);
    answer(`MU_STATE clean ${BASE}`, "MU_RM removed", 7);
    await expect(close()).rejects.toBeInstanceOf(RemoteCloseRefusedError);
    expect(execCalls().filter((c) => c.includes("worktree remove"))).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("an already-missing worktree is reported gone and the row goes", async () => {
    await remoteAgent();
    answer("MU_STATE gone");
    expect((await close()).worktree).toMatchObject({ path: WT, action: "gone" });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("a --cwd-only remote row (no base) never touches the remote", async () => {
    await remoteAgent({ base: null });
    const r = await close();
    expect(r).toMatchObject({ killedPane: true, deletedRow: true, worktree: null });
    expect(execCalls()).toEqual([]);
  });
});

describe("a host template's exit 3 is a hand-back", () => {
  it("close rethrows it unchanged: nothing removed, row and channel state kept", async () => {
    await remoteAgent();
    writeFileSync(join(dir, "handback"), "");
    const err = await closeAgent(db, "worker-1", { workstream: "auth" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostHandbackError);
    expect((err as HostHandbackError).detail).toBe("touch your key");
    expect(execCalls().filter((c) => c.includes("worktree remove"))).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });
});

describe("agent close preview", () => {
  it("describes the remote worktree and the rule, with no remote command and no kill", async () => {
    await remoteAgent({ collectedHead: COLLECTED });
    const p = await previewClose(db, "worker-1", { workstream: "auth", keepBranch: true });
    expect(p.remote).toEqual({ host: "dev", path: WT, base: BASE, collectedHead: COLLECTED });
    expect(p.keepBranch).toBe(true);
    expect(p.worktree).toBeNull();
    expect(execCalls()).toEqual([]);
    expect(mux.calls.filter((c) => c[0] === "kill-pane")).toEqual([]);
  });

  it("the CLI preview prints the remote line and the apply command keeps --keep-branch", async () => {
    await remoteAgent();
    const r = await runCliJson(
      ["agent", "close", "worker-1", "-w", "auth", "--keep-branch", "--json"],
      join(dir, "mu.db"),
    );
    expect(r.data.remote).toMatchObject({ host: "dev", path: WT, base: BASE });
    expect(r.doc.next).toEqual({
      mode: "alt",
      commands: [`mu agent close worker-1 -w auth --keep-branch --if ${r.data.revision}`],
    });
  });

  it("a local agent has no remote section", async () => {
    insertAgent(db, { name: "local-1", workstream: "auth", paneId: "%90" });
    expect((await previewClose(db, "local-1", { workstream: "auth" })).remote).toBeNull();
  });
});
