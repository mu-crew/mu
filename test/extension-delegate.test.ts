import { describe, expect, it, vi } from "vitest";
import {
  DELEGATE_CANCEL_TOOL,
  DELEGATE_REISSUE_TOOL,
  DELEGATE_TOOL,
  delegateEnabled,
  delegateMax,
  type MuResult,
  PENDING_CHANNEL,
  registerDelegate,
} from "../extension/delegate.js";
import { delegatesOsc, setTtyWriterForTests } from "../extension/delegate-osc.js";
import muPi from "../extension/mu-pi.js";
import { listDelegates } from "../src/delegates.js";
import {
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

describe("OSC 7501 waiting record", () => {
  it("writes working while delegates are pending and clear when none are, to the tty only", async () => {
    const seen: string[] = [];
    setTtyWriterForTests((d) => seen.push(d));
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("t", { task: "x" });
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "error", lastError: "x" }] }));
      await flush();
      await flush();
      expect(seen).toEqual([delegatesOsc(1), delegatesOsc(0)]);
    } finally {
      setTtyWriterForTests(() => {});
    }
  });
});

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

  it("stays visible to an orchestrator `mu orchestrate` started (MU_MANAGED_AGENT=1 with MU_ORCHESTRATOR=1)", () => {
    expect(delegateEnabled({ MU_MANAGED_AGENT: "1", MU_ORCHESTRATOR: "1" })).toBe(true);
    // Only the exact flag opens it, and the kill switch still wins.
    expect(delegateEnabled({ MU_MANAGED_AGENT: "1", MU_ORCHESTRATOR: "0" })).toBe(false);
    expect(delegateEnabled({ MU_MANAGED_AGENT: "1", MU_ORCHESTRATOR: "" })).toBe(false);
    expect(delegateEnabled({ MU_MANAGED_AGENT: "1", MU_ORCHESTRATOR: "1", MU_DELEGATE: "0" })).toBe(
      false,
    );
  });

  it("is hidden in a remote workspace loop (--mule): its pane env is a worker's (Spec B D3)", () => {
    // The env the --mule spawn pins (test/rex-placement-spawn.integration.test.ts).
    const remoteWorkspace = {
      MU_MANAGED_AGENT: "1",
      MU_ORCHESTRATOR: "",
      MU_REMOTE: "",
      MU_HOST: "",
    };
    expect(delegateEnabled(remoteWorkspace)).toBe(false);
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
    await tool(p).execute("t", { task: "x", model: "gateway/anthropic/claude-sonnet-5-5:low" });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn[spawn.indexOf("--command") + 1]).toContain(
      "--model gateway/anthropic/claude-sonnet-5-5:low",
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
    ["gateway/openai/gpt-6.1-sol[1m]:high", "'gateway/openai/gpt-6.1-sol[1m]:high'"],
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
    // The tail is the worker's words, not the screen furniture.
    expect(mu.calls.find((c) => c[1] === "read")).toEqual([
      "agent",
      "read",
      "delegate-2",
      "--text",
      "-n",
      "50",
      "-w",
      "scratch",
    ]);
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
    expect(String(err)).toMatch(
      /delivery unknown.*Pane kept.*mu agent read delegate-2 --text -n 20 -w scratch/,
    );
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
    expect(sentText(p)).toContain("Read it with: mu agent read delegate-2 --text -n 50 -w scratch");
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
