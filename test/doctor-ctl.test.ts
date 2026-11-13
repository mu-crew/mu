// Doctor rows for the mu pi extension (live hello) and per-agent
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
  type AgentCtlReport,
  ctlExtensionDoctorCheck,
  ctlSocketsDoctorCheck,
  extensionLive,
  MURMUR_NOT_NEEDED_DETAIL,
  murmurDoctorCheck,
} from "../src/doctor-summary.js";

const HOME_KEY = "MU_PI_HOME";
const DB_KEY = "MU_DB_PATH";

let home: string;
let savedHome: string | undefined;
let savedPath: string | undefined;
let servers: Server[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mu-dctl-"));
  savedHome = process.env[HOME_KEY];
  savedPath = process.env.PATH;
  process.env[HOME_KEY] = home;
  process.env[DB_KEY] = join(home, "mu.db");
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  delete process.env[DB_KEY];
  if (savedHome === undefined) delete process.env[HOME_KEY];
  else process.env[HOME_KEY] = savedHome;
  process.env.PATH = savedPath;
  rmSync(home, { recursive: true, force: true });
});

describe("mu ext row (live hello, never a file on disk)", () => {
  const report = (over: Partial<AgentCtlReport> = {}): AgentCtlReport => ({
    workstream: "ws",
    agent: "a",
    socket: "/s",
    probe: "ok",
    ...over,
  });

  it("is unknown (ok, no claim) when there is no pi agent to ask", () => {
    const row = ctlExtensionDoctorCheck([]);
    expect(row).toMatchObject({ name: "mu ext", status: "ok" });
    expect(row.detail).toContain("unknown");
    expect(row.detail).toContain("pi install npm:@mu-crew/mu");
  });

  it("is not inferred from a legacy shim: one on disk changes nothing", () => {
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "extensions", "mu.ts"), "// mu:shim\n");
    expect(ctlExtensionDoctorCheck([]).detail).toContain("unknown");
  });

  it("reports the live extVersion, ops and features from hello", () => {
    const row = ctlExtensionDoctorCheck([
      report({ extVersion: "3.14.0", opCount: 9, features: ["incarnation", "msgId"] }),
    ]);
    expect(row).toEqual({
      name: "mu ext",
      status: "ok",
      detail: "3.14.0 (ctl, 9 ops; incarnation, msgId)",
    });
  });

  it("warns, with the install advice, when agents exist and none answers", () => {
    const row = ctlExtensionDoctorCheck([report({ probe: "missing" })]);
    expect(row.status).toBe("warn");
    expect(row.detail).toContain("pi install npm:@mu-crew/mu");
  });

  it("the ctl rows carry hello.features through the probe", async () => {
    await serveV1("w1", { ops: [...CTL_OPS], extVersion: "1.2.3", features: ["msgId"] });
    const { agents } = await ctlSocketsDoctorCheck([agent("w1")], { installedVersion: "1.2.3" });
    expect(agents[0]).toMatchObject({
      probe: "ok",
      extVersion: "1.2.3",
      opCount: CTL_OPS.length,
      features: ["msgId"],
    });
    expect(ctlExtensionDoctorCheck(agents).detail).toContain("1.2.3");
  });

  it("an extension whose hello lists no features reports none", async () => {
    await serveV1("w1");
    const { agents } = await ctlSocketsDoctorCheck([agent("w1")]);
    expect(agents[0]?.features).toBeUndefined();
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

  it("old murmur + mu ext ok: the warning says it affects non-pi CLIs only", () => {
    const root = join(home, "murmur");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@mu-crew/murmur", version: "0.6.1" }),
    );
    writeFileSync(join(bin, "murmur"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "murmur"), 0o755);
    process.env.PATH = bin;
    expect(murmurDoctorCheck("murmur", { muExtOk: true })).toEqual({
      name: "murmur",
      status: "warn",
      detail:
        "murmur 0.6.1 is older than 1.0.0; idle/stall timing unknown for non-pi CLIs (pi agents use ctl)",
    });
    expect(murmurDoctorCheck("murmur", { muExtOk: false }).detail).toBe(
      "murmur 0.6.1 is older than 1.0.0; @murmur_pane_since missing, idle/stall timing unknown",
    );
  });

  it("murmur installed keeps reporting murmur", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "murmur"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "murmur"), 0o755);
    process.env.PATH = bin;
    expect(murmurDoctorCheck("murmur", { muExtOk: true })).toMatchObject({
      status: "ok",
      detail: "agent state from murmur",
    });
  });
});

function agent(name: string, cli = "pi"): AgentRow {
  const now = new Date().toISOString();
  return {
    incarnation: 1,
    name,
    workstreamName: "ws",
    cli,
    paneId: "%1",
    role: "full-access",
    tab: null,
    cwd: null,
    base: null,
    command: null,
    commandSource: null,
    spawner: null,
    host: null,
    collectedHead: null,
    repo: null,
    gateToken: null,
    channel: null,
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
      {
        workstream: "ws",
        agent: "w1",
        socket: ctlSocketPath("ws", "w1"),
        probe: "ok",
        opCount: CTL_OPS.length,
      },
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
      detail: "ws/w1: extension lacks ops: interrupt, fresh, command",
    });
    expect(r.agents[0]).toMatchObject({
      probe: "ok",
      outdated: true,
      missingOps: ["interrupt", "fresh", "command"],
    });
  });

  it("ctl row: a lacking-ops extension that serves command reloads over ctl", async () => {
    await serveV1("w1", {
      ops: ["hello", "status", "send", "wait", "command"],
      extVersion: "3.1.0",
    });
    await serveV1("w2", { ops: ["hello", "status", "send", "wait"], extVersion: "3.1.0" });
    const r = await ctlSocketsDoctorCheck([agent("w1"), agent("w2")], {
      installedVersion: "3.1.0",
    });
    expect(r.agents[0]).toMatchObject({ reloadVia: "ctl" });
    expect(r.agents[1]).toMatchObject({ reloadVia: "respawn" });
  });

  it("skips non-pi agents (same rule as spawn's handshake)", async () => {
    const r = await ctlSocketsDoctorCheck([agent("c1", "claude")]);
    expect(r.check).toEqual({ name: "ctl", status: "ok", detail: "no pi agents" });
    expect(r.agents).toEqual([]);
  });

  // Spec D15: a pi on the `hooks` fallback still serves ctl for doctor, though
  // every verb reaches it through hooks; a hook harness on `hooks` serves none.
  it("probes a pi on the hooks fallback, and still skips a hooks claude", async () => {
    await serveV1("w1");
    const pi = { ...agent("w1"), channel: "hooks" as const };
    const claude = { ...agent("c1", "claude"), channel: "hooks" as const };
    const r = await ctlSocketsDoctorCheck([pi, claude]);
    expect(r.check).toEqual({ name: "ctl", status: "ok", detail: "1/1 pi agents reachable" });
    expect(r.agents.map((a) => a.agent)).toEqual(["w1"]);
  });

  // A hooks pi's live hello proves the extension, never that pi's state is free of murmur.
  it("a reachable pi on the hooks fallback keeps the murmur-missing warning", async () => {
    await serveV1("w1");
    await serveV1("w2");
    const hooksPi = { ...agent("w1"), channel: "hooks" as const };
    const r = await ctlSocketsDoctorCheck([hooksPi, agent("w2")]);
    expect(r.agents.map((a) => [a.agent, a.probe, a.hooksFallback])).toEqual([
      ["w1", "ok", true],
      ["w2", "ok", undefined],
    ]);
    expect(extensionLive(r.agents)).toBe(false);
    expect(extensionLive(r.agents.filter((a) => a.agent === "w2"))).toBe(true);
    expect(ctlExtensionDoctorCheck(r.agents).status).toBe("ok");
    process.env.PATH = join(home, "empty-bin");
    expect(murmurDoctorCheck("murmur", { muExtOk: extensionLive(r.agents) })).toEqual({
      name: "murmur",
      status: "warn",
      detail: "murmur not installed: agent state shows unknown",
    });
  });

  it("probes a pi on the hooks fallback by its command when the cli key names no harness", async () => {
    const pi = { ...agent("w1", "helper"), channel: "hooks" as const, command: "pi-meta --x" };
    const r = await ctlSocketsDoctorCheck([pi]);
    expect(r.check).toEqual({ name: "ctl", status: "warn", detail: "ws/w1: missing" });
  });
});
