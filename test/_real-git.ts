import { execFileSync } from "node:child_process";
import { delimiter, dirname, isAbsolute } from "node:path";

/** Put the macOS toolchain's Git ahead of xcrun's trampoline and any PATH wrapper. */
export function pinRealGit(env: NodeJS.ProcessEnv = process.env): void {
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
  // Keep Git's installation prefix intact. Calling it through a symlink in a
  // scratch bin changes where Apple Git looks for its helpers and templates.
  // PATH reaches the SDK, CLI subprocesses and the fixtures' shell scripts.
  env.PATH = [dirname(real), env.PATH || "/usr/bin:/bin"].join(delimiter);
}
