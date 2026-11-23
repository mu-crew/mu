import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ctlSocketPath, MAX_SOCK_PATH } from "../src/ctl/path.js";

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
