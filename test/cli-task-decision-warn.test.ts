// Decision-time guardrail for triage findings (weak-decision-warn):
// `mu task accept` / `close --as rejected|wontfix|duplicate` on an
// OPEN/triage task warn (stderr + `warnings` in --json) when the reason
// is short AND no note records a verdict. Warnings never change the exit
// code. Also: decision notes name the tasks they cite, and lifecycle
// evidence notes carry the actor as author.
//
// Fast tier: runCli in-process, temp DB, mocked mux, MU_AGENT_NAME set
// so identity resolution never reaches a multiplexer.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { addNote, addTask, claimTask, closeTask, listNotes, parkTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

const WS = "rv";
const AGENT_KEY = "MU_AGENT_NAME";
const LONG = "npm test -- foo.test.ts: fails before fix, passes after (exit 0)";
let tempDir: string;
let dbPath: string;
let mux: MuxHarness;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-decision-warn-"));
  dbPath = join(tempDir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, WS);
  for (const id of ["f1", "f2", "fix_x"]) {
    addTask(db, {
      localId: id,
      workstream: WS,
      title: `high: ${id} title`,
      impact: 50,
      effortDays: 1,
      ...(id === "fix_x" ? {} : { triage: true }),
    });
  }
  addTask(db, { localId: "plain", workstream: WS, title: "Plain", impact: 50, effortDays: 1 });
  db.close();
  process.env[AGENT_KEY] = "orch";
  mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
});

afterEach(() => {
  mux.restore();
  delete process.env[AGENT_KEY];
  rmSync(tempDir, { recursive: true, force: true });
});

function note(id: string, text: string): void {
  const db = openDb({ path: dbPath });
  addNote(db, id, text, { workstream: WS, author: "refuter" });
  db.close();
}

function notesOf(id: string): { author: string | null; content: string }[] {
  const db = openDb({ path: dbPath });
  const n = listNotes(db, id, WS);
  db.close();
  return n;
}

async function json(
  argv: string[],
): Promise<{ exitCode: number | null; body: { warnings?: string[] } }> {
  const r = await runCli([...argv, "-w", WS, "--json"], dbPath);
  return { exitCode: r.exitCode, body: JSON.parse(r.stdout) as { warnings?: string[] } };
}

describe("weak decision warnings", () => {
  it("(a) accepting a finding with short evidence and no verdict warns on stderr", async () => {
    const r = await runCli(["task", "accept", "f1", "-w", WS, "--evidence", "valid"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toContain("warning:");
    expect(r.stderr).toContain("verdict");
    expect(r.stderr).toContain(`mu task note f1 -w ${WS} "EVIDENCE: <command + result>"`);
  });

  it("(a) accept with no evidence at all warns", async () => {
    const { body } = await json(["task", "accept", "f1"]);
    expect(body.warnings?.length).toBe(1);
  });

  it("(b) a REFUTER or VERDICT note silences the warning", async () => {
    note("f1", "REFUTER r1 (claude): CONFIRMED\nfile.ts:12 deletes before unlink");
    note("f2", "checked by hand\nVERDICT: CONFIRMED (sev med)");
    const a = await runCli(["task", "accept", "f1", "-w", WS, "--evidence", "valid"], dbPath);
    expect(a.stderr).not.toContain("warning:");
    const b = await json(["task", "close", "f2", "--as", "rejected", "--why", "nope"]);
    expect(b.body.warnings).toEqual([]);
  });

  it("(c) close --as rejected with 40+ chars of evidence does not warn", async () => {
    const { body } = await json(["task", "close", "f1", "--as", "rejected", "--why", LONG]);
    expect(body.warnings).toEqual([]);
  });

  it("close --as rejected|wontfix with a short reason warns", async () => {
    expect(
      (await json(["task", "close", "f1", "--as", "rejected", "--why", "no"])).body.warnings
        ?.length,
    ).toBe(1);
    expect(
      (await json(["task", "close", "f2", "--as", "wontfix", "--why", "meh"])).body.warnings
        ?.length,
    ).toBe(1);
  });

  it("(d) a duplicate naming an existing task does not warn; one naming nothing does", async () => {
    expect(
      (await json(["task", "close", "f1", "--as", "duplicate", "--why", "fix_x"])).body.warnings,
    ).toEqual([]);
    expect(
      (await json(["task", "close", "f2", "--as", "duplicate", "--why", "same"])).body.warnings
        ?.length,
    ).toBe(1);
  });

  it("(e) closing a task not in triage never warns", async () => {
    expect((await json(["task", "close", "plain"])).body.warnings).toEqual([]);
    const r = await runCli(
      ["task", "close", "fix_x", "-w", WS, "--as", "wontfix", "--why", "x"],
      dbPath,
    );
    expect(r.stderr).not.toContain("warning:");
  });

  it("(f) --json carries the warnings and the exit code is unchanged", async () => {
    const r = await json(["task", "close", "f1", "--as", "rejected", "--why", "no"]);
    expect(r.exitCode).toBeNull();
    expect(r.body.warnings?.[0]).toContain("f1");
  });
});

describe("decision notes stand alone", () => {
  it("(g) REJECTED note gets each named task's title appended", async () => {
    const db = openDb({ path: dbPath });
    closeTask(db, "f1", { workstream: WS, as: "rejected", why: "f2, fix_x and ghost are wrong" });
    db.close();
    expect(notesOf("f1").map((n) => n.content)).toContain(
      "REJECTED: f2 (high: f2 title), fix_x (high: fix_x title) and ghost are wrong",
    );
  });

  it("SUPERSEDED note names the fix task's title", async () => {
    const db = openDb({ path: dbPath });
    closeTask(db, "f1", { workstream: WS, as: "superseded", why: "by fix_x" });
    db.close();
    expect(notesOf("f1").map((n) => n.content)).toContain(
      "SUPERSEDED: by fix_x (high: fix_x title)",
    );
  });

  it("WONTFIX notes are left as is", async () => {
    const db = openDb({ path: dbPath });
    closeTask(db, "f1", { workstream: WS, as: "wontfix", why: "fix_x covers it" });
    db.close();
    expect(notesOf("f1").map((n) => n.content)).toContain("WONTFIX: fix_x covers it");
  });
});

describe("lifecycle evidence notes carry the actor", () => {
  function authorOf(id: string, prefix: string): string | null | undefined {
    return notesOf(id).find((n) => n.content.startsWith(prefix))?.author;
  }

  it("accept / open / unpark / release / claim --for store MU_AGENT_NAME as author", async () => {
    const db = openDb({ path: dbPath });
    insertAgent(db, { name: "w1", workstream: WS, paneId: "%1" });
    parkTask(db, "plain", { workstream: WS, why: "later" });
    closeTask(db, "fix_x", { workstream: WS });
    db.close();
    await runCli(["task", "accept", "f1", "-w", WS, "--evidence", LONG], dbPath);
    await runCli(["task", "unpark", "plain", "-w", WS, "--evidence", "ok"], dbPath);
    await runCli(["task", "open", "fix_x", "-w", WS, "--evidence", "ok"], dbPath);
    await runCli(["task", "claim", "f1", "-w", WS, "--for", "w1", "--evidence", "go"], dbPath);
    await runCli(["task", "release", "f1", "-w", WS, "--evidence", "back"], dbPath);
    expect(authorOf("f1", "ACCEPT:")).toBe("orch");
    expect(authorOf("plain", "UNPARK:")).toBe("orch");
    expect(authorOf("fix_x", "OPEN:")).toBe("orch");
    expect(authorOf("f1", "CLAIM:")).toBe("orch");
    expect(authorOf("f1", "RELEASE:")).toBe("orch");
  });

  it("claim --self evidence is attributed to the actor", async () => {
    const db = openDb({ path: dbPath });
    await claimTask(db, "plain", {
      workstream: WS,
      self: true,
      actor: "deploy-bot",
      evidence: "x",
    });
    db.close();
    expect(authorOf("plain", "CLAIM:")).toBe("deploy-bot");
  });
});
