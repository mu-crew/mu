// spawn --task as ONE journaled attempt (v_spawn_receipts): stage-by-stage
// outcomes, replay, replacement, eviction. A real unix-socket server stands
// in for the mu pi extension; the mux is the fake tmux harness.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Seams to swap the agent (or the task) at an exact point inside one attempt. */
const hook = vi.hoisted(() => ({
  beforeClaim: undefined as undefined | (() => Promise<void> | void),
  afterClaim: undefined as undefined | (() => Promise<void> | void),
  beforeSendToAgent: undefined as undefined | (() => Promise<void> | void),
}));
vi.mock("../src/tasks/claim.js", async (orig) => {
  const real = await orig<typeof import("../src/tasks/claim.js")>();
  return {
    ...real,
    claimTask: async (...a: Parameters<typeof real.claimTask>) => {
      const before = hook.beforeClaim;
      hook.beforeClaim = undefined;
      if (before) await before();
      const r = await real.claimTask(...a);
      const after = hook.afterClaim;
      hook.afterClaim = undefined;
      if (after) await after();
      return r;
    },
  };
});
vi.mock("../src/agents.js", async (orig) => {
  const real = await orig<typeof import("../src/agents.js")>();
  return {
    ...real,
    sendToAgent: async (...a: Parameters<typeof real.sendToAgent>) => {
      const before = hook.beforeSendToAgent;
      hook.beforeSendToAgent = undefined;
      if (before) await before();
      return real.sendToAgent(...a);
    },
  };
});

import { getReceipt, requestSha, reserveReceipt, updateReceipt } from "../src/agents/receipts.js";
import {
  AgentCtlUnreachableError,
  AgentExistsError,
  AgentReplacedError,
  AgentSendUnsupportedError,
  AgentSlashCommandUnsupportedError,
  deleteAgent,
  getAgent,
  insertAgent,
  resetCommandResolverForTests,
  SpawnAttemptBusyError,
  SpawnReceiptConflictError,
  SpawnTaskStateError,
  SpawnTrustDialogError,
  setCommandResolverForTests,
  spawnForTask,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { claimTask, releaseTask } from "../src/tasks/claim.js";
import { addTask } from "../src/tasks/edit.js";
import { TaskAlreadyOwnedError, TaskNotFoundError, TaskParkedError } from "../src/tasks/errors.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { getTask, selectTaskNotes, taskIdFor } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { helloReply, INC, withHello } from "./_ctl-ext.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliWire } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

const SCREEN = readFileSync(new URL("./fixtures/claude-trust-dialog.txt", import.meta.url), "utf8");

type Reply = Record<string, unknown> | "close" | "silent";
type Handler = (req: Record<string, unknown>) => Reply;

let dir: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let servers: Server[];
/** Every non-hello request the fake extension received, in order. */
let requests: Record<string, unknown>[];
/** The msgIds the fake extension "remembers" (status {msgId} answers from it). */
let accepted: Set<string>;
let onSend: Handler;
/** Runs (once) BEFORE a fake extension answers its next `hello`: the swap window. */
let beforeHelloReply: undefined | (() => Promise<void>);
/** Requests a fake extension refused for naming another incarnation (nothing dispatched). */
let refusals: Record<string, unknown>[];
let extensionOn: boolean;
let saved: Record<string, string | undefined>;
let scrollback: string | undefined;

const IDLE = { v: 1, ok: true, state: "idle", since: 1, runs: 7, pending: false };
const sends = () => requests.filter((r) => r.op === "send");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "msr-"));
  db = openDb({ path: join(dir, "mu.db") });
  saved = { c: process.env.MU_SPAWN_CTL_MS, l: process.env.MU_SPAWN_LIVENESS_MS };
  process.env.MU_SPAWN_CTL_MS = "300";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  servers = [];
  requests = [];
  refusals = [];
  beforeHelloReply = undefined;
  accepted = new Set();
  extensionOn = true;
  scrollback = undefined;
  onSend = () => IDLE;
  ensureWorkstream(db, "auth");
  addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1 });
  state = freshMockState();
  const fake = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    const res = await fake(args);
    if (args[0] === "new-session" && scrollback !== undefined) {
      for (const p of state.panes.values()) p.scrollback = scrollback;
    }
    if (
      extensionOn &&
      (args[0] === "new-session" || args[0] === "new-window" || args[0] === "split-window")
    ) {
      const name = /MU_AGENT_NAME=(\S+)/.exec(args.join(" "))?.[1];
      if (name !== undefined) await serveExtension(ctlSocketPath("auth", name, dir));
    }
    return res;
  });
});

afterEach(async () => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, e] of [
    ["c", "MU_SPAWN_CTL_MS"],
    ["l", "MU_SPAWN_LIVENESS_MS"],
  ] as const) {
    const v = saved[k];
    if (v === undefined) delete process.env[e];
    else process.env[e] = v;
  }
});

/**
 * A fake extension bound at `path`. Like the real one it reports `incarnation`
 * in hello and refuses a send/fresh whose `expectIncarnation` differs, before
 * dispatching anything. `rebind` replaces whatever is bound at the path.
 */
async function serveExtension(
  path: string,
  opts: { incarnation?: string; rebind?: boolean; noIncarnation?: boolean } = {},
): Promise<void> {
  const incarnation = opts.incarnation ?? INC;
  mkdirSync(dirname(path), { recursive: true });
  if (opts.rebind === true) rmSync(path, { force: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as Record<string, unknown>;
        if (req.op === "hello" && beforeHelloReply !== undefined) {
          const swap = beforeHelloReply;
          beforeHelloReply = undefined;
          void swap().then(() => {
            sock.end(encode(helloReply({ incarnation })));
          });
          continue;
        }
        if (
          (req.op === "send" || req.op === "fresh") &&
          req.expectIncarnation !== undefined &&
          req.expectIncarnation !== incarnation
        ) {
          refusals.push(req);
          sock.end(encode({ v: 1, ok: false, error: "incarnation mismatch", incarnation }));
          continue;
        }
        if (req.op !== "hello") requests.push(req);
        let reply: Reply;
        if (req.op === "send") {
          reply = onSend(req);
          if (reply !== "close" && reply !== "silent" && reply.ok === true) {
            accepted.add(String(req.msgId));
          }
        } else if (req.op === "status" && typeof req.msgId === "string") {
          reply = {
            ...IDLE,
            msg: { id: req.msgId, accepted: accepted.has(req.msgId), runs: 7, at: 1 },
          };
        } else reply = IDLE;
        if (reply === "silent") continue;
        if (reply === "close") {
          sock.destroy();
          continue;
        }
        const hello = helloReply({ incarnation });
        if (opts.noIncarnation === true) delete hello.incarnation;
        const answer = withHello(req, reply, hello);
        if (opts.noIncarnation === true) delete answer.incarnation;
        sock.end(encode(answer));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

const req = (over: Partial<Parameters<typeof spawnForTask>[1]> = {}) => ({
  task: "t1",
  text: "do the thing",
  spawn: { name: "worker-1", workstream: "auth" },
  ...over,
});
const task = (id = "t1") => getTask(db, id, "auth");
const receipt = (key = "manual:t1") => getReceipt(db, taskIdFor(db, "t1", "auth") ?? 0, key);
const notes = () => selectTaskNotes(db, "t1", { workstream: "auth" }).notes;
const panes = () => state.panes.size;

describe("spawn --task: the delivered attempt", () => {
  it("spawns, claims for THAT agent, sends the reserved msgId once, pins the brief", async () => {
    const out = await spawnForTask(db, req());
    const agent = getAgent(db, "worker-1", "auth");
    expect(out).toMatchObject({ state: "sent", replay: false, brief: "recorded" });
    expect(task()).toMatchObject({ ownerId: agent?.incarnation, status: "IN_PROGRESS" });
    const rec = receipt();
    expect(rec).toMatchObject({
      state: "sent",
      agentId: agent?.incarnation,
      paneId: agent?.paneId,
      transport: "ctl",
      incarnation: INC,
      runs: 7,
    });
    // The id on the wire is the id the journal reserved.
    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.msgId).toBe(rec?.msgId);
    expect(notes()).toMatchObject([{ kind: "brief", content: "do the thing" }]);
  });

  it("a task that already has a brief keeps it (no recursive copy)", async () => {
    const { addNote } = await import("../src/tasks/edit.js");
    addNote(db, "t1", "the pinned brief", { workstream: "auth", kind: "brief" });
    const out = await spawnForTask(db, req({ text: "Read: mu task notes t1" }));
    expect(out.brief).toBe("kept");
    expect(notes().map((n) => n.content)).toEqual(["the pinned brief"]);
  });

  it("refuses before any effect: unknown task, owned task, slash text, empty text", async () => {
    await expect(spawnForTask(db, req({ task: "nope" }))).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(spawnForTask(db, req({ text: "/new" }))).rejects.toBeInstanceOf(
      AgentSlashCommandUnsupportedError,
    );
    await expect(spawnForTask(db, req({ text: "/model x" }))).rejects.toBeInstanceOf(
      AgentSlashCommandUnsupportedError,
    );
    insertAgent(db, { name: "other", workstream: "auth", paneId: "%99" });
    await claimTask(db, "t1", { workstream: "auth", agentName: "other" });
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(TaskAlreadyOwnedError);
    expect(panes()).toBe(0);
    expect(receipt()).toBeUndefined();
  });
});

describe("replay: never a second prompt", () => {
  it("the same attempt returns the saved delivery; no pane, no send", async () => {
    await spawnForTask(db, req());
    const before = { panes: panes(), sends: sends().length };
    const again = await spawnForTask(db, req());
    expect(again).toMatchObject({ state: "sent", replay: true });
    expect(again.receipt.msgId).toBe(receipt()?.msgId);
    expect({ panes: panes(), sends: sends().length }).toEqual(before);
  });

  it("two in-process callers of one attempt: one pane, one send (the attempt lock)", async () => {
    const [a, b] = await Promise.all([spawnForTask(db, req()), spawnForTask(db, req())]);
    expect(sends()).toHaveLength(1);
    expect(panes()).toBe(1);
    expect([a.replay, b.replay].sort()).toEqual([false, true]);
  });

  it("a held attempt lock fails closed (exit-4 class), nothing done", async () => {
    const { withSpawnAttemptLock } = await import("../src/agents/lock.js");
    const id = taskIdFor(db, "t1", "auth") ?? 0;
    process.env.MU_AGENT_LOCK_TIMEOUT_MS = "50";
    try {
      await withSpawnAttemptLock(
        db,
        id,
        "manual:t1",
        async () => {
          await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(SpawnAttemptBusyError);
        },
        () => {
          throw new Error("outer lock unavailable");
        },
      );
    } finally {
      const k = "MU_AGENT_LOCK_TIMEOUT_MS";
      delete process.env[k];
    }
    expect(panes()).toBe(0);
    expect(receipt()).toBeUndefined();
  });

  it("a changed request under the same key conflicts; a new --attempt is a new prompt", async () => {
    await spawnForTask(db, req());
    await expect(spawnForTask(db, req({ text: "something else" }))).rejects.toBeInstanceOf(
      SpawnReceiptConflictError,
    );
    await expect(
      spawnForTask(db, req({ spawn: { name: "worker-2", workstream: "auth" } })),
    ).rejects.toBeInstanceOf(SpawnReceiptConflictError);
    expect(sends()).toHaveLength(1);
  });

  it("replay after the agent was DELETED: the historical delivery, marked stale", async () => {
    await spawnForTask(db, req());
    deleteAgent(db, "worker-1", "auth");
    const again = await spawnForTask(db, req());
    expect(again).toMatchObject({ state: "sent", replay: true, stale: "deleted" });
    expect(again.agent).toBeUndefined();
    expect(sends()).toHaveLength(1);
  });

  it("replay after delete + recreate: stale 'replaced'; the replacement is never claimed or sent to", async () => {
    await spawnForTask(db, req());
    deleteAgent(db, "worker-1", "auth");
    const replacement = insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%50" });
    const again = await spawnForTask(db, req());
    expect(again).toMatchObject({ state: "sent", replay: true, stale: "replaced" });
    expect(again.agent).toBeUndefined();
    expect(task()?.ownerId).not.toBe(replacement.incarnation);
    expect(sends()).toHaveLength(1);
  });
});

describe("failures BEFORE the prompt could be written: unsent, own resources rolled back", () => {
  const rolledBack = () => {
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(task()).toMatchObject({ ownerId: null, status: "OPEN" });
    expect(panes()).toBe(0);
  };

  it("ctl never answered: AgentCtlUnreachableError, pane + row gone, task unowned, receipt failed", async () => {
    extensionOn = false;
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(AgentCtlUnreachableError);
    rolledBack();
    expect(receipt()).toMatchObject({ state: "failed" });
    expect(notes().filter((n) => n.kind === "brief")).toEqual([]);
  });

  it("a failed attempt's key is reusable: the fixed retry sends once", async () => {
    extensionOn = false;
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(AgentCtlUnreachableError);
    const firstMsg = receipt()?.msgId;
    extensionOn = true;
    const out = await spawnForTask(db, req());
    expect(out).toMatchObject({ state: "sent", replay: false });
    expect(receipt()?.msgId).not.toBe(firstMsg);
    expect(sends()).toHaveLength(1);
  });

  it("the extension refuses the send (ok:false): unsent, claim released, agent removed", async () => {
    onSend = () => ({ v: 1, ok: false, error: "busy" });
    await expect(spawnForTask(db, req())).rejects.toThrow(/refused the send/);
    rolledBack();
    expect(receipt()?.state).toBe("failed");
  });

  it("the claim fails after the pane exists (parked task): rolled back, nothing sent", async () => {
    db.prepare("UPDATE tasks SET substate = 'parked' WHERE local_id = 't1'").run();
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(TaskParkedError);
    expect(sends()).toHaveLength(0);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(receipt()?.state).toBe("failed");
  });

  it("Claude's trust dialog: rolled back, nothing sent, task unowned", async () => {
    process.env.MU_SPAWN_LIVENESS_MS = "1500";
    scrollback = SCREEN;
    extensionOn = false;
    await expect(
      spawnForTask(db, req({ spawn: { name: "worker-1", workstream: "auth", cli: "claude" } })),
    ).rejects.toBeInstanceOf(SpawnTrustDialogError);
    rolledBack();
  });

  it("a non-pi agent on tmux has no send: AgentSendUnsupportedError, rolled back", async () => {
    extensionOn = false;
    await expect(
      spawnForTask(db, req({ spawn: { name: "worker-1", workstream: "auth", cli: "claude" } })),
    ).rejects.toBeInstanceOf(AgentSendUnsupportedError);
    rolledBack();
  });

  it("rollback leaves a task that changed hands/closed meanwhile alone", async () => {
    onSend = () => {
      closeTask(db, "t1", { workstream: "auth", evidence: "done elsewhere" });
      return { v: 1, ok: false, error: "busy" };
    };
    await expect(spawnForTask(db, req())).rejects.toThrow(/refused the send/);
    expect(task()?.status).toBe("CLOSED");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });
});

describe("AMBIGUOUS delivery: unknown, never reaped, never resent", () => {
  const keptIntact = () => {
    const agent = getAgent(db, "worker-1", "auth");
    expect(agent).toBeDefined();
    expect(task()).toMatchObject({ ownerId: agent?.incarnation, status: "IN_PROGRESS" });
    expect(panes()).toBe(1);
  };

  it("written, connection dropped, not confirmed: receipt unknown, pane + claim kept, no brief", async () => {
    onSend = () => "close";
    const out = await spawnForTask(db, req());
    expect(out).toMatchObject({ state: "unknown", replay: false, brief: "pending" });
    expect(receipt()).toMatchObject({ state: "unknown", transport: "ctl" });
    keptIntact();
    expect(notes().filter((n) => n.kind === "brief")).toEqual([]);
  });

  it("replay asks ONCE and an absent id stays unknown (eviction is not 'unsent'); no resend", async () => {
    onSend = () => "close";
    await spawnForTask(db, req());
    const before = requests.length;
    const again = await spawnForTask(db, req());
    expect(again).toMatchObject({ state: "unknown", replay: true, checked: "not-accepted" });
    expect(requests.slice(before).map((r) => r.op)).toEqual(["status"]);
    expect(sends()).toHaveLength(1);
    keptIntact();
  });

  it("replay finds it accepted later: sent, runs recorded, the brief is pinned then", async () => {
    onSend = () => "close";
    await spawnForTask(db, req());
    accepted.add(receipt()?.msgId ?? "");
    const again = await spawnForTask(db, req());
    expect(again).toMatchObject({
      state: "sent",
      replay: true,
      checked: "accepted",
      brief: "recorded",
    });
    expect(receipt()).toMatchObject({ state: "sent", runs: 7 });
    expect(sends()).toHaveLength(1);
  });

  it("a pane that dies AFTER the write is unknown, not unsent (write evidence beats the pane check)", async () => {
    onSend = () => {
      state.panes.clear();
      return "close";
    };
    const out = await spawnForTask(db, req());
    expect(out.state).toBe("unknown");
    expect(receipt()?.state).toBe("unknown");
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(task()?.status).toBe("IN_PROGRESS");
  });
});

describe("the CLI verb", () => {
  const cli = async (args: string[]) => {
    db.close();
    const r = await runCliWire(
      [
        "agent",
        "spawn",
        "worker-1",
        "-w",
        "auth",
        "--task",
        "t1",
        "--send",
        "go",
        ...args,
        "--json",
      ],
      join(dir, "mu.db"),
    );
    db = openDb({ path: join(dir, "mu.db") });
    return r;
  };

  it("unknown delivery: exit 1, ONE failure document with the receipt, agent evidence and the receipt check as next; replay exits 1 again without a send", async () => {
    onSend = () => "close";
    const r = await cli([]);
    expect(r.exitCode).toBe(1);
    const doc = JSON.parse(r.stdout) as {
      ok: boolean;
      error: string;
      msgId: string;
      delivery: string;
      data: {
        agent: { name: string; id: number };
        task: { state: string; claimed: boolean };
      };
      next: { commands: string[] } | null;
    };
    expect(doc).toMatchObject({
      ok: false,
      error: "AgentSendIndeterminateError",
      delivery: "unknown",
    });
    expect(doc.msgId).toBe(receipt()?.msgId);
    expect(doc.data.agent.id).toBe(getAgent(db, "worker-1", "auth")?.incarnation);
    expect(doc.data.task).toMatchObject({ state: "unknown", claimed: true });
    expect(doc.next?.commands).toEqual([`mu agent check worker-1 ${doc.msgId} -w auth --json`]);
    const again = await cli([]);
    expect(again.exitCode).toBe(1);
    expect(sends()).toHaveLength(1);
  });

  it("a changed prompt under the same attempt: exit 4; --attempt makes it a new key", async () => {
    await cli([]);
    db.close();
    const r = await runCliWire(
      ["agent", "spawn", "worker-1", "-w", "auth", "--task", "t1", "--send", "different", "--json"],
      join(dir, "mu.db"),
    );
    db = openDb({ path: join(dir, "mu.db") });
    expect(r.exitCode).toBe(4);
    expect(sends()).toHaveLength(1);
  });
});

describe("crash recovery: a receipt left in each stage", () => {
  const seed = (patch: Parameters<typeof updateReceipt>[3], withAgent = false) => {
    const id = taskIdFor(db, "t1", "auth") ?? 0;
    reserveReceipt(db, {
      taskId: id,
      attemptKey: "manual:t1",
      name: "worker-1",
      workstream: "auth",
      requestSha: requestSha({ name: "worker-1", nextFree: false, text: "do the thing" }),
      msgId: "reserved-msg-1",
    });
    const ag = withAgent
      ? insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" })
      : undefined;
    updateReceipt(db, id, "manual:t1", {
      ...(ag ? { agentId: ag.incarnation, paneId: ag.paneId } : {}),
      ...patch,
    });
    return ag;
  };

  it("reserved, no agent: the reservation is failed and the attempt runs fresh", async () => {
    seed({});
    const out = await spawnForTask(db, req());
    expect(out.state).toBe("sent");
    expect(sends()[0]?.msgId).not.toBe("reserved-msg-1");
  });

  it("reserved, but the name exists now: its identity was never journaled, refuse (never adopt or kill)", async () => {
    seed({});
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%7" });
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(AgentExistsError);
    expect(sends()).toHaveLength(0);
    expect(getAgent(db, "worker-1", "auth")?.paneId).toBe("%7");
  });

  it("pane journaled, agent gone (died before claim): failed, runs fresh", async () => {
    seed({ state: "pane", agentId: 424242, paneId: "%9" });
    const out = await spawnForTask(db, req());
    expect(out.state).toBe("sent");
    expect(getAgent(db, "worker-1", "auth")?.incarnation).not.toBe(424242);
  });

  it("pane journaled with its live agent (died before claim): resumes at claim + send, same msgId", async () => {
    extensionOn = true;
    // A real pane the agent row can point at: spawn one by hand through the mux harness.
    const { spawnAgent } = await import("../src/agents.js");
    const spawned = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    seed({ state: "pane", agentId: spawned.incarnation, paneId: spawned.paneId });
    // seed() inserted nothing (no withAgent); the receipt names the spawned agent.
    const out = await spawnForTask(db, req());
    expect(out).toMatchObject({ state: "sent" });
    expect(task()?.ownerId).toBe(spawned.incarnation);
    expect(sends()[0]?.msgId).toBe("reserved-msg-1");
    expect(panes()).toBe(1);
  });

  it("sending: the write may have happened: asks, never resends", async () => {
    const { spawnAgent } = await import("../src/agents.js");
    const spawned = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    await claimTask(db, "t1", { workstream: "auth", agentName: "worker-1" });
    seed({
      state: "sending",
      transport: "ctl",
      agentId: spawned.incarnation,
      paneId: spawned.paneId,
    });
    requests.length = 0; // the hand-made spawn above ran its own handshake
    const out = await spawnForTask(db, req());
    expect(out).toMatchObject({ state: "unknown", replay: true });
    expect(requests.map((r) => r.op)).toEqual(["status"]);
  });

  it("a send that went through the pane (no receipt) stays unknown: nothing to ask", async () => {
    const ag = seed({ state: "sending", transport: "mux" }, true);
    const out = await spawnForTask(db, req());
    expect(out).toMatchObject({ state: "unknown", replay: true });
    expect(out.reason).toMatch(/no receipt/);
    expect(requests).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(ag?.incarnation);
  });
});

// ── identity seams: the prompt and the claim go to THE spawned agent only ──

/** Delete worker-1 and recreate it on a NEW pane (same name, new registry id). */
async function swap(onDb: Db): Promise<number> {
  deleteAgent(onDb, "worker-1", "auth");
  const r = insertAgent(onDb, { name: "worker-1", workstream: "auth", paneId: "%77" });
  state.panes.set("%77", { windowId: "@9", paneId: "%77", command: "pi" });
  // A LIVE extension (another pi process) now owns the path: a misdirected
  // prompt would be delivered.
  await serveExtension(ctlSocketPath("auth", "worker-1", dir), {
    incarnation: "inc-replacement",
    rebind: true,
  });
  return r.incarnation;
}

describe("a replacement that appears mid-attempt gets neither claim nor prompt", () => {
  it("swapped BEFORE the claim: refused (claim bound to the spawned id), nothing sent", async () => {
    let inc = 0;
    hook.beforeClaim = async () => {
      inc = await swap(db);
    };
    await expect(spawnForTask(db, req())).rejects.toThrow();
    expect(task()?.ownerId).toBeNull();
    expect(sends()).toHaveLength(0);
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(inc);
    expect(state.panes.has("%77")).toBe(true);
    expect(receipt()?.state).toBe("failed");
  });

  it("swapped AFTER the claim, before the write: AgentReplacedError, nothing sent, replacement kept", async () => {
    let inc = 0;
    hook.afterClaim = async () => {
      inc = await swap(db);
    };
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(AgentReplacedError);
    expect(task()?.ownerId).not.toBe(inc);
    expect(sends()).toHaveLength(0);
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(inc);
    expect(state.panes.has("%77")).toBe(true);
    expect(notes().filter((n) => n.kind === "brief")).toEqual([]);
    expect(receipt()?.state).toBe("failed");
  });

  it("task re-owned by another agent before an unsent failure: the rollback leaves it with them", async () => {
    hook.afterClaim = () => {
      releaseTask(db, "t1", { workstream: "auth" });
      insertAgent(db, { name: "other", workstream: "auth", paneId: "%88" });
      return claimTask(db, "t1", { workstream: "auth", agentName: "other" }).then(async () => {
        await swap(db); // an unsent failure (AgentReplacedError) follows
      });
    };
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(AgentReplacedError);
    expect(task()).toMatchObject({ ownerName: "other", status: "IN_PROGRESS" });
    expect(sends()).toHaveLength(0);
  });
});

describe("a resume re-verifies the claim before sending", () => {
  const resumeAtClaimed = async () => {
    const { spawnAgent } = await import("../src/agents.js");
    const spawned = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    await claimTask(db, "t1", { workstream: "auth", agentName: "worker-1" });
    const id = taskIdFor(db, "t1", "auth") ?? 0;
    reserveReceipt(db, {
      taskId: id,
      attemptKey: "manual:t1",
      name: "worker-1",
      workstream: "auth",
      requestSha: requestSha({ name: "worker-1", nextFree: false, text: "do the thing" }),
      msgId: "m-claimed",
    });
    updateReceipt(db, id, "manual:t1", {
      state: "claimed",
      agentId: spawned.incarnation,
      paneId: spawned.paneId,
    });
    return spawned;
  };

  it("task closed meanwhile: SpawnTaskStateError, no send, own pane rolled back", async () => {
    await resumeAtClaimed();
    closeTask(db, "t1", { workstream: "auth", evidence: "done elsewhere" });
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(SpawnTaskStateError);
    expect(sends()).toHaveLength(0);
    expect(task()?.status).toBe("CLOSED");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(receipt()?.state).toBe("failed");
  });

  it("task released and re-owned by another: refused, the other keeps it, no send", async () => {
    await resumeAtClaimed();
    releaseTask(db, "t1", { workstream: "auth" });
    insertAgent(db, { name: "other", workstream: "auth", paneId: "%88" });
    await claimTask(db, "t1", { workstream: "auth", agentName: "other" });
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(TaskAlreadyOwnedError);
    expect(sends()).toHaveLength(0);
    expect(task()).toMatchObject({ ownerName: "other", status: "IN_PROGRESS" });
  });

  it("task released (unowned): refused, no send", async () => {
    await resumeAtClaimed();
    releaseTask(db, "t1", { workstream: "auth" });
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(SpawnTaskStateError);
    expect(sends()).toHaveLength(0);
  });

  it("a fresh attempt on a CLOSED, unowned task is refused before any pane exists", async () => {
    closeTask(db, "t1", { workstream: "auth", evidence: "x" });
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(SpawnTaskStateError);
    expect(panes()).toBe(0);
    expect(sends()).toHaveLength(0);
    expect(receipt()).toBeUndefined();
  });
});

describe("plain spawn --send uses the spawned registry id + pane", () => {
  it("delete + recreate between spawn and send: refused with one line, the replacement gets nothing", async () => {
    let inc = 0;
    hook.beforeSendToAgent = async () => {
      const d = openDb({ path: join(dir, "mu.db") });
      inc = await swap(d);
      d.close();
    };
    db.close();
    const r = await runCliWire(
      ["agent", "spawn", "worker-1", "-w", "auth", "--send", "hello there"],
      join(dir, "mu.db"),
    );
    db = openDb({ path: join(dir, "mu.db") });
    expect(sends()).toHaveLength(0);
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(inc);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/replaced before the prompt was written/);
    expect(r.exitCode).not.toBe(0);
  });

  it("the same refusal in --json names the error and exit class", async () => {
    hook.beforeSendToAgent = async () => {
      const d = openDb({ path: join(dir, "mu.db") });
      await swap(d);
      d.close();
    };
    db.close();
    const r = await runCliWire(
      ["agent", "spawn", "worker-1", "-w", "auth", "--send", "hello there", "--json"],
      join(dir, "mu.db"),
    );
    db = openDb({ path: join(dir, "mu.db") });
    expect(sends()).toHaveLength(0);
    expect(r.stdout).toMatch(/AgentReplacedError/);
  });
});

describe("the send is bound to the ctl incarnation the spawn handshake saw", () => {
  it("task path: a replacement binding the socket path during the send's hello gets nothing", async () => {
    let swapped = 0;
    hook.afterClaim = () => {
      // the next hello is the send's: the swap lands inside that await
      beforeHelloReply = async () => {
        swapped = await swap(db);
      };
    };
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(AgentReplacedError);
    expect(swapped).not.toBe(0);
    expect(sends()).toHaveLength(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.expectIncarnation).toBe(INC);
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(swapped);
    expect(receipt()?.state).toBe("failed");
    expect(notes().filter((n) => n.kind === "brief")).toEqual([]);
  });

  it("plain spawn --send: the same swap, one-line refusal, the replacement gets nothing", async () => {
    let swapped = 0;
    hook.beforeSendToAgent = () => {
      beforeHelloReply = async () => {
        const d = openDb({ path: join(dir, "mu.db") });
        swapped = await swap(d);
        d.close();
      };
    };
    db.close();
    const r = await runCliWire(
      ["agent", "spawn", "worker-1", "-w", "auth", "--send", "hello there"],
      join(dir, "mu.db"),
    );
    db = openDb({ path: join(dir, "mu.db") });
    expect(swapped).not.toBe(0);
    expect(sends()).toHaveLength(0);
    expect(refusals).toHaveLength(1);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/replaced before the prompt was written/);
    expect(r.exitCode).not.toBe(0);
  });

  it("a replacement already bound before the send's hello is refused client-side, nothing written", async () => {
    hook.afterClaim = async () => {
      await serveExtension(ctlSocketPath("auth", "worker-1", dir), {
        incarnation: "inc-replacement",
        rebind: true,
      });
    };
    await expect(spawnForTask(db, req())).rejects.toBeInstanceOf(AgentReplacedError);
    expect(requests.filter((r) => r.op === "send")).toHaveLength(0);
    expect(refusals).toHaveLength(0);
  });

  it("the unreplaced agent still gets the prompt, carrying the handshake's incarnation", async () => {
    await spawnForTask(db, req());
    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.expectIncarnation).toBe(INC);
  });

  it("an extension that names no incarnation is sent to unbound (nothing to bind to)", async () => {
    extensionOn = false;
    state.panes.clear();
    const origExec = mux;
    void origExec;
    // bind a legacy extension as soon as the pane exists
    mux.restore();
    const fake = mockTmux(state).executor;
    mux = installMux("tmux", async (args) => {
      const res = await fake(args);
      if (args[0] === "new-session" || args[0] === "new-window" || args[0] === "split-window") {
        const name = /MU_AGENT_NAME=(\S+)/.exec(args.join(" "))?.[1];
        if (name !== undefined) {
          await serveExtension(ctlSocketPath("auth", name, dir), { noIncarnation: true });
        }
      }
      return res;
    });
    const out = await spawnForTask(db, req());
    expect(out.state).toBe("sent");
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).not.toHaveProperty("expectIncarnation");
  });
});
