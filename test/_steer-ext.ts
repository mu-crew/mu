// A fake pi extension for the steer tests: a real unix socket that, like the
// real one, remembers accepted msgIds but does NOT dedupe sends (every send
// request it receives is a delivery, counted in `sends`).

import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { helloReply, INC } from "./_ctl-ext.js";

export interface FakeExt {
  /** Every send request received (the deliveries). */
  sends: Record<string, unknown>[];
  hellos: number;
  /** Accepted msgIds -> runs. Pre-seed to model "accepted before the crash". */
  accepted: Map<string, number>;
  incarnation: string;
  runs: number;
  /** Called on each hello, before the reply (mutate the DB here). */
  onHello?: () => void;
  /** Delay hello reply (ms). */
  helloDelayMs?: number;
  /** "swallow": accept and act, then close with no reply. "refuse": ok:false. "silent": never answer a send. */
  sendBehaviour: "ok" | "swallow" | "refuse" | "silent" | "mismatch";
  /** The `status {msgId}` answer: honest (default), or one that has no memory. */
  forgetful: boolean;
  server?: Server;
}

export function newExt(over: Partial<FakeExt> = {}): FakeExt {
  return {
    sends: [],
    hellos: 0,
    accepted: new Map(),
    incarnation: INC,
    runs: 2,
    sendBehaviour: "ok",
    forgetful: false,
    ...over,
  };
}

export async function serveFake(path: string, ext: FakeExt, servers: Server[]): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as Record<string, unknown>;
        const reply = (r: Record<string, unknown>) => sock.end(encode(r));
        if (req.op === "hello") {
          ext.hellos++;
          ext.onHello?.();
          const answer = () => reply(helloReply({ incarnation: ext.incarnation }));
          if (ext.helloDelayMs) setTimeout(answer, ext.helloDelayMs);
          else answer();
        } else if (req.op === "status") {
          const id = req.msgId as string | undefined;
          const base = { v: 1, ok: true, state: "idle", since: 1, runs: ext.runs, pending: 0 };
          if (id === undefined) return reply({ ...base, incarnation: ext.incarnation });
          const got = ext.forgetful ? undefined : ext.accepted.get(id);
          reply({
            ...base,
            incarnation: ext.incarnation,
            msg:
              got === undefined
                ? { id, accepted: false }
                : { id, accepted: true, runs: got, at: Date.now() },
          });
        } else if (req.op === "send") {
          ext.sends.push(req);
          if (ext.sendBehaviour === "silent") return;
          if (
            ext.sendBehaviour === "mismatch" ||
            (req.expectIncarnation !== undefined && req.expectIncarnation !== ext.incarnation)
          ) {
            return reply({ v: 1, ok: false, error: "incarnation mismatch" });
          }
          if (ext.sendBehaviour === "refuse") return reply({ v: 1, ok: false, error: "busy" });
          ext.accepted.set(req.msgId as string, ext.runs);
          if (ext.sendBehaviour === "swallow") return sock.destroy();
          reply({
            v: 1,
            ok: true,
            state: "busy",
            since: Date.now(),
            runs: ext.runs,
            incarnation: ext.incarnation,
          });
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}
