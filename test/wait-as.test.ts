// `--as <caller>` and the live-wait marks behind its refusal (spec D9, U7): a
// verb that needs a caller outside a managed pane names it, and a wait as a
// caller another live process already waits as is refused (exit 4). Real
// SQLite in a temp dir; the one subprocess is `ps`, reading this test's parent.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { setWaitSleepForTests } from "../src/wait.js";
import { callerNameProblem } from "../src/wait-callers.js";
import { CallerBusyError, holdCallers, liveHolder, waitersDir } from "../src/wait-holders.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { runCliWire } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-as-"));
  dbPath = join(dir, "mu.db");
  // Marks live under the state dir: each test starts with none.
  process.env.MU_STATE_DIR = join(dir, "state");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  setWaitSleepForTests(async () => {});
});

afterEach(() => {
  setWaitSleepForTests(undefined);
  const key = "MU_STATE_DIR";
  delete process.env[key];
  db.close();
  rmFixtureDir(dir);
});

const callerDir = (caller: string): string =>
  join(waitersDir(), createHash("sha256").update(caller).digest("hex").slice(0, 16));

/** A mark as `holdCallers` writes it, for another process. */
function plantHolder(caller: string, pid: number, startedMs: number): string {
  mkdirSync(callerDir(caller), { recursive: true });
  const file = join(callerDir(caller), `${pid}.json`);
  writeFileSync(file, JSON.stringify({ caller, pid, startedMs }));
  return file;
}

/** `ps`'s start of a live pid, in ms, as the reader computes it. */
function startOf(pid: number): number {
  const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  return Date.parse(out.trim().replace(/\s+/g, " "));
}

/** A pid that is not running. */
function deadPid(): number {
  for (let pid = 4_000_000; pid > 3_000_000; pid -= 7919) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no free pid");
}

describe("caller names", () => {
  it.each([
    ["auth/orchestrator-1", true],
    ["pi:01abc", true],
    ["auth", false],
    ["auth/", false],
    ["a/b/c", false],
    ["Auth/Orch", false],
    ["pi:", false],
    ["pi: x", false],
  ])("%s → %s", (raw, ok) => {
    expect(callerNameProblem(raw) === undefined).toBe(ok);
  });
});

describe("live wait marks", () => {
  it("a wait marks each of its callers until released; its own mark never refuses it", () => {
    const release = holdCallers(["auth/orch", "pi:s1"]);
    expect(readdirSync(callerDir("auth/orch"))).toEqual([`${process.pid}.json`]);
    expect(readdirSync(callerDir("pi:s1"))).toEqual([`${process.pid}.json`]);
    expect(liveHolder("auth/orch")).toBeUndefined();
    // Another process reading sees this one.
    expect(liveHolder("auth/orch", { self: -1, startOf: () => null })?.pid).toBe(process.pid);
    release();
    release();
    expect(readdirSync(callerDir("auth/orch"))).toEqual([]);
  });

  it("a live other process holds; a dead or reused pid does not, and its mark is pruned", () => {
    const parent = process.ppid;
    plantHolder("auth/orch", parent, startOf(parent));
    expect(liveHolder("auth/orch")?.pid).toBe(parent);

    const dead = plantHolder("auth/w1", deadPid(), Date.now());
    expect(liveHolder("auth/w1")).toBeUndefined();
    expect(readdirSync(callerDir("auth/w1"))).not.toContain(dead.split("/").at(-1));

    // The parent's pid with another start time: a later process took the pid.
    plantHolder("auth/w2", parent, startOf(parent) - 3_600_000);
    expect(liveHolder("auth/w2")).toBeUndefined();
    expect(readdirSync(callerDir("auth/w2"))).toEqual([]);
  });
});

describe("an --as hold marks first, then checks", () => {
  it("refused: another live holder is named, and this process's own mark is gone", () => {
    const parent = process.ppid;
    plantHolder("auth/orch", parent, startOf(parent));
    let caught: unknown;
    try {
      holdCallers(["auth/orch"], { refuse: ["auth/orch"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CallerBusyError);
    expect((caught as CallerBusyError).pid).toBe(parent);
    expect(readdirSync(callerDir("auth/orch"))).toEqual([`${parent}.json`]);
  });

  it("two racers see each other's marks: the second refuses, though the first had checked", () => {
    // The first --as wait has marked and checked (nobody else held then).
    const first = holdCallers(["auth/orch"], { refuse: ["auth/orch"] });
    // A second process marks before the first's check could see it: its own check sees the first.
    const theirs = plantHolder("auth/orch", process.ppid, startOf(process.ppid));
    expect(liveHolder("auth/orch")?.pid).toBe(process.ppid);
    expect(() => holdCallers(["auth/orch"], { refuse: ["auth/orch"] })).toThrow(CallerBusyError);
    first();
    expect(readdirSync(callerDir("auth/orch"))).toEqual([theirs.split("/").at(-1)]);
  });

  it("a free caller is held and released", () => {
    const release = holdCallers(["auth/free"], { refuse: ["auth/free"] });
    expect(readdirSync(callerDir("auth/free"))).toEqual([`${process.pid}.json`]);
    release();
    expect(readdirSync(callerDir("auth/free"))).toEqual([]);
  });
});

describe("a real wait marks its callers while it runs", () => {
  it("mu wait as a managed caller holds auth/orch during the wait, and not after", async () => {
    addTask(db, { localId: "t1", workstream: "auth", title: "t1", impact: 50, effortDays: 1 });
    const seen: (number | undefined)[] = [];
    setWaitSleepForTests(async () => {
      // Read as another process would (self -1): the wait's own mark.
      if (seen.length === 0)
        seen.push(liveHolder("auth/orch", { self: -1, startOf: () => null })?.pid);
    });
    await withEnv("MU_MANAGED_AGENT", "1", () =>
      withEnv("MU_WORKSTREAM", "auth", () =>
        withEnv("MU_AGENT_NAME", "orch", async () => {
          const r = await runCliWire(
            ["wait", "task:t1", "-w", "auth", "--timeout", "0.05", "--json"],
            dbPath,
          );
          expect(r.exitCode, r.stdout + r.stderr).not.toBe(2);
        }),
      ),
    );
    expect(seen).toEqual([process.pid]);
    expect(readdirSync(callerDir("auth/orch"))).toEqual([]);
  });
});

describe("--as on the verbs", () => {
  it("mu wait --as is refused (exit 4) while another live process waits as that caller", async () => {
    plantHolder("auth/orch", process.ppid, startOf(process.ppid));
    const r = await runCliWire(
      ["wait", "--as", "auth/orch", "--timeout", "0.05", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(4);
    const doc = JSON.parse(r.stdout) as { error: string; message: string };
    expect(doc.error).toBe("CallerBusyError");
    expect(doc.message).toContain(String(process.ppid));
    // Another caller is free.
    const other = await runCliWire(
      ["wait", "--as", "auth/w9", "--timeout", "0.05", "--json"],
      dbPath,
    );
    expect(other.exitCode).not.toBe(4);
  });

  it("mu wait --as checks the name, and is no flag for --resume", async () => {
    const bad = await runCliWire(["wait", "--as", "nobody", "--json"], dbPath);
    expect(bad.exitCode).toBe(2);
    expect(JSON.parse(bad.stdout).message).toContain("<workstream>/<agent> or pi:<session>");
    const resume = await runCliWire(
      ["wait", "--resume", "r1", "--as", "auth/orch", "--json"],
      dbPath,
    );
    expect(resume.exitCode).toBe(2);
    expect(JSON.parse(resume.stdout).message).toContain("--as");
  });

  it("mu next --as: a hold waits, so it is refused; a plain pass is not", async () => {
    plantHolder("auth/orch", process.ppid, startOf(process.ppid));
    const held = await runCliWire(
      ["next", "-w", "auth", "--as", "auth/orch", "--hold", "--json"],
      dbPath,
    );
    expect(held.exitCode).toBe(4);
    const dry = await runCliWire(
      ["next", "-w", "auth", "--as", "auth/orch", "--dry", "--json"],
      dbPath,
    );
    expect(dry.exitCode).toBeNull();
  });

  it("mu state --as reads that caller, and refuses --me beside it", async () => {
    await withEnv("PI_SESSION_ID", undefined, async () => {
      const r = await runCliWire(["state", "-w", "auth", "--as", "pi:s1"], dbPath);
      expect(r.exitCode).toBeNull();
      expect(JSON.parse(r.stdout).data.caller).toBe("pi:s1");
      const both = await runCliWire(["state", "--me", "--as", "pi:s1"], dbPath);
      expect(both.exitCode).toBe(2);
    });
  });
});
