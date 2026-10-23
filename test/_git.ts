import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Make `dir` a git repo with one commit (README), so `--workspace` and
 *  `createWorkspace` have a project root to branch from. */
export function initGitRepo(dir: string): void {
  writeFileSync(join(dir, "README"), "hello\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}
