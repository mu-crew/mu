import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATE_CANCEL_TOOL,
  DELEGATE_REISSUE_TOOL,
  DELEGATE_TOOL,
  type DelegateCtx,
  delegateEnabled,
  delegateMax,
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
import muPi, { type MuPiContext } from "../extension/mu-pi.js";
import { listDelegates } from "../src/delegates.js";
import {
  failed,
  fakeMu,
  fakePi,
  flush,
  installDelegateEnv,
  ok,
  reportOf,
  sentArg,
  sentText,
  tool,
} from "./_delegate-fixtures.js";
import { withEnv } from "./_env.js";

installDelegateEnv();

const pendingCounts = (p: ReturnType<typeof fakePi>) =>
  p.emitted
    .filter((e) => e.channel === PENDING_CHANNEL)
    .map((e) => (e.data as { source: string; count: number }).count);

describe("registration guards", () => {
  it("registers mu_delegate, mu_delegate_reissue and mu_delegate_cancel in an unmanaged pi", () => {
    const p = fakePi();
    registerDelegate(p.pi, fakeMu().run);
    expect([...p.tools.keys()]).toEqual([
      DELEGATE_TOOL,
      DELEGATE_REISSUE_TOOL,
      DELEGATE_CANCEL_TOOL,
    ]);
  });

  it("is hidden inside a mu-managed agent (no helper-spawns-helper)", () => {
    process.env.MU_MANAGED_AGENT = "1";
    const p = fakePi();
    registerDelegate(p.pi, fakeMu().run);
    expect(p.tools.size).toBe(0);
  });

  it("delegateEnabled is false under MU_MANAGED_AGENT (agents and the pis nested in them)", () => {
    expect(delegateEnabled({ MU_MANAGED_AGENT: "1", TMUX: "/tmp/x,1,0" })).toBe(false);
  });

  it("is hidden by the MU_DELEGATE=0 kill switch", () => {
    process.env.MU_DELEGATE = "0";
    expect(delegateEnabled()).toBe(false);
  });

  it("is registered with no mux in reach (it runs mux-free)", () => {
    expect(delegateEnabled({ PATH: "/nonexistent" })).toBe(true);
  });

  it("the default export carries it (not optional)", () => {
    const p = fakePi();
    muPi({ ...p.pi, on: () => {}, sendUserMessage: () => {}, registerCommand: () => {} });
    // A real runner would shell out; registration alone must not.
    expect(p.tools.has(DELEGATE_TOOL)).toBe(true);
  });
});

describe("mu_delegate", () => {
  it("returns at once with the name, then records the answer, closes the pane and wakes an idle pi", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const res = await tool(p).execute("t1", { task: "find X", brief: "You are terse." });
    // delegate-1 is taken in the list: the next free name.
    expect(res.content[0]?.text).toContain("scratch/delegate-2");
    expect(res.content[0]?.text).toContain("tmux attach -t mu-scratch");
    // Bound to its durable delegate task, with a stable attempt: a replay never sends twice.
    const task = (listDelegates(mu.db)[0] ?? { task: "" }).task;
    expect(mu.calls.find((c) => c[1] === "spawn")).toEqual([
      "agent",
      "spawn",
      "delegate-1",
      "-w",
      "scratch",
      "--next-free",
      "--task",
      task,
      "--attempt",
      task,
      "--send",
      "You are terse.\n\nfind X",
      "--json",
      "--cwd",
      process.cwd(),
    ]);
    expect(res.details).toMatchObject({ task: `scratch/${task}`, state: "running" });
    expect(p.sendMessage).not.toHaveBeenCalled();

    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "X is 42" }] }));
    await flush();
    await flush();
    expect(mu.calls.some((c) => c[1] === "close" && c[2] === "delegate-2")).toBe(true);
    expect(reportOf(mu)).toBe("X is 42");
    // pi is idle: one wake, a pointer to the report, never the answer itself.
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = p.sendMessage.mock.calls[0] ?? [];
    expect(msg).toMatchObject({ customType: "mu-delegate", display: true });
    const wake = (msg as { content: string }).content;
    expect(wake).not.toContain("X is 42");
    expect(wake).toContain(`mu task notes ${task} -w scratch`);
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("registers the call, spawns it task-bound, marks it running, then waits --after-runs <runs>", async () => {
    const mu = fakeMu({ on: { send: () => Promise.resolve(ok({ transport: "ctl", runs: 3 })) } });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    // No agent list, no separate send, no speculative plain wait.
    expect(mu.calls.map((c) => c[1])).toEqual(["register", "spawn", "mark", "wait"]);
    const wait = mu.calls[3] ?? [];
    expect(wait[wait.indexOf("--after-runs") + 1]).toBe("3");
  });

  it("with record: task show, register, spawn, mark, wait before the tool returns", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    let returned = -1;
    await tool(p)
      .execute("t", { task: "x", record: { task: "f1", workstream: "crew" } })
      .then(() => {
        returned = mu.calls.length;
      });
    // The wait runs in the background; the tool returned after show, register, spawn and mark.
    expect(mu.calls.slice(0, 4).map((c) => c.slice(0, 2))).toEqual([
      ["task", "show"],
      ["delegates", "register"],
      ["agent", "spawn"],
      ["delegates", "mark"],
    ]);
    expect(returned).toBe(5);
    expect(mu.calls[4]?.[1]).toBe("wait");
  });

  it("without runs in the send reply (older extension) waits past run 0: the pi just started", async () => {
    const mu = fakeMu({ on: { send: () => Promise.resolve(ok({ transport: "ctl" })) } });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const wait = mu.calls.find((c) => c[1] === "wait") ?? [];
    expect(wait[wait.indexOf("--after-runs") + 1]).toBe("0");
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "old" }] }));
    await flush();
    await flush();
    expect(reportOf(mu)).toBe("old");
  });

  it("cwd and timeout reach spawn and wait; the timeout is named in the report", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", cwd: "/tmp", timeout: 90 });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn.slice(spawn.indexOf("--cwd"), spawn.indexOf("--cwd") + 2)).toEqual([
      "--cwd",
      "/tmp",
    ]);
    const wait = mu.calls.find((c) => c[1] === "wait") ?? [];
    expect(wait[wait.indexOf("--timeout") + 1]).toBe("90");
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "timeout" }] }));
    await flush();
    await flush();
    expect(reportOf(mu)).toContain("still running after 90s");
  });

  it("model appends --model to the cli's resolved command and spawns with --command", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await withEnv("MU_PI_COMMAND", "pi-meta --approve", async () => {
      await tool(p).execute("t", { task: "x", model: "anthropic/claude-opus-4:high" });
    });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn[spawn.indexOf("--command") + 1]).toBe(
      "pi-meta --approve --model anthropic/claude-opus-4:high",
    );
    expect(spawn).not.toContain("--cli");
  });

  it("model accepts a gateway provider/family/id:level value", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", model: "modelbridge/anthropic/claude-sonnet-5-5:low" });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn[spawn.indexOf("--command") + 1]).toContain(
      "--model modelbridge/anthropic/claude-sonnet-5-5:low",
    );
  });

  it("model with cli resolves that key's command, or the bare key when unset", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", cli: "pi-alt", model: "sonnet" });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn[spawn.indexOf("--command") + 1]).toBe("pi-alt --model sonnet");
    // --cli still names the agent's kind; --command wins for what runs.
    expect(spawn[spawn.indexOf("--cli") + 1]).toBe("pi-alt");
  });

  it.each([
    [
      "modelbridge/meta-openai/gpt-6.1-sol[1m]:high",
      "'modelbridge/meta-openai/gpt-6.1-sol[1m]:high'",
    ],
    ["  `anthropic/claude-opus-5-5:high`  ", "anthropic/claude-opus-5-5:high"],
    ["'sonnet'", "sonnet"],
    ["--model sonnet", "sonnet"],
    ['--model="sonnet"', "sonnet"],
    ["x;$(rm)", "'x;$(rm)'"],
    ["it's", "'it'\\''s'"],
  ])("model forgives %j, passing --model %s", async (model, arg) => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", cli: "pi-alt", model });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn[spawn.indexOf("--command") + 1]).toBe(`pi-alt --model ${arg}`);
  });

  it("treats an empty model as unset", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", model: "" });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn).not.toContain("--command");
  });

  it("refuses a model with inner whitespace before spawning", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x", model: "x; rm -rf ~" })).rejects.toThrow(
      /model/,
    );
    expect(mu.calls.some((c) => c[1] === "spawn")).toBe(false);
  });

  it("workspace: true spawns with --worktree --root <cwd> (no --cwd) and reports the worktree path", async () => {
    const mu = fakeMu({ workspace: "/ws/scratch/delegate-2" });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const res = await tool(p).execute("t", { task: "x", workspace: true, cwd: "/tmp" });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn.slice(spawn.indexOf("--worktree"), spawn.indexOf("--worktree") + 3)).toEqual([
      "--worktree",
      "--root",
      "/tmp",
    ]);
    expect(spawn).not.toContain("--cwd");
    expect(res.content[0]?.text).toContain("Workspace: /ws/scratch/delegate-2");
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "timeout" }] }));
    await flush();
    await flush();
    expect(reportOf(mu)).toContain("Workspace: /ws/scratch/delegate-2");
  });

  it("workspace without cwd: a bare --worktree (the caller's cwd is the repo)", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", workspace: true });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn).toContain("--worktree");
    expect(spawn).not.toContain("--root");
    expect(spawn).not.toContain("--cwd");
  });

  it("workspace with a cwd that is not a dir refuses before anything registers", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(
      tool(p).execute("t", { task: "x", workspace: true, cwd: "/nonexistent-mu-dir" }),
    ).rejects.toThrow(/not a directory/);
    expect(mu.calls).toEqual([]);
  });

  it("a non-repo worktree refusal is final: names the fix, never 'reissue', recorded as failed", async () => {
    const refusal = JSON.stringify({
      ok: false,
      error: "WorktreeVcsRequiredError",
      message: "--worktree requires a git repository; /tmp is not inside one",
      exit: 4,
    });
    const mu = fakeMu({
      on: { spawn: () => Promise.resolve({ code: 4, stdout: refusal, stderr: "" }) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const err = await tool(p)
      .execute("t", { task: "x", workspace: true, cwd: "/tmp" })
      .then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    expect(err).toContain("--worktree requires a git repository; /tmp is not inside one");
    expect(err).toContain("Pass cwd: <a git repo>");
    expect(err).toContain("as failed");
    expect(err).not.toMatch(/reissue/i);
    expect(mu.calls.map((c) => c[1])).toEqual(["register", "spawn", "finish"]);
  });

  it("parallel calls get distinct names", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const [a, b] = await Promise.all([
      tool(p).execute("a", { task: "one" }),
      tool(p).execute("b", { task: "two" }),
    ]);
    expect(a.content[0]?.text).toContain("delegate-2");
    expect(b.content[0]?.text).toContain("delegate-3");
  });

  it("past MU_DELEGATE_MAX a call is queued, and starts when a slot frees", async () => {
    process.env.MU_DELEGATE_MAX = "2";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      // All three start before any spawn resolves, as parallel tool calls do.
      const [a, b, c] = await Promise.all([
        tool(p).execute("a", { task: "one" }),
        tool(p).execute("b", { task: "two" }),
        tool(p).execute("c", { task: "three" }),
      ]);
      expect(a.content[0]?.text).toContain("Delegated to");
      expect(b.content[0]?.text).toContain("Delegated to");
      expect(c.content[0]?.text).toContain("Queued as queued-1");
      expect(c.details).toMatchObject({ queued: true, position: 1 });
      const spawns = () => mu.calls.filter((x) => x[1] === "spawn");
      expect(spawns()).toHaveLength(2);
      // An answer frees a slot: the queued call spawns, with the caller's cwd.
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      for (let i = 0; i < 5; i++) await flush();
      expect(spawns()).toHaveLength(3);
      expect(spawns()[2]).toContain("--cwd");
      expect(sentArg(spawns()[2] ?? [])).toBe("three");
      // Its answer names the call id the queued result gave, so a batch of
      // answers still maps back to the calls.
      const third = [...mu.waits.keys()].at(-1) ?? "";
      mu.waits.get(third)?.resolve(ok({ agents: [{ outcome: "done", lastText: "z" }] }));
      for (let i = 0; i < 4; i++) await flush();
      const callId = String((c.details as { call_id: string }).call_id);
      const texts = p.sendMessage.mock.calls.map((x) => (x[0] as { content: string }).content);
      expect(texts.some((t) => t.includes(`${third} (done; call ${callId})`))).toBe(true);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("the queue holds four caps' worth; past it a call is REFUSED, durable, and reissued once", async () => {
    process.env.MU_DELEGATE_MAX = "2";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      // 2 running + 8 queued (4 x 2) are accepted; the next 2 are refused, not thrown.
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          tool(p).execute(String(i), { task: `t${i}`, wave: "w" }),
        ),
      );
      const state = (r: (typeof results)[number]) => (r.details as { state: string }).state;
      expect(results.map(state)).toEqual([
        ...Array(2).fill("running"),
        ...Array(8).fill("queued"),
        ...Array(2).fill("refused"),
      ]);
      const refused = results.slice(10);
      for (const r of refused) {
        const text = r.content[0]?.text ?? "";
        expect(text).toContain("REFUSED, not started");
        expect(text).toContain("8 queued (MU_DELEGATE_MAX=2)");
        expect(text).toContain(DELEGATE_REISSUE_TOOL);
      }
      // Every call, refused ones included, is a durable delegate task.
      const rows = listDelegates(mu.db);
      expect(rows).toHaveLength(12);
      expect(rows.filter((r) => r.state === "refused").map((r) => r.callId)).toEqual(
        refused.map((r) => (r.details as { call_id: string }).call_id),
      );
      // murmur counts running + starting + queued, never the refused.
      expect(pendingCounts(p).at(-1)).toBe(10);
      // Refused tasks are parked: outside the ready view the executor reads.
      const ready = mu.db.prepare("SELECT local_id FROM ready").all() as { local_id: string }[];
      for (const r of rows.filter((x) => x.state === "refused"))
        expect(ready.map((x) => x.local_id)).not.toContain(r.task);
      // Still full: reissue says so, changes nothing.
      const first = refused[0] as (typeof results)[number];
      await expect(
        tool(p, DELEGATE_REISSUE_TOOL).execute("r", {
          call_id: (first.details as { call_id: string }).call_id,
        }),
      ).rejects.toThrow(/still full/);
      // Slots free as answers arrive: 2 finish, 2 queued start, the queue has room again.
      for (const name of [...mu.waits.keys()].slice(0, 2))
        mu.waits.get(name)?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      for (let i = 0; i < 12; i++) await flush();
      for (const r of refused) {
        const id = (r.details as { call_id: string }).call_id;
        const out = await tool(p, DELEGATE_REISSUE_TOOL).execute("r", { call_id: id });
        expect((out.details as { call_id: string }).call_id).toBe(id);
        await expect(tool(p, DELEGATE_REISSUE_TOOL).execute("r", { call_id: id })).rejects.toThrow(
          /not refused/,
        );
      }
      const after = listDelegates(mu.db);
      expect(after).toHaveLength(12); // reissue never makes a second call or task
      expect(after.filter((r) => r.state === "refused")).toHaveLength(0);
      expect(
        mu.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE kind = 'delegate'").get(),
      ).toEqual({
        c: 12,
      });
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("mu_delegate_cancel drops a queued call before it starts", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      const q = await tool(p).execute("b", { task: "two" });
      expect(q.content[0]?.text).toContain("queued-1");
      const r = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "queued-1" });
      expect(r.content[0]?.text).toContain("never started");
      expect(mu.calls.some((x) => x[1] === "abort")).toBe(false);
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      for (let i = 0; i < 5; i++) await flush();
      expect(mu.calls.filter((x) => x[1] === "spawn")).toHaveLength(1);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("a queued call that fails to start reports it as a follow-up", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      let n = 0;
      const mu = fakeMu({
        on: {
          spawn: () =>
            ++n === 2 ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) : undefined,
        },
      });
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      await tool(p).execute("b", { task: "two" });
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      for (let i = 0; i < 6; i++) await flush();
      const texts = p.sendMessage.mock.calls.map((c) => (c[0] as { content: string }).content);
      expect(
        texts.some(
          (t) => t.includes("Queued delegate queued-1 could not start") && t.includes("boom"),
        ),
      ).toBe(true);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("session_shutdown names queued calls as never started", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      await tool(p).execute("b", { task: "two" });
      const notify = vi.fn();
      for (const h of p.shutdown) await h({}, { hasUI: true, ui: { notify } });
      expect(notify.mock.calls[0]?.[0]).toContain("queued, never started: queued-1");
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("a queued workspace call keeps its root when it starts", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      const q = await tool(p).execute("b", { task: "two", workspace: true, cwd: "/tmp" });
      expect(q.details).toMatchObject({ queued: true });
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      for (let i = 0; i < 5; i++) await flush();
      const second = mu.calls.filter((x) => x[1] === "spawn")[1] ?? [];
      expect(second[second.indexOf("--root") + 1]).toBe("/tmp");
      expect(second).not.toContain("--cwd");
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("abort during spawn: the runner gets the signal; the call ends cancelled once the spawn returned", async () => {
    const ctl = new AbortController();
    let release: (r: MuResult) => void = () => {};
    let seen: AbortSignal | undefined;
    const mu = fakeMu({
      on: {
        spawn: () =>
          new Promise<MuResult>((r) => {
            release = r;
          }),
      },
    });
    const run: typeof mu.run = (args, signal, stdin) => {
      if (args[1] === "spawn") seen = signal;
      return mu.run(args, signal, stdin);
    };
    const p = fakePi();
    registerDelegate(p.pi, run);
    let settled = false;
    const out = tool(p)
      .execute("t", { task: "x", workspace: true }, ctl.signal)
      .then(
        () => "resolved",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        settled = true;
      });
    await flush();
    await flush();
    ctl.abort();
    await flush();
    expect(seen?.aborted).toBe(true);
    expect(settled).toBe(false); // still waiting for the spawn's rollback
    release({ code: 143, stdout: "", stderr: "SIGTERM during spawn: rolled back" });
    const msg = await out;
    expect(msg).toContain("rolled back");
    expect(msg).not.toMatch(/reissue/i);
    expect(mu.calls.map((c) => c[1])).toEqual(["register", "spawn", "finish"]);
  });

  it("a failed spawn frees its slot", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      let fail = true;
      const mu = fakeMu({
        on: {
          spawn: () =>
            fail ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) : undefined,
        },
      });
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await expect(tool(p).execute("a", { task: "one" })).rejects.toThrow("boom");
      fail = false;
      const b = await tool(p).execute("b", { task: "two" });
      expect(b.content[0]?.text).toContain("Delegated to"); // a free slot, not queued
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("a direct call that fails while a call is queued starts the queued call", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      let fail: (r: MuResult) => void = () => {};
      let n = 0;
      const mu = fakeMu({
        on: {
          // The first spawn stays pending until the second call has queued.
          spawn: () => (++n === 1 ? new Promise<MuResult>((r) => (fail = r)) : undefined),
        },
      });
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      const a = tool(p).execute("a", { task: "one" });
      const b = await tool(p).execute("b", { task: "two" });
      expect(b.content[0]?.text).toContain("Queued as queued-1");
      for (let i = 0; i < 5 && n === 0; i++) await flush();
      expect(n).toBe(1); // the first spawn is in flight
      fail({ code: 1, stdout: "", stderr: "boom" });
      await expect(a).rejects.toThrow("boom");
      for (let i = 0; i < 5; i++) await flush();
      const spawns = mu.calls.filter((x) => x[1] === "spawn");
      expect(spawns).toHaveLength(2);
      expect(sentArg(spawns[1] ?? [])).toBe("two");
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("delegateMax: default 16; ignores junk", () => {
    expect(delegateMax({})).toBe(16);
    expect(delegateMax({ MU_DELEGATE_MAX: "4" })).toBe(4);
    expect(delegateMax({ MU_DELEGATE_MAX: "0" })).toBe(16);
    expect(delegateMax({ MU_DELEGATE_MAX: "x" })).toBe(16);
  });

  it("keep: true leaves the pane open", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", keep: true });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
    await flush();
    await flush();
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false);
    expect(sentText(p)).toContain("Pane kept (keep: true)");
  });

  it("a died delegate keeps its pane as evidence and carries the pane tail", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve({ ...ok({ agents: [{ outcome: "died" }] }), code: 6 });
    await flush();
    await flush();
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false);
    const content = reportOf(mu);
    expect(content).toContain("died");
    expect(content).toContain("last pane lines");
    expect(sentText(p)).toContain("Pane kept (kept as evidence)");
  });

  it("an API error keeps the pane, names the error, and leaves nothing outstanding", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits
      .get("delegate-2")
      ?.resolve(ok({ agents: [{ outcome: "error", lastError: "529 overloaded" }] }));
    await flush();
    await flush();
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false);
    expect(mu.calls.some((c) => c[1] === "read")).toBe(false); // the error is the evidence
    const content = reportOf(mu);
    expect(content).toContain("stopped on an API error");
    expect(content).toContain("529 overloaded");
    expect(content).toContain("re-issue the call, or record the check as UNVERIFIED");
    expect(content).toContain("mu agent close delegate-2 -w scratch");
    expect(pendingCounts(p)).toEqual([1, 0]); // a failed pane has answered
  });

  it("throws (a normal tool error) when the control socket is not ok", async () => {
    const p = fakePi();
    registerDelegate(p.pi, fakeMu({ ctl: "missing" }).run);
    await expect(tool(p).execute("t", { task: "x" })).rejects.toThrow(/control socket is missing/);
  });

  it("session_shutdown names exactly the delegates still in flight", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" });
    await tool(p).execute("b", { task: "two" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "z" }] }));
    await flush();
    await flush();
    const notify = vi.fn();
    for (const h of p.shutdown) await h({ reason: "quit" }, { hasUI: true, ui: { notify } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatch(/^1 delegate still running: delegate-3\./);
    expect(mu.waits.get("delegate-3")?.signal?.aborted).toBe(true);
  });

  it("mu_delegate_cancel aborts, closes, and suppresses the follow-up", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const res = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" });
    expect(mu.calls.some((c) => c[1] === "abort" && c[2] === "delegate-2")).toBe(true);
    expect(mu.calls.some((c) => c[1] === "close" && c[2] === "delegate-2")).toBe(true);
    expect(res.content[0]?.text).toContain("Pane closed");
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "late" }] }));
    await flush();
    expect(p.sendMessage).not.toHaveBeenCalled();
  });
});

describe("errors and corner cases", () => {
  const deferred = () => {
    let resolve!: (r: MuResult) => void;
    const promise = new Promise<MuResult>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };
  const fail = (stderr: string): MuResult => ({ code: 1, stdout: "", stderr });

  it("a label names the delegate, numbered when taken", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const [a, b] = await Promise.all([
      tool(p).execute("a", { task: "x", label: "Code Review" }),
      tool(p).execute("b", { task: "y", label: "code review" }),
    ]);
    expect(a.content[0]?.text).toContain("scratch/delegate-code-review ");
    expect(b.content[0]?.text).toContain("scratch/delegate-code-review-2 ");
  });

  it("an invalid timeout is refused, not silently an hour", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    for (const timeout of [0, -1, Number.NaN, "60"])
      await expect(tool(p).execute("t", { task: "x", timeout })).rejects.toThrow(
        /timeout must be a positive number/,
      );
    expect(mu.calls.some((c) => c[1] === "spawn")).toBe(false);
  });

  it("the wake details carry the call ids it points at, for machine readers", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const r = await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "42" }] }));
    await flush();
    await flush();
    const msg = p.sendMessage.mock.calls[0]?.[0] as { details: Record<string, unknown> };
    expect(msg.details).toEqual({ wake: 1, calls: [(r.details as { call_id: string }).call_id] });
  });

  it("a cwd that is not a directory fails before anything spawns", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x", cwd: "/nonexistent/xyz" })).rejects.toThrow(
      /is not a directory/,
    );
    expect(mu.calls.some((c) => c[1] === "spawn")).toBe(false);
  });

  it("defaults cwd to the session's ctx.cwd", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" }, undefined, undefined, { cwd: "/tmp" });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn[spawn.indexOf("--cwd") + 1]).toBe("/tmp");
  });

  it("a failed send closes the pane, says so, and frees the name", async () => {
    let sends = 0;
    const mu = fakeMu({
      on: { send: () => (sends++ === 0 ? Promise.resolve(fail("boom")) : undefined) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x" })).rejects.toThrow(/boom.*Pane closed/);
    expect(mu.calls.some((c) => c[1] === "close" && c[2] === "delegate-2")).toBe(true);
    const again = await tool(p).execute("t2", { task: "y" });
    expect(again.content[0]?.text).toContain("delegate-2");
  });

  it("a delivery-unknown send keeps the pane, says so, and does not retry", async () => {
    const mu = fakeMu({
      on: {
        send: () =>
          Promise.resolve({
            code: 1,
            stdout: "AgentSendIndeterminateError",
            stderr: "delivery unknown",
          }),
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const err = await tool(p)
      .execute("t", { task: "x" })
      .catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/delivery unknown.*Pane kept.*mu agent read delegate-2 -w scratch/);
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false);
    expect(mu.calls.filter((c) => c[1] === "spawn")).toHaveLength(1);
  });

  it("an abort signal during spawn takes the new pane down", async () => {
    const ac = new AbortController();
    const mu = fakeMu({
      on: {
        spawn: () => {
          ac.abort();
          return undefined; // the default ok answer
        },
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x" }, ac.signal)).rejects.toThrow();
    expect(mu.calls.some((c) => c[1] === "close" && c[2] === "delegate-2")).toBe(true);
    expect(mu.calls.some((c) => c[1] === "send")).toBe(false);
  });

  it("a delivery failure becomes a follow-up, not an unhandled rejection", async () => {
    const mu = fakeMu({ on: { read: () => Promise.reject(new Error("read exploded")) } });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "died" }] }));
    await flush();
    await flush();
    expect(sentText(p)).toMatch(/delivering its answer failed: read exploded/);
  });

  it("cancel whose abort fails keeps the delegate tracked and delivers an answer that landed meanwhile", async () => {
    const ab = deferred();
    const mu = fakeMu({ on: { abort: () => ab.promise } });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const cancel = tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" });
    await flush();
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "late" }] }));
    await flush();
    expect(p.sendMessage).not.toHaveBeenCalled(); // parked while the abort is in flight
    ab.resolve(fail("agent gone"));
    await expect(cancel).rejects.toThrow(/agent gone/);
    await flush();
    await flush();
    expect(reportOf(mu)).toBe("late");
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    expect(pendingCounts(p).at(-1)).toBe(0);
  });

  it("cancel whose abort fails before any answer keeps waiting (still outstanding)", async () => {
    const mu = fakeMu({ on: { abort: () => Promise.resolve(fail("nope")) } });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    await expect(
      tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" }),
    ).rejects.toThrow(/nope/);
    expect(pendingCounts(p)).toEqual([1]);
    mu.waits
      .get("delegate-2")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: "still here" }] }));
    await flush();
    await flush();
    expect(reportOf(mu)).toBe("still here");
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("a successful cancel drops an answer that its own abort settled", async () => {
    const ab = deferred();
    const mu = fakeMu({ on: { abort: () => ab.promise } });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const cancel = tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" });
    await flush();
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "empty" }] }));
    await flush();
    ab.resolve(ok("{}"));
    await cancel;
    await flush();
    expect(p.sendMessage).not.toHaveBeenCalled();
  });
});

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
    await settled(p);
    expect(p.sendMessage).toHaveBeenCalledTimes(2); // no wake after the user stopped
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
        "- scratch/delegate-3 (error; call pi:s:1): mu task notes delegate_ab -w scratch. Pane kept (kept as evidence): mu agent read delegate-3 -n 50 -w scratch.",
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

  it("a wave entry whose first wait carries a human need keeps that wait's JSON", async () => {
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
    expect(text).toContain("Its result:");
    expect(text).toContain('"reason":"spend approval"');
    expect(text).toContain("Wave w:");
    expect(r?.continue).toBeUndefined(); // a human stop ends the turn
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
