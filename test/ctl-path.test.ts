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
    expect(p).toMatch(/\/sock\/h\/[0-9a-f]{16}\.sock$/);
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
