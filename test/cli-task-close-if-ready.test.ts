// CLI tests for `mu task close --if-ready` (fb_umbrella_no_auto_close).
//
// The dogfood report: built a wave umbrella with 18 blockers; after
// every blocker reached CLOSED, the umbrella stayed OPEN (had to
// remember to close manually). `--if-ready` is the cheap fix: bare
// `mu task close` is unchanged, `--if-ready` no-ops unless every
// direct blocker is CLOSED and lists the still-blocking ids when it
// skips.
//
// We exercise the wired CLI via runCli (real SQLite + buildProgram)
// so the assertions cover the JSON shape the orchestrator depends on
// + the human card the operator sees.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStdinReaderForTests } from "../src/cli/stdin.js";
import { openDb } from "../src/db.js";
import { acceptTask, addTask, claimTask, closeTask, getTask, parkTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

describe("mu task close --if-ready", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-close-if-ready-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    setStdinReaderForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("closes a task with zero blockers", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
    });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "test", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const payload = r.data as {
      changed: boolean;
      status: string;
      skipped?: string;
    };
    expect(payload.changed).toBe(true);
    expect(payload.status).toBe("CLOSED");
    expect(payload.skipped).toBeUndefined();

    const check = openDb({ path: dbPath });
    expect(getTask(check, "umbrella", "test")?.status).toBe("CLOSED");
    check.close();
  });

  it("closes when every blocker is CLOSED", async () => {
    const seed = openDb({ path: dbPath });
    for (const id of ["a", "b", "c"]) {
      addTask(seed, {
        localId: id,
        workstream: "test",
        title: id.toUpperCase(),
        impact: 50,
        effortDays: 1,
      });
    }
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a", "b", "c"],
    });
    closeTask(seed, "a", { workstream: "test", evidence: "test" });
    closeTask(seed, "b", { workstream: "test", evidence: "test" });
    closeTask(seed, "c", { workstream: "test", evidence: "test" });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "test", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const payload = r.data as { changed: boolean; status: string; skipped?: string };
    expect(payload.changed).toBe(true);
    expect(payload.status).toBe("CLOSED");
    expect(payload.skipped).toBeUndefined();

    const check = openDb({ path: dbPath });
    expect(getTask(check, "umbrella", "test")?.status).toBe("CLOSED");
    check.close();
  });

  it("no-ops + lists still-blocking ids when any blocker is OPEN/IN_PROGRESS", async () => {
    const seed = openDb({ path: dbPath });
    for (const id of ["a", "b", "c"]) {
      addTask(seed, {
        localId: id,
        workstream: "test",
        title: id.toUpperCase(),
        impact: 50,
        effortDays: 1,
      });
    }
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a", "b", "c"],
    });
    // a CLOSED, b/c still OPEN.
    closeTask(seed, "a", { workstream: "test", evidence: "test" });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "test", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const payload = r.data as {
      taskName: string;
      changed: boolean;
      skipped?: string;
      previousStatus: string;
      status: string;
      blockingIds?: string[];
    };
    expect(payload.changed).toBe(false);
    expect(payload.skipped).toBe("not_ready");
    expect(payload.previousStatus).toBe("OPEN");
    expect(payload.status).toBe("OPEN");
    expect(payload.blockingIds).toEqual(["b", "c"]);

    const check = openDb({ path: dbPath });
    expect(getTask(check, "umbrella", "test")?.status).toBe("OPEN");
    check.close();
  });

  it("bare `mu task close --as done` refuses while a blocker is open (exit 4, names it)", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--evidence", "test", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(4);
    expect(String(r.doc.message)).toContain("open blockers: a");
  });

  it("a non-done close still closes over open blockers (it claims no work happened)", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    seed.close();

    const r = await runCliJson(
      ["task", "close", "umbrella", "-w", "test", "--as", "wontfix", "--why", "dropped", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ changed: true, status: "CLOSED" });
  });

  it("--if-ready without --evidence and no open blockers: usage refusal (exit 2, one line), nothing written", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "U",
      impact: 50,
      effortDays: 1,
    });
    seed.close();

    const r = await runCli(["task", "close", "umbrella", "-w", "test", "--if-ready"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--evidence");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("human card prints the skip reason + still-blocking ids", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, {
      localId: "a",
      workstream: "test",
      title: "A",
      impact: 50,
      effortDays: 1,
    });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    seed.close();

    const r = await runCli(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "test"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("Skipped");
    expect(r.stdout).toContain("umbrella");
    expect(r.stdout).toContain("blocked by 1 task");
    expect(r.stdout).toContain("a");
  });
  function seedBlocker(as: "done" | "wontfix" | "duplicate" | "superseded" | "rejected" | "open") {
    const seed = openDb({ path: dbPath });
    addTask(seed, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    if (as !== "open") {
      closeTask(seed, "a", { workstream: "test", evidence: "e", why: "w", as });
    }
    seed.close();
  }
  const closeIfReady = ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "e"];

  it.each(["done", "wontfix", "duplicate", "superseded"] as const)(
    "a CLOSED/%s blocker counts as ready",
    async (as) => {
      seedBlocker(as);
      const r = await runCli(closeIfReady, dbPath);
      expect(r.exitCode).toBeNull();
      const db = openDb({ path: dbPath });
      expect(getTask(db, "umbrella", "test")?.status).toBe("CLOSED");
      db.close();
    },
  );

  it("a CLOSED/rejected blocker refuses (exit 4) and writes nothing", async () => {
    seedBlocker("rejected");
    const r = await runCli(closeIfReady, dbPath);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("CLOSED/rejected");
    expect(r.stderr).toContain("a");
    const db = openDb({ path: dbPath });
    expect(getTask(db, "umbrella", "test")?.status).toBe("OPEN");
    db.close();
  });

  it("an OPEN blocker still skips (exit 0)", async () => {
    seedBlocker("open");
    const r = await runCli(closeIfReady, dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("Skipped");
  });

  it("without --if-ready a rejected blocker does not stop the close", async () => {
    seedBlocker("rejected");
    const r = await runCli(["task", "close", "umbrella", "-w", "test", "--evidence", "e"], dbPath);
    expect(r.exitCode).toBeNull();
  });

  it("--evidence - and --why - read stdin verbatim", async () => {
    seedBlocker("done");
    setStdinReaderForTests(async () => "it's $HOME\n");
    const r = await runCli(["task", "close", "umbrella", "-w", "test", "--evidence", "-"], dbPath);
    expect(r.exitCode).toBeNull();
    setStdinReaderForTests(async () => "no $time\n");
    const w = await runCli(
      ["task", "close", "umbrella", "-w", "test", "--as", "wontfix", "--why", "-"],
      dbPath,
    );
    expect(w.exitCode).toBeNull();
    const n = await runCli(["task", "notes", "umbrella", "-w", "test"], dbPath);
    expect(n.stdout).toContain("it's $HOME");
    expect(n.stdout).toContain("no $time");
    expect(n.stdout).not.toMatch(/\t-\s*$/m);
  });

  // ---- fsj U3 rework: finding vs work rejection, stdin, precedence ----
  function seedUmbrella(blockers: { id: string; triage?: boolean }[]) {
    const seed = openDb({ path: dbPath });
    for (const b of blockers) {
      addTask(seed, {
        localId: b.id,
        workstream: "test",
        title: b.id,
        impact: 50,
        effortDays: 1,
        ...(b.triage ? { triage: true } : {}),
      });
    }
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: blockers.map((b) => b.id),
    });
    return seed;
  }
  const rej = { workstream: "test", why: "w", as: "rejected" } as const;
  const umbrellaStatus = () => {
    const db = openDb({ path: dbPath });
    const st = getTask(db, "umbrella", "test")?.status;
    db.close();
    return st;
  };

  it("findings flow: triage -> rejected -> umbrella --if-ready closes", async () => {
    const seed = seedUmbrella([
      { id: "f1", triage: true },
      { id: "f2", triage: true },
    ]);
    seed.close();
    expect(
      (
        await runCli(
          ["task", "close", "umbrella", "-w", "test", "--if-ready", "--evidence", "e"],
          dbPath,
        )
      ).stdout,
    ).toContain("Skipped");
    const db = openDb({ path: dbPath });
    closeTask(db, "f1", rej);
    acceptTask(db, "f2", { workstream: "test" });
    closeTask(db, "f2", { workstream: "test", evidence: "fixed" });
    db.close();
    const r = await runCli(closeIfReady, dbPath);
    expect(r.exitCode).toBeNull();
    expect(umbrellaStatus()).toBe("CLOSED");
  });

  it("a rejected required blocker rejected from triage counts as decided", async () => {
    seedUmbrella([{ id: "a", triage: true }]).close();
    const db = openDb({ path: dbPath });
    closeTask(db, "a", rej);
    db.close();
    expect((await runCli(closeIfReady, dbPath)).exitCode).toBeNull();
    expect(umbrellaStatus()).toBe("CLOSED");
  });

  it("a rejected work blocker refuses (created without --triage)", async () => {
    seedUmbrella([{ id: "b" }]).close();
    const db = openDb({ path: dbPath });
    closeTask(db, "b", rej);
    db.close();
    const r = await runCli(closeIfReady, dbPath);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("b");
    expect(umbrellaStatus()).toBe("OPEN");
  });

  it("a finding accepted, claimed, then rejected stays a finding: decided", async () => {
    seedUmbrella([{ id: "a", triage: true }]).close();
    const db = openDb({ path: dbPath });
    acceptTask(db, "a", { workstream: "test" });
    await claimTask(db, "a", { workstream: "test", self: true });
    closeTask(db, "a", rej);
    db.close();
    expect((await runCli(closeIfReady, dbPath)).exitCode).toBeNull();
    expect(umbrellaStatus()).toBe("CLOSED");
  });

  it("--json refusal is a JSON error envelope, exit 4", async () => {
    seedBlocker("rejected");
    const r = await runCli([...closeIfReady, "--json"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(
      JSON.parse(r.stderr || r.stdout).error ?? JSON.parse(r.stderr || r.stdout),
    ).toBeDefined();
    expect(r.stderr + r.stdout).toContain("CLOSED/rejected");
  });

  it.each([
    ["OPEN/todo", () => undefined],
    [
      "OPEN/parked",
      (d: ReturnType<typeof openDb>) => parkTask(d, "a", { workstream: "test", why: "later" }),
    ],
    [
      "IN_PROGRESS",
      (d: ReturnType<typeof openDb>) => claimTask(d, "a", { workstream: "test", self: true }),
    ],
  ])("a %s blocker skips (exit 0), umbrella stays open", async (_n, mutate) => {
    const seed = seedUmbrella([{ id: "a" }]);
    await mutate(seed);
    seed.close();
    const r = await runCli(closeIfReady, dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("Skipped");
    expect(umbrellaStatus()).toBe("OPEN");
  });

  it("an OPEN/triage blocker skips (exit 0)", async () => {
    seedUmbrella([{ id: "a", triage: true }]).close();
    const r = await runCli(closeIfReady, dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("Skipped");
    expect(umbrellaStatus()).toBe("OPEN");
  });

  it("precedence: rejected work + open blocker refuses (not skip)", async () => {
    const seed = seedUmbrella([{ id: "a" }, { id: "b" }]);
    closeTask(seed, "a", rej);
    seed.close();
    expect((await runCli(closeIfReady, dbPath)).exitCode).toBe(4);
  });

  it("precedence: rejected work + pending check refuses (not skip)", async () => {
    const seed = seedUmbrella([{ id: "a" }, { id: "b" }]);
    closeTask(seed, "a", rej);
    closeTask(seed, "b", { workstream: "test", evidence: "e" });
    seed.close();
    const c = await runCli(
      ["task", "check", "b", "-w", "test", "--by", "claude/opus", "--brief", "x"],
      dbPath,
    );
    expect(c.exitCode).toBeNull();
    expect((await runCli(closeIfReady, dbPath)).exitCode).toBe(4);
  });

  it.each([["--evidence"], ["--why"]])(
    "%s - with empty or whitespace stdin is a usage error",
    async (flag) => {
      seedBlocker("done");
      for (const body of ["", "  \n\t\n"]) {
        setStdinReaderForTests(async () => body);
        const args =
          flag === "--why"
            ? ["task", "close", "umbrella", "-w", "test", "--as", "wontfix", "--why", "-"]
            : ["task", "close", "umbrella", "-w", "test", "--evidence", "-"];
        const r = await runCli(args, dbPath);
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain(flag);
      }
      expect(umbrellaStatus()).toBe("OPEN");
    },
  );

  it("--note - reads stdin", async () => {
    seedBlocker("done");
    setStdinReaderForTests(async () => "noted $X\n");
    const r = await runCli(["task", "close", "umbrella", "-w", "test", "--note", "-"], dbPath);
    expect(r.exitCode).toBeNull();
    const n = await runCli(["task", "notes", "umbrella", "-w", "test"], dbPath);
    expect(n.stdout).toContain("CLOSE: noted $X");
  });

  it("a bare '-' is storable via stdin", async () => {
    seedBlocker("done");
    setStdinReaderForTests(async () => "-\n");
    const r = await runCli(["task", "close", "umbrella", "-w", "test", "--evidence", "-"], dbPath);
    expect(r.exitCode).toBeNull();
  });

  it.each([
    ["--evidence", "--why"],
    ["--note", "--why"],
  ])("%s - with %s - is a usage error, stdin untouched", async (a, b) => {
    seedBlocker("done");
    let reads = 0;
    setStdinReaderForTests(async () => {
      reads++;
      return "x";
    });
    const r = await runCli(
      ["task", "close", "umbrella", "-w", "test", "--as", "wontfix", a, "-", b, "-"],
      dbPath,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("at most one");
    expect(reads).toBe(0);
  });
});
