// spawn --task for a REMOTE hooks worker (spec D17, D11, U21): its brief file
// is written on its host through the profile's exec template, the brief as
// one argument, and a brief over 96 KB is refused with a typed error before
// anything is spawned or sent. The host is a fake node
// (test/_fake-remote-node.ts) whose exec runs each command here; the local
// pane is the fake harness (test/_fake-harness.ts) on the mock tmux's %1.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  briefFileName,
  briefPointer,
  briefPrintfOperand,
  EXEC_ARG_MAX_BYTES,
  REMOTE_BRIEF_MAX_BYTES,
  remoteBriefScript,
  writeRemoteBriefFile,
} from "../src/agents/hooks-brief.js";
import { getReceipt, requestSha, reserveReceipt } from "../src/agents/receipts.js";
import {
  getAgent,
  RemoteBriefTooLargeError,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAutoAttempt,
  spawnForTask,
} from "../src/agents.js";
import {
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { parseHarnessProbe, recordHostCapabilities } from "../src/host-harnesses.js";
import { addHost, expandHostTemplate, getHost, listHostChannels } from "../src/hosts.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask, selectTaskNotes, taskIdFor } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { INC, withHello } from "./_ctl-ext.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { type FakeRemoteNode, fakeRemoteNode } from "./_fake-remote-node.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
/** The worker's cwd on the "host" (the fake node runs here, so it is a local dir). */
let remoteCwd: string;
let db: Db;
let mux: MuxHarness;
let fake: FakeHarness;
let node: FakeRemoteNode;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrtb-"));
  // Physical, as the host's `pwd -P` names it (macOS's /var is /private/var).
  remoteCwd = realpathSync(mkdtempSync(join(tmpdir(), "mrtb-cwd-")));
  db = openDb({ path: join(dir, "mu.db") });
  saved = { l: process.env.MU_SPAWN_LIVENESS_MS, a: process.env.MU_SPAWN_ACK_MS };
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  process.env.MU_SPAWN_ACK_MS = "1000";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  ensureWorkstream(db, "auth");
  addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1 });
  node = fakeRemoteNode(dir);
  addHost(db, {
    name: "dev",
    shell: "echo {env} -- {cmd}",
    exec: node.exec,
    fetch: "true",
    repo: null,
    max_sessions: null,
  });
  // The local pane is the transport: the harness runs on the node, so a paste fires
  // nothing here but the node's own prompt_submitted.
  fake = fakeHarness(dir, "%1", "sess-1");
  fake.acks = false;
  fake.onSubmit = () => node.emit("prompt_submitted");
  setMurmurPaneRunnerForTests(fake.pane);
  setMurmurHookRunnerForTests(fake.hook);
  const tmux = mockTmux(freshMockState()).executor;
  mux = installMux("tmux", async (args) => fake.tmux(args) ?? tmux(args));
});

afterEach(() => {
  mux.restore();
  setMurmurPaneRunnerForTests(null);
  setMurmurHookRunnerForTests(null);
  resetSleep();
  resetCommandResolverForTests();
  db.close();
  for (const [k, v] of Object.entries({
    MU_SPAWN_LIVENESS_MS: saved.l,
    MU_SPAWN_ACK_MS: saved.a,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmFixtureDir(dir);
  rmFixtureDir(remoteCwd);
});

const TEXT = "do the thing\nit's 'quoted', \"double\", $HOME and `ticks`\n\n";
const req = (text = TEXT) => ({
  task: "t1",
  text,
  spawn: { name: "worker-1", workstream: "auth", cli: "claude", host: "dev", cwd: remoteCwd },
});
const remoteBrief = () => join(remoteCwd, ".mu", briefFileName("worker-1", "manual:t1"));
const briefExecs = () => node.execCalls().filter((c) => c.includes("MU_BRIEF"));

describe("a remote hooks worker's task brief (spec D17)", () => {
  it("reads the node for its session, writes the brief file there through exec, pastes one pointer", async () => {
    node.emit("session_start", { source: "startup" });
    const out = await spawnForTask(db, req());
    expect(out).toMatchObject({ state: "sent", replay: false, brief: "recorded" });
    expect(readFileSync(remoteBrief(), "utf8")).toBe(TEXT);
    expect(readFileSync(join(remoteCwd, ".mu", ".gitignore"), "utf8")).toBe("*\n");
    // Exactly one exec wrote it, and only the pointer went through the paste.
    expect(briefExecs()).toHaveLength(1);
    expect(fake.submitted).toEqual([briefPointer(remoteBrief())]);
    const rec = getReceipt(db, taskIdFor(db, "t1", "auth") ?? 0, "manual:t1");
    expect(rec).toMatchObject({ state: "sent", transport: "hooks", incarnation: "sess-1" });
    expect(getAgent(db, "worker-1", "auth")).toMatchObject({ channel: "hooks", host: "dev" });
    expect(getTask(db, "t1", "auth")?.ownerName).toBe("worker-1");
    const notes = selectTaskNotes(db, "t1", { workstream: "auth" }).notes;
    expect(notes.filter((n) => n.kind === "brief").map((n) => n.content)).toEqual([TEXT]);
  });

  it("a claude worker whose node reports no session yet is read again until it does, then briefed", async () => {
    // The harness starts on the node only after mu's first read of it.
    let localReads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      localReads += 1;
      if (localReads === 1) node.emit("session_start", { source: "startup" });
      return fake.pane(pane);
    });
    const out = await spawnForTask(db, req());
    expect(out.state).toBe("sent");
    const calls = node.execCalls();
    const firstBrief = calls.findIndex((c) => c.includes("MU_BRIEF"));
    // Two readiness reads of the node (the second relays the session), then the file.
    expect(
      calls.slice(0, firstBrief).filter((c) => c.includes("murmur pane --remote")),
    ).toHaveLength(2);
    expect(out.receipt).toMatchObject({ incarnation: "sess-1", runs: 0 });
  });

  it("a brief over 96 KB fails with the typed error before anything is spawned, sent or run on the host", async () => {
    const big = "x".repeat(97 * 1024);
    await expect(spawnForTask(db, req(big))).rejects.toBeInstanceOf(RemoteBriefTooLargeError);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(getReceipt(db, taskIdFor(db, "t1", "auth") ?? 0, "manual:t1")).toBeUndefined();
    expect(getTask(db, "t1", "auth")?.ownerName ?? null).toBeNull();
    expect(node.execCalls()).toEqual([]);
    expect(fake.submitted).toEqual([]);
  });

  it("an executor attempt with an oversized brief fails inside the attempt before its spawn: receipt failed, nothing run", async () => {
    node.emit("session_start", { source: "startup" });
    const big = "x".repeat(97 * 1024);
    const taskId = taskIdFor(db, "t1", "auth") ?? 0;
    reserveReceipt(db, {
      taskId,
      attemptKey: "auto:1",
      name: "worker-1",
      workstream: "auth",
      requestSha: requestSha({ name: "worker-1", nextFree: false, text: big, host: "dev" }),
      msgId: "m-1",
    });
    const err = await spawnAutoAttempt(db, {
      ...req(big),
      key: "auto:1",
      guard: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteBriefTooLargeError);
    expect(getReceipt(db, taskId, "auto:1")).toMatchObject({ state: "failed" });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(getTask(db, "t1", "auth")).toMatchObject({ ownerId: null, status: "OPEN" });
    // No pane, no remote prepare: the message's "nothing was sent" holds, and nothing was spawned.
    const panes = ["new-session", "new-window", "split-window"];
    expect(mux.calls.some((a) => panes.includes(a[0] ?? ""))).toBe(false);
    expect(node.execCalls()).toEqual([]);
    expect(fake.submitted).toEqual([]);
  });

  it("the CLI says so: exit 2, naming the size, the cap and the host", async () => {
    const big = "y".repeat(97 * 1024);
    const r = await runCliJson(
      [
        ...["agent", "spawn", "worker-1", "-w", "auth", "--cli", "claude", "--host", "dev"],
        ...["--cwd", remoteCwd, "--task", "t1", "--send", big, "--json"],
      ],
      join(dir, "mu.db"),
    );
    expect(r.exitCode).toBe(2);
    expect(String(r.doc.message)).toContain(
      `${97 * 1024} bytes; on dev it is written through the host's exec template`,
    );
    expect(node.execCalls()).toEqual([]);
  });
});

describe("a remote claude worker and a remote pi worker on one host (spec D17)", () => {
  it("both pass the host's recorded probe: claude on hooks with its brief file, pi on ctl", async () => {
    const caps = parseHarnessProbe(
      [
        "MU_HARNESS claude 1 1 /usr/bin/claude",
        "MU_HARNESS codex 0 0 ",
        "MU_HARNESS cursor-agent 0 0 ",
        "MU_HARNESS muse 0 - ",
        "MU_HARNESS pi - - /usr/bin/pi",
      ].join("\n"),
      "login",
    );
    if (caps === undefined) throw new Error("no caps");
    expect(recordHostCapabilities(db, getHost(db, "dev"), caps)).toBe(true);
    addTask(db, { localId: "t2", workstream: "auth", title: "P", impact: 50, effortDays: 1 });
    // The pi worker's extension, "forwarded" to its derived local socket as its pane starts.
    const server = createServer((c) => {
      const dec = new LineDecoder();
      c.setEncoding("utf8");
      c.on("error", () => {});
      c.on("data", (chunk: string) => {
        for (const line of dec.push(chunk)) {
          const r = JSON.parse(line) as { op: string };
          const idle = { v: 1, ok: true, state: "idle", since: 1, runs: 0, pending: false };
          c.end(encode(withHello(r, idle)));
        }
      });
    });
    const tmux = mockTmux(freshMockState()).executor;
    mux.restore();
    mux = installMux("tmux", async (args) => {
      const res = fake.tmux(args) ?? (await tmux(args));
      if (["new-session", "new-window"].includes(args[0] ?? "") && args.includes("pi-1")) {
        const sock = ctlSocketPath("auth", "pi-1", dir);
        mkdirSync(dirname(sock), { recursive: true });
        await new Promise<void>((r) => server.listen(sock, () => r()));
      }
      return res;
    });
    try {
      node.emit("session_start", { source: "startup" });
      const claude = await spawnForTask(db, req());
      expect(claude.state).toBe("sent");
      expect(readFileSync(remoteBrief(), "utf8")).toBe(TEXT);
      expect(fake.submitted).toEqual([briefPointer(remoteBrief())]);
      const pi = await spawnForTask(db, {
        task: "t2",
        text: "pi brief",
        spawn: { name: "pi-1", workstream: "auth", cli: "pi", host: "dev", cwd: remoteCwd },
      });
      expect(pi).toMatchObject({ state: "sent", replay: false });
      expect(pi.receipt).toMatchObject({ transport: "ctl", incarnation: INC });
      expect(getAgent(db, "worker-1", "auth")).toMatchObject({ host: "dev", channel: "hooks" });
      expect(getAgent(db, "pi-1", "auth")).toMatchObject({ host: "dev", channel: "ctl" });
      expect(getTask(db, "t1", "auth")?.ownerName).toBe("worker-1");
      expect(getTask(db, "t2", "auth")?.ownerName).toBe("pi-1");
      // Only the claude worker got a brief file, and the pi brief never went through a paste.
      expect(briefExecs()).toHaveLength(1);
      expect(fake.submitted).toHaveLength(1);
    } finally {
      if (server.listening) await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("writeRemoteBriefFile", () => {
  it("writes the exact bytes at the cap, and refuses one byte more without running exec", async () => {
    const atCap = `${"a".repeat(REMOTE_BRIEF_MAX_BYTES - 1)}\n`;
    const path = await writeRemoteBriefFile(db, "dev", remoteCwd, "w", "auth", "auto:1", atCap);
    expect(path).toBe(join(remoteCwd, ".mu", briefFileName("w", "auto:1")));
    expect(readFileSync(path, "utf8")).toBe(atCap);
    const calls = node.execCalls().length;
    await expect(
      writeRemoteBriefFile(db, "dev", remoteCwd, "w", "auth", "auto:2", `${atCap}!`),
    ).rejects.toMatchObject({
      name: "RemoteBriefTooLargeError",
      bytes: REMOTE_BRIEF_MAX_BYTES + 1,
      cap: REMOTE_BRIEF_MAX_BYTES,
      host: "dev",
    });
    expect(node.execCalls()).toHaveLength(calls);
    expect(existsSync(join(remoteCwd, ".mu", briefFileName("w", "auto:2")))).toBe(false);
  });

  it("a brief full of apostrophes and backslashes is never grown by quoting: at the cap it is written byte for byte", async () => {
    // Each ' is 5 bytes escaped (\0047), each \ two: the escaped brief is exactly the cap.
    const unit = "it's \\'q\\' ";
    const escapedUnit = Buffer.byteLength(briefPrintfOperand(unit));
    const reps = Math.floor(REMOTE_BRIEF_MAX_BYTES / escapedUnit);
    const pad = "b".repeat(REMOTE_BRIEF_MAX_BYTES - reps * escapedUnit);
    const text = unit.repeat(reps) + pad;
    expect(Buffer.byteLength(briefPrintfOperand(text))).toBe(REMOTE_BRIEF_MAX_BYTES);
    expect(text.split("'").length - 1).toBeGreaterThan(10_000);
    const path = await writeRemoteBriefFile(db, "dev", remoteCwd, "w", "auth", "auto:1", text);
    expect(readFileSync(path, "utf8")).toBe(text);
    // The filled exec template, the one argument the local /bin/sh gets, stays under 128 KiB.
    const cmd = remoteBriefScript(remoteCwd, "w", "auto:1", text);
    const filled = expandHostTemplate(node.exec, { cmd, cwd: remoteCwd }, "exec");
    expect(Buffer.byteLength(filled)).toBeLessThan(EXEC_ARG_MAX_BYTES);
    expect(Buffer.byteLength(filled) - REMOTE_BRIEF_MAX_BYTES).toBeLessThan(4096);
  });

  it("a raw brief under 96 KB that is over it escaped is refused, naming both sizes", async () => {
    const text = "'".repeat(30 * 1024);
    const calls = node.execCalls().length;
    const err = await writeRemoteBriefFile(db, "dev", remoteCwd, "w", "auth", "k", text).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      name: "RemoteBriefTooLargeError",
      bytes: 30 * 1024,
      escaped: 5 * 30 * 1024,
      cap: REMOTE_BRIEF_MAX_BYTES,
    });
    expect(String((err as Error).message)).toContain(
      `is ${30 * 1024} bytes (${5 * 30 * 1024} with its \\ and ' escaped)`,
    );
    expect(node.execCalls()).toHaveLength(calls);
  });

  it("a filled template of 128 KiB or more is refused with the typed error, and nothing runs", async () => {
    const longCwd = `/${"c".repeat(40 * 1024)}`;
    const text = "a".repeat(90 * 1024);
    const calls = node.execCalls().length;
    const err = await writeRemoteBriefFile(db, "dev", longCwd, "w", "auth", "k", text).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RemoteBriefTooLargeError);
    expect(err).toMatchObject({ host: "dev", bytes: 90 * 1024, cap: EXEC_ARG_MAX_BYTES });
    expect((err as RemoteBriefTooLargeError).command).toBeGreaterThanOrEqual(EXEC_ARG_MAX_BYTES);
    expect(String((err as Error).message)).toContain("over the 131072-byte limit");
    expect(node.execCalls()).toHaveLength(calls);
    expect(listHostChannels(db, "dev")).toEqual([]);
  });

  it("a host that cannot write it fails with the host named, before any paste", async () => {
    await expect(
      writeRemoteBriefFile(db, "dev", join(remoteCwd, "missing\0"), "w", "auth", "k", "t"),
    ).rejects.toThrow();
    await expect(
      writeRemoteBriefFile(db, "dev", "/proc/no/such/dir", "w", "auth", "k", "t"),
    ).rejects.toMatchObject({ name: "RemotePrepareError", host: "dev" });
  });
});
