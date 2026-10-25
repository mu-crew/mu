import { describe, expect, it } from "vitest";
import { DELEGATE_CANCEL_TOOL, type MuResult, registerDelegate } from "../extension/delegate.js";
import { listDelegates } from "../src/delegates.js";
import { selectTaskNotes } from "../src/tasks/queries.js";
import { getTask } from "../src/tasks.js";
import {
  type FakeMu,
  failed,
  fakeMu,
  fakePi,
  flush,
  installDelegateEnv,
  ok,
  sentText,
  tool,
} from "./_delegate-fixtures.js";

installDelegateEnv();

describe("record", () => {
  /** The `mu task note` calls: the recorder writes in-process now, so none. */
  const noteCalls = (mu: FakeMu) => mu.calls.filter((c) => c[0] === "task" && c[1] === "note");
  /** The notes of a task, read from the real DB. */
  const notesOf = (mu: FakeMu, ws: string, id: string) =>
    selectTaskNotes(mu.db, id, { workstream: ws, all: true }).notes;
  const verdicts = (mu: FakeMu, ws: string, id: string) =>
    notesOf(mu, ws, id).filter((n) => n.kind === "verdict");
  /** The one delegate call of the DB. */
  const theCall = (mu: FakeMu, i = 0) => {
    const c = listDelegates(mu.db)[i];
    if (!c) throw new Error("no delegate call registered");
    return c;
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++) await flush();
  };
  const answer = [
    "I read src/x.ts.",
    "VERDICT: early draft",
    "more thinking",
    "VERDICT: CONFIRMED (sev med) src/x.ts:12 skips the check",
    "EVIDENCE: npm test -> 1 failed",
    "EVIDENCE: grep -n check src/x.ts -> nothing",
  ].join("\n");

  it("a done answer lands as ONE verdict note: REFUTER header, then the tail from the last VERDICT", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", {
      task: "refute f1",
      label: "ref1",
      record: { task: "f1", workstream: "audit" },
    });
    expect(mu.calls.find((c) => c[0] === "task" && c[1] === "show")).toEqual([
      "task",
      "show",
      "f1",
      "-w",
      "audit",
      "--json",
    ]);
    mu.waits.get("delegate-ref1")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(noteCalls(mu)).toHaveLength(0); // no `mu task note`: one recorder (`mu delegates finish`)
    const v = verdicts(mu, "audit", "f1");
    expect(v).toHaveLength(1);
    expect(v[0]?.author).toBe("delegate-ref1");
    const lines = (v[0]?.content ?? "").split("\n");
    expect(lines[0]).toMatch(/^REFUTER ref1 \(delegate-ref1, \d+s\):$/);
    expect(lines.slice(1)).toEqual([
      "VERDICT: CONFIRMED (sev med) src/x.ts:12 skips the check",
      "EVIDENCE: npm test -> 1 failed",
      "EVIDENCE: grep -n check src/x.ts -> nothing",
    ]);
    expect(sentText(p)).toContain("Recorded on audit/f1 as a note");
    expect(sentText(p)).toContain(answer); // the answer still arrives in full
    expect(theCall(mu)).toMatchObject({ state: "done", verdict: "CONFIRMED" });
  });

  it("a multi-line EVIDENCE body after the header is kept, not just the EVIDENCE: lines", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    const refuter = [
      "Checked the claim.",
      "VERDICT: REFUTED src/x.ts:12 the guard exists",
      "EVIDENCE:",
      "- src/x.ts:10 `if (!ok) return`",
      "- $ npm test -> 12 passed",
      "",
      "  indented detail line",
    ].join("\n");
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: refuter }] }));
    await settle();
    const text = verdicts(mu, "crew", "f1")[0]?.content ?? "";
    expect(text.split("\n").slice(1)).toEqual(refuter.split("\n").slice(1));
  });

  it("a qualified ws/task names the workstream; the note goes there", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "audit/f2" } });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(verdicts(mu, "audit", "f2")).toHaveLength(1);
    expect(theCall(mu).record).toMatchObject({ workstream: "audit", task: "f2" });
  });

  it("an answer without a VERDICT line records the WHOLE answer as NO VERDICT LINE", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    const long = `${"a".repeat(6000)}END`;
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: long }] }));
    await settle();
    const text = verdicts(mu, "crew", "f1")[0]?.content ?? "";
    const [head, second = ""] = text.split("\n");
    expect(head).toMatch(/^REFUTER r \(delegate-r, /);
    expect(second.startsWith("NO VERDICT LINE:")).toBe(true);
    expect(text.endsWith("END")).toBe(true);
    expect(text.length).toBeGreaterThan(6000); // nothing cut
    expect(theCall(mu)).toMatchObject({ state: "done", verdict: null });
  });

  it("keeps a long verdict tail whole: no 4000 cap, no [truncated]", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    const long = `VERDICT: CONFIRMED\n${"EVIDENCE: x\n".repeat(800)}END-EVIDENCE-MARKER`;
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: long }] }));
    await settle();
    const text = verdicts(mu, "crew", "f1")[0]?.content ?? "";
    expect(text.length).toBeGreaterThan(9000);
    expect(text).toContain("END-EVIDENCE-MARKER");
    expect(text).not.toContain("[truncated]");
    // the delegate task's report holds the same full answer
    const c = theCall(mu);
    const report = notesOf(mu, c.workstream, c.task).find((n) => n.kind === "report");
    expect(report?.content).toContain("END-EVIDENCE-MARKER");
  });

  it("accepts the hand-written 'REFUTER: VERDICT:' shape", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    const hand = "notes\nREFUTER: VERDICT: REFUTED the guard exists\nEVIDENCE:\n- a\n- b";
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: hand }] }));
    await settle();
    const text = verdicts(mu, "crew", "f1")[0]?.content ?? "";
    expect(text).toContain("REFUTER: VERDICT: REFUTED the guard exists\nEVIDENCE:\n- a\n- b");
    expect(text).not.toContain("NO VERDICT LINE");
    expect(theCall(mu).verdict).toBe("REFUTED");
  });

  it.each(["timeout", "died", "empty", "error"])(
    "outcome %s records a no-verdict note and closes the delegate task non-done",
    async (outcome) => {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
      mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome, lastError: "overloaded" }] }));
      await settle();
      expect(verdicts(mu, "crew", "f1").map((n) => n.content)).toEqual([
        `REFUTER r: no verdict (${outcome})`,
      ]);
      const c = theCall(mu);
      expect(c.state).toBe("failed");
      expect(getTask(mu.db, c.task, c.workstream)).toMatchObject({
        status: "CLOSED",
        substate: "rejected",
      });
    },
  );

  it("a cancelled delegate records a no-verdict note", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-r" });
    expect(verdicts(mu, "crew", "f1").map((n) => n.content)).toEqual([
      "REFUTER r: no verdict (cancelled)",
    ]);
    expect(theCall(mu).state).toBe("cancelled");
  });

  it("a done answer that is only whitespace records a no-verdict note (empty)", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    mu.waits
      .get("delegate-r")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: " \n\t\n " }] }));
    await settle();
    expect(verdicts(mu, "crew", "f1").map((n) => n.content)).toEqual([
      "REFUTER r: no verdict (empty)",
    ]);
  });

  it("cancelling a queued delegate records a no-verdict note and closes its task", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      await tool(p).execute("b", { task: "two", label: "r", record: { task: "crew/f9" } });
      const c = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "queued-1" });
      expect(verdicts(mu, "crew", "f9")).toHaveLength(1);
      expect(verdicts(mu, "crew", "f9")[0]?.content).toBe("REFUTER r: no verdict (cancelled)");
      expect(verdicts(mu, "crew", "f9")[0]?.author).toBe("queued-1");
      expect(c.content[0]?.text).toContain("never started.");
      expect(c.content[0]?.text).toContain("Recorded on crew/f9 as a note");
      const q = theCall(mu, 1);
      expect(q.state).toBe("cancelled");
      expect(getTask(mu.db, q.task, q.workstream)).toMatchObject({ status: "CLOSED" });
      expect(notesOf(mu, q.workstream, q.task).some((n) => n.kind === "report")).toBe(true);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("an unknown task fails the call before anything spawns", async () => {
    const mu = fakeMu({
      task: {
        show: () => Promise.resolve(failed(3, "TaskNotFoundError", "no such task: nope")),
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(
      tool(p).execute("t", { task: "x", record: { task: "nope", workstream: "audit" } }),
    ).rejects.toThrow(/record.*nope.*no such task/);
    expect(mu.calls.some((c) => c[1] === "spawn" || c[1] === "list")).toBe(false);
  });

  it("a bare record.task with no workstream is refused before anything spawns", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x", record: { task: "f1" } })).rejects.toThrow(
      /record\.task f1 needs a workstream.*crew\/f1|<workstream>\/f1/,
    );
    expect(mu.calls).toHaveLength(0);
  });

  it("record.workstream or a qualified task names the scope", async () => {
    for (const record of [{ task: "f1", workstream: "audit" }, { task: "audit/f1" }]) {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("t", { task: "x", label: "r", record });
      const show = mu.calls.find((c) => c[0] === "task" && c[1] === "show");
      expect(show?.slice(0, 3)).toEqual(["task", "show", record.task]);
    }
  });

  it.each([
    [{ task: "t-own", workstream: " own" }],
    [{ task: "t-own", workstream: "own " }],
    [{ task: "t-own", workstream: "" }],
    [{ task: "t-own", workstream: "  " }],
    [{ task: " own/t-own" }],
    [{ task: "own /t-own" }],
    [{ task: "/t-own" }],
    [{ task: " t-own", workstream: "own" }],
    [{ task: "own/t-own", workstream: "decoy" }],
  ])("an invalid record scope %j is refused: no mu call, never trimmed", async (record) => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x", record })).rejects.toThrow(
      /mu_delegate: .*Nothing spawned/,
    );
    expect(mu.calls).toHaveLength(0);
  });

  it("a record without a task name is refused", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x", record: {} })).rejects.toThrow(/record\.task/);
    expect(mu.calls).toHaveLength(0);
  });

  it("a record that fails never becomes done: the answer is still delivered, the call is failed, the pane is kept", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    // The judged task vanishes between the call and its answer.
    mu.db.prepare("DELETE FROM tasks WHERE local_id = 'f1'").run();
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    const text = sentText(p);
    expect(text).toContain(answer);
    expect(text).toMatch(/record crew\/f1 failed/);
    expect(text).toContain("kept as the report");
    expect(text).not.toContain("Recorded on");
    const c = theCall(mu);
    expect(c.state).toBe("failed");
    expect(getTask(mu.db, c.task, c.workstream)).toMatchObject({
      status: "CLOSED",
      substate: "rejected",
    });
    // The answer stays retrievable from the delegate task; the evidence pane is not closed.
    expect(notesOf(mu, c.workstream, c.task).find((n) => n.kind === "report")?.content).toContain(
      "EVIDENCE: grep -n check src/x.ts -> nothing",
    );
    expect(mu.calls.some((c2) => c2[1] === "close")).toBe(false);
    expect(mu.registry.has("delegate-r")).toBe(true);
  });

  it("a queued delegate records too", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      const q = await tool(p).execute("b", {
        task: "two",
        label: "r",
        record: { task: "crew/f9" },
      });
      expect(q.content[0]?.text).toContain("queued-1");
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      await settle();
      expect(verdicts(mu, "crew", "f9")).toHaveLength(0); // the first had no record
      mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
      await settle();
      expect(verdicts(mu, "crew", "f9")).toHaveLength(1);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("the delegate task is closed BEFORE the pane: close waits for the recorded result", async () => {
    let releaseClose: (r: MuResult) => void = () => {};
    const mu = fakeMu({ on: { close: () => new Promise((r) => (releaseClose = r)) } });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    // The pane close is in flight, and by now the result is already durable.
    expect(mu.calls.some((c) => c[1] === "close")).toBe(true);
    const order = mu.calls.map((c) =>
      c[0] === "delegates" ? `delegates ${c[1]}` : `${c[0]} ${c[1]}`,
    );
    expect(order.indexOf("delegates finish")).toBeLessThan(order.indexOf("agent close"));
    expect(theCall(mu).state).toBe("done");
    expect(verdicts(mu, "crew", "f1")).toHaveLength(1);
    expect(p.sendMessage).not.toHaveBeenCalled(); // waits for the close
    releaseClose(ok("{}"));
    await settle();
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentText(p)).toContain("Recorded on crew/f1 as a note");
  });

  it("a refused close (the fenced apply) is reported; the result is already on record", async () => {
    const mu = fakeMu({
      on: {
        // the preview (no --if) answers; the apply is refused
        close: (args) =>
          args.includes("--if")
            ? Promise.resolve({ code: 4, stdout: "", stderr: "busy" })
            : undefined,
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    const text = sentText(p);
    expect(text).toMatch(/close refused: busy/);
    expect(text).toContain("Recorded on crew/f1 as a note");
    expect(theCall(mu).state).toBe("done");
  });

  it("a failed close preview keeps the pane and never applies", async () => {
    const mu = fakeMu({
      on: { close: () => Promise.resolve({ code: 4, stdout: "", stderr: "busy" }) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r" });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(sentText(p)).toMatch(/Pane kept \(close preview failed: busy\)/);
    expect(mu.calls.filter((c) => c[1] === "close" && c.includes("--if"))).toEqual([]);
    expect(mu.registry.has("delegate-r")).toBe(true);
  });

  it("without record, no task verb is called; the answer is still the delegate task's report", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(mu.calls.some((c) => c[0] === "task")).toBe(false);
    expect(sentText(p)).not.toContain("Recorded on");
    const c = theCall(mu);
    expect(c).toMatchObject({ state: "done", record: null });
    expect(notesOf(mu, c.workstream, c.task).find((n) => n.kind === "report")?.content).toBe(
      answer,
    );
    expect(sentText(p)).toContain(`mu task notes ${c.task} -w scratch`);
  });
});
