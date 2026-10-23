// The `ssh` of a sandbox (installed by fixtures.sshShim as <dir>/bin/ssh). It "connects" to hosts
// that live on this machine: per-host config in <sandbox>/hosts/<host>/shim.json.
// Pipes are never used: with -t inside a tmux pane the remote command gets the pane's TTY.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseSshArgs, remoteEnv, rewriteCommand, rewriteSock } from "./ssh-args.ts";

export interface HostConfig {
  host: string;
  hostRoot: string;
  maxSessions?: number;
  sessionsLog: string;
  tmuxSocket: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Take a session slot, or return false when maxSessions live sessions exist. Serialised by a mkdir lock. */
async function takeSlot(dir: string, max: number | undefined): Promise<boolean> {
  mkdirSync(dir, { recursive: true });
  const lock = `${dir}.lock`;
  for (let i = 0; i < 200; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      await sleep(10);
    }
  }
  try {
    const live = readdirSync(dir).filter((f) => alive(Number(f)));
    if (max !== undefined && live.length >= max) return false;
    writeFileSync(join(dir, String(process.pid)), "");
    return true;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Emulate `-L local:remote`: once the remote socket exists, link the local path to it. */
async function forward(local: string, remote: string, links: string[]): Promise<void> {
  mkdirSync(dirname(remote), { recursive: true });
  mkdirSync(dirname(local), { recursive: true });
  await sleep(200);
  for (let i = 0; i < 600; i++) {
    if (existsSync(remote)) {
      rmSync(local, { force: true });
      symlinkSync(remote, local);
      links.push(local);
      return;
    }
    await sleep(50);
  }
}

async function main(argv: string[]): Promise<number> {
  const inv = parseSshArgs(argv);
  const sandbox = process.env.EVAL_SANDBOX_DIR ?? "";
  const cfgPath = inv.host ? join(sandbox, "hosts", inv.host, "shim.json") : "";
  if (!inv.host || !existsSync(cfgPath)) {
    console.error(`ssh: Could not resolve hostname ${inv.host ?? ""}: Name or service not known`);
    return 255;
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as HostConfig;
  const command = inv.command === null ? null : rewriteCommand(inv.command, cfg.hostRoot);
  const logLine = (what: string): void =>
    appendFileSync(cfg.sessionsLog, `${Date.now()} ${what} ${command ?? ""}\n`);

  const sessions = join(cfg.hostRoot, ".sessions");
  if (!(await takeSlot(sessions, cfg.maxSessions))) {
    appendFileSync(cfg.sessionsLog, `${Date.now()} REFUSED ${command ?? ""}\n`);
    console.error("channel 0: open failed: administratively prohibited: open failed");
    console.error("ssh: session limit reached");
    return 255;
  }
  const slot = join(sessions, String(process.pid));
  logLine(String(process.pid));

  if (inv.tty && !process.stdin.isTTY) {
    console.error("Pseudo-terminal will not be allocated because stdin is not a terminal.");
  }
  const links: string[] = [];
  for (const f of inv.forwards) {
    void forward(f.local, rewriteSock(f.remote, cfg.hostRoot), links);
  }

  const env = remoteEnv(process.env, cfg.hostRoot, cfg.host, cfg.tmuxSocket);
  const child = spawn("bash", command === null ? [] : ["-c", command], {
    cwd: join(cfg.hostRoot, "home"),
    env,
    stdio: "inherit",
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => child.kill(sig));
  }
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(255));
    child.on("exit", (c, s) => resolve(c ?? (s ? 128 + (s === "SIGHUP" ? 1 : 15) : 1)));
  });
  rmSync(slot, { force: true });
  // ssh removes its forwarded socket when the connection ends.
  for (const l of links) {
    try {
      if (lstatSync(l).isSymbolicLink() && readlinkSync(l)) rmSync(l, { force: true });
    } catch {
      // already gone
    }
  }
  return code;
}

main(process.argv.slice(2)).then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(255);
  },
);
