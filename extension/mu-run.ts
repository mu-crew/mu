/**
 * Running `mu` from the pi extensions: the runner seam (tests inject a fake)
 * and the reading of its one `--json` envelope. Pure plumbing, shared by the
 * delegate tools and the nudges.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type MuResult = { code: number; stdout: string; stderr: string };
/** Per-call options. `env` is merged over this process's env for that child only
 *  (undefined deletes a key). `drainMs` bounds how long an aborted child (SIGTERM'd,
 *  its final document kept: a `mu wait` snapshot) may run before SIGKILL; default 10 s. */
export type MuRunOpts = { env?: Record<string, string | undefined>; drainMs?: number };
/** Runs `mu <args>`. The test seam: tests inject a fake. */
export type MuRunner = (
  args: readonly string[],
  signal?: AbortSignal,
  /** Written to the child's stdin (a `--text -` argument reads it). */
  stdin?: string,
  opts?: MuRunOpts,
) => Promise<MuResult>;

function childEnv(over: MuRunOpts["env"]): NodeJS.ProcessEnv | undefined {
  if (over === undefined) return undefined;
  const env = { ...process.env };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** The CLI this extension ships with (dist/cli.js next to dist/extension/), else `mu` on PATH. */
export function defaultRunner(): MuRunner {
  let cli: string | undefined;
  try {
    const p = fileURLToPath(new URL("../cli.js", import.meta.url));
    if (existsSync(p)) cli = p;
  } catch {
    // not a file: URL; use PATH
  }
  return (args, signal, stdin, opts) =>
    cli
      ? runChild(process.execPath, [cli, ...args], signal, stdin, opts)
      : runChild("mu", args, signal, stdin, opts);
}

/** How long an aborted mu gets to exit (a spawn rolls back its worktree; a wait prints its snapshot) before SIGKILL. */
const ABORT_GRACE_MS = 10_000;

/**
 * Run one child. The ONE terminate path: an abort sends SIGTERM and resolves
 * only once the child has EXITED, with its final stdout kept. mu rolls back on
 * SIGTERM, and a caller told "cancelled" while that runs would report a spawn
 * gone that is still removing its pane and worktree. SIGKILL follows after
 * `opts.drainMs` (default ABORT_GRACE_MS).
 */
export function runChild(
  cmd: string,
  argv: readonly string[],
  signal?: AbortSignal,
  stdin?: string,
  opts: MuRunOpts = {},
): Promise<MuResult> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const env = childEnv(opts.env);
    const child = execFile(
      cmd,
      [...argv],
      { maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const code = err ? (typeof err.code === "number" ? err.code : err.signal ? 143 : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || err?.message || "") });
      },
    );
    function onAbort(): void {
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), opts.drainMs ?? ABORT_GRACE_MS);
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    if (stdin !== undefined) {
      child.stdin?.on("error", () => {}); // the child may exit before it reads
      child.stdin?.end(stdin);
    }
  });
}

/** A `mu --json` stdout as one object: the envelope's `data` on success, its
 *  partial `data` plus `error`/`message` on failure; undefined when it is not
 *  an envelope. */
export function parseEnvelope(stdout: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(stdout) as Record<string, unknown> | null;
    if (typeof v !== "object" || v === null || typeof v.ok !== "boolean") return undefined;
    const data =
      typeof v.data === "object" && v.data !== null ? (v.data as Record<string, unknown>) : {};
    return v.ok ? data : { ...data, error: v.error, message: v.message };
  } catch {
    return undefined;
  }
}

/** A `mu --json` stdout as its `data`, only when it is a SUCCESS envelope
 *  (`ok:true`). A failure's partial data is not a success: a destructive
 *  call that acts on a read must use this, never `parseEnvelope`. */
export function parseOkEnvelope(stdout: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(stdout) as Record<string, unknown> | null;
    if (typeof v !== "object" || v === null || v.ok !== true) return undefined;
    return typeof v.data === "object" && v.data !== null
      ? (v.data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
