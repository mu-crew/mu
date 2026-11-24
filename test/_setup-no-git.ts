// Fast tier only: a test that starts `git` fails.
//
// A `git` shim is first on PATH. It appends its argv and cwd to this fork's
// log and exits 127. Every launch that resolves `git` through PATH reaches it:
// execa, execFile, a shell line, a generated driver script, a mu subprocess, a
// helper module. A source scan sees only what it can parse (an aliased
// command, a helper, `sh -c "git ..."` slip past it). The log path is written
// into the shim, not passed by env: a child with its own env (the eval
// drivers) still records. After each test and file the log is read, and a hit
// fails that test with the argv. Move the test to `*.integration.test.ts`, or
// stub the VCS.
//
// Not seen: an absolute `/usr/bin/git`, and a test that replaces PATH
// wholesale. Nothing in src does either. The `pure` project does not load
// this: its allowlist (vitest.config.ts) is files that start no process.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach } from "vitest";

// Under the per-fork scratch dir that _setup.ts made, so teardown removes it.
const bin = join(tmpdir(), "no-git-bin");
const log = join(bin, "calls.log");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
mkdirSync(bin, { recursive: true });
rmSync(log, { force: true });
writeFileSync(
  join(bin, "git"),
  `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> ${quote(log)}\necho "git: not available in the fast tier (test/_setup-no-git.ts)" >&2\nexit 127\n`,
);
chmodSync(join(bin, "git"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;

function assertNoGit(): void {
  let calls: string;
  try {
    calls = readFileSync(log, "utf8");
  } catch {
    return;
  }
  rmSync(log, { force: true });
  throw new Error(
    `a fast-tier test started git (move it to *.integration.test.ts, or stub the VCS):\n${calls}`,
  );
}

afterEach(assertNoGit);
afterAll(assertNoGit);
