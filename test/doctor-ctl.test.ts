// Doctor rows for the mu pi extension, the mu skill, and per-agent
// control sockets (pictl_doctor). Every test writes only into a temp
// MU_PI_HOME; no real pi, no real ~/.pi or ~/.agents.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRow } from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { CTL_OPS, encode, LineDecoder } from "../src/ctl/protocol.js";
import {
  ctlExtensionDoctorCheck,
  ctlSocketsDoctorCheck,
  MURMUR_NOT_NEEDED_DETAIL,
  murmurDoctorCheck,
  skillDoctorCheck,
} from "../src/doctor-summary.js";
import { linkPi, linkSkill } from "../src/link.js";

const ENTRY_KEY = "MU_EXTENSION_ENTRY";
const HOME_KEY = "MU_PI_HOME";
const DB_KEY = "MU_DB_PATH";

let home: string;
let entry: string;
let savedHome: string | undefined;
let savedPath: string | undefined;
let savedPiDir: string | undefined;
let servers: Server[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mu-dctl-"));
  entry = join(home, "fixture", "mu-pi.js");
  mkdirSync(dirname(entry));
  writeFileSync(entry, "export default function () {}\n");
  savedHome = process.env[HOME_KEY];
  savedPath = process.env.PATH;
  savedPiDir = process.env.PI_CODING_AGENT_DIR;
  process.env[ENTRY_KEY] = entry;
  process.env[HOME_KEY] = home;
  process.env[DB_KEY] = join(home, "mu.db");
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  delete process.env[ENTRY_KEY];
  delete process.env[DB_KEY];
  if (savedHome === undefined) delete process.env[HOME_KEY];
  else process.env[HOME_KEY] = savedHome;
  process.env.PATH = savedPath;
  const piDirKey = "PI_CODING_AGENT_DIR";
  if (savedPiDir === undefined) delete process.env[piDirKey];
  else process.env[piDirKey] = savedPiDir;
  rmSync(home, { recursive: true, force: true });
});

describe("mu ext / mu skill rows", () => {
  it("warn with 'run mu link pi' on an empty home", () => {
    expect(ctlExtensionDoctorCheck()).toEqual({
      name: "mu ext",
      status: "warn",
      detail: "not linked: run mu link pi",
    });
    expect(skillDoctorCheck()).toEqual({
      name: "mu skill",
      status: "warn",
      detail: "not linked: run mu link pi",
    });
  });

  it("are ok after linkPi + linkSkill", () => {
    linkPi();
    linkSkill();
    expect(ctlExtensionDoctorCheck()).toEqual({
      name: "mu ext",
      status: "ok",
      detail: "(ctl, mu_delegate)",
    });
    expect(skillDoctorCheck()).toMatchObject({ name: "mu skill", status: "ok" });
  });

  it("mu ext names the MU_DELEGATE=0 kill switch", () => {
    linkPi();
    process.env.MU_DELEGATE = "0";
    try {
      expect(ctlExtensionDoctorCheck().detail).toBe("(ctl; mu_delegate disabled by MU_DELEGATE=0)");
    } finally {
      const key = "MU_DELEGATE";
      delete process.env[key];
    }
  });

  it("mu ext warns dangling when the shim's target is gone", () => {
    linkPi();
    rmSync(entry);
    expect(ctlExtensionDoctorCheck()).toMatchObject({
      status: "warn",
      detail: "dangling: run mu link pi",
    });
  });

  it("mu ext warns stale copy for --copy installs", () => {
    linkPi({ copy: true });
    expect(ctlExtensionDoctorCheck().detail).toBe("stale copy: run mu link pi");
  });

  it("mu skill warns about a foreign skill dir", () => {
    mkdirSync(join(home, ".agents", "skills", "mu"), { recursive: true });
    expect(skillDoctorCheck()).toEqual({
      name: "mu skill",
      status: "warn",
      detail: "foreign skill at ~/.agents/skills/mu (not a symlink)",
    });
  });
});

describe("murmur row with the mu extension", () => {
  it("murmur absent + mu ext ok → ok, not needed for pi agents", () => {
    process.env.PATH = join(home, "empty-bin");
    expect(murmurDoctorCheck("murmur", { muExtOk: true })).toEqual({
      name: "murmur",
      status: "ok",
      detail: MURMUR_NOT_NEEDED_DETAIL,
    });
  });

  it("murmur absent + mu ext missing → the old warn", () => {
    process.env.PATH = join(home, "empty-bin");
    expect(murmurDoctorCheck("murmur", { muExtOk: false })).toEqual({
      name: "murmur",
      status: "warn",
      detail: "murmur not installed: agent state shows unknown",
    });
  });

  it("murmur installed + its extension linked keeps reporting murmur", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "murmur"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "murmur"), 0o755);
    process.env.PATH = bin;
    const piDir = join(home, "pi");
    mkdirSync(join(piDir, "extensions"), { recursive: true });
    writeFileSync(join(piDir, "extensions", "murmur.ts"), "");
    process.env.PI_CODING_AGENT_DIR = piDir;
    expect(murmurDoctorCheck("murmur", { muExtOk: true })).toMatchObject({
      status: "ok",
      detail: "agent state from murmur",
    });
  });
});

function agent(name: string, cli = "pi"): AgentRow {
  const now = new Date().toISOString();
  return {
    name,
    workstreamName: "ws",
    cli,
    paneId: "%1",
    role: "full-access",
    tab: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Serve a v1 control socket at the agent's derived path. `hello` is the
 * extra hello fields; the default is a current extension run from source
 * (ops, no extVersion). `hello: {}` is an extension that predates ops.
 */
async function serveV1(
  name: string,
  hello: Record<string, unknown> = { ops: [...CTL_OPS] },
): Promise<void> {
  const path = ctlSocketPath("ws", name);
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const { op } = JSON.parse(line) as { op: string };
        sock.write(
          encode(
            op === "hello"
              ? { v: 1, ok: true, ...hello }
              : { v: 1, ok: true, state: "idle", since: 1, runs: 0, pending: false },
          ),
        );
      }
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

describe("ctl row", () => {
  it("ok when every pi agent answers v1", async () => {
    await serveV1("w1");
    const r = await ctlSocketsDoctorCheck([agent("w1")]);
    expect(r.check).toEqual({ name: "ctl", status: "ok", detail: "1/1 pi agents reachable" });
    expect(r.agents).toEqual([
      { workstream: "ws", agent: "w1", socket: ctlSocketPath("ws", "w1"), probe: "ok" },
    ]);
  });

  it("warns listing ws/agent: missing for an agent with no socket", async () => {
    await serveV1("w1");
    const r = await ctlSocketsDoctorCheck([agent("w1"), agent("w2")]);
    expect(r.check).toEqual({ name: "ctl", status: "warn", detail: "ws/w2: missing" });
  });

  it("flags an extension built from an older mu than the installed one", async () => {
    await serveV1("w1", { ops: [...CTL_OPS], extVersion: "3.0.9" });
    await serveV1("w2", { ops: [...CTL_OPS], extVersion: "3.1.0" });
    const r = await ctlSocketsDoctorCheck([agent("w1"), agent("w2")], {
      installedVersion: "3.1.0",
    });
    expect(r.check).toEqual({
      name: "ctl",
      status: "warn",
      detail: "ws/w1: extension 3.0.9 older than installed 3.1.0",
    });
    expect(r.agents[0]).toMatchObject({ probe: "ok", extVersion: "3.0.9", outdated: true });
    expect(r.agents[1]).toMatchObject({ probe: "ok", extVersion: "3.1.0" });
    expect(r.agents[1]?.outdated).toBeUndefined();
  });

  it("flags an extension whose hello predates ops (the --fresh incident)", async () => {
    await serveV1("w1", {});
    const r = await ctlSocketsDoctorCheck([agent("w1")], { installedVersion: "3.1.0" });
    expect(r.check).toMatchObject({
      status: "warn",
      detail: "ws/w1: extension (unknown) older than installed 3.1.0",
    });
  });

  it("flags a same-version extension missing ops (loaded before an op landed)", async () => {
    await serveV1("w1", {
      ops: ["hello", "status", "send", "wait", "abort"],
      extVersion: "3.1.0",
    });
    const r = await ctlSocketsDoctorCheck([agent("w1")], { installedVersion: "3.1.0" });
    expect(r.check).toEqual({
      name: "ctl",
      status: "warn",
      detail: "ws/w1: extension lacks ops: fresh, command",
    });
    expect(r.agents[0]).toMatchObject({
      probe: "ok",
      outdated: true,
      missingOps: ["fresh", "command"],
    });
  });

  it("skips non-pi agents (same rule as spawn's handshake)", async () => {
    const r = await ctlSocketsDoctorCheck([agent("c1", "claude")]);
    expect(r.check).toEqual({ name: "ctl", status: "ok", detail: "no pi agents" });
    expect(r.agents).toEqual([]);
  });
});
