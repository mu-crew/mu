// mu_delegate with no multiplexer: the spawn's NoMultiplexerError routes the
// call to `mu delegates run <call-id>` (a child pi, src/delegate-process.ts),
// faked here on the real delegate SDK. Nothing else falls back to it.
import { describe, expect, it } from "vitest";
import {
  DELEGATE_CANCEL_TOOL,
  DELEGATE_REISSUE_TOOL,
  type MuResult,
  type MuRunner,
  registerDelegate,
} from "../extension/delegate.js";
import { finishDelegate, getDelegateCall, listDelegates, markDelegate } from "../src/delegates.js";
import {
  failed,
  fakeMu,
  fakePi,
  flush,
  installDelegateEnv,
  ok,
  reportOf,
  sentText,
  tool,
} from "./_delegate-fixtures.js";

installDelegateEnv();

const noMux = () =>
  Promise.resolve(failed(5, "NoMultiplexerError", "no supported multiplexer found"));

/** A fake mu with no mux: spawn fails NoMultiplexerError; `delegates run` is
 *  held until `answer(callId, …)` finishes it as the real runner would. */
function muxFree(o: { killedEarly?: boolean } = {}) {
  const mu = fakeMu({ on: { spawn: noMux } });
  const runs = new Map<string, { resolve: (r: MuResult) => void; signal?: AbortSignal }>();
  const run: MuRunner = (args, signal, stdin, opts) => {
    if (args[0] === "delegates" && args[1] === "run") {
      mu.calls.push([...args]);
      const id = String(args[2]);
      return new Promise((resolve) => {
        runs.set(id, { resolve, ...(signal ? { signal } : {}) });
        signal?.addEventListener("abort", () => {
          // SIGTERM: the runner cancels the call durably, then exits 1; one
          // killed before its handler is installed exits 143 with nothing written.
          const c = getDelegateCall(mu.db, id);
          if (c && !o.killedEarly)
            finishDelegate(mu.db, id, { outcome: "cancelled", author: c.caller });
          resolve(
            o.killedEarly
              ? { code: 143, stdout: "", stderr: "" }
              : failed(1, "CliExitError", "cancelled"),
          );
        });
      });
    }
    return mu.run(args, signal, stdin, opts);
  };
  const callId = () => listDelegates(mu.db)[0]?.callId ?? "";
  /** Finish the call as `mu delegates run` does, and print its one result. */
  const answer = (id: string, outcome: string, text: string) => {
    const c = getDelegateCall(mu.db, id);
    if (!c) throw new Error(`no call ${id}`);
    if (outcome === "refused") markDelegate(mu.db, id, "refused", { error: text });
    else {
      markDelegate(mu.db, id, "running", { agent: c.task });
      finishDelegate(mu.db, id, { outcome, text, author: c.task });
    }
    const state = getDelegateCall(mu.db, id)?.state;
    runs.get(id)?.resolve(
      ok({
        callId: id,
        ran: true,
        outcome,
        state,
        transport: "process",
        attach: null,
        logPath: "/s/pi.log",
        sessionFile: "/s/session.jsonl",
        ...(outcome === "done" ? { answer: text } : { error: text }),
      }),
    );
  };
  return { mu, run, runs, callId, answer };
}

describe("mu_delegate with no multiplexer", () => {
  it("runs the call as a child pi: no pane, no attach; the recorded answer wakes an idle pi", async () => {
    const f = muxFree();
    const p = fakePi();
    registerDelegate(p.pi, f.run);
    const res = await tool(p).execute("t", {
      task: "check X",
      record: { task: "crew/f1" },
    });
    const id = f.callId();
    const task = getDelegateCall(f.mu.db, id)?.task ?? "";
    expect(res.details).toMatchObject({
      name: task,
      state: "running",
      transport: "process",
      attach: null,
    });
    expect(res.content[0]?.text).toContain("no pane to attach");
    expect(res.content[0]?.text).not.toMatch(/tmux|Attach:/);
    expect(f.mu.calls.find((c) => c[0] === "delegates" && c[1] === "run")).toEqual([
      "delegates",
      "run",
      id,
      "--no-keep",
      "--json",
    ]);
    expect(p.sendMessage).not.toHaveBeenCalled();

    f.answer(id, "done", "VERDICT: CONFIRMED\nEVIDENCE: ok");
    await flush();
    await flush();
    await flush();
    // One wake: a pointer to the report (the settle shows it), never the answer.
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    const text = sentText(p);
    expect(text).toContain(`(done, CONFIRMED, recorded on crew/f1; call ${id})`);
    expect(text).toContain(`mu task notes ${task} -w scratch`);
    expect(text).not.toContain("EVIDENCE");
    expect(text).not.toMatch(/Pane|attach|mu agent/);
    // The runner finished it; the extension never closes a pane or finishes twice.
    expect(f.mu.calls.some((c) => c[1] === "close" || c[1] === "finish")).toBe(false);
    expect(getDelegateCall(f.mu.db, id)?.state).toBe("done");
  });

  it("only NoMultiplexerError falls back: any other spawn failure is refused as before", async () => {
    const mu = fakeMu({
      on: { spawn: () => Promise.resolve(failed(5, "TmuxError", "server exited")) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x" })).rejects.toThrow(/server exited/);
    expect(mu.calls.some((c) => c[0] === "delegates" && c[1] === "run")).toBe(false);
  });

  it("a refused run (nothing sent) says so and the call stays reissuable", async () => {
    const f = muxFree();
    const p = fakePi();
    registerDelegate(p.pi, f.run);
    await tool(p).execute("t", { task: "x" });
    const id = f.callId();
    f.answer(id, "refused", "pi did not serve its control socket within 30000ms");
    await flush();
    await flush();
    const text = sentText(p);
    expect(text).toContain("control socket");
    expect(text).toContain(`${DELEGATE_REISSUE_TOOL} { call_id: "${id}" }`);
    expect(getDelegateCall(f.mu.db, id)?.state).toBe("refused");
  });

  it("a failed run is recorded failed with its words as the report; the wake names the outcome", async () => {
    const f = muxFree();
    const p = fakePi();
    registerDelegate(p.pi, f.run);
    await tool(p).execute("t", { task: "x" });
    f.answer(f.callId(), "unknown", "delivery unknown: socket closed");
    await flush();
    await flush();
    await flush();
    expect(sentText(p)).toMatch(/\(unknown; call /);
    expect(getDelegateCall(f.mu.db, f.callId())?.state).toBe("failed");
    expect(reportOf(f.mu)).toContain("delivery unknown: socket closed");
  });

  it("cancel SIGTERMs the run, which cancels the call durably; no follow-up", async () => {
    const f = muxFree();
    const p = fakePi();
    registerDelegate(p.pi, f.run);
    const res = await tool(p).execute("t", { task: "x" });
    const name = (res.details as { name: string }).name;
    const c = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name });
    expect(c.content[0]?.text).toMatch(/child pi stopped; call cancelled/);
    expect(f.runs.get(f.callId())?.signal?.aborted).toBe(true);
    expect(f.mu.calls.some((x) => x[1] === "abort" || x[1] === "close")).toBe(false);
    await flush();
    expect(p.sendMessage).not.toHaveBeenCalled();
  });

  it("reload leaves a run going; quit cancels it before the shutdown returns", async () => {
    const f = muxFree();
    const p = fakePi();
    registerDelegate(p.pi, f.run);
    await tool(p).execute("t", { task: "x" });
    const id = f.callId();
    for (const h of p.shutdown) await h({ reason: "reload" }, {});
    expect(f.runs.get(id)?.signal?.aborted).toBe(false);

    const g = muxFree();
    const q = fakePi();
    registerDelegate(q.pi, g.run);
    await tool(q).execute("t", { task: "x" });
    for (const h of q.shutdown) await h({ reason: "quit" }, {});
    expect(g.runs.get(g.callId())?.signal?.aborted).toBe(true);
    expect(getDelegateCall(g.mu.db, g.callId())?.state).toBe("cancelled");
  });

  it("a run killed before its handler still leaves the call cancelled (cancel and quit)", async () => {
    for (const how of ["cancel", "quit"] as const) {
      const f = muxFree({ killedEarly: true });
      const p = fakePi();
      registerDelegate(p.pi, f.run);
      const res = await tool(p).execute("t", { task: "x" });
      if (how === "cancel")
        await tool(p, DELEGATE_CANCEL_TOOL).execute("c", {
          name: (res.details as { name: string }).name,
        });
      else for (const h of p.shutdown) await h({ reason: "quit" }, {});
      expect(getDelegateCall(f.mu.db, f.callId())?.state, how).toBe("cancelled");
    }
  });

  it("a run that dies without a result finishes the call failed, never left starting", async () => {
    const f = muxFree();
    const p = fakePi();
    registerDelegate(p.pi, f.run);
    await tool(p).execute("t", { task: "x" });
    f.runs.get(f.callId())?.resolve({ code: 137, stdout: "", stderr: "Killed" });
    await flush();
    await flush();
    expect(getDelegateCall(f.mu.db, f.callId())?.state).toBe("failed");
    expect(sentText(p)).toContain("exited 137 without a result");
  });
});
