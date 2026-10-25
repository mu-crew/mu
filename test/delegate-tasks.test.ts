// Delegate calls as durable tasks (v_delegate): register, admission CAS,
// the single recorder (verdict -> report -> close), refusal and reissue.
// Real SQLite in a temp dir; no mux.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { parseVerdict } from "../src/delegate-verdict.js";
import {
  DelegateCallConflictError,
  DelegateStateError,
  finishDelegate,
  getDelegateCall,
  listDelegates,
  markDelegate,
  registerDelegateCall,
} from "../src/delegates.js";
import { addTask } from "../src/tasks/edit.js";
import { TaskNotFoundError } from "../src/tasks/errors.js";
import { selectTaskNotes } from "../src/tasks/queries.js";
import { getTask } from "../src/tasks.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
let n = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-delegate-tasks-"));
  db = openDb({ path: join(dir, "mu.db") });
  n = 0;
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

const judged = (ws: string, id: string) => addTask(db, { workstream: ws, localId: id, title: id });
const call = (over: Partial<Parameters<typeof registerDelegateCall>[1]> = {}) =>
  registerDelegateCall(db, {
    callId: `pi:s1:c${++n}`,
    caller: "pi:s1",
    workstream: "scratch",
    request: { text: "refute f1" },
    ...over,
  });
const notes = (ws: string, id: string) =>
  selectTaskNotes(db, id, { workstream: ws, all: true }).notes;
const longEvidence = `VERDICT: REFUTED the cap is wrong\nEVIDENCE:\n${"- line of evidence\n".repeat(400)}END-EVIDENCE-MARKER`;

describe("register", () => {
  it("creates a kind=delegate task with the brief, wave and a call row, in one go", () => {
    const { call: c, created } = call({
      wave: "w1",
      request: { text: "refute f1", label: "ref1" },
    });
    expect(created).toBe(true);
    const t = getTask(db, c.task, "scratch");
    expect(t).toMatchObject({ kind: "delegate", wave: "w1", status: "OPEN" });
    expect(notes("scratch", c.task).map((x) => [x.kind, x.content])).toEqual([
      ["brief", "refute f1"],
    ]);
    expect(c).toMatchObject({
      caller: "pi:s1",
      state: "queued",
      wave: "w1",
      workstream: "scratch",
    });
    expect(getDelegateCall(db, c.callId)?.task).toBe(c.task);
  });

  it("a queued or refused call is parked (outside next/ready); a starting one is todo", () => {
    const q = call({ state: "queued" }).call;
    const r = call({ state: "refused" }).call;
    const s = call({ state: "starting" }).call;
    expect(getTask(db, q.task, "scratch")?.substate).toBe("parked");
    expect(getTask(db, r.task, "scratch")?.substate).toBe("parked");
    expect(getTask(db, s.task, "scratch")?.substate).toBe("todo");
    const ready = db.prepare("SELECT local_id FROM ready").all() as { local_id: string }[];
    expect(ready.map((x) => x.local_id)).toEqual([s.task]);
  });

  it("is atomic: a record target that does not exist rolls the whole call back", () => {
    expect(() =>
      call({ callId: "pi:s1:bad", record: { workstream: "crew", task: "nope" } }),
    ).toThrow(TaskNotFoundError);
    expect(db.prepare("SELECT COUNT(*) AS c FROM delegate_calls").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM task_notes").get()).toEqual({ c: 0 });
  });

  it("repeating the same call id with the same request is idempotent", () => {
    const a = call({ callId: "pi:s1:x" });
    const b = call({ callId: "pi:s1:x" });
    expect(b.created).toBe(false);
    expect(b.call.task).toBe(a.call.task);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get()).toEqual({ c: 1 });
    expect(notes("scratch", a.call.task)).toHaveLength(1);
  });

  it("a changed request under the same call id is rejected and changes nothing", () => {
    call({ callId: "pi:s1:x" });
    const bad = [
      { request: { text: "something else" } },
      { request: { text: "refute f1", model: "other" } },
      { caller: "pi:s2" },
      { wave: "w9" },
      { workstream: "crew" },
    ];
    for (const over of bad)
      expect(() => call({ callId: "pi:s1:x", ...over })).toThrow(DelegateCallConflictError);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM delegate_calls").get()).toEqual({ c: 1 });
  });

  it("keeps the spawn options durable (cli, model, cwd, workspace, timeout, keep)", () => {
    const req = {
      text: "t",
      cli: "pi",
      model: "p/m:high",
      cwd: "/x",
      workspace: false,
      timeoutS: 90,
      keep: true,
    };
    const { call: c } = call({ request: req });
    expect(getDelegateCall(db, c.callId)?.request).toEqual(req);
  });

  it("same call id from two sessions never collides: ids are session-qualified by the caller", () => {
    const a = call({ callId: "pi:s1:c1" });
    const b = call({ callId: "pi:s2:c1", caller: "pi:s2" });
    expect(a.call.task).not.toBe(b.call.task);
  });
});

describe("admission", () => {
  it("queued -> starting unparks; starting -> running names the agent", () => {
    const { call: c } = call();
    const s = markDelegate(db, c.callId, "starting");
    expect(s.state).toBe("starting");
    expect(getTask(db, c.task, "scratch")?.substate).toBe("todo");
    const r = markDelegate(db, c.callId, "running", { agent: "delegate-ref1" });
    expect(r).toMatchObject({ state: "running", agent: "delegate-ref1" });
  });

  it("two runtimes cannot both start one call: the second CAS loses", () => {
    const { call: c } = call();
    markDelegate(db, c.callId, "starting");
    expect(() => markDelegate(db, c.callId, "starting")).toThrow(DelegateStateError);
  });

  it("refuses an illegal transition", () => {
    const { call: c } = call({ state: "starting" });
    markDelegate(db, c.callId, "running");
    expect(() => markDelegate(db, c.callId, "starting")).toThrow(DelegateStateError);
    expect(() => markDelegate(db, c.callId, "refused")).toThrow(DelegateStateError); // only queued/starting can be refused
    expect(() => markDelegate(db, c.callId, "done" as never)).toThrow(DelegateStateError); // done is finish's
  });
});

describe("finish: record before report and close", () => {
  it("done: verdict note (whole multi-line EVIDENCE) on the judged task, then the report and close, in ONE op group", () => {
    judged("crew", "f1");
    const { call: c } = call({
      record: { workstream: "crew", task: "f1" },
      request: { text: "refute f1", label: "ref1" },
    });
    markDelegate(db, c.callId, "starting");
    markDelegate(db, c.callId, "running", { agent: "delegate-ref1" });
    const r = finishDelegate(db, c.callId, {
      outcome: "done",
      text: `thinking...\n${longEvidence}`,
      elapsedMs: 65_000,
      author: "delegate-ref1",
    });
    expect(r).toMatchObject({ changed: true, state: "done", recorded: true, verdict: "REFUTED" });
    const v = notes("crew", "f1").filter((x) => x.kind === "verdict");
    expect(v).toHaveLength(1);
    expect(v[0]?.author).toBe("delegate-ref1");
    expect(v[0]?.content.length).toBeGreaterThan(6000);
    expect(v[0]?.content).toContain("END-EVIDENCE-MARKER");
    expect(v[0]?.content).not.toContain("[truncated]");
    expect(
      v[0]?.content.startsWith("REFUTER ref1 (delegate-ref1, 1m 05s):\nVERDICT: REFUTED"),
    ).toBe(true);
    // The delegate task keeps the full answer as its report and is closed done.
    const rep = notes("scratch", c.task).filter((x) => x.kind === "report");
    expect(rep).toHaveLength(1);
    expect(rep[0]?.content).toContain("thinking...");
    expect(rep[0]?.content).toContain("END-EVIDENCE-MARKER");
    expect(getTask(db, c.task, "scratch")).toMatchObject({ status: "CLOSED", substate: "done" });
    // One op group holds the verdict note, the report, the close and the status put,
    // verdict first.
    const finish = db
      .prepare(
        "SELECT entity, key, group_id FROM ops WHERE intent = 'delegate.finish' ORDER BY seq",
      )
      .all() as { entity: string; key: string; group_id: string }[];
    expect(new Set(finish.map((o) => o.group_id)).size).toBe(1);
    expect(finish.map((o) => `${o.entity} ${o.key.split("#")[0]}`)).toEqual([
      "note crew/f1",
      "task crew/f1",
      `note scratch/${c.task}`,
      `note scratch/${c.task}`,
      `task scratch/${c.task}`,
    ]);
  });

  it("accepts the hand-written 'REFUTER: VERDICT:' shape and keeps everything after it", () => {
    judged("crew", "f1");
    const { call: c } = call({ record: { workstream: "crew", task: "f1" } });
    const answer = "notes\nREFUTER: VERDICT: CONFIRMED sev med\nEVIDENCE:\n- a\n- b";
    const r = finishDelegate(db, c.callId, { outcome: "done", text: answer, author: "d" });
    expect(r.verdict).toBe("CONFIRMED");
    const v = notes("crew", "f1").find((x) => x.kind === "verdict")?.content ?? "";
    expect(v).toContain("REFUTER: VERDICT: CONFIRMED sev med\nEVIDENCE:\n- a\n- b");
    expect(v).not.toContain("NO VERDICT LINE");
    expect(v).not.toContain("notes\n");
  });

  it("the FIRST verdict line decides; a verdict quoted later in the EVIDENCE is stored verbatim and never replaces it", () => {
    judged("crew", "f1");
    const answer = [
      "Checked.",
      "VERDICT: crew/f1 REFUTED the guard exists",
      "EVIDENCE:",
      "- src/a.ts:10 guard",
      "- the earlier review said: VERDICT: CONFIRMED (it was wrong)",
      "- see the log: VERDICT: CONFIRMED",
      "REFUTER: VERDICT: CONFIRMED (a quoted role-prefixed line, also evidence)",
      "- src/b.ts:3 ...",
    ].join("\n");
    const { call: c } = call({ record: { workstream: "crew", task: "f1" } });
    const r = finishDelegate(db, c.callId, { outcome: "done", text: answer, author: "d" });
    expect(r.verdict).toBe("REFUTED");
    expect(getDelegateCall(db, c.callId)?.verdict).toBe("REFUTED");
    const v = notes("crew", "f1").find((x) => x.kind === "verdict")?.content ?? "";
    // The WHOLE body after the verdict line: the real line, the evidence above the quote, the quotes.
    expect(v.split("\n").slice(1)).toEqual(answer.split("\n").slice(1));
  });

  it("only an optional single role word may precede VERDICT:; prose, lowercase and multi-word prefixes do not", () => {
    const label = (t: string) => parseVerdict(t);
    expect(label("VERDICT: CONFIRMED")).toBe("CONFIRMED");
    expect(label("REFUTER: VERDICT: REFUTED")).toBe("REFUTED");
    expect(label("noise\nrefuter: VERDICT: UNVERIFIED")).toBe("UNVERIFIED");
    expect(label("the earlier review said: VERDICT: CONFIRMED")).toBeUndefined();
    expect(label("- see the log: VERDICT: CONFIRMED")).toBeUndefined();
    expect(label("two words: VERDICT: CONFIRMED")).toBeUndefined();
    expect(label("> VERDICT: CONFIRMED")).toBeUndefined();
    expect(label("x VERDICT: CONFIRMED")).toBeUndefined();
    // A prose line first, the real one second: the real one is the first VERDICT line.
    expect(label("- the log said: VERDICT: CONFIRMED\nVERDICT: REFUTED")).toBe("REFUTED");
  });

  it("no VERDICT line: the whole long answer is kept, marked, and no label is parsed", () => {
    judged("crew", "f1");
    const { call: c } = call({ record: { workstream: "crew", task: "f1" } });
    const answer = `${"x".repeat(6000)}\nEND`;
    const r = finishDelegate(db, c.callId, { outcome: "done", text: answer, author: "d" });
    expect(r).toMatchObject({ state: "done", recorded: true });
    expect(r.verdict).toBeNull();
    const v = notes("crew", "f1").find((x) => x.kind === "verdict")?.content ?? "";
    expect(v).toContain("NO VERDICT LINE:");
    expect(v.endsWith("END")).toBe(true);
    expect(v.length).toBeGreaterThan(6000);
  });

  it("commits `recording` before the group, then done; a failed record leaves recording -> failed, never done", () => {
    // A trigger logs every state the row ever held (each in its own committed or rolled-back txn).
    db.exec(
      "CREATE TABLE state_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, state TEXT)",
    );
    db.exec(
      `CREATE TRIGGER log_state AFTER UPDATE OF state ON delegate_calls
       BEGIN INSERT INTO state_log (call_id, state) VALUES (NEW.call_id, NEW.state); END`,
    );
    const states = (id: string) =>
      (
        db.prepare("SELECT state FROM state_log WHERE call_id = ? ORDER BY seq").all(id) as {
          state: string;
        }[]
      ).map((r) => r.state);
    judged("crew", "f1");
    judged("crew", "f2");
    const ok = call({ record: { workstream: "crew", task: "f1" } }).call;
    finishDelegate(db, ok.callId, { outcome: "done", text: "VERDICT: CONFIRMED", author: "d" });
    expect(states(ok.callId)).toEqual(["recording", "done"]);
    const bad = call({ record: { workstream: "crew", task: "f2" } }).call;
    db.prepare("DELETE FROM tasks WHERE local_id = 'f2'").run();
    finishDelegate(db, bad.callId, { outcome: "done", text: "VERDICT: CONFIRMED", author: "d" });
    expect(states(bad.callId)).toEqual(["recording", "failed"]);
  });

  it("the admission CAS holds when another runtime wins between the read and the update", () => {
    const { call: c } = call({ state: "refused" });
    const other = (id: string, to: string) =>
      db.prepare("UPDATE delegate_calls SET state = ? WHERE call_id = ?").run(to, id);
    // A db whose write transaction opens after a rival runtime's own COMMITTED
    // write: past markDelegate's pre-read, before its in-transaction CAS.
    const racing = (rival: () => void): Db =>
      new Proxy(db, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target) as unknown;
          if (prop === "exec")
            return (sql: string) => {
              if (sql === "BEGIN IMMEDIATE") rival();
              return target.exec(sql);
            };
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    // We read `refused`; the rival has already moved it to `starting` by the time we write.
    expect(() =>
      markDelegate(
        racing(() => other(c.callId, "starting")),
        c.callId,
        "queued",
      ),
    ).toThrow(DelegateStateError);
    expect(getDelegateCall(db, c.callId)?.state).toBe("starting"); // the rival's, not overwritten
    // And the guard keeps our side effects out: a rival's refusal stays parked, not unparked by our start.
    const { call: d } = call({ state: "queued" });
    expect(() =>
      markDelegate(
        racing(() => other(d.callId, "refused")),
        d.callId,
        "starting",
      ),
    ).toThrow(DelegateStateError);
    expect(getDelegateCall(db, d.callId)?.state).toBe("refused");
    expect(getTask(db, d.task, "scratch")?.substate).toBe("parked");
  });

  it("a duplicate callback writes one verdict, one report, one close", () => {
    judged("crew", "f1");
    const { call: c } = call({ record: { workstream: "crew", task: "f1" } });
    const a = finishDelegate(db, c.callId, {
      outcome: "done",
      text: "VERDICT: CONFIRMED",
      author: "d",
    });
    const b = finishDelegate(db, c.callId, {
      outcome: "done",
      text: "VERDICT: REFUTED",
      author: "d",
    });
    expect(a.changed).toBe(true);
    expect(b).toMatchObject({ changed: false, state: "done" });
    expect(notes("crew", "f1").filter((x) => x.kind === "verdict")).toHaveLength(1);
    expect(notes("scratch", c.task).filter((x) => x.kind === "report")).toHaveLength(1);
    expect(getDelegateCall(db, c.callId)?.verdict).toBe("CONFIRMED");
  });

  it("a timeout records 'no verdict' on the judged task, keeps the tail as the report, closes non-done", () => {
    judged("crew", "f1");
    const { call: c } = call({
      record: { workstream: "crew", task: "f1" },
      request: { text: "t", label: "slow" },
    });
    const r = finishDelegate(db, c.callId, {
      outcome: "timeout",
      text: "pane tail\nlast lines",
      author: "delegate-slow",
    });
    expect(r).toMatchObject({ state: "failed", recorded: true });
    expect(r.verdict).toBeNull();
    expect(notes("crew", "f1").find((x) => x.kind === "verdict")?.content).toBe(
      "REFUTER slow: no verdict (timeout)",
    );
    expect(notes("scratch", c.task).find((x) => x.kind === "report")?.content).toContain(
      "last lines",
    );
    expect(getTask(db, c.task, "scratch")).toMatchObject({
      status: "CLOSED",
      substate: "rejected",
    });
    expect(getDelegateCall(db, c.callId)?.state).toBe("failed");
  });

  it("without a record target: report and close only", () => {
    const { call: c } = call();
    const r = finishDelegate(db, c.callId, { outcome: "done", text: "the answer", author: "d" });
    expect(r).toMatchObject({ state: "done", recorded: false, record: null });
    expect(getTask(db, c.task, "scratch")).toMatchObject({ status: "CLOSED", substate: "done" });
  });

  it("a record that fails never becomes done: failed, task closed rejected, the answer kept, nothing half-written", () => {
    judged("crew", "f1");
    const { call: c } = call({ record: { workstream: "crew", task: "f1" } });
    db.prepare("DELETE FROM tasks WHERE local_id = 'f1'").run();
    const r = finishDelegate(db, c.callId, {
      outcome: "done",
      text: "VERDICT: CONFIRMED\nEVIDENCE: kept",
      author: "d",
    });
    expect(r).toMatchObject({ changed: true, state: "failed", recorded: false });
    expect(r.error).toMatch(/record/i);
    expect(getDelegateCall(db, c.callId)).toMatchObject({ state: "failed" });
    expect(getTask(db, c.task, "scratch")).toMatchObject({
      status: "CLOSED",
      substate: "rejected",
    });
    expect(notes("scratch", c.task).find((x) => x.kind === "report")?.content).toContain(
      "EVIDENCE: kept",
    );
  });

  it("cancelling a queued call persists a report and a non-done close", () => {
    const { call: c } = call({ state: "queued" });
    const r = finishDelegate(db, c.callId, { outcome: "cancelled", author: "pi:s1" });
    expect(r).toMatchObject({ state: "cancelled", changed: true });
    expect(getTask(db, c.task, "scratch")).toMatchObject({ status: "CLOSED", substate: "wontfix" });
    expect(notes("scratch", c.task).some((x) => x.kind === "report")).toBe(true);
    expect(notes("scratch", c.task).some((x) => x.kind === "close")).toBe(true);
  });

  it("same local id in two workstreams: each verdict lands on its own judged task", () => {
    judged("a", "f1");
    judged("b", "f1");
    const x = call({ record: { workstream: "a", task: "f1" } }).call;
    const y = call({ record: { workstream: "b", task: "f1" } }).call;
    finishDelegate(db, x.callId, { outcome: "done", text: "VERDICT: CONFIRMED", author: "dx" });
    finishDelegate(db, y.callId, { outcome: "done", text: "VERDICT: REFUTED", author: "dy" });
    expect(notes("a", "f1").map((v) => v.author)).toEqual(["dx"]);
    expect(notes("b", "f1").map((v) => v.author)).toEqual(["dy"]);
  });
});

describe("refusal and reissue", () => {
  it("a refused call is a durable, listable, parked row with its brief and record target", () => {
    judged("crew", "f1");
    const { call: r } = call({ state: "refused", record: { workstream: "crew", task: "f1" } });
    expect(r.state).toBe("refused");
    expect(notes("scratch", r.task)[0]?.kind).toBe("brief");
    expect(listDelegates(db, "pi:s1").map((x) => [x.callId, x.state, x.record?.task])).toEqual([
      [r.callId, "refused", "f1"],
    ]);
    expect(getTask(db, r.task, "scratch")?.substate).toBe("parked");
  });

  it("reissue (the runtime's mark) keeps the call and task, moves refused -> queued, and never doubles a verdict", () => {
    judged("crew", "f1");
    const { call: r } = call({ state: "refused", record: { workstream: "crew", task: "f1" } });
    const again = markDelegate(db, r.callId, "queued");
    expect(again).toMatchObject({ callId: r.callId, task: r.task, state: "queued", error: null });
    expect(() => markDelegate(db, r.callId, "queued")).toThrow(DelegateStateError); // not refused any more
    markDelegate(db, r.callId, "starting");
    finishDelegate(db, r.callId, { outcome: "done", text: "VERDICT: CONFIRMED", author: "d" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE kind = 'delegate'").get()).toEqual({
      c: 1,
    });
    expect(notes("crew", "f1").filter((x) => x.kind === "verdict")).toHaveLength(1);
  });

  it("saturation: 2 running + 8 queued + 2 refused; each refused is reissued exactly once", () => {
    const rows = [
      ...Array.from({ length: 2 }, () => call({ state: "starting" }).call),
      ...Array.from({ length: 8 }, () => call({ state: "queued" }).call),
      ...Array.from({ length: 2 }, () => call({ state: "refused" }).call),
    ];
    const by = (s: string) => listDelegates(db, "pi:s1").filter((x) => x.state === s).length;
    expect([by("starting"), by("queued"), by("refused")]).toEqual([2, 8, 2]);
    const refused = rows.filter((r) => r.state === "refused");
    for (const r of refused) markDelegate(db, r.callId, "queued");
    expect([by("queued"), by("refused")]).toEqual([10, 0]);
    for (const r of refused)
      expect(() => markDelegate(db, r.callId, "queued")).toThrow(DelegateStateError);
    expect(db.prepare("SELECT COUNT(*) AS c FROM delegate_calls").get()).toEqual({ c: 12 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get()).toEqual({ c: 12 });
  });
});

describe("listDelegates", () => {
  it("filters by caller, workstream and wave", () => {
    call({ wave: "w1" });
    call({ wave: "w2", workstream: "crew" });
    call({ caller: "pi:s2", callId: "pi:s2:c1", wave: "w1" });
    expect(listDelegates(db, "pi:s1")).toHaveLength(2);
    expect(listDelegates(db, "pi:s1", "crew")).toHaveLength(1);
    expect(listDelegates(db, "pi:s1", undefined, { wave: "w1" })).toHaveLength(1);
    expect(listDelegates(db, undefined, undefined, { wave: "w1" })).toHaveLength(2);
  });
});

describe("schema", () => {
  it("a v13 DB written before request/verdict/agent existed gains them in place and keeps its rows", () => {
    const { call: c } = call();
    db.close();
    const path = join(dir, "mu.db");
    const raw = new Database(path);
    for (const col of ["request", "verdict", "agent"])
      raw.exec(`ALTER TABLE delegate_calls DROP COLUMN ${col}`);
    raw.close();
    db = openDb({ path });
    const cols = (
      db.prepare("SELECT name FROM pragma_table_info('delegate_calls')").all() as { name: string }[]
    ).map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["request", "verdict", "agent"]));
    const old = getDelegateCall(db, c.callId);
    expect(old).toMatchObject({ callId: c.callId, state: "queued" });
    // An old row has no request (the brief note holds the text); it can still finish.
    expect(
      finishDelegate(db, c.callId, { outcome: "done", text: "VERDICT: CONFIRMED", author: "d" })
        .state,
    ).toBe("done");
  });
});
