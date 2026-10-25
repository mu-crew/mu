import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Make `dir` a git repo with one commit (README), so `--worktree` has a project root to branch from. */
export function initGitRepo(dir: string, opts: { refFormat?: "files" | "reftable" } = {}): void {
  writeFileSync(join(dir, "README"), "hello\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  git(
    "init",
    "-q",
    "-b",
    "main",
    ...(opts.refFormat === undefined ? [] : [`--ref-format=${opts.refFormat}`]),
  );
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

/** Whether the installed git can make a reftable repo (git >= 2.45). */
export function gitSupportsReftable(): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(
    execFileSync("git", ["--version"], { encoding: "utf8" }),
  );
  if (m?.[1] === undefined || m[2] === undefined) return false;
  return Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 45);
}
