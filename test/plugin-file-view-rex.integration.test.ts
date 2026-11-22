// wire_view_backend_name_is_not_server on real Rex: a file kind's view (its job's dispatcher)
// opened on private Rex server A records A's own identity (`rex:<instance_id>`), never the
// backend name. An ordinary close from a mu driving private server B (another MU_REX_SERVER)
// finds no such block there. That is no proof: the close refuses, nothing is stopped, and the
// record and the job file stay while A's view runs.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { CarrierJobKeptError } from "../src/agents/errors.js";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
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
const call = (address: string, method: string) =>
  spawnSync("rex", ["-S", address, "--autostart=false", "api", "call", method, "{}"], {
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

describe.skipIf(!rexAvailable)("a file view on another Rex server", () => {
  it("a close from Rex server B neither stops the job nor drops its record or file", async () => {
    // A short private dir: unix socket paths have a small length limit.
    dir = mkdtempSync(join(tmpdir().length > 40 ? "/tmp" : tmpdir(), "mu-rex-"));
    const servers = ["a", "b"].map((s) => ({
      address: `unix://${join(dir as string, `${s}.sock`)}`,
      state: join(dir as string, s),
    }));
    procs = servers.map(({ address, state }) =>
      spawn(
        "rex",
        ["server", "run", "--listen", address, "--restore=false", "--state-dir", state],
        {
          stdio: "ignore",
        },
      ),
    );
    try {
      for (const { address } of servers) {
        await pollUntil(() => call(address, "server.status").status === 0, {
          attempts: 100,
          intervalMs: 50,
          description: "private rex server",
        });
      }
      const [a, b] = servers as [(typeof servers)[0], (typeof servers)[0]];
      const instanceA = JSON.parse(call(a.address, "server.status").stdout).instance_id as string;
      process.env.MU_SPAWN_LIVENESS_MS = "0";
      await h.setup(FILE);
      // The stand-in view is a real Rex block; the handle is published as the dispatcher would.
      setMuxForTests({
        ...rexBackend,
        spawnAgent: async (o) => {
          const id = await rexBackend.spawnAgent({ ...o, cwd: "/tmp", command: "exec sleep 120" });
          writeFileSync(jobFile(), "file-job-1\n");
          return id;
        },
      });
      process.env.MU_REX_SERVER = a.address;
      const row = await h.spawn();
      expect(record()).toMatchObject({ wireState: "bound", paneId: row.paneId });
      const bound = record()?.viewServer;
      process.env.MU_REX_SERVER = b.address;
      expect(await rexBackend.paneAlive(row.paneId)).toBe(false);
      const outcome = await closeAgent(h.db, "w1", { workstream: "ws" }).catch((e: unknown) => e);
      process.env.MU_REX_SERVER = a.address;
      expect({
        live: await rexBackend.paneAlive(row.paneId),
        stops: h.f.backend().stops,
        file: existsSync(jobFile()),
        reservation: record() !== undefined,
      }).toEqual({ live: true, stops: 0, file: true, reservation: true });
      expect(outcome).toBeInstanceOf(CarrierJobKeptError);
      // How: the view recorded A's own identity, never the backend name.
      expect(bound).toBe(`rex:${instanceA}`);
    } finally {
      for (const { address } of servers) call(address, "server.stop");
    }
  }, 35_000);
});
