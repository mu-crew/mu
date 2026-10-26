// `claim --and-wait` as a real process (integration tier: the built dist/cli.js).
//
// What only a process shows: a SIGTERM while the entered wait is running prints the ONE
// document (the wait's snapshot, a resume, the claim as `data.claimed`) and exits 143, and the
// claim itself stays committed; a registration that cannot be stored (the caller already owes
// the 256-ref cap) never rolls the claim back: it is a `warnings` entry.
//
// Needs dist/ (npm run build). DB-only: the claimed worker is a registry row, no mux opens.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const built = existsSync(CLI);

let dir: string;
let dbPath: string;
const kids: ChildProcess[] = [];

function start(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) {
    if (k.startsWith("MU_") || k === "PI_SESSION_ID" || k === "TMUX" || k === "TMUX_PANE")
      delete e[k];
  }
  // PATH holds no tmux or herdr: a registry-row worker has no pane to read, so its state stays
  // unknown (never dead) and the wait runs until the signal.
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...e, PATH: dir, MU_DB_PATH: dbPath, MU_STATE_DIR: dir, MU_SYNC_DIR: "", ...extra },
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
  return { child, done, out: () => stdout };
}

const until = async (cond: () => boolean, tries = 100): Promise<void> => {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-arm-int-"));
  dbPath = join(dir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  insertAgent(db, { name: "worker-1", workstream: "w", paneId: "%1", cli: "sh" });
  for (const id of ["a", "b"])
    addTask(db, { localId: id, workstream: "w", title: id, impact: 50, effortDays: 1 });
  db.close();
});
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const claimed = (id: string): string => {
  const db = openDb({ path: dbPath });
  try {
    return (db.prepare("SELECT status FROM tasks WHERE local_id = ?").get(id) as { status: string })
      .status;
  } finally {
    db.close();
  }
};

describe.skipIf(!built)("claim --and-wait: a process", () => {
  it("SIGTERM mid-wait: ONE document with the claim and a resume, exit 143; the claim stays", async () => {
    const { child, done } = start(
      ["task", "claim", "a", "--for", "worker-1", "--and-wait", "-w", "w"],
      { PI_SESSION_ID: "s-int" },
    );
    await until(() => claimed("a") === "IN_PROGRESS");
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGTERM");
    const r = await done;
    expect(r.code).toBe(143);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.data).toMatchObject({
      firing: { kind: "interrupted", ref: null },
      exit: 143,
      claimed: { task: "a", workstream: "w", ownerName: "worker-1", status: "IN_PROGRESS" },
    });
    expect(doc.data.resume).toMatch(/^mu wait --resume \w+/);
    expect(claimed("a")).toBe("IN_PROGRESS");
  });

  it("a full registration never rolls the claim back: it is a warning in the one document", async () => {
    const db = openDb({ path: dbPath });
    // 256 tasks owed by the caller: the cap. The claim's own refs then cannot be stored.
    for (let i = 0; i < 256; i++)
      addTask(db, { localId: `f${i}`, workstream: "w", title: "f", impact: 1, effortDays: 1 });
    const refs = Array.from({ length: 256 }, (_, i) => ({
      kind: "task",
      workstream: "w",
      id: `f${i}`,
    }));
    db.prepare(
      "INSERT INTO wait_registrations (caller, refs_json, state, generation, updated_at, baselines_json) VALUES ('pi:s-full', ?, 'armed', 0, ?, '{}')",
    ).run(JSON.stringify(refs), new Date().toISOString());
    db.close();
    const { done } = start(["task", "claim", "b", "--for", "worker-1", "-w", "w", "--json"], {
      PI_SESSION_ID: "s-full",
    });
    const r = await done;
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.data.warnings?.[0]).toMatch(/not armed.*at most 256/);
    expect(claimed("b")).toBe("IN_PROGRESS");
  });

  it("--and-wait without --for: one JSON usage error (exit 2), nothing claimed", async () => {
    const { done } = start(["task", "claim", "a", "--self", "--and-wait", "-w", "w"]);
    const r = await done;
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "UsageError" });
    expect(claimed("a")).toBe("OPEN");
  });
});
