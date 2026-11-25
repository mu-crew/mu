import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ctlSocketPath,
  linkForwardSocket,
  MAX_SOCK_PATH,
  removeCtlSocket,
} from "../src/ctl/path.js";

describe("ctlSocketPath", () => {
  it("is readable for short names", () => {
    expect(ctlSocketPath("auth", "worker-1", "/s")).toBe("/s/sock/auth/worker-1.sock");
  });

  it("is deterministic", () => {
    expect(ctlSocketPath("a", "b", "/s")).toBe(ctlSocketPath("a", "b", "/s"));
  });

  it("hashes when the readable path is too long", () => {
    const p = ctlSocketPath("w".repeat(60), "a".repeat(60), "/Users/someone/.local/state/mu");
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(MAX_SOCK_PATH);
    expect(p).toMatch(/\/sock\/_h\/[0-9a-f]{16}\.sock$/);
  });

  it("binds distinct sockets in a private directory for long state dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "mu-ctl-path-"));
    const servers: ReturnType<typeof createServer>[] = [];
    try {
      const paths = ["a", "b"].map((name) => {
        const state = join(root, name.repeat(Math.max(1, 85 - Buffer.byteLength(root))));
        mkdirSync(state);
        expect(Buffer.byteLength(state)).toBeGreaterThanOrEqual(85);
        const path = ctlSocketPath("workstream", "worker-1", state);
        mkdirSync(dirname(path), { recursive: true });
        return path;
      });
      for (const path of paths) {
        const server = createServer();
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(path, resolve);
        });
        // Even if the OS silently truncates sun_path, the advertised name must exist.
        expect(existsSync(path)).toBe(true);
        expect(Buffer.byteLength(path)).toBeLessThanOrEqual(MAX_SOCK_PATH);
        expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await Promise.all(
        servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
      );
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes ws/agent splits", () => {
    expect(ctlSocketPath("a-b", "c", "/s")).not.toBe(ctlSocketPath("a", "b-c", "/s"));
  });

  it("follows MU_DB_PATH dir when no stateDir given", () => {
    const key = "MU_DB_PATH";
    const prev = process.env[key];
    process.env[key] = "/tmp/x/mu.db";
    try {
      expect(ctlSocketPath("a", "b")).toBe("/tmp/x/sock/a/b.sock");
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });
});

describe("removeCtlSocket", () => {
  const scratch = (): string => mkdtempSync(join(tmpdir(), "mu-ctl-rm-"));
  /** A socket file with nothing listening, as a dead forward leaves it. */
  async function boundSocket(path: string): Promise<void> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(path, () => r()));
    const keep = `${path}.keep`;
    linkSync(path, keep); // node unlinks the bound name on close; keep a second one
    await new Promise<void>((r) => s.close(() => r()));
    renameSync(keep, path);
  }

  it("unlinks only the name when the link points at a file mu did not make", () => {
    const root = scratch();
    try {
      const user = join(root, "notes.txt");
      writeFileSync(user, "mine");
      const sock = join(root, "agent.sock");
      symlinkSync(user, sock);
      removeCtlSocket(sock);
      expect(() => lstatSync(sock)).toThrow(/ENOENT/);
      expect(readFileSync(user, "utf8")).toBe("mine");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a socket the link names when it is not this name's forward path", async () => {
    const root = scratch();
    try {
      const other = join(root, "other.0123456789ab.sock"); // another agent's forward
      await boundSocket(other);
      const sock = join(root, "agent.sock");
      symlinkSync(other, sock);
      removeCtlSocket(sock);
      expect(() => lstatSync(sock)).toThrow(/ENOENT/);
      expect(lstatSync(other).isSocket()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a regular file named like the forward path", () => {
    const root = scratch();
    try {
      const sock = join(root, "agent.sock");
      const named = join(root, "agent.0123456789ab.sock");
      writeFileSync(named, "not a socket");
      symlinkSync(named, sock);
      removeCtlSocket(sock);
      expect(readFileSync(named, "utf8")).toBe("not a socket");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { where: "beside it", pad: 0 },
    { where: "under the short root", pad: 1 },
  ])("removes the link and the forward socket linkForwardSocket made $where", async ({ pad }) => {
    const root = scratch();
    try {
      // pad: a name whose `.<nonce>.sock` sibling no longer fits sun_path.
      const name = pad === 0 ? "agent" : "a".repeat(MAX_SOCK_PATH - root.length - 6);
      const sock = join(root, `${name}.sock`);
      const forward = linkForwardSocket(sock);
      expect(forward.startsWith(root)).toBe(pad === 0);
      await boundSocket(forward);
      removeCtlSocket(sock);
      expect(() => lstatSync(sock)).toThrow(/ENOENT/);
      expect(() => lstatSync(forward)).toThrow(/ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
