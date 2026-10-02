// `mu agent remote-env`: prints the ssh socket forward + identity env for
// a remote pi agent. Also: a forwarded socket file left behind by a dead
// ssh probes as refused, and deleting the agent unlinks it.

import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { ctlProbe } from "../src/ctl/client.js";
import { ctlSocketPath, MAX_SOCK_PATH, remoteCtlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mre-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "big");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const uid = process.getuid?.() ?? 0;

describe("remoteCtlSocketPath", () => {
  it("is /tmp/mu-<uid>/<ws>/<agent>.sock for short names", () => {
    expect(remoteCtlSocketPath("big", "worker-1", 501)).toBe("/tmp/mu-501/big/worker-1.sock");
  });

  it("hashes when the readable path would exceed the 103-byte limit", () => {
    const p = remoteCtlSocketPath("w".repeat(50), "a".repeat(50), 501);
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(MAX_SOCK_PATH);
    expect(p).toMatch(/^\/tmp\/mu-501\/h\/[0-9a-f]{16}\.sock$/);
  });
});

describe("mu agent remote-env", () => {
  it("--json: ssh args forward the local derived path to the remote path", async () => {
    const r = await runCli(["agent", "remote-env", "worker-1", "-w", "big", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    const j = JSON.parse(r.stdout) as Record<string, string>;
    const local = ctlSocketPath("big", "worker-1", dir);
    const remote = `/tmp/mu-${uid}/big/worker-1.sock`;
    expect(j.localSock).toBe(local);
    expect(j.remoteSock).toBe(remote);
    expect(j.sshArgs).toBe(
      `-o ControlMaster=no -o ControlPath=none -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L ${local}:${remote}`,
    );
    expect(j.env).toBe(
      `MU_MANAGED_AGENT=1 MU_AGENT_NAME=worker-1 MU_WORKSTREAM=big MU_CTL_SOCK=${remote}`,
    );
    expect(j.command).toContain(`ssh ${j.sshArgs} <host> -t`);
    // Interactive login shell so the remote rc files (PATH, provider env) load.
    expect(j.command).toContain(`${j.env} $SHELL -ilc "pi --approve"`);
  });

  it("--shell MU_SSH_ARGS forces a direct connection (no ControlMaster mux)", async () => {
    const r = await runCli(["agent", "remote-env", "worker-1", "-w", "big", "--shell"], dbPath);
    expect(r.stdout).toMatch(/^MU_SSH_ARGS='-o ControlMaster=no -o ControlPath=none /m);
  });

  it("--remote-sock overrides the remote path", async () => {
    const r = await runCli(
      ["agent", "remote-env", "worker-1", "-w", "big", "--remote-sock", "/run/u/w1.sock", "--json"],
      dbPath,
    );
    const j = JSON.parse(r.stdout) as Record<string, string>;
    expect(j.remoteSock).toBe("/run/u/w1.sock");
    expect(j.sshArgs).toMatch(/:\/run\/u\/w1\.sock$/);
    expect(j.env).toMatch(/MU_CTL_SOCK=\/run\/u\/w1\.sock$/);
  });

  it("refuses a relative, unsafe or over-long --remote-sock", async () => {
    for (const bad of ["rel.sock", "/tmp/a b.sock", "/tmp/$(x).sock", `/${"x".repeat(110)}`]) {
      const r = await runCli(
        ["agent", "remote-env", "worker-1", "-w", "big", "--remote-sock", bad],
        dbPath,
      );
      expect(r.exitCode, bad).not.toBeNull();
      expect(r.exitCode, bad).not.toBe(0);
    }
  });

  it("refuses an invalid agent name", async () => {
    const r = await runCli(["agent", "remote-env", "Bad Name", "-w", "big"], dbPath);
    expect(r.exitCode).not.toBeNull();
  });

  it("long names hash both paths under the socket limit", async () => {
    const name = `a${"b".repeat(31)}`;
    ensureWorkstream(db, `w${"x".repeat(31)}`);
    const r = await runCli(
      ["agent", "remote-env", name, "-w", `w${"x".repeat(31)}`, "--json"],
      dbPath,
    );
    const j = JSON.parse(r.stdout) as Record<string, string>;
    expect(Buffer.byteLength(j.localSock ?? "")).toBeLessThanOrEqual(MAX_SOCK_PATH);
    expect(Buffer.byteLength(j.remoteSock ?? "")).toBeLessThanOrEqual(MAX_SOCK_PATH);
  });

  it("--shell output is eval-safe and round-trips through sh", async () => {
    const r = await runCli(["agent", "remote-env", "worker-1", "-w", "big", "--shell"], dbPath);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/^MU_(SSH_ARGS|REMOTE_ENV)='[^']*'$/);
    const out = execFileSync(
      "sh",
      ["-c", `${r.stdout}\nprintf '%s\\n%s' "$MU_SSH_ARGS" "$MU_REMOTE_ENV"`],
      { encoding: "utf8" },
    );
    const j = JSON.parse(
      (await runCli(["agent", "remote-env", "worker-1", "-w", "big", "--json"], dbPath)).stdout,
    ) as Record<string, string>;
    expect(out).toBe(`${j.sshArgs}\n${j.env}`);
  });

  it("--help names AllowStreamLocalForwarding", async () => {
    const r = await runCli(["agent", "remote-env", "--help"], dbPath);
    expect(r.stdout + r.stderr).toContain("AllowStreamLocalForwarding");
  });
});

describe("leftover forwarded socket", () => {
  /** A socket file with no listener: what ssh leaves when the forward dies. */
  async function leftoverSocket(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    const live = join(dir, "live.sock");
    const s = createServer();
    await new Promise<void>((res) => s.listen(live, () => res()));
    linkSync(live, path); // second name survives node's unlink on close
    await new Promise<void>((res) => s.close(() => res()));
  }

  it("probes as refused, never ok", async () => {
    const p = ctlSocketPath("big", "worker-1", dir);
    await leftoverSocket(p);
    expect(existsSync(p)).toBe(true);
    const probe = await ctlProbe(p, 500);
    expect(probe.kind).toBe("refused");
  });

  it("deleteAgent (close / reap) unlinks the local socket path", async () => {
    insertAgent(db, { name: "worker-1", workstream: "big", paneId: "%1", cli: "pi" });
    const p = ctlSocketPath("big", "worker-1", dir);
    await leftoverSocket(p);
    expect(deleteAgent(db, "worker-1", "big")).toBe(true);
    expect(existsSync(p)).toBe(false);
  });

  it("deleteAgent leaves another agent's socket alone", async () => {
    insertAgent(db, { name: "worker-1", workstream: "big", paneId: "%1", cli: "pi" });
    const other = ctlSocketPath("big", "worker-2", dir);
    await leftoverSocket(other);
    deleteAgent(db, "worker-1", "big");
    expect(existsSync(other)).toBe(true);
  });
});
