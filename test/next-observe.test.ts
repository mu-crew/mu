// The production worker reader of `mu next` recovery (src/next-recover.ts): a status read
// carries no error, so an idle pi worker's last settled run is read over a real ctl socket
// (one immediate `wait` past runs-1). A fake extension stands in for pi; tmux is a stub.

import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import { agentCtlSocket } from "../src/agents/transport.js";
import { type AgentRow, insertAgent } from "../src/agents.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { observeWorkers } from "../src/next-recover.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
let servers: Server[];
let pia: AgentRow;
let ops: { op: string; afterRuns?: number; incarnation?: string }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mso-"));
  db = openDb({ path: join(dir, "mu.db") });
  servers = [];
  ops = [];
  setMuxForTests(tmuxBackend);
  setTmuxExecutor(async (args) =>
    args[0] === "list-panes"
      ? { stdout: "%1\t\t\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 },
  );
  setMurmurRunnerForTests(async () => null);
  resetAgentStateCacheForTests();
  pia = insertAgent(db, { name: "pia", workstream: "obs", paneId: "%1", cli: "pi" });
});
afterEach(() => {
  resetTmuxExecutor();
  setMuxForTests(undefined);
  setMurmurRunnerForTests(null);
  resetAgentStateCacheForTests();
  for (const s of servers) s.close();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

async function extension(
  status: Record<string, unknown>,
  settled: Record<string, unknown> | "hold",
): Promise<void> {
  const path = agentCtlSocket(db, pia);
  mkdirSync(dirname(path), { recursive: true });
  const held: Socket[] = [];
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string; afterRuns?: number; incarnation?: string };
        ops.push(req);
        if (req.op === "hello") sock.end(encode(helloReply()));
        else if (req.op === "wait" && settled === "hold") held.push(sock);
        else if (req.op === "wait") {
          sock.end(
            encode({ v: 1, ok: true, incarnation: INC, ended: "settled", ...(settled as object) }),
          );
        } else {
          sock.end(
            encode({
              v: 1,
              ok: true,
              incarnation: INC,
              state: "idle",
              since: 10,
              runs: 2,
              pending: false,
              ...status,
            }),
          );
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

describe("observeWorkers", () => {
  it("an idle worker's settled run error is read with ONE ctl wait past runs-1, bound to its incarnation", async () => {
    await extension(
      {},
      { state: "idle", runs: 2, since: 10, lastError: "529 overloaded", lastText: "" },
    );
    const got = (await observeWorkers(db)([pia], { ms: 1000 })).get("obs/pia");
    expect(got).toMatchObject({
      status: "needs_input",
      ctl: "ok",
      incarnation: INC,
      runs: 2,
      lastError: "529 overloaded",
    });
    expect(ops.filter((o) => o.op === "wait")).toEqual([
      expect.objectContaining({ op: "wait", afterRuns: 1, incarnation: INC }),
    ]);
  });

  it("a clean run has no lastError", async () => {
    await extension({}, { state: "idle", runs: 2, since: 10, lastText: "done" });
    const got = (await observeWorkers(db)([pia], { ms: 1000 })).get("obs/pia");
    expect(got?.status).toBe("needs_input");
    expect(got?.lastError).toBeUndefined();
  });

  it("a busy worker is not asked for an error at all", async () => {
    await extension({ state: "busy" }, "hold");
    const got = (await observeWorkers(db)([pia], { ms: 1000 })).get("obs/pia");
    expect(got?.status).toBe("busy");
    expect(ops.filter((o) => o.op === "wait")).toEqual([]);
  });

  it("a socket that never answers the wait is bounded by ms: the worker reads without an error", async () => {
    await extension({}, "hold");
    const t0 = Date.now();
    const got = (await observeWorkers(db)([pia], { ms: 80 })).get("obs/pia");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(got?.status).toBe("needs_input");
    expect(got?.lastError).toBeUndefined();
  });

  it("an abort signal bounds it too", async () => {
    await extension({}, "hold");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const got = (await observeWorkers(db)([pia], { ms: 60_000, signal: ac.signal })).get("obs/pia");
    expect(got?.lastError).toBeUndefined();
  });

  it("a gone pane reads status null", async () => {
    setTmuxExecutor(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const got = (await observeWorkers(db)([pia], { ms: 100 })).get("obs/pia");
    expect(got?.status).toBeNull();
  });
});
