// `--as` against real waits (integration tier: the built dist/cli.js; spec D9,
// U7). A wait marks its caller in its own process, so only a second process
// shows the refusal: a live `mu wait` holding a caller refuses `mu wait --as`
// and `mu next --hold --as` (exit 4), its mark goes when it ends, and two
// `--as` waits started together never both run.
//
// Needs dist/ (npm run build). DB-only: no mux opens.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const built = existsSync(CLI);

let dir: string;
let dbPath: string;
const kids: ChildProcess[] = [];

function start(args: string[]) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) {
    if (k.startsWith("MU_") || k === "PI_SESSION_ID" || k === "TMUX" || k === "TMUX_PANE")
      delete e[k];
  }
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...e, MU_DB_PATH: dbPath, MU_STATE_DIR: dir, MU_SYNC_DIR: "" },
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
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

const until = async (cond: () => boolean, tries = 100): Promise<void> => {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
};

/** The marks of live waits for `caller`: `<state dir>/waiters/<hash>/<pid>.json`. */
function marks(caller: string): string[] {
  const hash = createHash("sha256").update(caller).digest("hex").slice(0, 16);
  try {
    return readdirSync(join(dir, "waiters", hash));
  } catch {
    return [];
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-as-int-"));
  dbPath = join(dir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  addTask(db, { localId: "t1", workstream: "auth", title: "t1", impact: 50, effortDays: 1 });
  db.close();
});
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe.skipIf(!built)("--as against a live wait in another process", () => {
  it("a running mu wait refuses wait --as and next --hold --as, and frees the caller when it ends", async () => {
    const holder = start(["wait", "task:t1", "-w", "auth", "--as", "auth/orch", "--timeout", "30"]);
    await until(() => marks("auth/orch").length > 0);
    expect(marks("auth/orch")).toEqual([`${holder.child.pid}.json`]);

    const wait = await start(["wait", "--as", "auth/orch", "--timeout", "0.05", "--json"]).done;
    expect(wait.code, wait.stderr).toBe(4);
    const doc = JSON.parse(wait.stdout) as { error: string; message: string };
    expect(doc.error).toBe("CallerBusyError");
    expect(doc.message).toContain(String(holder.child.pid));
    const next = await start(["next", "-w", "auth", "--as", "auth/orch", "--hold", "--json"]).done;
    expect(next.code, next.stderr).toBe(4);
    // The refused processes left no mark of their own.
    expect(marks("auth/orch")).toEqual([`${holder.child.pid}.json`]);

    holder.child.kill("SIGTERM");
    await holder.done;
    expect(marks("auth/orch")).toEqual([]);
    const free = await start(["wait", "--as", "auth/orch", "--timeout", "0.05", "--json"]).done;
    expect(free.code).not.toBe(4);
  });

  it("two --as waits started together never both run", async () => {
    const args = ["wait", "task:t1", "-w", "auth", "--as", "auth/orch", "--timeout", "1", "--json"];
    const [a, b] = await Promise.all([start(args).done, start(args).done]);
    expect([a.code, b.code]).toContain(4);
  });
});
