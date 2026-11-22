// wire_view_proof_wrong_mux_server on real tmux: a file kind's view (its job's dispatcher, a
// stand-in shell that publishes the handle) opened on private server A; an ordinary close from
// a mu driving private server B finds no such pane there. That is no proof: the close refuses,
// nothing is stopped, and the record and the job file stay while A's view runs.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { CarrierJobKeptError } from "../src/agents/errors.js";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { shellQuote } from "../src/shell-quote.js";
import { setTmuxExecutor, tmux } from "../src/tmux.js";
import { tmuxIntegrationAvailable } from "./_mux.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture({ handshakeInProcess: true });
const FILE = { handle: "file", start: { lookup: true, fenceKey: false }, view: "detached" };
const jobFile = () => leaseJobFile(h.db, "ws", "w1");
const record = () => getCarrierJobByName(h.db, "ws", "w1");

const nonce = `${process.pid}-${randomUUID().slice(0, 8)}`;
const A = `mu-test-wire-${nonce}-a`;
const B = `mu-test-wire-${nonce}-b`;
/** A socket name that is a symlink to A's socket, retargeted mid-close. */
const ALIAS = `mu-test-wire-${nonce}-alias`;
let aliasPath: string | undefined;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MU_TMUX_SOCKET;
  process.env.MU_SPAWN_LIVENESS_MS = "0";
});
afterEach(async () => {
  if (aliasPath !== undefined) {
    for (const p of [aliasPath, `${aliasPath}.next`]) {
      try {
        unlinkSync(p);
      } catch {}
    }
    aliasPath = undefined;
  }
  const liveness = "MU_SPAWN_LIVENESS_MS";
  delete process.env[liveness];
  for (const s of [A, B]) {
    process.env.MU_TMUX_SOCKET = s;
    try {
      await tmux(["kill-server"]);
    } catch {}
  }
  if (saved === undefined) {
    const key = "MU_TMUX_SOCKET";
    delete process.env[key];
  } else process.env.MU_TMUX_SOCKET = saved;
});

describe.skipIf(!tmuxIntegrationAvailable())("a file view on another tmux server", () => {
  it("a close from server B neither stops the job nor drops its record or file", async () => {
    await h.setup(FILE, {
      viewCommand: `printf '%s\\n' file-job-1 > ${shellQuote(jobFile())}; exec sleep 120`,
    });
    process.env.MU_TMUX_SOCKET = A;
    setMuxForTests(tmuxBackend);
    const row = await h.spawn();
    expect(record()).toMatchObject({ job: "file-job-1", wireState: "bound", paneId: row.paneId });
    expect(record()?.viewServer).toMatch(/^tmux:\d+\|\d+$/);
    process.env.MU_TMUX_SOCKET = B;
    expect(await tmuxBackend.paneAlive(row.paneId)).toBe(false);
    const outcome = await closeAgent(h.db, "w1", { workstream: "ws" }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(CarrierJobKeptError);
    expect(String((outcome as Error).message)).toMatch(/which this mu does not drive/);
    process.env.MU_TMUX_SOCKET = A;
    expect(await tmuxBackend.paneAlive(row.paneId)).toBe(true);
    expect(h.f.backend().stops).toBe(0);
    expect(readFileSync(jobFile(), "utf8")).toBe("file-job-1\n");
    expect(existsSync(jobFile())).toBe(true);
    expect(record()).toBeDefined();
  });

  /** Server B, live, holding panes but not A's view id. */
  const startB = async (): Promise<string> => {
    process.env.MU_TMUX_SOCKET = B;
    await tmux(["new-session", "-d", "-s", "other", "sleep 120"]);
    await tmux(["new-window", "-d", "-t", "other", "sleep 120"]);
    await tmux(["kill-pane", "-t", "%0"]);
    return (await tmux(["list-sessions", "-F", "#{socket_path}"])).trim();
  };
  const viewOf = () => ({
    viewCommand: `printf '%s\\n' file-job-1 > ${shellQuote(jobFile())}; exec sleep 120`,
  });

  // wire_tmux_identity_not_atomic, absence: the socket mu drives starts answering for server B
  // between two tmux calls of the close. The proof's server check and pane lookup are ONE call,
  // so no retarget between calls can pair A's identity with B's miss.
  it("a socket retargeted to another server during the close proves nothing", async () => {
    await h.setup(FILE, viewOf());
    process.env.MU_TMUX_SOCKET = A;
    setMuxForTests(tmuxBackend);
    const row = await h.spawn();
    const a = (await tmux(["list-sessions", "-F", "#{pid}|#{start_time}"])).trim();
    const socketA = (await tmux(["list-sessions", "-F", "#{socket_path}"])).trim();
    expect(record()?.viewServer).toBe(`tmux:${a}`);
    const socketB = await startB();
    aliasPath = join(dirname(socketA), ALIAS);
    symlinkSync(socketA, aliasPath);
    process.env.MU_TMUX_SOCKET = ALIAS;
    let armed = true;
    const prev = setTmuxExecutor(async (args) => {
      const r = await prev(args);
      // Right after the first call that carried or answered A's identity: B answers from now.
      if (armed && (args.join(" ").includes(a) || r.stdout.includes(a))) {
        armed = false;
        symlinkSync(socketB, `${aliasPath}.next`);
        renameSync(`${aliasPath}.next`, aliasPath as string);
      }
      return r;
    });
    let outcome: unknown;
    try {
      outcome = await closeAgent(h.db, "w1", { workstream: "ws" }).catch((e: unknown) => e);
    } finally {
      setTmuxExecutor(prev);
    }
    process.env.MU_TMUX_SOCKET = A;
    expect({
      live: await tmuxBackend.paneAlive(row.paneId),
      stops: h.f.backend().stops,
      file: existsSync(jobFile()),
      reservation: record() !== undefined,
    }).toEqual({ live: true, stops: 0, file: true, reservation: true });
    expect(outcome).toBeInstanceOf(CarrierJobKeptError);
  });

  // wire_tmux_identity_not_atomic, birth: no server ran before the spawn, and B answers the
  // socket right after A created the view. The record binds the server the creation call itself
  // reported (A), never the one answering afterwards; a close routed to B then proves nothing.
  it("a view is bound to the server that created it, not the one answering after", async () => {
    await h.setup(FILE, viewOf());
    await startB();
    process.env.MU_TMUX_SOCKET = A;
    expect(await tmuxBackend.serverIdentity?.()).toBeUndefined();
    setMuxForTests({
      ...tmuxBackend,
      spawnAgent: async (o) => {
        let born: string | undefined;
        const pid = await tmuxBackend.spawnAgent({
          ...o,
          onPaneCreated: (_p, identity) => {
            born = identity;
          },
        });
        process.env.MU_TMUX_SOCKET = B;
        o.onPaneCreated?.(pid, born);
        return pid;
      },
    });
    const row = await h.spawn().catch((e: unknown) => e);
    process.env.MU_TMUX_SOCKET = A;
    const a = (await tmux(["list-sessions", "-F", "#{pid}|#{start_time}"])).trim();
    const bound = record()?.viewServer;
    process.env.MU_TMUX_SOCKET = B;
    const outcome = await closeAgent(h.db, "w1", { workstream: "ws" }).catch((e: unknown) => e);
    process.env.MU_TMUX_SOCKET = A;
    const paneId = record()?.paneId ?? (row as { paneId?: string }).paneId ?? "";
    expect({
      bound,
      live: await tmuxBackend.paneAlive(paneId),
      stops: h.f.backend().stops,
      file: existsSync(jobFile()),
      reservation: record() !== undefined,
    }).toEqual({ bound: `tmux:${a}`, live: true, stops: 0, file: true, reservation: true });
    expect(outcome).toBeInstanceOf(CarrierJobKeptError);
  });
});
