// One private directory per Vitest run. Register endpoints before launching a
// server so cleanup doesn't depend on a worker surviving to report a PID.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT_KEY = "muServerRoot";
export const TMUX_SOCKET_KEY = "muTmuxSocket";
const marker = "MU_TEST_SERVER_ROOT";
const commandTimeout = 2000;

export function createServerRoot(): string {
  // macOS TMPDIR plus tmux's socket name can exceed sockaddr_un.sun_path.
  const base = process.env.TMUX_TMPDIR || "/tmp";
  const dir = mkdtempSync(join(base.startsWith("/") && base.length <= 40 ? base : "/tmp", "mus-"));
  mkdirSync(join(dir, "tmux-registry"));
  mkdirSync(join(dir, "rex-registry"));
  return dir;
}

export function setServerRoot(dir: string): void {
  process.env[marker] = dir;
  process.env.TMUX_TMPDIR = dir;
}

function serverRoot(): string {
  const dir = process.env[marker];
  if (!dir) throw new Error("private server fixture requires Vitest global setup");
  return dir;
}

export function registerTmuxSocket(dir = serverRoot()): string {
  const name = `mu-test-${randomBytes(8).toString("hex")}`;
  writeFileSync(join(dir, "tmux-registry", name), "", { flag: "wx" });
  return name;
}

export function startTestRex(): { dir: string; address: string; stop(): Promise<void> } {
  const dir = mkdtempSync(join(serverRoot(), "rex-registry", "mu-rex-"));
  const address = rexAddress(dir);
  const child = spawn("rex", rexArgs(dir), { detached: true, stdio: "ignore" });
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  // A missing binary is reported to the fixture's caller, not an unhandled
  // rejection between setup and teardown.
  void started.catch(() => {});
  return {
    dir,
    address,
    async stop() {
      await started;
      await stopRex(dir);
      // If stop throws, leave the registration for global teardown to retry.
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function rexAddress(dir: string): string {
  return `unix://${join(dir, "rex.sock")}`;
}

function rexArgs(dir: string): string[] {
  return [
    "server",
    "run",
    "--listen",
    rexAddress(dir),
    "--restore=false",
    "--state-dir",
    join(dir, "state"),
  ];
}

function rexGroup(dir: string): number | undefined {
  // A PID alone can be recycled. Require the current group leader to name
  // both the private socket and state path registered by this run.
  const args = ` ${rexArgs(dir).join(" ")}`;
  const table = execFileSync("ps", ["-axww", "-o", "pid=,pgid=,command="], {
    encoding: "utf8",
    timeout: commandTimeout,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    const cmd = match?.[3];
    if (cmd?.endsWith(args) && /(?:^|\/)rex$/.test(cmd.slice(0, -args.length))) {
      const pid = Number(match?.[1]);
      if (pid > 1 && pid === Number(match?.[2])) return pid;
    }
  }
}

async function stopRex(dir: string): Promise<void> {
  const group = rexGroup(dir);
  if (group === undefined) return;
  // Graceful stop closes PTYs before leaving. If the private socket isn't
  // ready or shutdown hangs, terminate the verified group instead.
  spawnSync("rex", ["-S", rexAddress(dir), "--autostart=false", "server", "stop"], {
    stdio: "ignore",
    timeout: commandTimeout,
    killSignal: "SIGKILL",
  });
  for (let i = 0; i < 20; i++) {
    if (rexGroup(dir) !== group) return;
    if (i === 0 || i === 10) {
      try {
        process.kill(-group, i === 0 ? "SIGTERM" : "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
    await delay(50);
  }
  throw new Error(`private Rex server still running: ${dir}`);
}

export function stopTestTmux(name: string | undefined, dir = serverRoot()): void {
  if (!name || !/^mu-test-[a-f0-9]{16}$/.test(name)) return;
  if (!lstatSync(join(dir, "tmux-registry", name), { throwIfNoEntry: false })?.isFile()) return;
  const path = join(dir, `tmux-${process.getuid?.()}`, name);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSocket()) return;
  const result = spawnSync("tmux", ["-N", "-S", path, "kill-server"], {
    encoding: "utf8",
    timeout: commandTimeout,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (
    result.status !== 0 &&
    !/no server running|No such file|Connection refused/.test(result.stderr)
  ) {
    throw new Error(`could not stop private tmux ${path}: ${result.stderr}`);
  }
  rmSync(path, { force: true });
}

async function cleanServers(dir: string): Promise<void> {
  const rex = readdirSync(join(dir, "rex-registry"));
  const tmux = readdirSync(join(dir, "tmux-registry"));
  const results = await Promise.allSettled([
    ...rex.map((name) => stopRex(join(dir, "rex-registry", name))),
    ...tmux.map(async (name) => stopTestTmux(name, dir)),
  ]);
  const errors = results.flatMap((res) => (res.status === "rejected" ? [res.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, `test server cleanup failed in ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

// Vitest global teardown closes this pipe and awaits cleanup. A runner killed
// by an external timeout closes the same pipe by dying; the watchdog is in a
// different process group so that the timeout can't kill it with the runner.
export async function watchTestServers(dir: string, scratch: string): Promise<() => Promise<void>> {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(import.meta.url),
      "--watch-test-servers",
      dir,
      scratch,
    ],
    {
      detached: true,
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`test server watchdog exited: ${code ?? signal}`));
    });
  });
  void done.catch(() => {});
  child.stdin.on("error", () => {}); // watchdog failure is reported via done
  // Do not launch any servers until the watchdog has the pipe open.
  await Promise.race([
    once(child.stdout, "data"),
    done.then(() => {
      throw new Error("test server watchdog exited before ready");
    }),
  ]);
  child.unref();
  // The watchdog must not keep a runner alive when Vitest skips teardown.
  if (child.stdin instanceof Socket) child.stdin.unref();
  return async () => {
    child.ref();
    child.stdin.end();
    await done;
  };
}

const watchedDir = process.argv[3];
if (process.argv[2] === "--watch-test-servers" && watchedDir !== undefined) {
  process.stdout.end("ready\n");
  process.stdin.resume();
  process.stdin.once("end", () => {
    const scratch = process.argv[4];
    void cleanServers(watchedDir)
      .finally(() => {
        if (
          scratch &&
          dirname(scratch) === tmpdir() &&
          basename(scratch).startsWith("mu-test-run-")
        ) {
          rmSync(scratch, { recursive: true, force: true });
        }
      })
      .catch((err: unknown) => {
        console.error(err);
        process.exitCode = 1;
      });
  });
}
