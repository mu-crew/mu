// verdictTally (v_delegate): one result per call, attributed to the
// qualified judged task, never read back from label-matched notes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  finishDelegate,
  markDelegate,
  registerDelegateCall,
  verdictTally,
} from "../src/delegates.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
let n = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-delegate-tally-"));
  db = openDb({ path: join(dir, "mu.db") });
  n = 0;
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

const judged = (ws: string, id: string) => addTask(db, { workstream: ws, localId: id, title: id });
const reg = (
  over: Partial<Parameters<typeof registerDelegateCall>[1]> & {
    state?: "queued" | "starting" | "refused";
  },
) =>
  registerDelegateCall(db, {
    callId: `pi:s:c${++n}`,
    caller: "pi:s",
    workstream: "scratch",
    wave: "w",
    request: { text: "check" },
    ...over,
  }).call;
const done = (callId: string, text: string, outcome = "done") =>
  finishDelegate(db, callId, { outcome, text, author: `d${callId}` });
const rec = (ws: string, task: string) => ({ record: { workstream: ws, task } });
const finding = (t: ReturnType<typeof verdictTally>, id: string) =>
  t.findings.find((f) => f.id === id);

describe("verdictTally", () => {
  it("groups CONFIRMED / REFUTED / UNVERIFIED per judged finding, with the rest pending", () => {
    judged("crew", "f1");
    judged("crew", "f2");
    done(reg(rec("crew", "f1")).callId, "VERDICT: CONFIRMED yes");
    done(reg(rec("crew", "f1")).callId, "VERDICT: REFUTED no");
    done(reg(rec("crew", "f1")).callId, "VERDICT: CONFIRMED yes");
    done(reg(rec("crew", "f2")).callId, "VERDICT: UNVERIFIED cannot tell");
    reg({ ...rec("crew", "f2"), state: "queued" });
    const run = reg({ ...rec("crew", "f2"), state: "starting" });
    markDelegate(db, run.callId, "running");
    const t = verdictTally(db, "scratch", "w");
    expect(finding(t, "crew/f1")).toEqual({
      id: "crew/f1",
      confirmed: 2,
      refuted: 1,
      unverified: 0,
      pending: 0,
    });
    expect(finding(t, "crew/f2")).toEqual({
      id: "crew/f2",
      confirmed: 0,
      refuted: 0,
      unverified: 1,
      pending: 2,
    });
    expect(t).toMatchObject({ queued: 1, running: 1, refused: [] });
  });

  it("NO VERDICT, a failed run and a cancelled call all count UNVERIFIED", () => {
    judged("crew", "f1");
    done(reg(rec("crew", "f1")).callId, "I looked but wrote no verdict line");
    done(reg(rec("crew", "f1")).callId, "tail", "timeout");
    finishDelegate(db, reg({ ...rec("crew", "f1"), state: "queued" }).callId, {
      outcome: "cancelled",
      author: "me",
    });
    const f = finding(verdictTally(db, "scratch", "w"), "crew/f1");
    expect(f).toEqual({ id: "crew/f1", confirmed: 0, refuted: 0, unverified: 3, pending: 0 });
  });

  it("a refused call is pending and listed, never silently dropped", () => {
    judged("crew", "f1");
    const r = reg({ ...rec("crew", "f1"), state: "refused" });
    const t = verdictTally(db, "scratch", "w");
    expect(t.refused).toEqual([r.callId]);
    expect(finding(t, "crew/f1")?.pending).toBe(1);
    expect(t.queued).toBe(0);
  });

  it("counts one result per call id: a duplicate callback or a reissue never inflates it", () => {
    judged("crew", "f1");
    const c = reg(rec("crew", "f1"));
    done(c.callId, "VERDICT: CONFIRMED");
    done(c.callId, "VERDICT: CONFIRMED");
    const r = reg({ ...rec("crew", "f1"), state: "refused" });
    expect(finding(verdictTally(db, "scratch", "w"), "crew/f1")).toMatchObject({
      confirmed: 1,
      pending: 1,
    });
    expect(r.state).toBe("refused");
  });

  it("does not read historical or hand-written verdict notes off the judged task", () => {
    judged("crew", "f1");
    addNote(db, "f1", "REFUTER old (x, 1s):\nVERDICT: CONFIRMED", {
      workstream: "crew",
      kind: "verdict",
    });
    addNote(db, "f1", "VERDICT: REFUTED by hand", { workstream: "crew", kind: "verdict" });
    done(reg(rec("crew", "f1")).callId, "VERDICT: REFUTED the real one");
    expect(finding(verdictTally(db, "scratch", "w"), "crew/f1")).toEqual({
      id: "crew/f1",
      confirmed: 0,
      refuted: 1,
      unverified: 0,
      pending: 0,
    });
  });

  it("the same local id in two workstreams stays two findings", () => {
    judged("a", "f1");
    judged("b", "f1");
    done(reg(rec("a", "f1")).callId, "VERDICT: CONFIRMED");
    done(reg(rec("b", "f1")).callId, "VERDICT: REFUTED");
    const t = verdictTally(db, "scratch", "w");
    expect(finding(t, "a/f1")?.confirmed).toBe(1);
    expect(finding(t, "b/f1")?.refuted).toBe(1);
  });

  it("contradictory text: the label on the last VERDICT line, first known word", () => {
    judged("crew", "f1");
    done(
      reg(rec("crew", "f1")).callId,
      "VERDICT: CONFIRMED early\nmore\nVERDICT: REFUTED (not CONFIRMED)",
    );
    expect(finding(verdictTally(db, "scratch", "w"), "crew/f1")).toMatchObject({
      refuted: 1,
      confirmed: 0,
    });
  });

  it("only the asked wave in the asked workstream", () => {
    judged("crew", "f1");
    done(reg({ ...rec("crew", "f1"), wave: "other" }).callId, "VERDICT: CONFIRMED");
    done(reg({ ...rec("crew", "f1"), workstream: "crew" }).callId, "VERDICT: CONFIRMED");
    done(reg(rec("crew", "f1")).callId, "VERDICT: REFUTED");
    const t = verdictTally(db, "scratch", "w");
    expect(t.findings).toEqual([
      { id: "crew/f1", confirmed: 0, refuted: 1, unverified: 0, pending: 0 },
    ]);
  });

  it("a call with no record target is its own finding", () => {
    const c = reg({});
    done(c.callId, "VERDICT: CONFIRMED fine");
    const t = verdictTally(db, "scratch", "w");
    expect(t.findings).toHaveLength(1);
    expect(t.findings[0]).toMatchObject({ id: `scratch/${c.task}`, confirmed: 1 });
  });
});
