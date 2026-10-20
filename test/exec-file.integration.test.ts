// execFileCapture replaces execa in the tmux/herdr/kick/murmur executors.
// Pin the behaviours callers depend on: execa-compatible output trimming,
// numeric-or-null exit codes, no rejection, big output, timeout kill.

import { describe, expect, it } from "vitest";
import { execFileCapture } from "../src/exec-file.js";

const node = process.execPath;

describe("execFileCapture", () => {
  it("captures stdout and strips exactly one trailing newline", async () => {
    const r = await execFileCapture(node, ["-e", "process.stdout.write('a\\nb\\n\\n')"]);
    expect(r).toEqual({ stdout: "a\nb\n", stderr: "", exitCode: 0 });
  });

  it("strips a trailing CRLF", async () => {
    const r = await execFileCapture(node, ["-e", "process.stdout.write('x\\r\\n')"]);
    expect(r.stdout).toBe("x");
  });

  it("returns stderr and the numeric exit code without rejecting", async () => {
    const r = await execFileCapture(node, [
      "-e",
      "process.stderr.write('boom\\n'); process.exit(3)",
    ]);
    expect(r).toEqual({ stdout: "", stderr: "boom", exitCode: 3 });
  });

  it("returns exitCode null when the binary does not exist", async () => {
    const r = await execFileCapture("mu-no-such-binary-xyz", []);
    expect(r.exitCode).toBeNull();
  });

  it("does not truncate output above execFile's 1 MiB default", async () => {
    const r = await execFileCapture(node, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBe(2 * 1024 * 1024);
  });

  it("closes stdin so a child that reads it sees EOF", async () => {
    const r = await execFileCapture(node, [
      "-e",
      "process.stdin.on('data',()=>{}).on('end',()=>process.stdout.write('eof'))",
    ]);
    expect(r).toMatchObject({ stdout: "eof", exitCode: 0 });
  });

  it("kills on timeout and reports a null exit code", async () => {
    const r = await execFileCapture(node, ["-e", "setTimeout(()=>{},60000)"], { timeoutMs: 200 });
    expect(r.exitCode).toBeNull();
  });
});
