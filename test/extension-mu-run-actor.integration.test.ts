// A mu the pi extension runs records that pi's session (ops.actor_session /
// actor_anchor): pi exports PI_SESSION_ID only to its bash tool, so the
// extension passes MU_ACTOR_* (withActor). Real dist/cli.js, temp DB.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MuRunner, runChild, withActor } from "../extension/mu-run.js";
import { openDb } from "../src/db.js";
import { rmFixtureDir } from "./_fs.js";

const CLI = resolve("dist/cli.js");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-run-actor-"));
});
afterEach(() => {
  try {
    rmFixtureDir(dir);
  } catch {}
});

function cli(): MuRunner {
  const env = {
    MU_DB_PATH: join(dir, "mu.db"),
    MU_STATE_DIR: join(dir, "state"),
    MU_SYNC_DIR: "",
    MURMUR_STATE_DIR: join(dir, "murmur"),
  };
  return (args, signal, stdin, opts) =>
    runChild(process.execPath, [CLI, ...args], signal, stdin, {
      ...opts,
      env: { ...env, ...opts?.env },
    });
}

describe("withActor over the real CLI", () => {
  it("delegate.register and task.add record the pi session and its latest turn", async () => {
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", id: "s-1" })}\n${JSON.stringify({
        type: "message",
        id: "a1",
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc1" }] },
      })}\n`,
    );
    const run = withActor(cli(), () => ({
      getSessionId: () => "s-1",
      getSessionFile: () => file,
    }));
    const reg = await run(
      [
        "delegates",
        "register",
        "c1",
        "-w",
        "scratch",
        "--caller",
        "pi:s-1",
        "--text",
        "-",
        "--json",
      ],
      undefined,
      "hi",
    );
    expect(reg.code, reg.stderr).toBe(0);
    const add = await run(["task", "add", "t1", "--title", "T", "-w", "scratch", "--json"]);
    expect(add.code, add.stderr).toBe(0);

    const db = openDb({ path: join(dir, "mu.db") });
    try {
      const rows = db
        .prepare(
          "SELECT intent, actor_session AS s, actor_anchor AS a FROM ops WHERE intent IN ('delegate.register', 'task.add')",
        )
        .all() as { intent: string; s: string | null; a: string | null }[];
      expect(new Set(rows.map((r) => r.intent))).toEqual(
        new Set(["delegate.register", "task.add"]),
      );
      for (const r of rows) expect(r).toMatchObject({ s: "pi:s-1", a: "a1:tc1" });
    } finally {
      db.close();
    }
  });

  it("before any session_start the env is untouched: no session recorded", async () => {
    const run = withActor(cli(), () => undefined);
    const add = await run(["task", "add", "t1", "--title", "T", "-w", "scratch", "--json"]);
    expect(add.code, add.stderr).toBe(0);
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      const row = db.prepare("SELECT actor_session AS s FROM ops WHERE intent = 'task.add'").get();
      expect(row).toEqual({ s: null });
    } finally {
      db.close();
    }
  });
});
