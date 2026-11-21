// The real git binary for the run, put first on PATH once in globalSetup.
//
// On a managed Mac the first `git` on PATH can be a wrapper (Meta's starts
// scm_telem_log, which runs `route` and more on every call) and /usr/bin/git
// is xcrun's trampoline; behind endpoint-security agents each of those extra
// execs costs 14 ms to 1 s. The suite calls git thousands of times (test
// helpers, mu's own src/vcs/git.ts, the shell scripts of the remote-worktree
// and fake-plugin paths), all by name through PATH, so one directory holding
// only a `git` symlink, prepended to PATH, reaches every one of them without
// shadowing anything else in the toolchain directory (python3, make, clang).
//
// darwin: `xcrun -f git`. Elsewhere PATH is left alone: there is no portable
// test for "is a wrapper", and Linux CI has none.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** The real git on darwin (`xcrun -f git`), else undefined. */
export function resolveRealGit(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "darwin") return undefined;
  try {
    const out = execFileSync("xcrun", ["-f", "git"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return isAbsolute(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prepend a dir holding only `git -> <real>` to `env.PATH`; returns the dir
 * (the caller removes it) or undefined when there is no real git to pin. The
 * dir name starts `mu-test-run-<pid36>-` so sweepStaleRuns reaps it after a
 * killed run.
 */
export function pinRealGit(
  env: NodeJS.ProcessEnv = process.env,
  real: string | undefined = resolveRealGit(),
): string | undefined {
  if (real === undefined) return undefined;
  const dir = mkdtempSync(join(tmpdir(), `mu-test-run-${process.pid.toString(36)}-git-`));
  try {
    symlinkSync(real, join(dir, "git"));
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  env.PATH = env.PATH ? `${dir}${delimiter}${env.PATH}` : dir;
  return dir;
}
