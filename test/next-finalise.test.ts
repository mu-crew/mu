// The ONE finalisation of `next` (v_hint_wire): every result path takes its plan from
// computeNext over the DB handle() holds, after the verb's writes. In-process CLI, real
// temp SQLite, no mux.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fitNext } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import type { NextPlan } from "../src/output-contract.js";
import { taskRevision } from "../src/revision.js";
import { addTask } from "../src/tasks/edit.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let path: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-next-final-"));
  path = join(dir, "mu.db");
  db = openDb({ path });
  ensureWorkstream(db, "demo");
  addTask(db, { workstream: "demo", localId: "t", title: "t", impact: 50, effortDays: 1 });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

/** Every printed move parses as POSIX words and starts with mu. */
function assertExecutable(plan: NextPlan): void {
  for (const cmd of plan?.commands ?? []) {
    execFileSync("sh", ["-n", "-c", cmd]);
    expect(cmd.startsWith("mu ")).toBe(true);
    expect(cmd).not.toMatch(/<[^>]*>|\.\.\.|…/);
  }
}

describe("one finalisation for every result path", () => {
  it("success JSON: a preview's next is its --if apply, executable as printed", async () => {
    const r = await runCliJson(["task", "delete", "t", "-w", "demo", "--json"], path);
    expect(r.doc.next).toEqual({
      mode: "alt",
      commands: [`mu task delete t -w demo --if ${taskRevision(db, "demo", "t")}`],
    });
    assertExecutable(r.doc.next);
    expect(r.data).not.toHaveProperty("nextSteps");
  });

  it("human text: the same plan as one dim next: line on stdout", async () => {
    const r = await runCli(["task", "delete", "t", "-w", "demo"], path);
    expect(r.stdout).toContain(
      `next: mu task delete t -w demo --if ${taskRevision(db, "demo", "t")}`,
    );
    expect(r.stdout).not.toContain("Next:");
  });

  it("a read is never followed by a hint: next null, no next: line", async () => {
    const j = await runCliJson(["task", "show", "t", "-w", "demo", "--json"], path);
    expect(j.doc.next).toBeNull();
    const h = await runCli(["task", "update", "t", "-w", "demo", "--impact", "60"], path);
    expect(h.stdout).not.toMatch(/^.*next: /m);
  });

  it("failure JSON: one document, no nextSteps, next null when nothing is owed", async () => {
    const r = await runCliJson(["task", "show", "nope", "-w", "demo", "--json"], path);
    expect(r.exitCode).toBe(3);
    expect(r.doc).toMatchObject({ ok: false, error: "TaskNotFoundError", next: null, exit: 3 });
    expect(r.doc).not.toHaveProperty("nextSteps");
  });

  it("state moves reach every path: authorised work makes next `mu next -w <ws>`", async () => {
    await runCli(["task", "auto", "t", "--cli", "pi", "-w", "demo"], path);
    const ok = await runCliJson(
      ["task", "update", "t", "-w", "demo", "--impact", "70", "--json"],
      path,
    );
    expect(ok.doc.next).toEqual({ mode: "alt", commands: ["mu next -w demo"] });
    const human = await runCli(["task", "list", "-w", "demo"], path);
    expect(human.stdout).toContain("next: mu next -w demo");
    // A failure after the scope resolved computes from the same state.
    const bad = await runCliJson(["task", "show", "nope", "-w", "demo", "--json"], path);
    expect(bad.doc.next).toEqual({ mode: "alt", commands: ["mu next -w demo"] });
  });

  it("the bare wait follows only a verb that armed work, not a read or an unrelated write", async () => {
    await withEnv("PI_SESSION_ID", "s1", async () => {
      registerOwnedWait(db, "pi:s1", [{ kind: "task", workstream: "demo", id: "t" }]);
      const read = await runCliJson(["task", "show", "t", "-w", "demo", "--json"], path);
      expect(read.doc.next).toBeNull();
      const write = await runCliJson(
        ["task", "update", "t", "-w", "demo", "--impact", "70", "--json"],
        path,
      );
      expect(write.doc.next).toBeNull();
    });
  });

  it("a parse error has no DB and no scope: next is null", async () => {
    const r = await runCliJson(["task", "add", "-w", "demo", "-i", "abc", "--json"], path);
    expect(r.exitCode).toBe(2);
    expect(r.doc.next).toBeNull();
  });
});

describe("fitNext: the plan takes only what the 4 KB result leaves", () => {
  const alt: NextPlan = { mode: "alt", commands: ["mu next -w a", "mu wait -w a"] };
  it("keeps the plan when it fits", () => {
    expect(fitNext(alt, 100)).toEqual(alt);
  });
  it("cuts an alt from its tail near the budget, drops a seq whole", () => {
    // base + 4 ("null") leaves 49 bytes: room for one alternative (42), not two (57).
    const tight = 4096 - 45;
    expect(fitNext(alt, tight)).toEqual({ mode: "alt", commands: ["mu next -w a"] });
    expect(fitNext({ mode: "seq", commands: alt?.commands ?? [] }, tight)).toBeNull();
  });
});

describe("an unknown verb is one line naming the closest verb", () => {
  it.each([
    [["nex"], "unknown command 'nex' (closest: mu next); see mu --help"],
    [["claim"], "unknown command 'claim' (closest: mu task claim); see mu --help"],
    [["frobnicate"], "unknown command 'frobnicate'; see mu --help"],
    [["task", "lst"], "unknown command 'lst' (closest: mu task list); see mu task --help"],
  ])("%j", async (argv, line) => {
    const r = await runCli(argv, path);
    expect(r.exitCode).toBe(2);
    const out = r.stderr.replace(new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, "g"), "");
    expect(out.trim()).toBe(`error: ${line}`);
  });

  it("--json keeps usage, message is the same one line", async () => {
    const r = await runCliJson(["stat", "--json"], path);
    expect(r.doc).toMatchObject({
      ok: false,
      message: "unknown command 'stat' (closest: mu state); see mu --help",
      exit: 2,
      next: null,
    });
  });
});
