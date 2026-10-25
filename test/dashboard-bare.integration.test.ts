// Bare `mu` end to end against the built bin (needs dist/): on a real PTY it
// opens the dashboard and q / Esc exit 0 with the final sync flush done; with
// no TTY or with --json it prints the same help as before. Importing the UI
// chunk is also the no-import-cycle gate (a cycle exits silently).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const BIN = resolve("dist/cli.js");
const havePython = spawnSync("python3", ["--version"]).status === 0;

// Run the bin on a PTY, wait for `until` on the screen, send `keys`, report the exit.
const PTY_DRIVER = `
import os, pty, select, sys, time, json
bin_, until, keys = sys.argv[1], sys.argv[2].encode(), sys.argv[3].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", bin_])
buf, sent, deadline = b"", False, time.time() + 15
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.05)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
    if not sent and until in buf:
        os.write(fd, keys); sent = True
try:
    _, status = os.waitpid(pid, 0)
except ChildProcessError:
    status = 0
print(json.dumps({"sent": sent, "code": os.waitstatus_to_exitcode(status), "out": buf.decode("utf8", "replace")}))
`;

interface PtyRun {
  sent: boolean;
  code: number;
  out: string;
}

describe("bare mu", () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-dash-bare-"));
    env = {
      ...process.env,
      MU_DB_PATH: join(tmp, "mu.db"),
      MU_STATE_DIR: join(tmp, "state"),
      MU_SYNC_DIR: "",
      TERM: "xterm-256color",
    };
    for (const k of ["TMUX", "TMUX_PANE", "HERDR_ENV", "MU_WORKSTREAM"]) delete env[k];
  });
  afterEach(() => rmFixtureDir(tmp));

  const pty = (): PtyRun => {
    const r = spawnSync("python3", ["-c", PTY_DRIVER, BIN, "q/Esc quit", pty.keys], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    return JSON.parse(r.stdout) as PtyRun;
  };
  pty.keys = "q";

  it.skipIf(!havePython || !existsSync(BIN))("opens on a PTY, q exits 0", () => {
    pty.keys = "q";
    const run = pty();
    expect(run.out).toContain("mu dashboard");
    expect(run.sent).toBe(true);
    expect(run.code).toBe(0);
  });

  it.skipIf(!havePython || !existsSync(BIN))(
    "Esc exits 0 and the exit flushes this machine's ops to MU_SYNC_DIR",
    () => {
      const shared = join(tmp, "shared");
      mkdirSync(shared);
      const db = openDb({ path: env.MU_DB_PATH as string });
      ensureWorkstream(db, "demo");
      addTask(db, { workstream: "demo", localId: "t1", title: "t1", impact: 50, effortDays: 1 });
      db.close();
      env.MU_SYNC_DIR = shared;
      expect(readdirSync(shared)).toEqual([]);
      pty.keys = "\u001b";
      const run = pty();
      expect(run.out).toContain("mu dashboard");
      expect(run.code).toBe(0);
      expect(readdirSync(shared).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
    },
  );

  it.skipIf(!existsSync(BIN))("without a TTY, and with --json, it prints help", () => {
    const plain = spawnSync("node", [BIN], { env, encoding: "utf8", input: "" });
    const json = spawnSync("node", [BIN, "--json"], { env, encoding: "utf8", input: "" });
    const help = spawnSync("node", [BIN, "--help"], { env, encoding: "utf8" });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain("Usage: mu");
    expect(plain.stdout).toBe(help.stdout);
    expect(json.stdout).toBe(help.stdout);
  });

  // The SDK index and the bin's static graph must not reach ink/react: the UI is
  // one lazily imported chunk (a static edge would tax every verb and the SDK).
  it.skipIf(!existsSync(BIN))("ink and react are reachable only through a dynamic import", () => {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/from\s+["'](ink|react)(\/[^"']*)?["']/);
      for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["'](\.\/[^"']+)["']/gm)) {
        walk(resolve(dirname(file), m[1] as string));
      }
    };
    walk(resolve("dist/index.js"));
    walk(BIN);
    expect([...seen].length).toBeGreaterThan(2);
  });
});
