import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} from "../extension/delegate.js";
import muPi, { type MuPiContext } from "../extension/mu-pi.js";
import { listDelegates } from "../src/delegates.js";
import {
  fakeMu,
  fakePi,
  flush,
  installDelegateEnv,
  ok,
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

  it("is hidden when no mux is in reach", () => {
    expect(delegateEnabled({ PATH: "/nonexistent" })).toBe(false);
    expect(delegateEnabled({ PATH: "/nonexistent", TMUX: "/tmp/x,1,0" })).toBe(true);
  });

  it("the default export carries it (not optional)", () => {
    const p = fakePi();
    muPi({ ...p.pi, on: () => {}, sendUserMessage: () => {}, registerCommand: () => {} });
    // A real runner would shell out; registration alone must not.
    expect(p.tools.has(DELEGATE_TOOL)).toBe(true);
  });
});

describe("mu_delegate", () => {
  it("returns at once with the name, then delivers the answer as a follow-up and closes the pane", async () => {
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
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = p.sendMessage.mock.calls[0] ?? [];
    expect(msg).toMatchObject({ customType: "mu-delegate", display: true });
    expect((msg as { content: string }).content).toContain("X is 42");
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
    expect(sentText(p)).toContain("old");
  });

  it("cwd and timeout reach spawn and wait; the timeout is named in the message", async () => {
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
    expect(sentText(p)).toContain("still running after 90s");
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
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "edited" }] }));
    await flush();
    await flush();
    expect(sentText(p)).toContain("Workspace: /ws/scratch/delegate-2");
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
      // Its answer names the handle the model was given, so a batch of
      // answers still maps back to the calls.
      const third = [...mu.waits.keys()].at(-1) ?? "";
      mu.waits.get(third)?.resolve(ok({ agents: [{ outcome: "done", lastText: "z" }] }));
      for (let i = 0; i < 4; i++) await flush();
      const texts = p.sendMessage.mock.calls.map((x) => (x[0] as { content: string }).content);
      expect(texts.some((t) => t.includes(`${third} (queued as queued-1) finished`))).toBe(true);
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
    const content = sentText(p);
    expect(content).toContain("died");
    expect(content).toContain("last pane lines");
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
    const content = sentText(p);
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

  it("the follow-up details carry the answer and run time for machine readers", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "42" }] }));
    await flush();
    await flush();
    const msg = p.sendMessage.mock.calls[0]?.[0] as { details: Record<string, unknown> };
    expect(msg.details).toMatchObject({ outcome: "done", answer: "42", closed: true });
    expect(typeof msg.details.elapsedMs).toBe("number");
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
    expect(sentText(p)).toContain("late");
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
    expect(sentText(p)).toContain("still here");
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
    releaseSpawn(
      ok({ agent: { name: "delegate-2" }, ctl: "ok", send: { ok: true, runs: 0 }, nextSteps: [] }),
    );
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

  it("counts a finished answer as pending until it enters the conversation", async () => {
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    const { ctx } = uiCtx();
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, ctx);
    await tool(p).execute("b", { task: "two" }, undefined, undefined, ctx);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "x" }] }));
    await flush();
    await flush();
    // Sent, but pi is mid-turn: it waits in pi's follow-up queue.
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    expect(handle.answerPending()).toBe(true);
    expect(pendingCounts(p).at(-1)).toBe(1); // the second delegate only
    // Someone else's custom message does not clear it.
    await p.fire("message_start", {
      message: { role: "custom", customType: "other", details: { delivery: 1 } },
    });
    expect(handle.answerPending()).toBe(true);
    await p.drainQueue();
    expect(handle.answerPending()).toBe(false);
  });

  it("an aborted run drops queued answers from the pending count and points at each one", async () => {
    const cache = mkdtempSync(join(tmpdir(), "mu-dropped-"));
    process.env.XDG_CACHE_HOME = cache;
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    const { ctx } = uiCtx();
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, ctx);
    mu.waits
      .get("delegate-2")
      ?.resolve(
        ok({ agents: [{ outcome: "done", lastText: "the answer", sessionFile: "/s/d2.jsonl" }] }),
      );
    await flush();
    await flush();
    expect(handle.answerPending()).toBe(true);
    await p.fire("agent_settled", { type: "agent_settled", aborted: true });
    expect(handle.answerPending()).toBe(false);
    // One note, no turn, one line pointing at the copy and the session.
    expect(p.sendMessage).toHaveBeenCalledTimes(2);
    const [note, opts] = p.sendMessage.mock.calls[1] ?? [];
    expect(opts).toEqual({ triggerTurn: false });
    const text = (note as { content: string }).content;
    const line = text.split("\n").find((l) => l.startsWith("- scratch/delegate-2")) ?? "";
    expect(line).toContain("(done, ");
    expect(line).toContain("session: /s/d2.jsonl");
    const copy = /answer: (\S+)/.exec(line)?.[1] ?? "";
    expect(copy.startsWith(join(cache, "mu", "delegate-answers"))).toBe(true);
    expect(readFileSync(copy, "utf8")).toContain("the answer");
    rmSync(cache, { recursive: true, force: true });
  });

  /** agent_settled, then the tick the extension waits before judging an answer lost. */
  const settled = async (p: ReturnType<typeof fakePi>, aborted = false) => {
    await p.fire("agent_settled", { type: "agent_settled", aborted });
    await new Promise((r) => setImmediate(r));
  };

  it("a follow-up cleared from pi's queue without an abort is sent again when the run settles", async () => {
    // The dequeue key calls session.clearQueue(): the custom follow-up is
    // dropped, the run ends normally (aborted: false) and nothing arrives.
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    const { ctx } = uiCtx();
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, ctx);
    mu.waits
      .get("delegate-2")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: "the answer" }] }));
    await flush();
    await flush();
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    await settled(p); // queue was cleared
    expect(p.sendMessage).toHaveBeenCalledTimes(2);
    const [again, opts] = p.sendMessage.mock.calls[1] ?? [];
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    const [first] = p.sendMessage.mock.calls[0] ?? [];
    expect(again).toEqual(first);
    expect(handle.answerPending()).toBe(true);
    // pi starts the resent message: it arrives once and the count clears.
    p.state.busy = false;
    await p.fire("message_start", {
      type: "message_start",
      message: { role: "custom", ...(again as object) },
    });
    expect(handle.answerPending()).toBe(false);
  });

  it("a follow-up that pi drained before the run ended is not sent again", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "x" }] }));
    await flush();
    await flush();
    await p.drainQueue(); // message_start for the queued follow-up
    await p.fire("agent_settled", { type: "agent_settled", aborted: false });
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("an answer queued after agent_end (post-run compaction) and then cleared is sent again", async () => {
    // pi stays "streaming" through compaction after agent_end: the answer
    // is queued, the dequeue key clears it, the run settles normally.
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    await p.fire("agent_start", { type: "agent_start" });
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await p.fire("agent_end", { type: "agent_end" });
    p.state.busy = true; // compacting
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "x" }] }));
    await flush();
    await flush();
    expect(handle.answerPending()).toBe(true);
    await settled(p);
    expect(p.sendMessage).toHaveBeenCalledTimes(2);
    const [again, opts] = p.sendMessage.mock.calls[1] ?? [];
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    // Still pending until pi starts it; then it clears, so mu-pi's nudges are not held back.
    expect(handle.answerPending()).toBe(true);
    p.state.busy = false;
    await p.fire("message_start", { message: { role: "custom", ...(again as object) } });
    expect(handle.answerPending()).toBe(false);
  });

  it("several cleared answers are resent one at a time, each after the previous started", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    const n = 3;
    for (let i = 0; i < n; i++)
      await tool(p).execute(`c${i}`, { task: "t", keep: true }, undefined, undefined, uiCtx().ctx);
    for (let i = 0; i < n; i++)
      mu.waits
        .get(`delegate-${i + 2}`)
        ?.resolve(ok({ agents: [{ outcome: "done", lastText: `a${i}` }] }));
    await flush();
    await flush();
    expect(p.sendMessage).toHaveBeenCalledTimes(n);
    const settle = (aborted: boolean) => settled(p, aborted);
    for (let round = 1; round <= n; round++) {
      await settle(false); // queue was cleared
      expect(p.sendMessage).toHaveBeenCalledTimes(n + round); // exactly one resend
      const [m, o] = p.sendMessage.mock.calls[n + round - 1] ?? [];
      expect(o).toEqual({ deliverAs: "followUp", triggerTurn: true });
      await p.fire("message_start", {
        message: { role: "custom", ...(m as object) },
      }); // pi starts that one
    }
    await settle(false);
    expect(p.sendMessage).toHaveBeenCalledTimes(2 * n);
  });

  it("Escape during a resend drops the answers still waiting, with copies, and resends none", async () => {
    const cache = mkdtempSync(join(tmpdir(), "mu-dropped-"));
    process.env.XDG_CACHE_HOME = cache;
    const mu = fakeMu();
    const p = fakePi();
    const handle = registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    const n = 3;
    for (let i = 0; i < n; i++)
      await tool(p).execute(`c${i}`, { task: "t", keep: true }, undefined, undefined, uiCtx().ctx);
    for (let i = 0; i < n; i++)
      mu.waits
        .get(`delegate-${i + 2}`)
        ?.resolve(ok({ agents: [{ outcome: "done", lastText: `a${i}` }] }));
    await flush();
    await flush();
    // pi defers every triggerTurn send made inside agent_settled into a list
    // that neither abort() nor clearQueue() empties, and runs all of it.
    const before = p.sendMessage.mock.calls.length;
    await settled(p);
    const deferred = p.sendMessage.mock.calls.slice(before);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
    p.state.busy = false;
    await p.fire("message_start", {
      message: { role: "custom", ...(deferred[0]?.[0] as object) },
    });
    p.state.busy = true;
    await settled(p, true); // Escape in that run
    // Only the note follows: no further resend, and it names just the answers that will not arrive.
    expect(p.sendMessage).toHaveBeenCalledTimes(before + 2);
    const [note, opts] = p.sendMessage.mock.calls[before + 1] ?? [];
    expect(opts).toEqual({ triggerTurn: false });
    const dropped = (note as { details: { dropped: { name: string }[] } }).details.dropped;
    expect(dropped.map((d) => d.name)).toEqual(["delegate-3", "delegate-4"]);
    expect(handle.answerPending()).toBe(false);
    rmSync(cache, { recursive: true, force: true });
  });

  it("a second start of one delivery is rewritten to a one-line stub", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "BIG" }] }));
    await flush();
    await flush();
    const [sent] = p.sendMessage.mock.calls[0] ?? [];
    const again = { role: "custom", ...(sent as object) } as unknown as {
      content: string;
      details: Record<string, unknown>;
    };
    expect(again.content).toContain("BIG"); // the first start is untouched
    const repeat = structuredClone(again);
    await p.fire("message_start", { message: repeat });
    expect(repeat.content).toMatch(/already handled/);
    expect(repeat.content).not.toContain("BIG");
    expect(repeat.details).toMatchObject({ duplicateOf: again.details.delivery });
  });

  it("a dropped answer's deferred send is defused: no turn, and a stub if it starts", async () => {
    const cache = mkdtempSync(join(tmpdir(), "mu-dropped-"));
    process.env.XDG_CACHE_HOME = cache;
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "BIG" }] }));
    await flush();
    await flush();
    const [msg, opts] = p.sendMessage.mock.calls[0] ?? [];
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    await settled(p, true); // Escape: dropped with a copy
    // pi runs the send it deferred later, reading the options object it was handed.
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: false });
    expect((msg as { content: string }).content).toMatch(/already handled/);
    rmSync(cache, { recursive: true, force: true });
  });

  it("no resend while pi is not idle, or while a later answer is still in flight", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    p.state.busy = true;
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "x" }] }));
    await flush();
    await flush();
    const busyCtx = { isIdle: () => false };
    for (const h of p.handlers.get("agent_settled") ?? [])
      await h({ type: "agent_settled", aborted: false }, busyCtx);
    await new Promise((r) => setImmediate(r));
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("an interrupt with nothing queued leaves no note", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" }, undefined, undefined, uiCtx().ctx);
    await p.fire("agent_settled", { type: "agent_settled", aborted: true });
    expect(p.sendMessage).not.toHaveBeenCalled();
  });

  it("droppedNote falls back to mu agent read without a copy or session file", () => {
    const text = droppedNote([{ name: "delegate-3", outcome: "error" }]);
    expect(text).toContain("The interrupt dropped 1 delegate answer before it arrived:");
    expect(text).toContain(
      "- scratch/delegate-3 (error) read: mu agent read delegate-3 -n 50 -w scratch",
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

  it("a timeout points at the session and copies the partial answer", async () => {
    const mu = muWithSession(sessionWith(tmp, "halfway there"));
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "timeout" }] }));
    await flush();
    await flush();
    const text = sentText(p);
    expect(text).toContain(`Session: ${join(tmp, "s.jsonl")}`);
    const copy = /Partial answer so far: (\S+)/.exec(text)?.[1] ?? "";
    expect(copy.startsWith(join(tmp, "mu", "delegate-answers"))).toBe(true);
    expect(copy.endsWith("_delegate-2.partial.md")).toBe(true);
    expect(readFileSync(copy, "utf8")).toBe("halfway there\n");
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
    expect(sentText(p)).toContain(`Session: ${settled}`);
    expect(sentText(p)).toContain("Partial answer so far:");
  });

  it("a blocked delegate keeps its pane, copies no partial, and says it has not finished", async () => {
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
    const text = sentText(p);
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
    expect(sentText(p)).not.toContain("Session:");
    expect(sentText(p)).not.toContain("Partial answer");
  });

  it("cancel copies what it wrote and names the session", async () => {
    const mu = muWithSession(sessionWith(tmp, "before the abort"));
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const r = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" });
    const text = r.content[0]?.text ?? "";
    expect(text).toContain("Aborted scratch/delegate-2.");
    expect(text).toContain(`Session: ${join(tmp, "s.jsonl")}`);
    const copy = /Partial answer so far: (\S+)/.exec(text)?.[1] ?? "";
    expect(readFileSync(copy, "utf8")).toBe("before the abort\n");
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

describe("nudges yield to a delegate answer on its way", () => {
  // The real wiring: muPi registers the delegate and the nudges, and the
  // keep-driving nudge would continue the run while dispatched work is
  // IN_PROGRESS. pi's hasPendingMessages() does not count the answer.
  function setup() {
    const mu = fakeMu();
    const p = fakePi();
    const held: (() => void)[] = [];
    let holdState = false;
    // The keep-driving nudge's only read: `mu task list --status IN_PROGRESS`.
    const state = ok({ items: [{ id: "t1", status: "IN_PROGRESS" }] });
    const isInProgressList = (args: readonly string[]) =>
      args[0] === "task" && args[1] === "list" && args.includes("IN_PROGRESS");
    const run: MuRunner = (args, signal) => {
      if (!isInProgressList(args)) return mu.run(args, signal);
      if (!holdState) return Promise.resolve(state);
      return new Promise((resolve) => held.push(() => resolve(state)));
    };
    // The fake fires every handler with an empty ctx: no handler here reads it.
    const on = (e: string, h: (e: unknown, c: MuPiContext) => unknown) =>
      p.pi.on(e, h as (e: unknown, c: DelegateCtx) => unknown);
    muPi({ ...p.pi, on, sendUserMessage: () => {}, registerCommand: () => {} }, run);
    /** One settle through every handler: the merged nudge result, if any. */
    const settle = async (ctx: Partial<MuPiContext> = {}) => {
      let out: unknown;
      for (const h of p.handlers.get("agent_before_settle") ?? []) {
        const r = await h(
          { type: "agent_before_settle", outcome: "completed" },
          ctx as DelegateCtx,
        );
        if (r !== undefined) out = r;
      }
      return out as { continue?: boolean } | undefined;
    };
    const dispatch = () =>
      p.fire("tool_call", {
        toolName: "bash",
        input: { command: "mu agent send worker-1 go -w crew" },
      });
    return {
      mu,
      p,
      run,
      settle,
      dispatch,
      held,
      holdState: () => {
        holdState = true;
      },
    };
  }

  /** Start a delegate and let its answer reach pi's follow-up queue. */
  async function answerQueued(t: ReturnType<typeof setup>) {
    await tool(t.p).execute("d", { task: "check it" });
    t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "42" }] }));
    await flush();
    await flush();
  }

  it("no continuation while the answer is queued; the answer's own turn is nudged", async () => {
    const t = setup();
    t.p.state.busy = true;
    await t.dispatch();
    await answerQueued(t);
    expect(t.p.sendMessage).toHaveBeenCalledTimes(1);
    // Without the hold this settle continues the run ahead of the answer.
    expect(await t.settle()).toBeUndefined();
    await t.p.drainQueue(); // the answer enters the conversation
    // The held settle was not the prompt's one nudge.
    expect(await t.settle()).toMatchObject({ continue: true });
  });

  it("no continuation while an ordinary user message is queued", async () => {
    const t = setup();
    t.p.state.busy = true;
    await t.dispatch();
    // pi counts a queued user follow-up itself: its turn comes next.
    expect(await t.settle({ hasPendingMessages: () => true })).toBeUndefined();
    expect(await t.settle({ hasPendingMessages: () => false })).toMatchObject({ continue: true });
  });

  it("re-checks after the nudge's read: an answer that lands meanwhile wins", async () => {
    const t = setup();
    t.p.state.busy = true;
    t.holdState();
    await t.dispatch();
    await tool(t.p).execute("d", { task: "check it" });
    const settling = t.settle();
    await flush();
    expect(t.held).toHaveLength(1); // the nudge is reading mu state
    t.mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "42" }] }));
    await flush();
    await flush();
    t.held[0]?.();
    expect(await settling).toBeUndefined();
  });

  // reviewer-3's interleaving (high_parallel_settle_merge_continues): the
  // owned-by read answers first, the keep-driving task-list read is held,
  // the delegate answer queues, then the list read is released.
  it("the fast nudge's result yields to an answer that queues during a slower nudge's read", async () => {
    const mu = fakeMu();
    const p = fakePi();
    const heldList: (() => void)[] = [];
    const run: MuRunner = (args, signal) => {
      if (args[0] === "task" && args[1] === "list" && args.includes("IN_PROGRESS"))
        return new Promise((resolve) =>
          heldList.push(() => resolve(ok({ items: [{ id: "t1", status: "IN_PROGRESS" }] }))),
        );
      if (args[0] === "task" && args[1] === "owned-by")
        return Promise.resolve(ok({ items: [{ id: "w1-task", status: "IN_PROGRESS" }] }));
      return mu.run(args, signal);
    };
    const on = (e: string, h: (e: unknown, c: MuPiContext) => unknown) =>
      p.pi.on(e, h as (e: unknown, c: DelegateCtx) => unknown);
    // The close nudge reads its identity at registration.
    await withEnv("MU_AGENT_NAME", "w1", () =>
      withEnv("MU_WORKSTREAM", "crew", async () => {
        muPi({ ...p.pi, on, sendUserMessage: () => {}, registerCommand: () => {} }, run);
      }),
    );
    const settle = async () => {
      let out: unknown;
      for (const h of p.handlers.get("agent_before_settle") ?? []) {
        const r = await h({ type: "agent_before_settle", outcome: "completed" }, {});
        if (r !== undefined) out = r;
      }
      return out as { continue?: boolean; entries?: { customType?: string }[] } | undefined;
    };
    p.state.busy = true;
    // Arms keep-driving, whose task-list read is held.
    await p.fire("tool_call", {
      toolName: "bash",
      input: { command: "mu task claim t1 -w crew --for worker-1" },
    });
    await tool(p).execute("d", { task: "check it" });
    const settling = settle();
    await flush();
    // The close nudge is done; keep-driving still reads.
    expect(heldList).toHaveLength(1);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "42" }] }));
    await flush();
    await flush();
    heldList[0]?.();
    // Without the merge's late check, the fast nudge's result wins here.
    expect(await settling).toBeUndefined();
    await p.drainQueue(); // the answer enters the conversation
    // The dropped nudge was not the prompt's one nudge.
    const settled = settle();
    await flush();
    for (const release of heldList.splice(0)) release();
    const r = await settled;
    expect(r).toMatchObject({ continue: true });
    expect(r?.entries?.map((e) => e.customType).sort()).toEqual([
      "mu-close-task",
      "mu-keep-driving",
    ]);
  });

  it("no continuation while an extension dialog is open", async () => {
    const t = setup();
    await t.dispatch();
    await t.p.fire("ui_prompt_start", { kind: "confirm" });
    try {
      expect(await t.settle()).toBeUndefined();
    } finally {
      await t.p.fire("ui_prompt_end", { kind: "confirm" });
    }
    expect(await t.settle()).toMatchObject({ continue: true });
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
    expect(sentText(p)).toContain("Pane closed.");
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
              nextSteps: [],
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
