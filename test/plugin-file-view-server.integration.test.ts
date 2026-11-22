// wire_view_proof_wrong_mux_server on real tmux: a file kind's view (its job's dispatcher, a
// stand-in shell that publishes the handle) opened on private server A; an ordinary close from
// a mu driving private server B finds no such pane there. That is no proof: the close refuses,
// nothing is stopped, and the record and the job file stay while A's view runs.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { CarrierJobKeptError } from "../src/agents/errors.js";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { shellQuote } from "../src/shell-quote.js";
import { tmux } from "../src/tmux.js";
import { tmuxIntegrationAvailable } from "./_mux.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture({ handshakeInProcess: true });
const FILE = { handle: "file", start: { lookup: true, fenceKey: false }, view: "detached" };
const jobFile = () => leaseJobFile(h.db, "ws", "w1");
const record = () => getCarrierJobByName(h.db, "ws", "w1");

const nonce = `${process.pid}-${randomUUID().slice(0, 8)}`;
const A = `mu-test-wire-${nonce}-a`;
const B = `mu-test-wire-${nonce}-b`;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MU_TMUX_SOCKET;
  process.env.MU_SPAWN_LIVENESS_MS = "0";
});
afterEach(async () => {
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
});
