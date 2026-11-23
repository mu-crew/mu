// D15 on real Rex (wire_rex_presence_and_birth_aba): lease and plugin job views are
// tmux-only for now, because a Rex reply does not name the server instance that answered it
// (a retargeted MU_REX_SERVER alias let another server answer a birth or an absence). A file
// kind's spawn on a private Rex server refuses before any effect: no job.start, no record, no
// job file, no Rex session or block. Lifted by rexBackend.carrierViews.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
import { CarrierViewUnsupportedError } from "../src/hosts.js";
import { rexBackend, setMuxForTests } from "../src/mux.js";
import { pollUntil } from "./_env.js";
import { pluginHostFixture } from "./_plugin-host.js";

const rexAvailable = spawnSync("rex", ["--help"], { stdio: "ignore" }).status === 0;
const h = pluginHostFixture({ handshakeInProcess: true });
const FILE = { handle: "file", start: { lookup: true, fenceKey: false }, view: "detached" };
const jobFile = () => leaseJobFile(h.db, "ws", "w1");
const record = () => getCarrierJobByName(h.db, "ws", "w1");

let dir: string | undefined;
let procs: ChildProcess[] = [];
const call = (address: string, method: string, params = "{}") =>
  spawnSync("rex", ["-S", address, "--autostart=false", "api", "call", method, params], {
    encoding: "utf8",
    timeout: 2000,
  });
afterEach(() => {
  const key = "MU_REX_SERVER";
  delete process.env[key];
  const liveness = "MU_SPAWN_LIVENESS_MS";
  delete process.env[liveness];
  for (const p of procs) p.kill();
  procs = [];
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe.skipIf(!rexAvailable)("a file view on Rex", () => {
  it("refuses before any effect: no job.start, record, job file or Rex session", async () => {
    // A short private dir: unix socket paths have a small length limit.
    dir = mkdtempSync(join(tmpdir().length > 40 ? "/tmp" : tmpdir(), "mu-rex-"));
    const address = `unix://${join(dir, "a.sock")}`;
    procs = [
      spawn(
        "rex",
        ["server", "run", "--listen", address, "--restore=false", "--state-dir", join(dir, "a")],
        { stdio: "ignore" },
      ),
    ];
    try {
      await pollUntil(() => call(address, "server.status").status === 0, {
        attempts: 100,
        intervalMs: 50,
        description: "private rex server",
      });
      const sessions = () => call(address, "session.list").stdout;
      const before = sessions();
      process.env.MU_SPAWN_LIVENESS_MS = "0";
      await h.setup(FILE);
      setMuxForTests(rexBackend);
      process.env.MU_REX_SERVER = address;
      const err = await h.spawn().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CarrierViewUnsupportedError);
      expect({
        starts: h.calls("job.start").length,
        record: record() !== undefined,
        file: existsSync(jobFile()),
        sessions: sessions(),
      }).toEqual({ starts: 0, record: false, file: false, sessions: before });
    } finally {
      call(address, "server.stop");
    }
  }, 35_000);
});
