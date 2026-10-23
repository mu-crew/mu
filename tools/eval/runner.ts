// One AUT run over `pi --mode rpc`: spawn, prompt, collect metrics, enforce hard stops.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MetricsCollector, splitLf } from "./events.ts";
import { REAL_PI } from "./sandbox.ts";
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

export async function runAut(
  sb: Sandbox,
  scenario: Scenario,
  opts: RunOptions,
): Promise<RunMetrics> {
  const timeoutMs = opts.timeoutMs ?? scenario.timeoutMs ?? 900_000;
  const tokenCap = opts.tokenCap ?? scenario.tokenCap ?? 1_500_000;
  const quietMs = opts.quietMs ?? scenario.quietMs ?? 30_000;
  const maxProds = opts.maxProds ?? scenario.maxProds ?? 1;

  const env: Record<string, string> = { ...sb.env, ...scenario.env };
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
    sb.surface.skillDir,
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

  // pi's bash tool starts commands in their own process group, so killing pi's group alone would
  // orphan a hung tool. Collect the whole descendant tree first, then kill it and the group.
  const killGroup = (): void => {
    if (child.pid === undefined) return;
    for (const pid of descendants(child.pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // group already gone
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

  await new Promise<void>((resolve) => {
    let judging = false;
    const timer = setInterval(() => {
      void (async () => {
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
          killGroup();
          return;
        }
        if (closingSince > 0) {
          if (now - closingSince > 10_000) killGroup();
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
      })();
    }, TICK_MS);
  });

  await exitPromise;
  killGroup();
  child.stdout.destroy();
  child.stderr.destroy();
  await Promise.all(
    [log, errLog].map((s) => (s ? new Promise<void>((r) => s.end(r)) : Promise.resolve())),
  );
  return collector.result({ wallMs: Date.now() - started, prods, aborted });
}
