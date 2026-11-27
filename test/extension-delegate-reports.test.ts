import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATE_CANCEL_TOOL,
  DELEGATE_TOOL,
  delegateMessage,
  droppedNote,
  formatElapsed,
  labelStem,
  lastAssistantTextIn,
  type MuResult,
  type MuRunner,
  PENDING_CHANNEL,
  registerDelegate,
  wakeText,
} from "../extension/delegate.js";
import { listDelegates } from "../src/delegates.js";
import {
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

const pendingCounts = (p: ReturnType<typeof fakePi>) =>
  p.emitted
    .filter((e) => e.channel === PENDING_CHANNEL)
    .map((e) => (e.data as { source: string; count: number }).count);

describe("murmur pending report", () => {
  const counts = pendingCounts;

  it("reports running + queued delegates, and zero before the last answer is delivered", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" });
    await tool(p).execute("b", { task: "two" }); // queued behind the cap
    expect(counts(p)).toEqual([1, 2]);
    expect(p.emitted[0]?.data).toEqual({ source: DELEGATE_TOOL, count: 1 });

    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "x" }] }));
    await flush();
    await flush();
    // The queued one took the freed slot: still one outstanding.
    expect(counts(p).at(-1)).toBe(1);

    const name = [...mu.waits.keys()].at(-1) ?? "";
    const before = p.sendMessage.mock.calls.length;
    let atDelivery: number | undefined;
    p.sendMessage.mockImplementationOnce(async () => {
      atDelivery = counts(p).at(-1);
    });
    mu.waits.get(name)?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
    await flush();
    await flush();
    expect(p.sendMessage.mock.calls.length).toBe(before + 1);
    // Zero is out BEFORE the follow-up that re-runs the parent, so the
    // settle after that run is the one murmur may call done.
    expect(atDelivery).toBe(0);
  });

  it("cancelling a queued call lowers the reported count", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    const p = fakePi();
    registerDelegate(p.pi, fakeMu().run);
    await tool(p).execute("a", { task: "one" });
    await tool(p).execute("b", { task: "two" }); // queued-1
    await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "queued-1" });
    expect(counts(p)).toEqual([1, 2, 1]);
  });

  it("reports zero when a session shutdown drops the watchers", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" });
    for (const h of p.shutdown) h({}, {});
    expect(counts(p)).toEqual([1, 0]);
  });
});

describe("pending reports and delivery tracking", () => {
  const uiCtx = () => ({ ctx: { hasUI: true, ui: { notify: vi.fn() } } });

  it("reports running delegates and zero when the last one is cancelled", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const { ctx } = uiCtx();
    await tool(p).execute("a", { task: "one" }, undefined, undefined, ctx);
    await tool(p).execute("b", { task: "two" }, undefined, undefined, ctx);
    expect(pendingCounts(p)).toEqual([1, 2]);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "x" }] }));
    await flush();
    expect(pendingCounts(p)).toEqual([1, 2, 1]);
    await tool(p, DELEGATE_CANCEL_TOOL).execute(
      "c",
      { name: "delegate-3" },
      undefined,
      undefined,
      ctx,
    );
    expect(pendingCounts(p)).toEqual([1, 2, 1, 0]);
  });

  it("counts a call the moment it is made, before its pane is up, without double counting", async () => {
    let releaseSpawn: (r: MuResult) => void = () => {};
    const mu = fakeMu({
      on: {
        spawn: () =>
          new Promise<MuResult>((res) => {
            releaseSpawn = res;
          }),
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const { ctx } = uiCtx();
    const call = tool(p).execute("a", { task: "one" }, undefined, undefined, ctx);
    await flush();
    // The spawn has not returned: the call is already outstanding.
    expect(pendingCounts(p)).toEqual([1]);
    releaseSpawn(ok({ agent: { name: "delegate-2" }, ctl: "ok", send: { ok: true, runs: 0 } }));
    await call;
    expect(pendingCounts(p)).toEqual([1]); // starting -> running is not a second delegate
  });

  it("a spawn that fails while starting reports zero", async () => {
    const mu = fakeMu({
      on: { spawn: () => Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const { ctx } = uiCtx();
    await expect(
      tool(p).execute("a", { task: "one" }, undefined, undefined, ctx),
    ).rejects.toThrow();
    expect(pendingCounts(p)).toEqual([1, 0]);
  });

  /** Resolve delegate `name`'s wait with a done answer and let it record. */
  const finish = async (mu: ReturnType<typeof fakeMu>, name: string, text = "x") => {
    mu.waits.get(name)?.resolve(ok({ agents: [{ outcome: "done", lastText: text }] }));
    for (let i = 0; i < 4; i++) await flush();
  };
  /** agent_settled, then the tick the extension waits before judging a wake lost. */
  const settled = async (p: ReturnType<typeof fakePi>, aborted = false) => {
    await p.fire("agent_settled", { type: "agent_settled", aborted });
    await new Promise((r) => setImmediate(r));
  };
  const wakeCalls = (p: ReturnType<typeof fakePi>) =>
    p.sendMessage.mock.calls.filter(
      (c) => (c[0] as { details?: { wake?: unknown } }).details?.wake,
    );

  it("an answer recorded mid-turn sends nothing: that turn's settle shows it", async () => {
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    const r = await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await p.fire("agent_start", {});
    await finish(mu, "delegate-2");
    expect(p.sendMessage).not.toHaveBeenCalled();
    expect(handle.answerPending()).toBe(false);
    // The settle wait showed it: nothing owed, so the end of the run wakes nobody.
    handle.delivered([(r.details as { call_id: string }).call_id]);
    await settled(p);
    expect(p.sendMessage).not.toHaveBeenCalled();
  });

  it("an answer the settle did not show wakes pi once the run settles idle", async () => {
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await p.fire("agent_start", {});
    await finish(mu, "delegate-2", "THE ANSWER");
    await settled(p); // e.g. MU_NUDGE=0, or the settle wait failed
    expect(wakeCalls(p)).toHaveLength(1);
    const [msg, opts] = wakeCalls(p)[0] ?? [];
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect((msg as { content: string }).content).not.toContain("THE ANSWER");
    expect(handle.answerPending()).toBe(false); // fakePi starts it at once: idle
  });

  it("a run that starts in the tick an idle answer is recorded takes it: no wake", async () => {
    const mu = fakeMu();
    const p = fakePi();
    // The user's prompt starts a run while the pane closes, before the wake is due.
    const run: MuRunner = (args, ...rest) => {
      if (args[1] === "close" && args.includes("--if")) void p.fire("agent_start", {});
      return mu.run(args, ...rest);
    };
    registerDelegate(p.pi, run);
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "x" }] }));
    for (let i = 0; i < 4; i++) await flush();
    expect(reportOf(mu)).toBe("x");
    expect(p.sendMessage).not.toHaveBeenCalled(); // that run's settle shows it
  });

  it("a wait that found nothing owed covers answers recorded before it started, not after", async () => {
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await tool(p).execute("b", { task: "two" }, undefined, undefined, uiCtx().ctx);
    await p.fire("agent_start", {});
    await finish(mu, "delegate-2");
    const before = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 5));
    await finish(mu, "delegate-3");
    handle.delivered({ before }); // the model's own wait consumed delegate-2 only
    await settled(p);
    const ids = wakeCalls(p).flatMap(
      (c) => (c[0] as { details: { calls: string[] } }).details.calls,
    );
    expect(ids).toHaveLength(1);
    expect(listDelegates(mu.db).find((c) => c.callId === ids[0])?.agent).toBe("delegate-3");
  });

  it("answers recorded in one tick while idle share ONE wake; a wake is pending until it starts", async () => {
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    p.state.busy = true; // pi queues the wake behind a running compaction, say
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await tool(p).execute("b", { task: "two" }, undefined, undefined, uiCtx().ctx);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "a" }] }));
    mu.waits.get("delegate-3")?.resolve(ok({ agents: [{ outcome: "done", lastText: "b" }] }));
    for (let i = 0; i < 6; i++) await flush();
    expect(wakeCalls(p)).toHaveLength(1);
    expect((wakeCalls(p)[0]?.[0] as { content?: string } | undefined)?.content).toMatch(
      /^2 delegate answers/,
    );
    expect(handle.answerPending()).toBe(true);
    expect(pendingCounts(p).at(-1)).toBe(0); // murmur counts running work, never wakes
    await p.fire("message_start", {
      message: { role: "custom", customType: "other", details: { wake: 1 } },
    });
    expect(handle.answerPending()).toBe(true); // someone else's message does not clear it
    await p.drainQueue();
    expect(handle.answerPending()).toBe(false);
    await settled(p);
    expect(wakeCalls(p)).toHaveLength(1); // the wake carried both: nothing owed
  });

  it("Escape drops a queued wake with a one-line note per answer: no turn, no copy, reports intact", async () => {
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await finish(mu, "delegate-2", "the answer");
    const [, wakeOpts] = wakeCalls(p)[0] ?? [];
    await settled(p, true);
    expect(handle.answerPending()).toBe(false);
    // pi runs the send it deferred later, reading the options object it was handed.
    expect(wakeOpts).toEqual({ deliverAs: "followUp", triggerTurn: false });
    const [note, opts] = p.sendMessage.mock.calls.at(-1) ?? [];
    expect(opts).toEqual({ triggerTurn: false });
    const text = (note as { content: string }).content;
    expect(text).toMatch(/^Interrupted: 1 delegate answer recorded but not shown/);
    expect(text).toContain("- scratch/delegate-2 (done;");
    expect(text).not.toContain("the answer");
    expect(reportOf(mu)).toBe("the answer"); // durable: the next settle's wait shows it
    // Still owed: the next completed turn whose settle did not show it wakes for it (fsj U4).
    await settled(p);
    expect(wakeCalls(p)).toHaveLength(2);
  });

  it("an answer recorded during an aborted run is noted, never woken", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await p.fire("agent_start", {});
    await finish(mu, "delegate-2");
    await settled(p, true);
    expect(wakeCalls(p)).toHaveLength(0);
    expect((p.sendMessage.mock.calls[0]?.[1] as object) ?? {}).toEqual({ triggerTurn: false });
  });

  it("a wake cleared from pi's queue without an abort is sent again when the run settles", async () => {
    // The dequeue key calls session.clearQueue(): the wake is dropped, the run
    // ends normally (aborted: false) and nothing arrives.
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await finish(mu, "delegate-2");
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    await settled(p); // queue was cleared
    expect(p.sendMessage).toHaveBeenCalledTimes(2);
    const [again, opts] = p.sendMessage.mock.calls[1] ?? [];
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(again).toEqual(p.sendMessage.mock.calls[0]?.[0]);
    expect(handle.answerPending()).toBe(true);
    p.state.busy = false;
    await p.fire("message_start", { message: { role: "custom", ...(again as object) } });
    expect(handle.answerPending()).toBe(false);
    await settled(p);
    expect(p.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("a wake lost twice is dropped with a note; the report stays", async () => {
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await finish(mu, "delegate-2", "kept");
    await settled(p); // lost once: resent
    await settled(p); // lost again: dropped
    expect(p.sendMessage).toHaveBeenCalledTimes(3);
    const [note, opts] = p.sendMessage.mock.calls[2] ?? [];
    expect(opts).toEqual({ triggerTurn: false });
    expect((note as { content: string }).content).toMatch(/^Interrupted: 1 delegate answer/);
    expect(handle.answerPending()).toBe(false);
    expect(reportOf(mu)).toBe("kept");
  });

  it("a wake that pi drained before the run ended is not sent again", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await finish(mu, "delegate-2");
    await p.drainQueue(); // message_start for the queued wake
    await settled(p);
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("a repeated wake (a resend racing a deferred send) repeats no answer", async () => {
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await finish(mu, "delegate-2", "BIG");
    const [sent] = p.sendMessage.mock.calls[0] ?? [];
    await p.fire("message_start", { message: { role: "custom", ...(sent as object) } });
    expect(JSON.stringify(p.sendMessage.mock.calls)).not.toContain("BIG");
    expect(handle.answerPending()).toBe(false);
    await settled(p);
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("no resend while pi is not idle", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await finish(mu, "delegate-2");
    for (const h of p.handlers.get("agent_settled") ?? [])
      await h({ type: "agent_settled", aborted: false }, { isIdle: () => false });
    await new Promise((r) => setImmediate(r));
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("an interrupt with nothing owed leaves no note", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await p.fire("agent_settled", { type: "agent_settled", aborted: true });
    expect(p.sendMessage).not.toHaveBeenCalled();
  });

  it("after a shutdown nothing wakes; the report stays for the next session's wait", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await p.fire("agent_start", {});
    await finish(mu, "delegate-2", "r");
    for (const h of p.shutdown) await h({}, {});
    await settled(p);
    expect(wakeCalls(p)).toHaveLength(0);
    expect(reportOf(mu)).toBe("r");
  });

  it("droppedNote and wakeText name each answer's report and kept pane, never its text", () => {
    const a = {
      callId: "pi:s:1",
      name: "delegate-3",
      workstream: "scratch",
      task: "delegate_ab",
      outcome: "error",
      kept: "kept as evidence",
    };
    expect(droppedNote([a])).toBe(
      [
        "Interrupted: 1 delegate answer recorded but not shown; the next settle shows it:",
        "- scratch/delegate-3 (error; call pi:s:1): mu task notes delegate_ab -w scratch. Pane kept (kept as evidence): mu agent read delegate-3 --text -n 50 -w scratch.",
      ].join("\n"),
    );
    expect(
      wakeText([{ ...a, outcome: "done", verdict: "CONFIRMED", record: "w/f1", kept: undefined }]),
    ).toBe(
      [
        "A delegate answer is recorded; the settle shows it (or read the report):",
        "- scratch/delegate-3 (done, CONFIRMED, recorded on w/f1; call pi:s:1): mu task notes delegate_ab -w scratch.",
      ].join("\n"),
    );
  });

  it("works without a UI ctx (print mode, tests)", async () => {
    const p = fakePi();
    registerDelegate(p.pi, fakeMu().run);
    await expect(tool(p).execute("a", { task: "x" })).resolves.toBeDefined();
  });
});

describe("delegateMessage", () => {
  it("words each CLI outcome", () => {
    expect(delegateMessage("d", { outcome: "done", lastText: "A" }, { closed: true })).toBe(
      "Delegate scratch/d finished. Pane closed.\n\nA",
    );
    expect(
      delegateMessage("d", { outcome: "empty", lastText: "" }, { closed: true }, { tail: "tail" }),
    ).toContain("without a text answer");
    const t = delegateMessage("d", { outcome: "timeout" }, { closed: false, why: "evidence" });
    expect(t).toContain("still running");
    expect(t).toContain("will not arrive here");
    expect(t).toContain("Read: mu agent read d --text -n 50 -w scratch");
    expect(t).toContain("mu agent wait d -w scratch --json");
    const tb = delegateMessage(
      "d",
      { outcome: "timeout", afterRuns: 4 },
      { closed: false, why: "evidence" },
    );
    expect(tb).toContain("mu agent wait d -w scratch --json --after-runs 4");
  });

  it("names the run time when given", () => {
    expect(
      delegateMessage(
        "d",
        { outcome: "done", lastText: "A" },
        { closed: true },
        { elapsedMs: 185_000 },
      ),
    ).toBe("Delegate scratch/d finished after 3m 05s. Pane closed.\n\nA");
  });

  it("formatElapsed", () => {
    expect(formatElapsed(42_400)).toBe("42s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });
});

describe("labelStem", () => {
  it("makes a valid agent-name stem or nothing", () => {
    expect(labelStem("Review PR #12")).toBe("review-pr-12");
    expect(labelStem("  --  ")).toBeUndefined();
    expect(labelStem(7)).toBeUndefined();
    expect(labelStem("a".repeat(40))).toHaveLength(20);
    expect(labelStem("abcdefghijklmnopqrs-tuv")).toBe("abcdefghijklmnopqrs");
  });
});

describe("evidence when there is no final answer", () => {
  /** A pi session file whose last assistant message is `text`. */
  const sessionWith = (dir: string, text: string) => {
    const f = join(dir, "s.jsonl");
    const line = (o: object) => JSON.stringify(o);
    writeFileSync(
      f,
      [
        line({ type: "session", id: "x" }),
        line({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "q" }] },
        }),
        line({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "earlier" }] },
        }),
        line({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text },
            ],
          },
        }),
        '{"type":"message","message":{"role":"assist', // torn line pi is still writing
      ].join("\n"),
    );
    return f;
  };
  /** Session file reported by the spawn's send, as the child extension does. */
  const muWithSession = (sessionFile: string) =>
    fakeMu({ on: { send: () => Promise.resolve(ok({ transport: "ctl", runs: 0, sessionFile })) } });
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-evidence-"));
    process.env.XDG_CACHE_HOME = tmp;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("lastAssistantTextIn takes the last assistant text, skipping a torn line", () => {
    expect(lastAssistantTextIn(sessionWith(tmp, "so far"))).toBe("so far");
    expect(lastAssistantTextIn(join(tmp, "missing.jsonl"))).toBeUndefined();
  });

  it("a timeout's report names the session and holds the partial answer; no copy file", async () => {
    const mu = muWithSession(sessionWith(tmp, "halfway there"));
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "timeout" }] }));
    await flush();
    await flush();
    const text = reportOf(mu);
    expect(text).toContain(`Session: ${join(tmp, "s.jsonl")}`);
    expect(text).toContain("Partial answer so far:\nhalfway there");
    expect(existsSync(join(tmp, "mu", "delegate-answers"))).toBe(false);
  });

  it("an API error prefers the session file the wait reports", async () => {
    const mu = muWithSession(join(tmp, "from-spawn.jsonl"));
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const settled = sessionWith(tmp, "partial");
    mu.waits
      .get("delegate-2")
      ?.resolve(ok({ agents: [{ outcome: "error", lastError: "529", sessionFile: settled }] }));
    await flush();
    await flush();
    expect(reportOf(mu)).toContain(`Session: ${settled}`);
    expect(reportOf(mu)).toContain("Partial answer so far:\npartial");
  });

  it("a blocked delegate keeps its pane, records no partial, and says it has not finished", async () => {
    const mu = muWithSession(sessionWith(tmp, "half an answer"));
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(
      ok({
        agents: [
          {
            outcome: "blocked",
            lastText: "stale",
            blocked: { kind: "confirm", title: "Allow push?", since: 1 },
            afterRuns: 0,
          },
        ],
      }),
    );
    await flush();
    await flush();
    expect(sentText(p)).toContain("Pane kept (waiting on a dialog)");
    const text = reportOf(mu);
    expect(text).toContain('blocked on a confirm "Allow push?" dialog');
    expect(text).toContain("has NOT finished");
    expect(text).toContain("Pane kept (waiting on a dialog)");
    expect(text).toContain("mu agent wait delegate-2 -w scratch --json --after-runs 0");
    expect(text).toContain(`Session: ${join(tmp, "s.jsonl")}`);
    expect(text).not.toContain("Partial answer");
    expect(text).not.toContain("half an answer");
    expect(text).not.toContain("stale");
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false);
  });

  it("a clean finish adds no evidence lines", async () => {
    const mu = muWithSession(sessionWith(tmp, "ignored"));
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "A" }] }));
    await flush();
    await flush();
    expect(reportOf(mu)).toBe("A");
    expect(sentText(p)).not.toContain("Session:");
  });

  it("cancel records what it wrote and names the session", async () => {
    const mu = muWithSession(sessionWith(tmp, "before the abort"));
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const r = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" });
    const text = r.content[0]?.text ?? "";
    expect(text).toContain("Aborted scratch/delegate-2.");
    expect(text).toContain(`Session: ${join(tmp, "s.jsonl")}`);
    expect(reportOf(mu)).toContain("before the abort");
  });

  it("shutdown names each running delegate's session", async () => {
    const mu = muWithSession("/s/d2.jsonl");
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const notify = vi.fn();
    for (const h of p.shutdown) await h({}, { hasUI: true, ui: { notify } });
    expect(String(notify.mock.calls[0]?.[0])).toContain("Sessions: delegate-2: /s/d2.jsonl.");
  });
});
