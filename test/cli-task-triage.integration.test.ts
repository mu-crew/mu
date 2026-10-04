// CLI tests for the triage flow: `mu task add --triage`, `mu task accept`,
// and the hints every surface prints for a task in OPEN/triage
// (recipes/findings.md). Run through runCli: real SQLite + buildProgram.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addBlockEdge, addTask, getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

const WS = "rv";
let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-cli-triage-"));
  dbPath = join(tempDir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, WS);
  addTask(db, { localId: "review", workstream: WS, title: "Review", impact: 50, effortDays: 1 });
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function addFinding(id: string): Promise<void> {
  const r = await runCli(
    ["task", "add", id, "-w", WS, "--triage", "-t", `high: ${id}`, "-i", "70", "-e", "0.5"],
    dbPath,
  );
  expect(r.exitCode).toBeNull();
  const db = openDb({ path: dbPath });
  addBlockEdge(db, WS, "review", id);
  db.close();
}

function pairOf(id: string): string {
  const db = openDb({ path: dbPath });
  const t = getTask(db, id, WS);
  db.close();
  return `${t?.status}/${t?.substate}`;
}

describe("mu task add --triage / accept", () => {
  it("add --triage lands in OPEN/triage and points at accept, not claim", async () => {
    const r = await runCli(
      ["task", "add", "f1", "-w", WS, "--triage", "-t", "high: x", "-i", "70", "-e", "0.5"],
      dbPath,
    );
    expect(pairOf("f1")).toBe("OPEN/triage");
    expect(plain(r.stdout)).toContain(`mu task accept f1 -w ${WS}`);
    expect(plain(r.stdout)).not.toContain("Claim and start");
  });

  it("accept moves it to OPEN/todo with --json, then is a no-op", async () => {
    await addFinding("f1");
    const r = await runCli(["task", "accept", "f1", "-w", WS, "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(JSON.parse(r.stdout)).toMatchObject({
      taskName: "f1",
      changed: true,
      previousSubstate: "triage",
      substate: "todo",
    });
    const again = await runCli(["task", "accept", "f1", "-w", WS], dbPath);
    expect(plain(again.stdout)).toContain("not in triage (no-op)");
  });

  it("claim refuses a triage task with exit 4 and accept / decline / --force hints", async () => {
    await addFinding("f1");
    const r = await runCli(["task", "claim", "f1", "-w", WS, "--self"], dbPath);
    expect(r.exitCode).toBe(4);
    const out = plain(r.stdout + r.stderr);
    expect(out).toContain("is in triage");
    expect(out).toContain(`mu task accept f1 -w ${WS}`);
    expect(out).toContain("--as rejected");
    expect(out).toContain("--force");
    expect(pairOf("f1")).toBe("OPEN/triage");
  });
});

describe("triage hints on read surfaces", () => {
  it("task next names the triage count and the inbox", async () => {
    await addFinding("f1");
    const r = await runCli(["task", "next", "-w", WS], dbPath);
    const out = plain(r.stdout);
    expect(out).toContain("1 in triage");
    expect(out).toContain(`mu task list --substate triage -w ${WS}`);
  });

  it("task list with a triage task prints accept / decline / notes", async () => {
    await addFinding("f1");
    const r = await runCli(["task", "list", "-w", WS, "--substate", "triage"], dbPath);
    const out = plain(r.stdout);
    expect(out).toContain(`mu task accept f1 -w ${WS}`);
    expect(out).toContain("--as rejected|duplicate");
    expect(out).toContain(`mu task notes f1 -w ${WS}`);
  });

  it("task list without triage tasks prints no triage hint", async () => {
    const r = await runCli(["task", "list", "-w", WS], dbPath);
    expect(plain(r.stdout)).not.toContain("mu task accept");
  });

  it("task show on a triage task offers accept and decline", async () => {
    await addFinding("f1");
    const r = await runCli(["task", "show", "f1", "-w", WS], dbPath);
    const out = plain(r.stdout);
    expect(out).toContain(`mu task accept f1 -w ${WS}`);
    expect(out).toContain("--as rejected");
  });

  it("close --if-ready on a review blocked by findings leads with the triage inbox", async () => {
    await addFinding("f1");
    const r = await runCli(["task", "close", "review", "-w", WS, "--if-ready", "--json"], dbPath);
    const payload = JSON.parse(r.stdout) as { skipped: string; nextSteps: { command: string }[] };
    expect(payload.skipped).toBe("not_ready");
    expect(payload.nextSteps[0]?.command).toBe(`mu task list --substate triage -w ${WS}`);
    expect(pairOf("review")).toBe("OPEN/todo");
  });

  it("state lists the triage inbox in text and --json", async () => {
    await addFinding("f1");
    const text = plain((await runCli(["state", "-w", WS], dbPath)).stdout);
    expect(text).toContain("Triage (1)");
    expect(text).toContain("mu task accept <id>");
    const json = JSON.parse((await runCli(["state", "-w", WS, "--json"], dbPath)).stdout) as {
      triage: { name: string }[];
      ready: { name: string }[];
    };
    expect(json.triage.map((t) => t.name)).toEqual(["f1"]);
    expect(json.ready.map((t) => t.name)).toEqual([]);
  });
});
