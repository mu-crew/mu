// execFileCapture replaces execa in the tmux/herdr/murmur executors.
// Pin the behaviours callers depend on: execa-compatible output trimming,
// numeric-or-null exit codes, no rejection, big output, timeout kill.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { execFileCapture, execGroupCapture } from "../src/exec-file.js";

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

describe("execGroupCapture", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const sh = (script: string, opts = {}) => execGroupCapture("/bin/sh", ["-c", script], opts);

  it("captures output and the exit code like execFileCapture", async () => {
    expect(await sh("echo out; echo err >&2; exit 3")).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 3,
    });
    expect((await execGroupCapture("mu-no-such-binary-xyz", [])).exitCode).toBeNull();
  });

  it("a timeout returns null only after the descendants are dead (TERM-ignoring ones get KILL)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-exec-group-"));
    const pidFile = join(dir, "pid");
    try {
      const t = Date.now();
      const r = await sh(`(trap '' TERM; echo $$ > ${pidFile}; while :; do sleep 1; done) & wait`, {
        timeoutMs: 150,
        graceMs: 100,
      });
      expect(r.exitCode).toBeNull();
      expect(Date.now() - t).toBeLessThan(3000);
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a background leftover of a command that exited is reaped before the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-exec-group-"));
    const pidFile = join(dir, "pid");
    try {
      const r = await sh(
        `sh -c 'echo $$ > ${pidFile}; exec sleep 30' & while [ ! -s ${pidFile} ]; do :; done; echo done`,
      );
      expect(r).toMatchObject({ stdout: "done", exitCode: 0 });
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parent termination kills the whole group, descendants included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-exec-group-"));
    const pidFile = join(dir, "pid");
    const mod = pathToFileURL(join(__dirname, "..", "src", "exec-file.ts")).href;
    const script = `import { execGroupCapture } from ${JSON.stringify(mod)};
      await execGroupCapture("/bin/sh", ["-c", ${JSON.stringify(`sh -c 'echo $$ > ${pidFile}; exec sleep 30' || echo no`)}]);`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: "ignore",
    });
    const closed = new Promise((res) => parent.once("close", res));
    try {
      for (let i = 0; i < 200 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8")); i++)
        await sleep(25);
      await sleep(100);
      parent.kill("SIGTERM");
      await closed;
      const pid = Number(readFileSync(pidFile, "utf8"));
      for (let i = 0; i < 40 && alive(pid); i++) await sleep(25);
      expect(alive(pid)).toBe(false);
    } finally {
      parent.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

// Parent termination: execa's `cleanup: true` killed in-flight children when
// the parent died; execFileCapture must too (finding
// high_executor_children_survive_mu_exit).
describe("execFileCapture parent-exit cleanup", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // `hook` installs another signal-exit listener in the parent (as a TUI
  // library would), so we test the interplay on the shared global emitter.
  async function runParent(
    how: "SIGTERM" | "SIGINT" | "SIGHUP" | "SIGUSR2" | "exit",
    hook: "none" | "own" = "none",
  ): Promise<{
    parent: { code: number | null; signal: NodeJS.Signals | null };
    childPid: number;
  }> {
    const dir = mkdtempSync(join(tmpdir(), "mu-exec-cleanup-"));
    const pidFile = join(dir, "child.pid");
    const childScript = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`;
    const hookSrc =
      hook === "none"
        ? ""
        : `import { createRequire } from "node:module";
      const req = createRequire(${JSON.stringify(join(__dirname, "..", "package.json"))});
      const mod = req(req.resolve("signal-exit"));
      (mod.onExit ?? mod)(() => {});
      setInterval(() => {}, 1000);`;
    const parentScript = `
      ${hookSrc}
      import { execFileCapture, execGroupCapture } from ${JSON.stringify(pathToFileURL(join(__dirname, "..", "src", "exec-file.ts")).href)};
      const p = execFileCapture(process.execPath, ["-e", ${JSON.stringify(childScript)}], { timeoutMs: 5000 });
      ${how === "exit" ? `import { existsSync } from "node:fs"; while (!existsSync(${JSON.stringify(pidFile)})) await new Promise((r) => setTimeout(r, 20)); process.exit(0);` : "await p;"}
    `;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript], {
      stdio: "ignore",
      cwd: join(__dirname, ".."),
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
      parent.once("close", (code, signal) => res({ code, signal })),
    );
    try {
      for (let i = 0; i < 400 && !existsSync(pidFile); i++) await sleep(25);
      expect(existsSync(pidFile)).toBe(true);
      // The pid file is written before the parent finishes registering; give it a beat.
      await sleep(50);
      if (how !== "exit") parent.kill(how);
      const res = await closed;
      const childPid = Number(readFileSync(pidFile, "utf8"));
      // Allow the OS a moment to reap the SIGKILLed child.
      for (let i = 0; i < 40 && alive(childPid); i++) await sleep(25);
      return { parent: res, childPid };
    } finally {
      try {
        parent.kill("SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const how of ["SIGTERM", "SIGINT", "SIGHUP", "SIGUSR2", "exit"] as const) {
    it(`kills the in-flight child when the parent gets ${how}`, async () => {
      const { parent, childPid } = await runParent(how);
      try {
        expect(alive(childPid)).toBe(false);
        // Default signal behaviour is preserved: the parent still dies by the signal.
        if (how !== "exit") expect(parent.signal).toBe(how);
      } finally {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
    }, 15_000);
  }

  // With another signal-exit listener installed, the parent must still
  // terminate by the signal and the child must still die.
  it("kills the child and terminates the parent on SIGTERM with another signal-exit listener", async () => {
    const { parent, childPid } = await runParent("SIGTERM", "own");
    try {
      expect(alive(childPid)).toBe(false);
      expect(parent.signal).toBe("SIGTERM");
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
  }, 15_000);
});
