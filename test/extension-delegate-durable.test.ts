// What survives a lost pi echo, an Escape, a compaction-time clear and a
// /reload while other waits are still running: the call's result, on a REAL
// SQLite DB (the in-process recorder `mu delegates finish`). The real-pi
// integration suite (extension-delegate-pi.integration.test.ts) proves the same
// for pi's own queue; this one adds /reload, which fakePi can drive.

import { describe, expect, it, vi } from "vitest";
import { registerDelegate } from "../extension/delegate.js";
import { getDelegateCall, listDelegates } from "../src/delegates.js";
import { selectTaskNotes } from "../src/tasks/queries.js";
import { getTask } from "../src/tasks.js";
import { fakeMu, fakePi, flush, installDelegateEnv, ok, tool } from "./_delegate-fixtures.js";

installDelegateEnv();

const EVIDENCE =
  "EVIDENCE:\n- src/x.ts:10 `if (!ok) return`\n\n  indented detail\n- $ npm test -> 12 passed";
const answer = (v: string) => `Checked.\nREFUTER: VERDICT: ${v} the guard exists\n${EVIDENCE}`;
const settle = async () => {
  for (let i = 0; i < 8; i++) await flush();
};
const notes = (mu: ReturnType<typeof fakeMu>, ws: string, id: string) =>
  selectTaskNotes(mu.db, id, { workstream: ws, all: true }).notes;

describe("the result outlives the echo", () => {
  it("a dropped echo (Escape) leaves the verdict and the full report on the tasks", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "crew/f1" }, wave: "w" });
    p.state.busy = true; // pi is mid-turn: the follow-up queues
    mu.waits
      .get("delegate-r")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: answer("REFUTED") }] }));
    await settle();
    await p.fire("agent_settled", { aborted: true }); // Escape clears pi's queue
    await settle();
    const dropped = p.sendMessage.mock.calls
      .map(([m]) => m as { details?: { dropped?: unknown[] } })
      .filter((m) => m.details?.dropped);
    expect(dropped).toHaveLength(1); // the echo never arrived: one "dropped" note instead
    const c = listDelegates(mu.db)[0];
    expect(c).toMatchObject({ state: "done", verdict: "REFUTED" });
    const v = notes(mu, "crew", "f1").filter((n) => n.kind === "verdict");
    expect(v).toHaveLength(1);
    expect(v[0]?.content).toContain(EVIDENCE);
    const report = notes(mu, "scratch", c?.task ?? "").find((n) => n.kind === "report");
    expect(report?.content).toContain(EVIDENCE);
    expect(getTask(mu.db, c?.task ?? "", "scratch")).toMatchObject({
      status: "CLOSED",
      substate: "done",
    });
  });

  it("a /reload with waits still running keeps every finished result and leaves the rest durably running", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one", label: "a", record: { task: "crew/f1" }, wave: "w" });
    await tool(p).execute("b", { task: "two", label: "b", record: { task: "crew/f2" }, wave: "w" });
    await tool(p).execute("c", {
      task: "three",
      label: "c",
      record: { task: "crew/f3" },
      wave: "w",
    });
    p.state.busy = true;
    mu.waits
      .get("delegate-a")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: answer("CONFIRMED") }] }));
    await settle();
    // /reload: the old runtime shuts down while b and c still wait.
    const notify = vi.fn();
    for (const h of p.shutdown) await h({}, { hasUI: true, ui: { notify } });
    await settle();
    expect(notify.mock.calls[0]?.[0]).toContain("2 delegates still running");
    // The finished one is complete on both tasks and survives the reload.
    const [a, b, c] = listDelegates(mu.db);
    expect(a).toMatchObject({ state: "done", verdict: "CONFIRMED" });
    expect(notes(mu, "crew", "f1").find((n) => n.kind === "verdict")?.content).toContain(EVIDENCE);
    expect(notes(mu, "scratch", a?.task ?? "").find((n) => n.kind === "report")?.content).toContain(
      EVIDENCE,
    );
    // The others are not lost, and not falsely finished: running, listed, with their task and agent.
    expect([b?.state, c?.state]).toEqual(["running", "running"]);
    expect([b?.agent, c?.agent]).toEqual(["delegate-b", "delegate-c"]);
    expect(notes(mu, "crew", "f2").filter((n) => n.kind === "verdict")).toHaveLength(0);
    // A replacement runtime (the reloaded extension) records a late answer once, through the same recorder.
    const out = mu.run(
      [
        "delegates",
        "finish",
        b?.callId ?? "",
        "--outcome",
        "done",
        "--author",
        "delegate-b",
        "--text",
        "-",
        "--json",
      ],
      undefined,
      answer("REFUTED"),
    );
    expect(JSON.parse((await out).stdout).data).toMatchObject({ changed: true, state: "done" });
    const again = await mu.run(
      [
        "delegates",
        "finish",
        b?.callId ?? "",
        "--outcome",
        "done",
        "--author",
        "delegate-b",
        "--text",
        "-",
        "--json",
      ],
      undefined,
      answer("CONFIRMED"),
    );
    expect(JSON.parse(again.stdout).data.changed).toBe(false);
    expect(notes(mu, "crew", "f2").filter((n) => n.kind === "verdict")).toHaveLength(1);
    expect(getDelegateCall(mu.db, b?.callId ?? "")?.verdict).toBe("REFUTED");
  });

  it("a /reload drops queued calls to refused: durable, listable, reissuable, never silently gone", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      await tool(p).execute("b", { task: "two", label: "q", record: { task: "crew/f9" } });
      const notify = vi.fn();
      for (const h of p.shutdown) await h({}, { hasUI: true, ui: { notify } });
      const [, q] = listDelegates(mu.db);
      expect(q).toMatchObject({ state: "refused", record: { task: "f9" } });
      expect(q?.error).toMatch(/session ended/);
      expect(notify.mock.calls[0]?.[0]).toContain("mu delegates reissue");
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });
});
