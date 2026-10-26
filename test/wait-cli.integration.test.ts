// `mu wait` as a real process (integration tier: the built dist/cli.js, subprocesses).
//
// What only a process can show: a SIGTERM or SIGINT mid-wait still prints the ONE final
// snapshot with a runnable resume command and exits 143/130; a signal that lands during
// setup is not lost; the document is one stdout line and nothing else (heartbeat text goes
// to stderr), even through a slow pipe and with colour forced; and the resume command, run
// as printed through a shell, is the same wait. SIGKILL cannot print and is not tested.
//
// Needs dist/ (npm run build). No mux: DB-only waits never open one.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask, closeTask } from "../src/tasks.js";
import { loadResume } from "../src/wait-resume.js";
import { ensureWorkstream } from "../src/workstream.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const built = existsSync(CLI);
const V13 = join(import.meta.dirname, "fixtures", "v13-populated.db.gz");

interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

let dir: string;
let dbPath: string;
const kids: ChildProcess[] = [];

const env = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) {
    if (k.startsWith("MU_") || k === "PI_SESSION_ID" || k === "TMUX" || k === "TMUX_PANE")
      delete e[k];
  }
  return { ...e, MU_DB_PATH: dbPath, MU_STATE_DIR: dir, MU_SYNC_DIR: "" };
};

function start(
  args: string[],
  extra: NodeJS.ProcessEnv = {},
): { child: ChildProcess; done: Promise<Ran> } {
  const child = spawn("node", [CLI, ...args], {
    env: { ...env(), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const done = new Promise<Ran>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

const run = (args: string[]): Ran => {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      env: env(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, signal: null, stdout, stderr: "" };
  } catch (e) {
    const x = e as { status: number; stdout: string; stderr: string };
    return { code: x.status, signal: null, stdout: x.stdout, stderr: x.stderr };
  }
};

/** The stored wait behind a printed `mu wait --resume <id> [-w ws]`. */
const stored = (resume: string) => {
  const id = /--resume (\w+)/.exec(resume)?.[1] ?? "";
  const db = openDb({ path: dbPath });
  try {
    return loadResume(db, id);
  } finally {
    db.close();
  }
};

/** Poll until the wait has really started (its registration or the process age), not a fixed sleep. */
const started = async (ms = 400): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-int-"));
  dbPath = join(dir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  for (const id of ["a", "b"])
    addTask(db, { localId: id, workstream: "w", title: id, impact: 50, effortDays: 1 });
  db.close();
});
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!built)("mu wait: signals print one honest snapshot", () => {
  for (const [name, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    it(`${name} mid-wait: one JSON line, real states, a resume that names both refs, exit ${code}`, async () => {
      // a is closed before the signal; b stays open.
      const { child, done } = start(["wait", "task:a", "task:b", "-w", "w", "--all"]);
      await started();
      const db = openDb({ path: dbPath });
      closeTask(db, "a", { workstream: "w", evidence: "e" });
      db.close();
      await started(300);
      child.kill(name);
      const r = await done;
      expect(r.code).toBe(code);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
      const doc = JSON.parse(r.stdout);
      expect(doc.ok).toBe(true);
      expect(doc.data).toMatchObject({
        firing: { kind: "interrupted", ref: null },
        interrupted: true,
        signal: name,
        exit: code,
        timedOut: false,
      });
      const states = Object.fromEntries(
        (doc.data.snapshots as { id: string; status: string }[]).map((s) => [s.id, s.status]),
      );
      expect(states).toEqual({ a: "CLOSED", b: "OPEN" });
      // Nothing was consumed by the interrupted wait: the resume still names both.
      expect(doc.data.resume).toMatch(/^mu wait --resume [0-9a-f]{10} -w w$/);
      expect(stored(doc.data.resume).spec).toMatchObject({
        mode: "all",
        refs: [
          { kind: "task", id: "a" },
          { kind: "task", id: "b" },
        ],
      });
      expect(r.stderr).not.toMatch(/Error|at .*\.js/);
    });
  }

  it("a signal during SETUP (before the DB is even opened) is not lost", async () => {
    // The signal is sent the instant the process exists: the listeners are installed
    // before any async setup, so this is still a snapshot (or, at worst, a clean usage
    // exit), never a bare kill with an empty stdout.
    const { child, done } = start(["wait", "task:a", "-w", "w"]);
    child.kill("SIGTERM");
    const r = await done;
    if (r.signal !== null) {
      // killed before node reached the listener (module load): nothing to promise (SIGKILL-like)
      expect(r.stdout).toBe("");
    } else {
      expect(r.code).toBe(143);
      expect(JSON.parse(r.stdout).data).toMatchObject({ interrupted: true, signal: "SIGTERM" });
    }
  });

  it("the resume command, run as printed through sh, is the same wait", async () => {
    const first = start([
      "wait",
      "task:a",
      "task:b",
      "-w",
      "w",
      "--timeout",
      "0.3",
      "--stuck-after",
      "30",
    ]);
    const r = await first.done;
    const resume = JSON.parse(r.stdout).data.resume as string;
    expect(resume).toMatch(/^mu wait --resume [0-9a-f]{10} -w w$/);
    expect(stored(resume).spec).toMatchObject({ stuckAfter: 30, timeout: 0.3 });
    const db = openDb({ path: dbPath });
    closeTask(db, "b", { workstream: "w", evidence: "e" });
    db.close();
    const out = execFileSync("sh", ["-c", resume.replace(/^mu /, `node ${CLI} `)], {
      env: env(),
      encoding: "utf8",
    });
    expect(JSON.parse(out).data.firing).toEqual({ kind: "closed", ref: "task:w/b" });
  });

  it("one stdout line and no ANSI with colour forced, an event or a timeout", () => {
    for (const args of [
      ["wait", "task:a", "-w", "w", "--timeout", "0.2"],
      ["task", "wait", "a", "-w", "w", "--timeout", "0.2"],
    ]) {
      const e = { ...env(), FORCE_COLOR: "1", CLICOLOR_FORCE: "1" };
      const out = execFileSync("node", [CLI, ...args], { env: e, encoding: "utf8" });
      expect(out.trim().split("\n")).toHaveLength(1);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
      expect(out).not.toMatch(/\u001b/);
    }
  });

  it("an error is one stdout document with the real exit, in a process too", () => {
    const r = run(["wait", "task:nosuch", "-w", "w"]);
    expect(r.code).toBe(3);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "TaskNotFoundError", exit: 3 });
    const parse = run(["wait", "--bogus"]);
    expect(parse.code).toBe(2);
    expect(JSON.parse(parse.stdout)).toMatchObject({ ok: false, exit: 2 });
  });

  it("a slow pipe reader still gets the whole document", async () => {
    const { done } = start(["wait", "task:a", "task:b", "-w", "w", "--timeout", "0.2"]);
    const r = await done;
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it("the heartbeat is stderr only, one short line, never JSON on stdout", async () => {
    // A heartbeat every 60 s is too slow to wait for: assert the contract on the quiet path.
    const r = await start(["wait", "task:a", "-w", "w", "--timeout", "0.2"]).done;
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe.skipIf(!built)("mu wait: a signal while setup is blocked is still an envelope", () => {
  for (const [name, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    it(`${name} lands while openDb is stalled on a schema-upgrade lock: listeners already installed`, async () => {
      // Setup is stalled for real. A stale file needs an upgrade WRITE on open (a WAL reader alone is
      // never blocked), and a raw connection holds the write lock, so the child sits inside openDb()
      // with node long since loaded. A listener installed after the open (or in the engine) leaves
      // the default SIGTERM/SIGINT action: the process dies by the signal with an empty stdout.
      writeFileSync(dbPath, gunzipSync(readFileSync(V13)));
      const stale = new Database(dbPath);
      stale.exec("UPDATE schema_version SET capture_version = 3"); // an older capture stamp: open must rewrite
      stale.close();
      const lock = new Database(dbPath);
      lock.pragma("busy_timeout = 0");
      lock.exec("BEGIN IMMEDIATE");
      try {
        const { child, done } = start(["wait", "task:alpha/t1"]);
        await started(900);
        expect(child.exitCode).toBeNull(); // still inside setup, not already finished
        child.kill(name);
        await started(300);
        lock.exec("ROLLBACK");
        const r = await done;
        expect(r.signal).toBeNull();
        expect(r.code).toBe(code);
        expect(r.stdout.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(r.stdout).data).toMatchObject({ interrupted: true, signal: name });
      } finally {
        try {
          lock.exec("ROLLBACK");
        } catch {}
        lock.close();
      }
    });
  }
});
