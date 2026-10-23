// bug_group_id_prefix_asymmetry — `mu log --group` accepts the 8-char
// group prefix that `mu log` prints.
//
// The failure was SILENT and misleading: an unmatched prefix returned an
// empty listing, which reads as "this group did nothing".

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;

interface LogJson {
  items: Array<{ seq: number; group: string; intent: string | null; rendered: string }>;
}

/** Strip SGR so assertions read prose, not escapes. */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-groupprefix-"));
  dbPath = join(tempDir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "demo");
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** The full group id of the most recent op in `demo`. */
async function newestGroup(): Promise<string> {
  const r = await runCli(["log", "-w", "demo", "--json", "-n", "1"], dbPath);
  const group = (JSON.parse(r.stdout.trim()) as LogJson).items[0]?.group;
  if (group === undefined) throw new Error("no group id");
  return group;
}

describe("group workflow with a SHORT id", () => {
  it("mu log → mu log --group <short>", async () => {
    const add = await runCli(
      ["task", "add", "t1", "-t", "Build it", "-i", "50", "-e", "1", "-w", "demo"],
      dbPath,
    );
    expect(add.exitCode).toBeNull();

    const fullId = await newestGroup();
    const shortId = fullId.slice(0, 8);
    expect(shortId).not.toBe(fullId);

    const inspect = await runCli(["log", "--group", shortId, "-w", "demo"], dbPath);
    expect(inspect.exitCode).toBeNull();
    expect(plain(inspect.stdout)).toContain("task add t1");
    expect(plain(inspect.stdout)).not.toContain("(no log entries)");
  });

  it("the short and full forms of --group return identical rows", async () => {
    await runCli(["task", "add", "t1", "-t", "T", "-i", "5", "-e", "1", "-w", "demo"], dbPath);
    const fullId = await newestGroup();

    const byShort = await runCli(
      ["log", "--group", fullId.slice(0, 8), "-w", "demo", "--json"],
      dbPath,
    );
    const byFull = await runCli(["log", "--group", fullId, "-w", "demo", "--json"], dbPath);
    const shortItems = (JSON.parse(byShort.stdout.trim()) as LogJson).items;
    const fullItems = (JSON.parse(byFull.stdout.trim()) as LogJson).items;
    expect(shortItems.length).toBeGreaterThan(0);
    expect(shortItems.map((i) => i.seq)).toEqual(fullItems.map((i) => i.seq));
  });
});

describe("group prefix resolution errors", () => {
  // Previously an unmatched prefix degraded to an empty listing, which is
  // indistinguishable from "that group did nothing".
  it("an unmatched prefix is exit 3, not an empty listing", async () => {
    await runCli(["task", "add", "t1", "-t", "T", "-i", "5", "-e", "1", "-w", "demo"], dbPath);
    const r = await runCli(["log", "--group", "deadbeef", "-w", "demo"], dbPath);
    expect(r.exitCode).toBe(3);
    expect(plain(r.stderr)).toContain("no op group matching");
    expect(plain(r.stderr)).toContain("deadbeef");
    expect(plain(r.stdout)).not.toContain("(no log entries)");
  });

  it("an ambiguous prefix is exit 4, naming the candidates", async () => {
    await runCli(["task", "add", "t1", "-t", "T", "-i", "5", "-e", "1", "-w", "demo"], dbPath);
    // Force a collision: two groups sharing the first 8 chars.
    const db = openDb({ path: dbPath });
    try {
      db.prepare("UPDATE ops SET group_id = ? WHERE seq = 1").run(
        "aaaaaaaa-1111-1111-1111-111111111111",
      );
      db.prepare("UPDATE ops SET group_id = ? WHERE seq = 2").run(
        "aaaaaaaa-2222-2222-2222-222222222222",
      );
    } finally {
      db.close();
    }

    const r = await runCli(["log", "--group", "aaaaaaaa", "-w", "demo"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(plain(r.stderr)).toContain("ambiguous");
    expect(plain(r.stderr)).toContain("aaaaaaaa-111");
  });

  it("a full id still wins over prefix matching", async () => {
    await runCli(["task", "add", "t1", "-t", "T", "-i", "5", "-e", "1", "-w", "demo"], dbPath);
    const db = openDb({ path: dbPath });
    let full = "";
    try {
      // One id that is a strict prefix of another: the exact match must win
      // rather than being reported ambiguous.
      db.prepare("UPDATE ops SET group_id = 'abc' WHERE seq = 1").run();
      db.prepare("UPDATE ops SET group_id = 'abcdef' WHERE seq = 2").run();
      full = "abc";
    } finally {
      db.close();
    }
    const r = await runCli(["log", "--group", full, "-w", "demo", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    const items = (JSON.parse(r.stdout.trim()) as LogJson).items;
    expect(items.every((i) => i.group === "abc")).toBe(true);
  });
});
