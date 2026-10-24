import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Make `dir` a git repo with one commit (README), so `--worktree` has a project root to branch from. */
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

/** Run git in `dir` with a fixed identity; stdout trimmed. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Write `file` in `dir` and commit it; returns the new HEAD. */
export function commitFileIn(dir: string, file: string, subject: string): string {
  writeFileSync(join(dir, file), `${subject}\n`);
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", subject);
  return gitIn(dir, "rev-parse", "HEAD");
}
