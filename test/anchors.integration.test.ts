// The anchor wrapper under a real /bin/sh (spec D3): it writes
// `<dir>/<pid>.json` for its own pid, with a start time murmur's reader
// accepts, and then runs the command in that same process. The command prints
// its own pid and `ps` start, so the check is the one murmur makes.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AnchorRecord,
  anchorDir,
  anchorDirs,
  anchorWrapper,
  pruneAnchors,
} from "../src/anchors.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-anchor-"));
});
afterEach(() => {
  rmFixtureDir(dir);
});

const anchor: AnchorRecord = {
  agent_name: "worker-1",
  workstream: "auth",
  role: "worker",
  cli: "claude",
  orchestrator: false,
  remote_key: null,
};

/** Run the pane command the way tmux does: through a shell's -c. */
function runPane(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** murmur's parse of one `lstart` (src/process-chain.ts): seconds since the epoch. */
const murmurStart = (lstart: string): number => Math.floor(Date.parse(lstart.trim()) / 1000);

describe("anchorWrapper", () => {
  it("writes the anchor for the pid that then runs the command, with a start time murmur matches", () => {
    const anchors = join(dir, "state", "anchors");
    const out = runPane(
      anchorWrapper(`echo "$$"; LC_ALL=C ps -o lstart= -p "$$"`, anchor, [anchors]),
    );
    const [pid, lstart = ""] = out.trim().split("\n");
    const record = JSON.parse(readFileSync(join(anchors, `${pid}.json`), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({ ...anchor });
    expect(typeof record.start_time).toBe("number");
    expect(Math.abs((record.start_time as number) - murmurStart(lstart))).toBeLessThanOrEqual(1);
    expect(readdirSync(anchors)).toEqual([`${pid}.json`]);
  });

  it("quotes the command as one word and passes its exit through", () => {
    const anchors = join(dir, "anchors");
    expect(runPane(anchorWrapper(`printf '%s\\n' "it's" 'a b'`, anchor, [anchors]))).toBe(
      "it's\na b\n",
    );
    const r = spawnSync("/bin/sh", ["-c", anchorWrapper("exit 7", anchor, [anchors])]);
    expect(r.status).toBe(7);
  });

  it("an unwritable anchor dir never stops the launch", () => {
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "");
    expect(runPane(anchorWrapper("echo started", anchor, [join(file, "anchors")]))).toBe(
      "started\n",
    );
  });

  it("pruneAnchors removes dead pids' anchors and keeps live ones", () => {
    const anchors = join(dir, "anchors");
    mkdirSync(anchors);
    writeFileSync(join(anchors, `${process.pid}.json`), "{}");
    const out = runPane(anchorWrapper('echo "$$"', anchor, [anchors]));
    const dead = out.trim();
    expect(readdirSync(anchors).sort()).toEqual([`${dead}.json`, `${process.pid}.json`].sort());
    pruneAnchors([anchors]);
    expect(readdirSync(anchors)).toEqual([`${process.pid}.json`]);
  });

  it("writes the same anchor into every dir it is given", () => {
    const a = join(dir, "home", "anchors");
    const b = join(dir, "xdg", "anchors");
    const pid = runPane(anchorWrapper('echo "$$"', anchor, [a, b])).trim();
    expect(readFileSync(join(a, `${pid}.json`), "utf8")).toBe(
      readFileSync(join(b, `${pid}.json`), "utf8"),
    );
  });

  it("runs the command in $SHELL, the shell it ran in unwrapped, else /bin/sh", () => {
    const anchors = join(dir, "anchors");
    const shell = join(dir, "my-shell");
    writeFileSync(shell, '#!/bin/sh\necho "via my-shell"\nexec /bin/sh "$@"\n');
    chmodSync(shell, 0o755);
    const command = anchorWrapper("echo ran", anchor, [anchors]);
    expect(runPane(command, { ...process.env, SHELL: shell })).toBe("via my-shell\nran\n");
    const { SHELL: _, ...noShell } = process.env;
    expect(runPane(command, noShell)).toBe("ran\n");
  });

  it("anchors live under the home dir; a set XDG_STATE_HOME adds its own dir", async () => {
    const home = join(homedir(), ".local", "state", "mu-next", "anchors");
    expect(anchorDir()).toBe(home);
    await withEnv("XDG_STATE_HOME", undefined, async () => {
      expect(anchorDirs()).toEqual([home]);
    });
    await withEnv("XDG_STATE_HOME", join(dir, "xdg"), async () => {
      expect(anchorDir()).toBe(home);
      expect(anchorDirs()).toEqual([home, join(dir, "xdg", "mu-next", "anchors")]);
    });
  });
});
