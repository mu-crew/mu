// waitForEvents over a REAL control socket (v_wait_engine): the default ctl
// hooks (src/wait-ctl.ts) against a unix-socket fake of the pi extension that
// answers `ended: "settled"`. Covers the settle -> CLOSE -> snapshot path, a
// delegate report arriving while a worker's ctl wait is held open, and the
// abort that cancels the held wait.

import { mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { getTask } from "../src/tasks.js";
import { waitForEvents } from "../src/wait.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { readCursors } from "../src/wait-cursor.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { agentRef, answer, mkDelegate, mkOwnedTask, taskRef, useWaitDb } from "./_wait-fixtures.js";

const env = useWaitDb();
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

interface Fake {
  settle: (text: string) => void;
  waits: () => number;
}

async function fakePi(name: string, state: "busy" | "idle", runs = 0): Promise<Fake> {
  let st = state;
  let n = runs;
  let lastText = "";
  const held: Socket[] = [];
  const status = () => ({
    v: 1,
    ok: true,
    incarnation: INC,
    state: st,
    since: 1,
    runs: n,
    pending: false,
  });
  const path = ctlSocketPath("w", name, env.dir);
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    const dec = new LineDecoder();
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string; afterRuns?: number };
        if (req.op === "hello") sock.end(encode(helloReply()));
        else if (req.op === "wait") {
          if (req.afterRuns !== undefined && n > req.afterRuns && st === "idle") {
            sock.end(encode({ ...status(), lastText, ended: "settled" }));
          } else {
            held.push(sock);
            sock.on("close", () => {
              const i = held.indexOf(sock);
              if (i >= 0) held.splice(i, 1);
            });
          }
        } else sock.end(encode(status()));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  return {
    settle: (text) => {
      st = "idle";
      n++;
      lastText = text;
      for (const s of held.splice(0)) s.end(encode({ ...status(), lastText, ended: "settled" }));
    },
    waits: () => held.length,
  };
}

const block = (task: string) =>
  `All done.\n\nCLOSE: task=${task} evidence="npm test: 3 passed"\nREPORT:\nFILES: a.ts`;

describe("waitForEvents with the ctl hooks", () => {
  it("a worker settling applies its CLOSE once and returns the snapshot, cursor moved", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const pi = await fakePi("w1", "busy");
    setTimeout(() => pi.settle(block("t1")), 30);
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...ctlAgentHooks(env.db),
      sync: false,
      pollMs: 20,
      timeoutMs: 5000,
      caller: "pi:s",
    });
    expect(r.event).toMatchObject({ kind: "settled", incarnation: INC, runs: 1 });
    expect(r.refs[0]?.close).toMatchObject({ applied: true, task: "t1" });
    expect(getTask(env.db, "t1", "w")).toMatchObject({ status: "CLOSED", substate: "done" });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM agent_settles").get()).toEqual({ n: 1 });
    expect(readCursors(env.db, "pi:s").get("agent:w/w1")).toEqual({ incarnation: INC, runs: 1 });
  });

  it("a delegate report ends the wait while the worker's ctl wait stays held open, then abort releases it", async () => {
    const caller = "pi:s2";
    await mkOwnedTask(env.db, "t1", "w1");
    const pi = await fakePi("w1", "busy");
    registerOwnedWait(env.db, caller, [agentRef("w1"), taskRef("t1")]);
    const call = mkDelegate(env.db, caller);
    setTimeout(() => answer(env.db, call), 30);
    const r = await waitForEvents(env.db, [], {
      ...ctlAgentHooks(env.db),
      sync: false,
      pollMs: 20,
      timeoutMs: 5000,
      caller,
    });
    expect(r.event).toMatchObject({ kind: "delegate", ref: { id: call } });
    // The worker was never settled: its ctl wait was held the whole time, and is gone now.
    expect(r.refs.every((s) => s.ref.kind !== "agent" || !s.fired)).toBe(true);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const again = await waitForEvents(env.db, [], {
      ...ctlAgentHooks(env.db),
      sync: false,
      pollMs: 20,
      timeoutMs: 5000,
      caller,
      signal: ac.signal,
    });
    expect(again.interrupted).toBe(true);
    expect(again.exit).toBe(130);
    // ...and the abort (and the earlier return) cancelled it: no wait is left held.
    for (let i = 0; i < 20 && pi.waits() > 0; i++) await new Promise((res) => setTimeout(res, 25));
    expect(pi.waits()).toBe(0);
  });

  it("an owed agent's run that settled before the wait started still arrives (counted from run 0)", async () => {
    const caller = "pi:s3";
    await mkOwnedTask(env.db, "t1", "w1");
    await fakePi("w1", "idle", 0).then((p) => p.settle("early answer"));
    registerOwnedWait(env.db, caller, [agentRef("w1")]);
    const r = await waitForEvents(env.db, [], {
      ...ctlAgentHooks(env.db),
      sync: false,
      pollMs: 20,
      timeoutMs: 5000,
      caller,
      applyClose: false,
    });
    expect(r.event).toMatchObject({ kind: "settled", runs: 1 });
    expect(r.refs[0]?.lastText).toBe("early answer");
  });
});
