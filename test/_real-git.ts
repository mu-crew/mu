import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Put the macOS toolchain's Git ahead of xcrun's trampoline and any PATH wrapper.
 * Only `git` is exposed: a private dir under `scratchDir` holds one symlink, so
 * cc, python3, make and the rest still resolve through the caller's PATH.
 */
export function pinRealGit(scratchDir: string, env: NodeJS.ProcessEnv = process.env): void {
  // Elsewhere keep PATH: there is no portable way to recognize Git wrappers.
  if (process.platform !== "darwin") return;
  let real: string;
  try {
    real = execFileSync("xcrun", ["-f", "git"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return;
  }
  if (!isAbsolute(real)) return;
  let execPath: string;
  try {
    execPath = execFileSync(real, ["--exec-path"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return;
  }
  // Apple Git derives its helper prefix from the path it was invoked by, so a
  // symlink alone points at Xcode's helpers. GIT_EXEC_PATH pins the real ones.
  const bin = join(scratchDir, "git-bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(real, join(bin, "git"));
  env.GIT_EXEC_PATH = execPath;
  env.PATH = [bin, env.PATH || "/usr/bin:/bin"].join(delimiter);
}
