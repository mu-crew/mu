// One AUT run over `pi --mode rpc`: spawn, prompt, collect metrics, enforce hard stops.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MetricsCollector, splitLf } from "./events.ts";
import { REAL_PI, sandboxSkillDir } from "./sandbox.ts";
import type { Aborted, RunMetrics, Sandbox, Scenario } from "./types.ts";

export { REAL_PI };

export interface RunOptions {
  model: string;
  providerExt: string;
  /** Faux AUT script path (selftest); exported to the child as EVAL_FAUX_SCRIPT. */
  auTScript?: string;
  timeoutMs?: number;
  tokenCap?: number;
  quietMs?: number;
  maxProds?: number;
  /** Grace between SIGTERM to pi and the SIGKILL sweep (default 3000). */
  graceMs?: number;
  /** Path for the raw rpc JSONL (stderr goes to <log>.stderr). */
  log?: string;
}

const TICK_MS = 500;

/** All descendants of `root` (by ppid), from one `ps` snapshot. */
function descendants(root: number): number[] {
  let table = "";
  try {
    table = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const kids = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || Number.isNaN(pid) || Number.isNaN(ppid))
      continue;
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const stack = [root];
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    for (const k of kids.get(p) ?? []) {
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

/**
 * Every process that carries `EVAL_RUN_TOKEN=<token>` in its environment (pi and every tool it
 * started, however far reparented or regrouped). Linux /proc; elsewhere falls back to the
 * descendants of `root`, which is blind to orphans.
 */
export function ownedPids(token: string, root: number | undefined): number[] {
  if (!existsSync("/proc/self/environ")) return root === undefined ? [] : descendants(root);
  const needle = `EVAL_RUN_TOKEN=${token}\0`;
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`, "latin1").includes(needle)) out.push(Number(name));
    } catch {
      // gone, or not ours
    }
  }
  return out;
}

export async function runAut(
  sb: Sandbox,
  scenario: Scenario,
  opts: RunOptions,
): Promise<RunMetrics> {
  const timeoutMs = opts.timeoutMs ?? scenario.timeoutMs ?? 900_000;
  const tokenCap = opts.tokenCap ?? scenario.tokenCap ?? 1_500_000;
  const quietMs = opts.quietMs ?? scenario.quietMs ?? 30_000;
  const maxProds = opts.maxProds ?? scenario.maxProds ?? 1;

  const token = randomBytes(8).toString("hex");
  const env: Record<string, string> = { ...sb.env, ...scenario.env, EVAL_RUN_TOKEN: token };
  if (opts.auTScript) env.EVAL_FAUX_SCRIPT = opts.auTScript;
  const args = [
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    opts.providerExt,
    "-e",
    sb.surface.extension,
    "--no-skills",
    "--skill",
    existsSync(sandboxSkillDir(sb.dir)) ? sandboxSkillDir(sb.dir) : sb.surface.skillDir,
    "--no-context-files",
    "--no-prompt-templates",
    "--session-dir",
    join(sb.dir, "sessions"),
    "--model",
    opts.model,
  ];

  let log: ReturnType<typeof createWriteStream> | null = null;
  let errLog: ReturnType<typeof createWriteStream> | null = null;
  if (opts.log) {
    mkdirSync(dirname(opts.log), { recursive: true });
    log = createWriteStream(opts.log);
    errLog = createWriteStream(`${opts.log}.stderr`);
  }

  const started = Date.now();
  const collector = new MetricsCollector();
  // detached: own process group, so a hard stop kills pi and everything it started.
  const child = spawn(REAL_PI, args, {
    cwd: sb.repoDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  let exited = false;
  let aborted: Aborted = null;
  let stdinClosed = false;
  child.stdin.on("error", () => {});

  // pi's bash tool starts commands in their own process group, and they are reparented once pi
  // dies, so neither the group nor a descendants snapshot finds them. Find them by the run token
  // in their environment instead, and repeat until none are left (a dying tool may fork).
  const killGroup = (): void => {
    for (let i = 0; i < 5; i++) {
      const pids = ownedPids(token, child.pid);
      if (pids.length === 0) break;
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // group already gone
    }
  };
  // Hard stops go SIGTERM first: pi's rpc mode kills its own tracked detached tool shells on
  // SIGTERM/SIGHUP. The token sweep is the backstop once the grace is up.
  const graceMs = opts.graceMs ?? 3000;
  let termAt = 0;
  const terminate = (): void => {
    if (termAt === 0) {
      termAt = Date.now();
      try {
        if (child.pid !== undefined) process.kill(child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    } else if (Date.now() - termAt > graceMs) {
      killGroup();
    }
  };
  const closeStdin = (): void => {
    if (stdinClosed) return;
    stdinClosed = true;
    child.stdin.end();
  };
  const send = (message: string): void => {
    collector.markPrompted();
    child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
  };

  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    log?.write(chunk);
    buf += chunk;
    const { lines, rest } = splitLf(buf);
    buf = rest;
    for (const line of lines) {
      try {
        collector.push(JSON.parse(line));
      } catch {
        // not protocol JSON: ignore
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => errLog?.write(d));

  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", () => {
      exited = true;
      resolve();
    });
    child.on("error", () => {
      exited = true;
      resolve();
    });
  });

  send(scenario.prompt);
  let prods = 0;
  let closingSince = 0;

  let failure: { error: unknown } | null = null;
  await new Promise<void>((resolve) => {
    let judging = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const now = Date.now();
          if (exited) {
            if (!aborted && closingSince === 0) aborted = "exit";
            clearInterval(timer);
            resolve();
            return;
          }
          if (now - started > timeoutMs) {
            aborted = "timeout";
          } else if (collector.result({ wallMs: 0, prods, aborted: null }).usage.total > tokenCap) {
            aborted = "token-cap";
          }
          if (aborted) {
            terminate();
            return;
          }
          if (closingSince > 0) {
            if (now - closingSince > 10_000) terminate();
            return;
          }
          const quiet = now - collector.lastActivity() >= quietMs;
          if (!(collector.isSettled() && quiet) || judging) return;
          judging = true;
          try {
            const so_far = collector.result({ wallMs: now - started, prods, aborted: null });
            const verdict = await scenario.judge(sb, so_far);
            if (!verdict.completed && prods < maxProds) {
              prods++;
              send("carry on");
            } else {
              closingSince = Date.now();
              closeStdin();
            }
          } finally {
            judging = false;
          }
        } catch (error) {
          // a throwing judge must reach runAut's caller, after the AUT and its tools are stopped
          failure = { error };
          clearInterval(timer);
          resolve();
        }
      })();
    }, TICK_MS);
  });

  if (!exited) {
    terminate();
    await Promise.race([exitPromise, new Promise((r) => setTimeout(r, graceMs))]);
  }
  killGroup();
  await exitPromise;
  child.stdout.destroy();
  child.stderr.destroy();
  await Promise.all(
    [log, errLog].map((s) => (s ? new Promise<void>((r) => s.end(r)) : Promise.resolve())),
  );
  if (failure) throw (failure as { error: unknown }).error;
  return collector.result({ wallMs: Date.now() - started, prods, aborted });
}
