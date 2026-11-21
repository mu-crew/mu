// `mu host exec` through the built CLI (spec A §6): what the in-process tests cannot see.
// Arguments after `--` are the remote command's, never mu's flags, and a nonzero exit keeps
// the whole of a command's piped stderr. Needs `dist/` (`npm run build`).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addHost } from "../src/hosts.js";
import { rmFixtureDir } from "./_fs.js";

const CLI = join(process.cwd(), "dist", "cli.js");
const describeIfBuilt = existsSync(CLI) ? describe : describe.skip;

describeIfBuilt("mu host exec (built CLI)", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mhx-"));
    const dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    addHost(db, {
      name: "box",
      shell: "true",
      exec: "/bin/sh -c {cmd}",
      fetch: "true",
      repo: null,
      max_sessions: null,
    });
    db.close();
    env = {
      ...process.env,
      MU_DB_PATH: dbPath,
      MU_STATE_DIR: join(dir, "state"),
      MU_SYNC_DIR: "",
      MURMUR_STATE_DIR: join(dir, "murmur"),
    };
  });
  afterEach(() => rmFixtureDir(dir));

  const mu = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

  it.each(["--json", "--json=pretty"])(
    "%s after `--` is the remote command's, not mu's",
    (flag) => {
      const r = mu("host", "exec", "box", "--", "echo", flag);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${flag}\n`);
    },
  );

  it("--json before `--` is still mu's", () => {
    const r = mu("host", "exec", "box", "--json", "--", "echo", "hi");
    expect(JSON.parse(r.stdout)).toMatchObject({ data: { exit: 0, stdout: "hi" } });
  });

  it("an error after `--json`-looking words renders as prose, not a mu document", () => {
    const r = mu("host", "exec", "nope", "--", "echo", "--json");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/nope/);
  });

  it("a nonzero exit keeps all of a command's piped stderr", () => {
    const r = mu("host", "exec", "box", "--", "head -c 500000 /dev/zero | tr '\\0' e >&2; exit 7");
    expect(r.status).toBe(7);
    expect(r.stderr.length).toBeGreaterThanOrEqual(500_000);
  });
});
