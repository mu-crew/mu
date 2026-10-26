// The opt-in ctl write fence (v_wait_steer): ctlRequest `beforeWrite`, abort
// semantics, and sendViaTransport's `ctlGuard`. Defaults are unchanged.

import { mkdtempSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendViaTransport } from "../src/agents/transport.js";
import { type AgentRow, AgentSendUnsupportedError, insertAgent } from "../src/agents.js";
import {
  CtlDeliveryUnknownError,
  CtlWriteVetoedError,
  ctlRequest,
  newMsgId,
} from "../src/ctl/client.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { type FakeExt, newExt, serveFake } from "./_steer-ext.js";

let dir: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];
let ext: FakeExt;
let sock: string;
let agent: AgentRow;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mwt-"));
  db = openDb({ path: join(dir, "mu.db") });
  servers = [];
  ext = newExt();
  setSleepForTests(async () => {});
  mux = installMux("tmux", async () => ({ stdout: "%1\n", stderr: "", exitCode: 0 }));
  agent = insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", cli: "pi" });
  sock = ctlSocketPath("auth", "w1", dir);
  await serveFake(sock, ext, servers);
});
afterEach(async () => {
  mux.restore();
  resetSleep();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  rmFixtureDir(dir);
});

const send = { op: "send", text: "hi", mode: "steer", msgId: "m-1" } as const;

describe("ctlRequest beforeWrite", () => {
  it("runs synchronously on connect, before the one write", async () => {
    let seenSends = -1;
    const r = await ctlRequest(sock, send, {
      beforeWrite: () => {
        seenSends = ext.sends.length;
        return true;
      },
    });
    expect(r.ok).toBe(true);
    expect(seenSends).toBe(0);
    expect(ext.sends).toHaveLength(1);
  });

  it("false writes nothing and is a definite CtlWriteVetoedError, not an unknown delivery", async () => {
    const err = await ctlRequest(sock, send, { beforeWrite: () => false }).catch((e) => e);
    expect(err).toBeInstanceOf(CtlWriteVetoedError);
    expect(err).not.toBeInstanceOf(CtlDeliveryUnknownError);
    await new Promise((r) => setTimeout(r, 20));
    expect(ext.sends).toHaveLength(0);
  });

  it("a throwing fence also writes nothing, with the cause kept", async () => {
    const err = await ctlRequest(sock, send, {
      beforeWrite: () => {
        throw new Error("db locked");
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CtlWriteVetoedError);
    expect(String(err.message)).toMatch(/db locked/);
    expect(ext.sends).toHaveLength(0);
  });

  it("without the option nothing changes", async () => {
    expect((await ctlRequest(sock, send)).ok).toBe(true);
  });
});

describe("ctlRequest abort", () => {
  it("before the connect writes nothing and is a plain error", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await ctlRequest(sock, send, { signal: ac.signal }).catch((e) => e);
    expect(err).not.toBeInstanceOf(CtlDeliveryUnknownError);
    await new Promise((r) => setTimeout(r, 20));
    expect(ext.sends).toHaveLength(0);
  });

  it("after the write of a side-effecting op is an unknown delivery (an abort is not an undo)", async () => {
    ext.sendBehaviour = "silent";
    const ac = new AbortController();
    const p = ctlRequest(sock, send, { signal: ac.signal }).catch((e) => e);
    for (let i = 0; i < 50 && ext.sends.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await p).toBeInstanceOf(CtlDeliveryUnknownError);
  });

  it("an abort of a read-only op stays a plain error", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await ctlRequest(sock, { op: "hello" }, { signal: ac.signal }).catch((e) => e);
    expect(err).not.toBeInstanceOf(CtlDeliveryUnknownError);
  });
});

describe("sendViaTransport ctlGuard", () => {
  const opts = (g: NonNullable<Parameters<typeof sendViaTransport>[2]["ctlGuard"]>) => ({
    socket: sock,
    mode: "steer" as const,
    msgId: newMsgId(),
    ctlGuard: g,
  });

  it("a vetoing fence sends nothing and rethrows the veto (no probe, no indeterminate error)", async () => {
    const err = await sendViaTransport(agent, "x", opts({ beforeWrite: () => false })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(CtlWriteVetoedError);
    expect(ext.sends).toHaveLength(0);
  });

  it("an aborted signal fails the hello before anything is written", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sendViaTransport(agent, "x", opts({ signal: ac.signal }))).rejects.toBeDefined();
    expect(ext.sends).toHaveLength(0);
  });

  it("the fence runs after the hello and the incarnation bind", async () => {
    let helloAtFence = 0;
    await sendViaTransport(agent, "x", {
      ...opts({
        beforeWrite: () => {
          helloAtFence = ext.hellos;
          return true;
        },
      }),
      expectIncarnation: ext.incarnation,
    });
    expect(helloAtFence).toBe(1);
    expect(ext.sends[0]).toMatchObject({ expectIncarnation: ext.incarnation, mode: "steer" });
  });

  it("a fence the route cannot honour (a mux send) refuses instead of skipping it", async () => {
    const plain = insertAgent(db, { name: "c1", workstream: "auth", paneId: "%2", cli: "claude" });
    await expect(
      sendViaTransport(plain, "x", {
        socket: ctlSocketPath("auth", "c1", dir),
        ctlGuard: { beforeWrite: () => true },
      }),
    ).rejects.toBeInstanceOf(AgentSendUnsupportedError);
  });

  it("a fence on a session-command text (/new) refuses instead of skipping it", async () => {
    let fenced = false;
    await expect(
      sendViaTransport(agent, "/new", {
        socket: sock,
        ctlGuard: {
          beforeWrite: () => {
            fenced = true;
            return false;
          },
        },
      }),
    ).rejects.toBeInstanceOf(AgentSendUnsupportedError);
    expect(fenced).toBe(false);
    expect(ext.sends).toHaveLength(0);
  });

  it("a fence on a herdr non-ctl agent refuses and never prompts the pane", async () => {
    mux.restore();
    mux = installMux("herdr", async () => ({ stdout: "{}", stderr: "", exitCode: 0 }));
    const plain = insertAgent(db, { name: "c2", workstream: "auth", paneId: "p2", cli: "claude" });
    await expect(
      sendViaTransport(plain, "x", {
        socket: ctlSocketPath("auth", "c2", dir),
        ctlGuard: { beforeWrite: () => true },
      }),
    ).rejects.toBeInstanceOf(AgentSendUnsupportedError);
    expect(mux.calls).toEqual([]);
  });
});
