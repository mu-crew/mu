import { describe, expect, it } from "vitest";
import { DELEGATE_CANCEL_TOOL, type MuResult, registerDelegate } from "../extension/delegate.js";
import {
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
  const notes = (mu: ReturnType<typeof fakeMu>) =>
    mu.calls.filter((c) => c[0] === "task" && c[1] === "note");
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

  it("a done answer writes one note: REFUTER header, then the tail from the last VERDICT", async () => {
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
    const ns = notes(mu);
    expect(ns).toHaveLength(1);
    const [, , id, w, ws, a, author, text = ""] = ns[0] ?? [];
    expect([id, w, ws, a, author]).toEqual(["f1", "-w", "audit", "--author", "delegate-ref1"]);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^REFUTER ref1 \(delegate-ref1, \d+s\):$/);
    expect(lines.slice(1)).toEqual([
      "VERDICT: CONFIRMED (sev med) src/x.ts:12 skips the check",
      "EVIDENCE: npm test -> 1 failed",
      "EVIDENCE: grep -n check src/x.ts -> nothing",
    ]);
    expect(sentText(p)).toContain("Recorded on audit/f1 as a note");
    expect(sentText(p)).toContain(answer); // the answer still arrives in full
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
    const text = notes(mu)[0]?.[7] ?? "";
    expect(text.split("\n").slice(1)).toEqual(refuter.split("\n").slice(1));
  });

  it("a qualified ws/task names the workstream; the note goes there", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "audit/f2" } });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(notes(mu)[0]?.slice(0, 5)).toEqual(["task", "note", "f2", "-w", "audit"]);
  });

  it("an answer without a VERDICT line records its tail as NO VERDICT LINE", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    const long = `${"a".repeat(3000)}END`;
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: long }] }));
    await settle();
    const text = notes(mu)[0]?.at(-1) ?? "";
    const [head, second = "", ...rest] = text.split("\n");
    expect(head).toMatch(/^REFUTER r \(delegate-r, /);
    expect(second.startsWith("NO VERDICT LINE:")).toBe(true);
    const body = [second, ...rest].join("\n");
    expect(body.endsWith("END")).toBe(true);
    expect(body.length).toBeLessThan(1600);
    expect(notes(mu)[0]?.slice(2, 5)).toEqual(["f1", "-w", "crew"]);
  });

  it("caps a long verdict tail at about 4000 chars, marked [truncated]", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    const long = `VERDICT: CONFIRMED\n${"EVIDENCE: x\n".repeat(800)}`;
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: long }] }));
    await settle();
    const text = notes(mu)[0]?.at(-1) ?? "";
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain("[truncated]");
  });

  it.each(["timeout", "died", "empty", "error"])(
    "outcome %s records a no-verdict note",
    async (outcome) => {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
      mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome, lastError: "overloaded" }] }));
      await settle();
      expect(notes(mu)).toHaveLength(1);
      expect(notes(mu)[0]?.at(-1)).toBe(`REFUTER r: no verdict (${outcome})`);
    },
  );

  it("a cancelled delegate records a no-verdict note", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-r" });
    expect(notes(mu)[0]?.at(-1)).toBe("REFUTER r: no verdict (cancelled)");
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
    expect(notes(mu)).toHaveLength(1);
    expect(notes(mu)[0]?.at(-1)).toBe("REFUTER r: no verdict (empty)");
  });

  it("cancelling a queued delegate records a no-verdict note on its task", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      await tool(p).execute("b", { task: "two", label: "r", record: { task: "crew/f9" } });
      const c = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "queued-1" });
      expect(notes(mu)).toEqual([
        [
          "task",
          "note",
          "f9",
          "-w",
          "crew",
          "--author",
          "queued-1",
          "REFUTER r: no verdict (cancelled)",
        ],
      ]);
      expect(c.content[0]?.text).toContain("never started. Recorded on crew/f9 as a note.");
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("an unknown task fails the call before anything spawns", async () => {
    const mu = fakeMu({
      task: {
        show: () =>
          Promise.resolve({
            code: 3,
            stdout: JSON.stringify({ error: "TaskNotFoundError", message: "no such task: nope" }),
            stderr: "",
          }),
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

  it("a record without a task name is refused", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x", record: {} })).rejects.toThrow(/record\.task/);
    expect(mu.calls).toHaveLength(0);
  });

  it("a failed note write still delivers the answer and says why recording failed", async () => {
    const mu = fakeMu({
      task: { note: () => Promise.resolve({ code: 1, stdout: "", stderr: "db locked" }) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    const text = sentText(p);
    expect(text).toContain(answer);
    expect(text).toMatch(/Recording on crew\/f1 failed.*db locked/);
    expect(text).not.toContain("Recorded on");
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
      expect(notes(mu)).toHaveLength(0); // the first had no record
      mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
      await settle();
      expect(notes(mu)).toHaveLength(1);
      expect(notes(mu)[0]?.slice(2, 5)).toEqual(["f9", "-w", "crew"]);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("close and note overlap: both mu calls are issued before either answers", async () => {
    let releaseClose: (r: MuResult) => void = () => {};
    let releaseNote: (r: MuResult) => void = () => {};
    const mu = fakeMu({
      on: { close: () => new Promise((r) => (releaseClose = r)) },
      task: { note: () => new Promise((r) => (releaseNote = r)) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(mu.calls.some((c) => c[1] === "close")).toBe(true);
    expect(notes(mu)).toHaveLength(1);
    expect(p.sendMessage).not.toHaveBeenCalled(); // waits for both
    releaseNote(ok("{}"));
    await settle();
    expect(p.sendMessage).not.toHaveBeenCalled();
    releaseClose(ok("{}"));
    await settle();
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentText(p)).toContain("Recorded on crew/f1 as a note");
  });

  it("a refused close and a failed note are both reported", async () => {
    const mu = fakeMu({
      on: { close: () => Promise.resolve({ code: 4, stdout: "", stderr: "busy" }) },
      task: { note: () => Promise.resolve({ code: 3, stdout: "", stderr: "db locked" }) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" } });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    const text = sentText(p);
    expect(text).toMatch(/close refused: busy/);
    expect(text).toMatch(/Recording on crew\/f1 failed.*db locked/);
  });

  it("without record, no task verb is called", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(mu.calls.some((c) => c[0] === "task")).toBe(false);
    expect(sentText(p)).not.toContain("Recorded on");
  });
});
