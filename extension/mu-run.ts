/**
 * Running `mu` from the pi extensions: the runner seam (tests inject a fake)
 * and the reading of its one `--json` envelope. Pure plumbing, shared by the
 * delegate tools and the nudges.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type MuResult = { code: number; stdout: string; stderr: string };
/** Runs `mu <args>`. The test seam: tests inject a fake. */
export type MuRunner = (
  args: readonly string[],
  signal?: AbortSignal,
  /** Written to the child's stdin (a `--text -` argument reads it). */
  stdin?: string,
) => Promise<MuResult>;

/** The CLI this extension ships with (dist/cli.js next to dist/extension/), else `mu` on PATH. */
export function defaultRunner(): MuRunner {
  let cli: string | undefined;
  try {
    const p = fileURLToPath(new URL("../cli.js", import.meta.url));
    if (existsSync(p)) cli = p;
  } catch {
    // not a file: URL; use PATH
  }
  return (args, signal, stdin) =>
    new Promise((resolve) => {
      const [cmd, argv] = cli ? [process.execPath, [cli, ...args]] : ["mu", [...args]];
      const child = execFile(
        cmd,
        argv,
        { maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr || err?.message || "") });
        },
      );
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
