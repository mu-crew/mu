// A root probe that fails indeterminately (spawn error, signal) reads as
// "not this VCS", so a fallback backend found during that detection is not
// proof of a stable backend. The TUI's cached detection must skip it and
// re-detect, or a transient `jj root` failure in a colocated jj/git repo
// pins git for the TUI's lifetime. A clean "not this VCS" (the tool's own
// not-a-repo message, or the tool missing) is a real answer and stays
// cached; a non-zero exit for any other reason (e.g. a jj config error)
// is not.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  loadWorkstreamSnapshotSlow,
  resetRecentCommitsBackendCacheForTests,
} from "../src/state.js";

type Outcome = { stdout: string } | { fail: Error & { code?: unknown } };
const script = vi.hoisted(() => ({
  calls: [] as string[],
  jjRoot: [] as unknown[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = (() => {}) as unknown as typeof actual.execFile;
  const custom = async (bin: string, args: string[]) => {
    const key = `${bin} ${args[0] ?? ""}`;
    script.calls.push(key);
    const out = respond(bin, args);
    if ("fail" in out) throw out.fail;
    return { stdout: out.stdout, stderr: "" };
  };
  Object.defineProperty(execFile, promisify.custom, { value: custom });
  return { ...actual, execFile };
});

function respond(bin: string, args: string[]): Outcome {
  const fail = (code: unknown): Outcome => ({
    fail: Object.assign(new Error(`${bin} failed`), {
      code,
      stderr: "abort: '/repo' is not inside a repository",
    }),
  });
  if (bin === "jj" && args[0] === "root") {
    const next = script.jjRoot.shift();
    return next === undefined ? { stdout: "/repo" } : (next as Outcome);
  }
  if (bin === "jj") return { stdout: "" }; // jj log
  if (bin === "sl") return fail(1);
  if (bin === "git" && args[0] === "rev-parse") return { stdout: "/repo" };
  if (bin === "git") return { stdout: "" }; // git log
  return fail("ENOENT");
}

vi.mock("../src/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents.js")>();
  return {
    ...actual,
    listLiveAgents: vi.fn(async () => ({
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, orphans: [], report: null, mode: "full" },
    })),
  };
});

let db: Db | undefined;
beforeEach(() => {
  script.calls.length = 0;
  script.jjRoot.length = 0;
  resetRecentCommitsBackendCacheForTests();
  db = openDb({ path: join(mkdtempSync(join(tmpdir(), "mu-probe-failure-")), "mu.db") });
});
afterEach(() => {
  db?.close();
  db = undefined;
});

const opts = { withRecentCommits: { limit: 3 } };
const err = (code: unknown, stderr = ""): Outcome => ({
  fail: Object.assign(new Error("jj root failed"), { code, stderr }),
});
const notARepo = (): Outcome => err(1, 'Error: There is no jj repo in "."');
const tick = async () => {
  if (db === undefined) throw new Error("no db");
  return (await loadWorkstreamSnapshotSlow(db, "ws", opts)).commitsBackend;
};

describe("recent-commits backend cache vs failed root probes", () => {
  it("does not cache a fallback chosen while jj root failed; uses jj once it recovers", async () => {
    script.jjRoot.push(err("EAGAIN")); // first tick only; later ticks succeed

    expect(await tick()).toBe("git"); // fallback while jj probe failed
    expect(await tick()).toBe("jj"); // re-detected, jj wins by precedence
    const probesBefore = script.calls.filter((c) => c === "jj root").length;
    expect(await tick()).toBe("jj");
    expect(script.calls.filter((c) => c === "jj root")).toHaveLength(probesBefore); // now cached
  });

  it("does not cache a fallback when jj root exits 1 for a config error", async () => {
    // Real jj exits 1 on a TOML config error too; that is not "no jj repo".
    script.jjRoot.push(err(1, "Config error: Configuration cannot be parsed as TOML document"));

    expect(await tick()).toBe("git");
    expect(await tick()).toBe("jj"); // config fixed: jj re-detected
  });

  it("still caches a fallback when jj root cleanly says not-a-repo", async () => {
    script.jjRoot.push(notARepo(), err("ENOENT"), notARepo());

    expect(await tick()).toBe("git");
    expect(await tick()).toBe("git");
    expect(await tick()).toBe("git");
    expect(script.calls.filter((c) => c === "jj root")).toHaveLength(1);
  });
});
