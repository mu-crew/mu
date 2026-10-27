// What survives a lost pi echo, an Escape, a compaction-time clear and a
// /reload while other waits are still running: the call's result, on a REAL
// SQLite DB (the in-process recorder `mu delegates finish`). The real-pi
// integration suite (extension-delegate-pi.integration.test.ts) proves the same
// for pi's own queue; this one adds /reload, which fakePi can drive.

import { describe, expect, it, vi } from "vitest";
import { DELEGATE_REISSUE_TOOL, registerDelegate } from "../extension/delegate.js";
import { getDelegateCall, listDelegates } from "../src/delegates.js";
import { selectTaskNotes } from "../src/tasks/queries.js";
import { getTask } from "../src/tasks.js";
import {
  failed,
  fakeMu,
  fakePi,
  flush,
  installDelegateEnv,
  ok,
  tool,
} from "./_delegate-fixtures.js";
import { runCliWire } from "./_runCli.js";

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

  it("a /reload re-adopts the session's running pane calls: the late answer is recorded and woken, no wait owes it forever", async () => {
    const mu = fakeMu();
    const ctx = { sessionManager: { getSessionId: () => "s1" } };
    const first = fakePi();
    registerDelegate(first.pi, mu.run);
    await tool(first).execute(
      "a",
      { task: "one", label: "a", record: { task: "crew/f1" } },
      undefined,
      undefined,
      ctx,
    );
    const [call] = listDelegates(mu.db);
    expect(call).toMatchObject({ state: "running", agent: "delegate-a", caller: "pi:s1" });
    for (const h of first.shutdown) await h({ reason: "reload" }, { hasUI: false });
    mu.waits.delete("delegate-a"); // the old runtime's watcher died with it
    // The reloaded runtime: same session, same DB.
    const second = fakePi();
    registerDelegate(second.pi, mu.run);
    for (const h of second.handlers.get("session_start") ?? []) await h({ reason: "reload" }, ctx);
    await settle();
    const wait = mu.calls.filter((c) => c[0] === "agent" && c[1] === "wait").at(-1) ?? [];
    expect(wait.slice(2, 3)).toEqual(["delegate-a"]);
    expect(wait[wait.indexOf("--after-runs") + 1]).toBe("0"); // a one-shot delegate: its first run
    mu.waits
      .get("delegate-a")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: answer("CONFIRMED") }] }));
    await settle();
    expect(getDelegateCall(mu.db, call?.callId ?? "")).toMatchObject({
      state: "done",
      verdict: "CONFIRMED",
    });
    expect(notes(mu, "crew", "f1").filter((n) => n.kind === "verdict")).toHaveLength(1);
    expect(second.sendMessage).toHaveBeenCalledTimes(1); // the wake: the answer is not stranded
  });

  it("another session's running calls are left alone", async () => {
    const mu = fakeMu();
    const first = fakePi();
    registerDelegate(first.pi, mu.run);
    await tool(first).execute("a", { task: "one", label: "a" }, undefined, undefined, {
      sessionManager: { getSessionId: () => "s1" },
    });
    const second = fakePi();
    registerDelegate(second.pi, mu.run);
    const before = mu.calls.length;
    for (const h of second.handlers.get("session_start") ?? [])
      await h({ reason: "startup" }, { sessionManager: { getSessionId: () => "s2" } });
    await settle();
    expect(mu.calls.slice(before).some((c) => c[1] === "wait")).toBe(false);
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
      expect(notify.mock.calls[0]?.[0]).toContain("mu_delegate_reissue");
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });
});

describe("spawn receipts", () => {
  const taskOf = (mu: ReturnType<typeof fakeMu>, i = 0) => listDelegates(mu.db)[i];

  it("a replayed spawn (saved agent, no top-level ctl) is a running call that records its answer once", async () => {
    // The first spawn's send fails (unsent -> refused); the reissue replays the journal:
    // the fixture answers a saved agent with NO ctl, exactly as the real CLI does.
    let sends = 0;
    const mu = fakeMu({
      on: {
        send: () =>
          Promise.resolve(++sends === 1 ? failed(1, "Error", "no reply") : ok({ runs: 0 })),
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("a", { task: "x", label: "r" })).rejects.toThrow(/reissue/);
    expect(taskOf(mu)?.state).toBe("refused");
    const out = await tool(p, DELEGATE_REISSUE_TOOL).execute("r", {
      call_id: taskOf(mu)?.callId ?? "",
    });
    expect((out.details as { state: string }).state).toBe("running");
    const spawns = mu.calls.filter((c) => c[1] === "spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.[spawns[1].indexOf("--attempt") + 1]).toBe(taskOf(mu)?.task); // the same attempt
    expect(taskOf(mu)).toMatchObject({ state: "running" });
    const name = taskOf(mu)?.agent ?? "";
    expect(name).not.toBe("");
    mu.waits
      .get(name)
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: answer("CONFIRMED") }] }));
    await settle();
    expect(taskOf(mu)).toMatchObject({ state: "done", verdict: "CONFIRMED" });
  });

  it("a fresh spawn whose control socket is not ok still fails loudly, pane kept", async () => {
    const mu = fakeMu({ ctl: "missing" });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("a", { task: "x" })).rejects.toThrow(/control socket is missing/);
    expect(taskOf(mu)).toMatchObject({ state: "failed" });
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false); // the pane is kept
  });

  it("a stale receipt (its agent was closed) refuses the call: parked, reissuable, the replacement untouched", async () => {
    const mu = fakeMu({
      on: {
        spawn: () =>
          Promise.resolve(ok({ task: { id: "t", state: "sent", replay: true, stale: "closed" } })),
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const err = await tool(p)
      .execute("a", { task: "x", label: "r" })
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/is stale: its agent was closed; the replacement was left alone/);
    expect(String(err)).toContain(DELEGATE_REISSUE_TOOL);
    const c = taskOf(mu);
    expect(c?.state).toBe("refused");
    expect(getTask(mu.db, c?.task ?? "", "scratch")).toMatchObject({
      status: "OPEN",
      substate: "parked",
    });
    expect(mu.calls.some((x) => x[1] === "close")).toBe(false); // nothing of ours to close
  });
});

describe("reissue is the tool's", () => {
  it("the CLI reissue refuses and leaves the call refused; the tool then runs it (same call, one verdict)", async () => {
    let sends = 0;
    const mu = fakeMu({
      on: {
        send: () =>
          Promise.resolve(++sends === 1 ? failed(1, "Error", "no reply") : ok({ runs: 0 })),
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("a", { task: "x", label: "r" })).rejects.toThrow(/reissue/);
    const id = listDelegates(mu.db)[0]?.callId ?? "";
    const cli = await runCliWire(["delegates", "reissue", id], mu.db.name);
    expect(cli.exitCode).toBe(2);
    expect(cli.stderr).toContain(DELEGATE_REISSUE_TOOL);
    expect(getDelegateCall(mu.db, id)?.state).toBe("refused"); // never stranded queued
    await tool(p, DELEGATE_REISSUE_TOOL).execute("r", { call_id: id });
    expect(getDelegateCall(mu.db, id)?.state).toBe("running");
    mu.waits
      .get(getDelegateCall(mu.db, id)?.agent ?? "")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: answer("CONFIRMED") }] }));
    await settle();
    expect(getDelegateCall(mu.db, id)).toMatchObject({ state: "done", verdict: "CONFIRMED" });
    expect(listDelegates(mu.db)).toHaveLength(1);
  });
});
