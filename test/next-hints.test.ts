// computeNext: the one rule set behind `next`. Real SQLite in a temp dir, no mux, no ctl:
// the function is read-only by contract, and the test proves it writes nothing.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { resumeCommand } from "../src/cli/wait-output.js";
import { type Db, openDb } from "../src/db.js";
import { recordHumanNeeded } from "../src/human-needed.js";
import {
  COURSE_CHECK_AGE_MS,
  COURSE_CHECK_CLOSED,
  capPlan,
  computeNext,
  computeNotices,
  courseCheckHint,
  type NextContext,
  renderArgv,
  renderPlan,
  UnguardedMoveError,
} from "../src/next-hints.js";
import type { NextPlan } from "../src/output-contract.js";
import { authorizeTasks } from "../src/task-auto.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mnh-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "d");
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

/** Words of `line` as POSIX sh parses them. */
function shWords(line: string): string[] {
  execFileSync("sh", ["-n", "-c", line]);
  const out = execFileSync("sh", ["-c", `printf '%s\\0' ${line}`], { encoding: "utf8" });
  return out.split("\0").slice(0, -1);
}

/** Every printed hint: sh-parseable, starts with mu, no placeholder, ellipsis, a|b, or read verb. */
function assertExecutable(plan: NextPlan): void {
  for (const cmd of plan?.commands ?? []) {
    const words = shWords(cmd);
    expect(words[0]).toBe("mu");
    for (const w of words) {
      expect(w).not.toMatch(/^<.*>$|\.\.\.|…/);
      expect(w).not.toMatch(/^[a-z-]+\|[a-z-]+$/);
    }
    expect(words.slice(1, 3).join(" ")).not.toMatch(
      /^(task (show|notes|list|tree)|agent (read|list)|log|state|sql)\b/,
    );
  }
}

const opsCount = () => (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;

function next(ctx: Partial<NextContext>): NextPlan {
  const before = opsCount();
  const plan = computeNext(db, { callers: [], ...ctx });
  expect(opsCount()).toBe(before); // read-only
  assertExecutable(plan);
  return plan;
}

const agent = (name: string, cli = "pi") =>
  insertAgent(db, { name, workstream: "d", paneId: `%${name}`, cli });

describe("computeNext: usually nothing", () => {
  it("no outcome, no callers, no authorised work: null", () => {
    addTask(db, { workstream: "d", localId: "t1", title: "ready but not authorised" });
    expect(next({ workstream: "d" })).toBeNull();
  });
});

describe("computeNext: the outcome's own move", () => {
  it("a delivered send: the exact wait on the send's baseline, one quoted word", () => {
    const plan = next({
      outcome: {
        kind: "sent",
        agent: { workstream: "d", name: "w1" },
        runs: 4,
        incarnation: "7f-1",
      },
    });
    expect(plan).toEqual({ mode: "alt", commands: ["mu wait 'agent:d/w1@4#7f-1'"] });
  });

  it("a send that started no fenced run (mux, slash command): no wait hint", () => {
    expect(next({ outcome: { kind: "sent", agent: { workstream: "d", name: "w1" } } })).toBeNull();
  });

  it("an unknown delivery: the receipt check, never a resend", () => {
    const row = agent("w1");
    const plan = next({
      outcome: {
        kind: "send-unknown",
        agent: { workstream: "d", name: "w1" },
        msgId: "m-42",
        agentId: row.incarnation,
      },
    });
    expect(plan?.commands).toEqual(["mu agent check w1 m-42 -w d --json"]);
    expect(plan?.commands.join(" ")).not.toMatch(/agent send|--inc/);
  });

  it("an unknown delivery to a replaced or gone agent: nothing (check would probe the wrong pi)", () => {
    const old = agent("w1");
    deleteAgent(db, "w1", "d");
    agent("w1");
    const o = { kind: "send-unknown", agent: { workstream: "d", name: "w1" }, msgId: "m" } as const;
    expect(next({ outcome: { ...o, agentId: old.incarnation } })).toBeNull();
    deleteAgent(db, "w1", "d");
    expect(next({ outcome: { ...o, agentId: old.incarnation } })).toBeNull();
  });

  it("a gate spawned: the wait that returns its exit", () => {
    const plan = next({ outcome: { kind: "gate-spawned", agent: { workstream: "d", name: "g" } } });
    expect(plan?.commands).toEqual(["mu wait agent:d/g"]);
  });

  it("claim --for a pi owner: send it the task --fresh; a non-pi owner: a plain send", () => {
    agent("w1");
    agent("cc", "claude");
    const task = { workstream: "d", id: "t1" };
    const pi = next({
      outcome: { kind: "claimed-for", task, owner: { workstream: "d", name: "w1" } },
    });
    expect(pi?.commands).toEqual([
      "mu agent send w1 --fresh 'Claim done: work on t1. Read: mu task notes t1 -w d' -w d",
    ]);
    const cc = next({
      outcome: { kind: "claimed-for", task, owner: { workstream: "d", name: "cc" } },
    });
    expect(cc?.commands[0]).toMatch(/^mu agent send cc 'Claim done/);
    expect(
      next({ outcome: { kind: "claimed-for", task, owner: { workstream: "d", name: "gone" } } }),
    ).toBeNull();
  });

  it("a preview: the apply, fenced with --if <rev>, and nothing else", () => {
    authorizeTasks(db, [addTask(db, { workstream: "d", localId: "a1", title: "a" }).name], {
      workstream: "d",
      cli: "pi",
      worktree: false,
      maxRuns: 1,
    });
    const plan = next({
      workstream: "d",
      outcome: { kind: "preview", apply: ["mu", "workstream", "teardown", "d"], revision: 99 },
    });
    expect(plan?.commands).toEqual(["mu workstream teardown d --if 99"]);
  });

  it("a wait with a stored handle: exactly the shared resume builder's line", () => {
    const plan = next({ outcome: { kind: "waited", resumeId: "abc123", scope: "my ws" } });
    expect(plan?.commands).toEqual([resumeCommand("abc123", "my ws")]);
    expect(plan?.commands[0]).toBe("mu wait --resume abc123 -w 'my ws'");
    expect(next({ outcome: { kind: "waited", resumeId: null } })).toBeNull();
  });
});

describe("computeNext: state moves", () => {
  function authorised(id: string): void {
    addTask(db, { workstream: "d", localId: id, title: id });
    authorizeTasks(db, [id], { workstream: "d", cli: "pi", worktree: false, maxRuns: 1 });
  }

  it("authorised ready work in scope: mu next -w <ws>; ready-but-unauthorised never is", () => {
    addTask(db, { workstream: "d", localId: "plain", title: "p" });
    expect(next({ workstream: "d" })).toBeNull();
    authorised("a1");
    expect(next({ workstream: "d" })?.commands).toEqual(["mu next -w d"]);
    expect(next({})).toBeNull(); // no scope: no executor move
  });

  it("owned registered refs: the bare wait, scoped when the call is", () => {
    addTask(db, { workstream: "d", localId: "t1", title: "t" });
    registerOwnedWait(db, "d/orch", [{ kind: "task", workstream: "d", id: "t1" }]);
    expect(next({ callers: ["d/orch"], workstream: "d" })?.commands).toEqual(["mu wait -w d"]);
    expect(next({ callers: ["d/orch"] })?.commands).toEqual(["mu wait"]);
    expect(next({ callers: ["pi:other"], workstream: "d" })).toBeNull();
    // A verb that armed nothing (a read, an unrelated write) is not followed by the bare wait.
    expect(next({ callers: ["d/orch"], workstream: "d", armed: false })).toBeNull();
    expect(next({ callers: ["d/orch"], workstream: "d", armed: true })?.commands).toEqual([
      "mu wait -w d",
    ]);
    ensureWorkstream(db, "e");
    expect(next({ callers: ["d/orch"], workstream: "e" })).toBeNull();
  });

  it("ranking: the outcome's move first, then mu next; a bare wait beside an exact wait is dropped", () => {
    authorised("a1");
    registerOwnedWait(db, "d/orch", [{ kind: "task", workstream: "d", id: "a1" }]);
    const plan = next({
      callers: ["d/orch"],
      workstream: "d",
      outcome: { kind: "sent", agent: { workstream: "d", name: "w1" }, runs: 0 },
    });
    expect(plan).toEqual({ mode: "alt", commands: ["mu wait agent:d/w1@0", "mu next -w d"] });
  });

  it("a caller's open human need stops the state moves (the outcome's own move stays)", () => {
    authorised("a1");
    recordHumanNeeded(db, { workstream: "d", caller: "d/orch", reason: "pick a db" });
    expect(next({ callers: ["d/orch"], workstream: "d" })).toBeNull();
    expect(
      next({
        callers: ["d/orch"],
        workstream: "d",
        outcome: { kind: "gate-spawned", agent: { workstream: "d", name: "g" } },
      })?.commands,
    ).toEqual(["mu wait agent:d/g"]);
    expect(next({ callers: ["pi:else"], workstream: "d" })?.commands).toEqual(["mu next -w d"]);
  });

  it("the scratch workstream is never an executor target", () => {
    expect(next({ workstream: "scratch" })).toBeNull();
  });
});

describe("rendering: quoting, ranking, guards, caps", () => {
  it("POSIX-quotes apostrophes and shell control chars; sh reads back the exact argv", () => {
    const nasty = ["it's", "a;b", "$(x)", "`y`", "a b", "*", "-w", "x&&y", 'q"q', "nl\nx"];
    const line = renderArgv(["mu", "task", "note", ...nasty]);
    expect(shWords(line)).toEqual(["mu", "task", "note", ...nasty]);
  });

  it("an unguarded destructive move is refused; guarded ones rank after safe ones in alt", () => {
    expect(() =>
      renderPlan("alt", [{ argv: ["mu", "agent", "close", "w"], destructive: true }]),
    ).toThrow(UnguardedMoveError);
    const plan = renderPlan("alt", [
      { argv: ["mu", "agent", "close", "w", "--if", "3"], destructive: true },
      { argv: ["mu", "next", "-w", "d"] },
    ]);
    expect(plan?.commands).toEqual(["mu next -w d", "mu agent close w --if 3"]);
  });

  it("seq keeps its order and is never truncated; alt is cut to MAX_ALTERNATIVES", () => {
    const moves = ["a", "b", "c", "d", "e"].map((x) => ({ argv: ["mu", "wait", `task:${x}`] }));
    expect(renderPlan("seq", moves)?.commands).toHaveLength(5);
    expect(renderPlan("alt", moves)?.commands).toEqual([
      "mu wait task:a",
      "mu wait task:b",
      "mu wait task:c",
    ]);
    expect(renderPlan("alt", [])).toBeNull();
  });

  it("capPlan: an oversized seq is dropped WHOLE; an alt loses its tail; the budget is UTF-8 bytes", () => {
    const long = (c: string) => `mu task note t ${c.repeat(300)}`;
    const seq: NextPlan = { mode: "seq", commands: [long("a"), long("b"), long("c"), long("d")] };
    expect(capPlan(seq, 1024)).toEqual({ next: null, cut: 4 });
    const alt: NextPlan = { mode: "alt", commands: seq.commands };
    const r = capPlan(alt, 1024);
    expect(r.next?.commands).toEqual([long("a"), long("b"), long("c")]);
    expect(r.cut).toBe(1);
    // 300 × "é" is 600 bytes: two fit by length, one by bytes.
    const wide: NextPlan = { mode: "alt", commands: [long("é"), long("é")] };
    expect(capPlan(wide, 700).next?.commands).toHaveLength(1);
    expect(capPlan(null)).toEqual({ next: null, cut: 0 });
  });
});

describe("courseCheckHint / computeNotices: the course-correct trigger", () => {
  const H = 3600_000;
  /** Add `n` work tasks to `ws` and close them done (each writes its close note now). */
  const closeN = (n: number, ws = "d", from = 0): void => {
    for (let i = from; i < from + n; i++) {
      addTask(db, { workstream: ws, localId: `c${i}`, title: `c${i}` });
      closeTask(db, `c${i}`, { workstream: ws, evidence: "ok" });
    }
  };
  const wsCreated = (ws = "d"): number =>
    Date.parse(
      (
        db.prepare("SELECT created_at FROM workstreams WHERE name = ?").get(ws) as {
          created_at: string;
        }
      ).created_at,
    );
  const courseNote = (): void => {
    addTask(db, { workstream: "d", localId: "cc", title: "course" });
    addNote(db, "cc", "COURSE CHECK: on track", { workstream: "d" });
  };

  it("a fresh workstream: nothing due, even a day later", () => {
    expect(courseCheckHint(db, "d")).toBeUndefined();
    expect(courseCheckHint(db, "d", wsCreated() + 48 * H)).toBeUndefined();
  });

  it(`fires at ${COURSE_CHECK_CLOSED} closed work tasks, not at ${COURSE_CHECK_CLOSED - 1}`, () => {
    closeN(COURSE_CHECK_CLOSED - 1);
    expect(courseCheckHint(db, "d")).toBeUndefined();
    closeN(1, "d", COURSE_CHECK_CLOSED - 1);
    expect(courseCheckHint(db, "d")).toMatch(
      /^course check due: 10 closed since \d{4}-\d\d-\d\dT\d\d:\d\dZ \(recipes\/course-correct\.md\)$/,
    );
  });

  it("fires at 24 h with one closed task, not at 23 h", () => {
    closeN(1);
    const t0 = wsCreated();
    expect(courseCheckHint(db, "d", t0 + 23 * H)).toBeUndefined();
    expect(courseCheckHint(db, "d", t0 + COURSE_CHECK_AGE_MS)).toMatch(
      /^course check due: 1 closed/,
    );
  });

  it("a newer COURSE CHECK note clears it; a later note on an earlier close does not re-count it", async () => {
    closeN(COURSE_CHECK_CLOSED);
    expect(courseCheckHint(db, "d")).toBeDefined();
    courseNote();
    expect(courseCheckHint(db, "d")).toBeUndefined();
    // Notes bump updated_at, never the close note's time; 5 ms so they are strictly later.
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < COURSE_CHECK_CLOSED; i++) {
      addNote(db, `c${i}`, "after the check", { workstream: "d" });
    }
    expect(courseCheckHint(db, "d")).toBeUndefined();
    closeN(COURSE_CHECK_CLOSED, "d", COURSE_CHECK_CLOSED);
    expect(courseCheckHint(db, "d")).toMatch(/^course check due: 10 closed/);
  });

  it("counts only CLOSED/done work tasks of THIS workstream", () => {
    ensureWorkstream(db, "other");
    closeN(COURSE_CHECK_CLOSED, "other");
    expect(courseCheckHint(db, "d")).toBeUndefined();
    for (let i = 0; i < COURSE_CHECK_CLOSED; i++) {
      addTask(db, { workstream: "d", localId: `r${i}`, title: `r${i}` });
      closeTask(db, `r${i}`, { workstream: "d", as: "rejected", why: "no" });
    }
    expect(courseCheckHint(db, "d")).toBeUndefined();
  });

  it("computeNotices: one line, scoped, well inside the 4 KB result cap; read-only", () => {
    closeN(COURSE_CHECK_CLOSED);
    const ops = (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
    const lines = computeNotices(db, { callers: [], workstream: "d" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(Buffer.byteLength(lines[0] ?? "")).toBeLessThan(200);
    expect(computeNotices(db, { callers: [] })).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n).toBe(ops);
  });
});
