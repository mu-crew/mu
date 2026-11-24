import { describe, expect, it } from "vitest";
import {
  DELEGATE_CANCEL_TOOL,
  type DelegateCtx,
  type MuResult,
  type MuRunner,
  registerDelegate,
} from "../extension/delegate.js";
import muPi, { type MuPiContext } from "../extension/mu-pi.js";
import { listDelegates } from "../src/delegates.js";
import {
  failed,
  fakeMu,
  fakePi,
  flush,
  installDelegateEnv,
  ok,
  sentText,
  tool,
} from "./_delegate-fixtures.js";
import { withEnv } from "./_env.js";

installDelegateEnv();

describe("the settle wait delivers delegate answers (muPi wiring)", () => {
  // The real wiring: muPi registers the delegate and the nudges. The settle
  // wait's `mu wait` is faked; everything else (delegates, task notes) is the
  // real SDK on a temp DB, so a report the settle shows is what was recorded.
  const SESSION = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s1" } };
  const EVENT = ok({ firing: { kind: "closed" }, exit: 0 });
  /** A delegate event as the real engine prints it: `owed` are the answers still unconsumed. */
  const delegateEvent = (callId: string, owed: readonly string[] = []) =>
    ok({
      firing: { kind: "delegate", ref: `delegate:${callId}` },
      snapshots: [callId, ...owed].map((id) => ({ kind: "delegate", ref: `delegate:${id}` })),
      exit: 0,
    });
  type Entry = { customType?: string; content?: string };
  async function setup(opts: { worker?: boolean } = {}) {
    const mu = fakeMu();
    const p = fakePi();
    /** Settle waits in flight: their argv and signal, and how to answer them. */
    const settleWaits: {
      args: readonly string[];
      signal?: AbortSignal;
      resolve: (r: MuResult) => void;
    }[] = [];
    const run: MuRunner = (args, signal, stdin) => {
      if (args[0] === "state") return Promise.resolve(ok({ workstreams: [] }));
      if (args[0] === "wait")
        return new Promise((resolve) => {
          settleWaits.push({ args, resolve, ...(signal ? { signal } : {}) });
          signal?.addEventListener("abort", () =>
            resolve(ok({ firing: { kind: "interrupted" }, interrupted: true, exit: 143 })),
          );
        });
      if (args[0] === "task" && args[1] === "owned-by")
        return Promise.resolve(ok({ items: [{ id: "w1-task", status: "IN_PROGRESS" }] }));
      return mu.run(args, signal, stdin);
    };
    const on = (e: string, h: (e: unknown, c: MuPiContext) => unknown) =>
      p.pi.on(e, h as (e: unknown, c: DelegateCtx) => unknown);
    const api = { ...p.pi, on, sendUserMessage: () => {}, registerCommand: () => {} };
    if (opts.worker)
      // The close nudge reads its identity at registration.
      await withEnv("MU_AGENT_NAME", "w1", () =>
        withEnv("MU_WORKSTREAM", "crew", async () => muPi(api, run)),
      );
    else muPi(api, run);
    /** One settle through every handler: the merged result, if any. */
    const settle = async (ctx: Partial<MuPiContext> = {}) => {
      let out: unknown;
      for (const h of p.handlers.get("agent_before_settle") ?? []) {
        const r = await h({ type: "agent_before_settle", outcome: "completed" }, {
          ...SESSION,
          hasUI: true,
          ...ctx,
        } as DelegateCtx);
        if (r !== undefined) out = r;
      }
      return out as { continue?: boolean; entries?: Entry[] } | undefined;
    };
    /** Answer the next settle wait (after letting it start). */
    const answerWait = async (r: MuResult) => {
      for (let i = 0; i < 20 && settleWaits.length === 0; i++) await flush();
      settleWaits.shift()?.resolve(r);
    };
    return { mu, p, settle, settleWaits, answerWait };
  }
  const delegate = async (t: Awaited<ReturnType<typeof setup>>, params: Record<string, unknown>) =>
    String(((await tool(t.p).execute("d", params)).details as { call_id: string }).call_id);
  const content = (r: { entries?: Entry[] } | undefined) =>
    (r?.entries ?? []).map((e) => e.content ?? "").join("\n");

  it("a delegate event shows that call's report: header, the answer, no echo", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    const id = await delegate(t, { task: "check it" });
    t.mu.waits
      .get("delegate-2")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: "42 is it" }] }));
    for (let i = 0; i < 4; i++) await flush();
    const settling = t.settle();
    await t.answerWait(delegateEvent(id));
    const r = await settling;
    expect(r?.continue).toBe(true);
    expect(content(r)).toContain(`Delegate answer: call ${id}, task scratch/`);
    expect(content(r)).toContain("\n42 is it");
    // Not a wave: the wait's own result stays in the entry.
    expect(content(r)).toContain("Its result:");
    expect(content(r)).toContain(`"ref":"delegate:${id}"`);
    await t.p.fire("agent_settled", { aborted: false });
    await new Promise((x) => setImmediate(x));
    expect(t.p.sendMessage).not.toHaveBeenCalled(); // shown once, by the settle
  });

  it("a long report is capped with the pointer to the whole of it", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    const id = await delegate(t, { task: "x" });
    const long = `HEAD${"y".repeat(5000)}TAIL`;
    t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: long }] }));
    for (let i = 0; i < 4; i++) await flush();
    const settling = t.settle();
    await t.answerWait(delegateEvent(id));
    const text = content(await settling);
    expect(text).toContain("HEAD");
    expect(text).not.toContain("TAIL");
    const c = listDelegates(t.mu.db)[0];
    expect(text).toContain(`more characters: mu task notes ${c?.task} -w scratch]`);
  });

  it("a recorded check with a verdict shows the header only: the verdict is on its task", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    const id = await delegate(t, { task: "x", record: { task: "crew/f1" } });
    t.mu.waits
      .get("delegate-2")
      ?.resolve(
        ok({ agents: [{ outcome: "done", lastText: "VERDICT: CONFIRMED\nEVIDENCE: SECRET" }] }),
      );
    for (let i = 0; i < 4; i++) await flush();
    const settling = t.settle();
    await t.answerWait(delegateEvent(id));
    const text = content(await settling);
    expect(text).toContain("done, CONFIRMED, recorded on crew/f1. Full answer: mu task notes");
    expect(text).not.toContain("SECRET");
  });

  it("a wave event runs the same wait until the wave is in, then shows ONE summary", async () => {
    process.env.MU_DELEGATE_MAX = "2";
    try {
      const t = await setup();
      await t.p.fire("agent_start", {});
      const ids: string[] = [];
      for (let n = 1; n <= 3; n++)
        ids.push(await delegate(t, { task: `c${n}`, wave: "w", record: { task: `crew/c${n}` } }));
      // past the cap and the queue? no: 2 run, 1 queued (cap 2, queue 8)
      const answer = async (name: string, v: string) => {
        t.mu.waits
          .get(name)
          ?.resolve(ok({ agents: [{ outcome: "done", lastText: `VERDICT: ${v}` }] }));
        for (let i = 0; i < 6; i++) await flush();
      };
      await answer("delegate-2", "CONFIRMED");
      const settling = t.settle();
      await t.answerWait(delegateEvent(ids[0] ?? ""));
      // Siblings pending: the same owned wait again, not a summary yet.
      await answer("delegate-3", "REFUTED");
      await t.answerWait(delegateEvent(ids[1] ?? ""));
      const third = [...t.mu.waits.keys()].at(-1) ?? "";
      await answer(third, "CONFIRMED");
      await t.answerWait(delegateEvent(ids[2] ?? ""));
      const r = await settling;
      expect(r?.continue).toBe(true);
      expect(r?.entries).toHaveLength(1);
      const text = content(r);
      expect(text).toContain(
        "Wave w: 2/3 CONFIRMED, 1 REFUTED, 0 UNVERIFIED, 0 pending, 0 refused.",
      );
      for (const n of [1, 2, 3]) expect(text).toContain(`- crew/c${n}: `);
      // The first wait's stale result (siblings still "running") is not dumped.
      expect(text).toContain("It waited until wave w was in:");
      expect(text).not.toContain("Its result:");
      expect(text).not.toContain('"snapshots"');
      expect(t.settleWaits).toHaveLength(0);
      await t.p.fire("agent_settled", { aborted: false });
      await new Promise((x) => setImmediate(x));
      expect(t.p.sendMessage).not.toHaveBeenCalled(); // no N follow-ups, no wake
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("a wave already recorded before the settle is ONE entry; the later settle owes nothing", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++)
      ids.push(await delegate(t, { task: `c${n}`, wave: "w", record: { task: `crew/c${n}` } }));
    for (const [i, name] of ["delegate-2", "delegate-3", "delegate-4"].entries()) {
      t.mu.waits
        .get(name)
        ?.resolve(ok({ agents: [{ outcome: "done", lastText: `VERDICT: CONFIRMED ${i}` }] }));
      for (let k = 0; k < 6; k++) await flush();
    }
    const settling = t.settle();
    // No sibling is pending, but each is owed its own event: the wave drains them all.
    await t.answerWait(delegateEvent(ids[0] ?? "", ids.slice(1)));
    await t.answerWait(delegateEvent(ids[1] ?? "", ids.slice(2)));
    await t.answerWait(delegateEvent(ids[2] ?? ""));
    const r = await settling;
    expect(r?.entries).toHaveLength(1);
    const text = content(r);
    expect(text).toContain("Wave w: 3/3 CONFIRMED");
    for (const id of ids) expect(text).toContain(`Delegate answer: call ${id}`);
    expect(t.settleWaits).toHaveLength(0);
  });

  it("a wave sibling an earlier wait already consumed is not waited for again", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    const ids: string[] = [];
    for (let n = 1; n <= 2; n++) ids.push(await delegate(t, { task: `c${n}`, wave: "w" }));
    for (const name of ["delegate-2", "delegate-3"]) {
      t.mu.waits
        .get(name)
        ?.resolve(ok({ agents: [{ outcome: "done", lastText: "VERDICT: CONFIRMED" }] }));
      for (let k = 0; k < 6; k++) await flush();
    }
    const settling = t.settle();
    // The settle's event is the second call; the first was consumed by an earlier explicit wait,
    // so the engine's picture (snapshots) no longer shows it, though unrelated work stays open.
    await t.answerWait(delegateEvent(ids[1] ?? ""));
    const r = await settling;
    expect(t.settleWaits).toHaveLength(0); // no further wait: nothing of the wave is owed
    expect(content(r)).toContain("Wave w: 2/2 CONFIRMED");
    expect(r?.continue).toBe(true);
  });

  it("a refused wave call is listed for reissue, never waited on", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const t = await setup();
      await t.p.fire("agent_start", {});
      const ids: string[] = [];
      for (let n = 1; n <= 6; n++) ids.push(await delegate(t, { task: `c${n}`, wave: "w" }));
      const refused = listDelegates(t.mu.db).filter((c) => c.state === "refused");
      expect(refused).toHaveLength(1); // 1 running, 4 queued, 1 refused
      // Cancel the queued ones: only the running call and the refused one stay.
      for (const q of ["queued-1", "queued-2", "queued-3", "queued-4"])
        await tool(t.p, DELEGATE_CANCEL_TOOL).execute("c", { name: q });
      t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "ok" }] }));
      for (let i = 0; i < 6; i++) await flush();
      const settling = t.settle();
      // The running call's event, then each cancelled one's (terminal, still owed to the wait).
      for (const id of ids.filter((i) => i !== refused[0]?.callId))
        await t.answerWait(delegateEvent(id));
      const text = content(await settling);
      expect(text).toContain("1 refused.");
      expect(text).toContain(
        `REFUSED, reissue it: mu_delegate_reissue (call ${refused[0]?.callId})`,
      );
      expect(t.settleWaits).toHaveLength(0); // not waited on
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("another event during a wave's wait ends it: the summary so far, then that event", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    const a = await delegate(t, { task: "c1", wave: "w" });
    await delegate(t, { task: "c2", wave: "w" });
    t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "one" }] }));
    for (let i = 0; i < 4; i++) await flush();
    const settling = t.settle();
    await t.answerWait(delegateEvent(a));
    await t.answerWait(ok({ firing: { kind: "dead", ref: "agent:crew/w1" }, exit: 6 }));
    const r = await settling;
    const text = content(r);
    expect(text).toContain("Wave w: 0/2 CONFIRMED, 0 REFUTED, 1 UNVERIFIED, 1 pending");
    expect(text).toContain("Another event came before the rest of wave w:");
    expect(text).toContain('"agent:crew/w1"');
    // The wave is not all in: the head says so, never "waited until ... was in".
    expect(text).toContain("It waited for wave w, which is not all in (below):");
    expect(text).not.toContain("It waited until wave w was in");
    expect(r?.continue).toBe(true);
  });

  it("a wave entry keeps the waits' notices (a course check due) without the stale JSON", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    const a = await delegate(t, { task: "c1", wave: "w" });
    const b = await delegate(t, { task: "c2", wave: "w" });
    for (const name of ["delegate-2", "delegate-3"]) {
      t.mu.waits.get(name)?.resolve(ok({ agents: [{ outcome: "done", lastText: "ok" }] }));
      for (let i = 0; i < 4; i++) await flush();
    }
    const settling = t.settle();
    const withNotice = (r: MuResult, n: string) => {
      const v = JSON.parse(r.stdout);
      v.data.notices = [n];
      return { ...r, stdout: JSON.stringify(v) };
    };
    await t.answerWait(withNotice(delegateEvent(a, [b]), "course check due: run mu course check"));
    await t.answerWait(withNotice(delegateEvent(b), "a later notice"));
    const text = content(await settling);
    expect(text).toContain("It waited until wave w was in:");
    expect(text).toContain("Notice: course check due: run mu course check");
    expect(text).toContain("Notice: a later notice");
    expect(text).not.toContain('"snapshots"');
  });

  it("a human need does not cut a wave short: the summary stands, led by the drain rule", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    const a = await delegate(t, { task: "c1", wave: "w" });
    await delegate(t, { task: "c2", wave: "w" });
    t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "one" }] }));
    for (let i = 0; i < 4; i++) await flush();
    const settling = t.settle();
    const v = JSON.parse(delegateEvent(a).stdout);
    v.data.humanNeeds = [{ workstream: "crew", id: "h1", reason: "spend approval" }];
    await t.answerWait({ ...delegateEvent(a), stdout: JSON.stringify(v) });
    // The sibling's wait ends the wave loop quietly.
    await t.answerWait(failed(3, "WaitNothingError", "nothing owed"));
    const r = await settling;
    const text = content(r);
    expect(text).toContain("A human stop is open");
    expect(text).toContain("Stop: spend approval");
    expect(text).toContain("Wave w:");
    expect(r?.continue).toBe(true); // collecting started work goes on; nothing new starts
  });

  it("no wait while a wake is queued; the wake's own turn waits and shows the report", async () => {
    const t = await setup();
    t.p.state.busy = true; // pi mid-compaction: the wake queues
    const id = await delegate(t, { task: "check it" });
    t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "42" }] }));
    for (let i = 0; i < 6; i++) await flush();
    expect(t.p.sendMessage).toHaveBeenCalledTimes(1);
    expect(await t.settle()).toBeUndefined(); // the wake's turn comes first
    expect(t.settleWaits).toHaveLength(0);
    await t.p.drainQueue(); // the wake enters the conversation
    const settling = t.settle();
    await t.answerWait(delegateEvent(id));
    expect(content(await settling)).toContain("\n42");
  });

  it("no wait while an ordinary user message is queued", async () => {
    const t = await setup();
    expect(await t.settle({ hasPendingMessages: () => true })).toBeUndefined();
    const settling = t.settle({ hasPendingMessages: () => false });
    await t.answerWait(EVENT);
    expect(await settling).toMatchObject({ continue: true });
  });

  it("an answer recorded during the wait is not a wake: the running wait returns it", async () => {
    const t = await setup({ worker: true });
    await t.p.fire("agent_start", {});
    const id = await delegate(t, { task: "check it" });
    const settling = t.settle();
    for (let i = 0; i < 4; i++) await flush();
    expect(t.settleWaits).toHaveLength(1);
    t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "42" }] }));
    for (let i = 0; i < 4; i++) await flush();
    expect(t.settleWaits[0]?.signal?.aborted).toBe(false); // nothing aborts it
    expect(t.p.sendMessage).not.toHaveBeenCalled(); // and nothing echoes
    await t.answerWait(delegateEvent(id));
    const r = await settling;
    expect(r).toMatchObject({ continue: true });
    expect(r?.entries?.map((e) => e.customType).sort()).toEqual([
      "mu-close-task",
      "mu-keep-driving",
    ]);
    expect(content(r)).toContain("\n42");
  });

  it("a wait that finds nothing owed clears answers recorded before it: no wake", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    await delegate(t, { task: "x" });
    t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "a" }] }));
    for (let i = 0; i < 4; i++) await flush();
    await new Promise((x) => setTimeout(x, 2));
    const settling = t.settle(); // e.g. the model's own `mu wait` consumed it first
    await t.answerWait(ok({ firing: { kind: "drained" }, drained: true, exit: 0 }));
    expect(await settling).toBeUndefined();
    await t.p.fire("agent_settled", { aborted: false });
    await new Promise((x) => setImmediate(x));
    expect(t.p.sendMessage).not.toHaveBeenCalled();
  });

  it("Esc during the wait: drained, the answer stays owed, no wake; the next prompt's settle shows it", async () => {
    const t = await setup();
    await t.p.fire("agent_start", {});
    const id = await delegate(t, { task: "x" });
    let key: ((d: string) => undefined) | undefined;
    const settling = t.settle({
      ui: {
        notify: () => {},
        onTerminalInput: (h) => {
          key = h;
          return () => {};
        },
      },
    });
    for (let i = 0; i < 4; i++) await flush();
    t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "kept" }] }));
    for (let i = 0; i < 4; i++) await flush();
    key?.("\u001b");
    expect(await settling).toBeUndefined();
    await t.p.fire("agent_settled", { aborted: true });
    expect(t.p.handlers.get("agent_settled")).toBeDefined();
    const wakes = t.p.sendMessage.mock.calls.filter(
      (c) => (c[1] as { triggerTurn?: boolean }).triggerTurn === true,
    );
    expect(wakes).toHaveLength(0);
    // The next prompt: its settle's wait still owes the report.
    t.settleWaits.length = 0; // the cancelled one
    await t.p.fire("agent_start", {});
    const next = t.settle();
    await t.answerWait(delegateEvent(id));
    expect(content(await next)).toContain("\nkept");
  });

  it("no wait while an extension dialog is open", async () => {
    const t = await setup();
    await t.p.fire("ui_prompt_start", { kind: "confirm" });
    try {
      expect(await t.settle()).toBeUndefined();
    } finally {
      await t.p.fire("ui_prompt_end", { kind: "confirm" });
    }
    const settling = t.settle();
    await t.answerWait(EVENT);
    expect(await settling).toMatchObject({ continue: true });
  });
});

describe("closing is bound to the agent the delegate spawned as", () => {
  const done = ok({ agents: [{ outcome: "done", lastText: "the answer" }] });
  const applies = (mu: ReturnType<typeof fakeMu>) =>
    mu.calls.filter((c) => c[1] === "close" && c.includes("--if"));
  const run = async (mu: ReturnType<typeof fakeMu>, params: Record<string, unknown> = {}) => {
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", ...params });
    return p;
  };

  it("success: previews, then applies once with the preview's revision", async () => {
    const mu = fakeMu();
    const p = await run(mu);
    mu.waits.get("delegate-2")?.resolve(done);
    await flush();
    await flush();
    const closes = mu.calls.filter((c) => c[1] === "close");
    expect(closes).toHaveLength(2);
    expect(closes[0]).not.toContain("--if"); // the read-only preview first
    // the fixture's first spawn is registry id 100, revision id * 7
    expect(closes[1]?.[closes[1].indexOf("--if") + 1]).toBe("700");
    expect(mu.registry.has("delegate-2")).toBe(false);
    expect(sentText(p)).not.toContain("Pane kept");
  });

  it("replaced before cleanup: the replacement is never previewed-then-applied; the pane is kept", async () => {
    const mu = fakeMu();
    const p = await run(mu);
    mu.replace("delegate-2"); // another agent took the name behind the delegate's back
    const replacement = mu.registry.get("delegate-2");
    mu.waits.get("delegate-2")?.resolve(done);
    await flush();
    await flush();
    expect(applies(mu)).toEqual([]);
    expect(mu.registry.get("delegate-2")).toEqual(replacement);
    expect(sentText(p)).toMatch(/Pane kept \(the name now belongs to another agent\)/);
  });

  it("the same incarnation on another pane, or another incarnation on the same pane, is not it", async () => {
    for (const mutate of [
      (r: { id: number; pane_id: string }) => ({ ...r, pane_id: "%999" }),
      (r: { id: number; pane_id: string }) => ({ ...r, id: r.id + 1 }),
    ]) {
      const mu = fakeMu();
      const p = await run(mu);
      const cur = mu.registry.get("delegate-2");
      if (cur) mu.registry.set("delegate-2", mutate(cur));
      mu.waits.get("delegate-2")?.resolve(done);
      await flush();
      await flush();
      expect(applies(mu)).toEqual([]);
      expect(sentText(p)).toMatch(/Pane kept \(the name now belongs to another agent\)/);
    }
  });

  it("gone before cleanup: nothing to apply", async () => {
    const mu = fakeMu();
    const p = await run(mu);
    mu.registry.delete("delegate-2");
    mu.waits.get("delegate-2")?.resolve(done);
    await flush();
    await flush();
    expect(applies(mu)).toEqual([]);
    expect(sentText(p)).toMatch(/Pane kept \(it is no longer registered\)/);
  });

  it("a code-0 reply that is not a success envelope is not a preview", async () => {
    const mu = fakeMu({
      on: {
        close: (args) =>
          args.includes("--if")
            ? undefined
            : Promise.resolve({
                code: 0,
                stdout: JSON.stringify({
                  ok: false,
                  error: "X",
                  message: "m",
                  data: { kind: "agent", revision: 1 },
                }),
                stderr: "",
              }),
      },
    });
    const p = await run(mu);
    mu.waits.get("delegate-2")?.resolve(done);
    await flush();
    await flush();
    expect(applies(mu)).toEqual([]);
    expect(sentText(p)).toMatch(/Pane kept \(close preview failed/);
  });

  it("a preview without a safe-integer revision is not applied", async () => {
    const mu = fakeMu({
      on: {
        close: (args) => {
          if (args.includes("--if")) return undefined;
          const cur = mu.registry.get("delegate-2");
          return Promise.resolve(ok({ kind: "agent", revision: "7", ...cur }));
        },
      },
    });
    const p = await run(mu);
    mu.waits.get("delegate-2")?.resolve(done);
    await flush();
    await flush();
    expect(applies(mu)).toEqual([]);
    expect(sentText(p)).toMatch(/Pane kept \(close preview had no revision\)/);
  });

  it("cancel closes through the same bound path; a replacement survives it", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.replace("delegate-2");
    const res = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" });
    expect(applies(mu)).toEqual([]);
    expect(res.content[0]?.text).toContain("Pane kept: the name now belongs to another agent");
    expect(mu.registry.has("delegate-2")).toBe(true);
  });

  it("an abort during spawn and a failed send go through the bound close too", async () => {
    const ac = new AbortController();
    const mu = fakeMu({
      on: {
        spawn: () => {
          ac.abort();
          return undefined;
        },
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x" }, ac.signal)).rejects.toThrow();
    expect(applies(mu)).toHaveLength(1);
    expect(mu.registry.has("delegate-2")).toBe(false);

    let sends = 0;
    const mu2 = fakeMu({
      on: {
        send: () =>
          sends++ === 0 ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) : undefined,
      },
    });
    const p2 = fakePi();
    registerDelegate(p2.pi, mu2.run);
    await expect(tool(p2).execute("t", { task: "x" })).rejects.toThrow(/Pane closed/);
    expect(applies(mu2)).toHaveLength(1);
  });

  it("a spawn reply without an identity keeps the pane (an older mu): no blind close", async () => {
    const mu = fakeMu({
      on: {
        spawn: () =>
          Promise.resolve(
            ok({
              agent: { name: "delegate-2", cwd: null },
              ctl: "ok",
              send: { ok: true, runs: 0 },
            }),
          ),
      },
    });
    const p = await run(mu);
    mu.waits.get("delegate-2")?.resolve(done);
    await flush();
    await flush();
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false);
    expect(sentText(p)).toMatch(/Pane kept \(its spawn did not report an identity\)/);
  });
});
