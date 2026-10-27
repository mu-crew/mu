import { describe, expect, it, vi } from "vitest";
import type { MuResult } from "../extension/delegate.js";
import {
  CLOSE_NUDGE_MESSAGE_TYPE,
  closeNudgeText,
  type MuNudgeCtx,
  NUDGE_LOG_KIND,
  registerCloseNudge,
  workerIdentity,
} from "../extension/nudge.js";

type Handler = (event: unknown, ctx: MuNudgeCtx) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, h: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
  };
  const emit = async (event: string, extra: Record<string, unknown> = {}) => {
    let last: unknown;
    for (const h of handlers.get(event) ?? []) last = await h({ type: event, ...extra }, {});
    return last;
  };
  return { pi, emit, handlers };
}

const owned = (tasks: [string, string][]): MuResult => ({
  code: 0,
  stdout: JSON.stringify({
    ok: true,
    data: {
      items: tasks.map(([id, status]) => ({ id, status })),
      count: tasks.length,
    },
    next: null,
  }),
  stderr: "",
});

const WORKER = { MU_AGENT_NAME: "worker-1", MU_WORKSTREAM: "auth" };

function setup(result: MuResult, env: NodeJS.ProcessEnv = WORKER) {
  const f = fakePi();
  const run = vi.fn(async (args: readonly string[]) =>
    args[0] === "task" ? result : { code: 0, stdout: "", stderr: "" },
  );
  registerCloseNudge(f.pi, run, env);
  return { ...f, run };
}

describe("workerIdentity", () => {
  it.each([
    [{}, undefined],
    [{ MU_AGENT_NAME: "w" }, undefined],
    [{ MU_AGENT_NAME: "w", MU_WORKSTREAM: "scratch" }, undefined],
    [WORKER, { agent: "worker-1", workstream: "auth" }],
  ])("%j", (env, want) => {
    expect(workerIdentity(env)).toEqual(want);
  });
});

describe("registerCloseNudge", () => {
  it("outside a mu-spawned worker: registers nothing", () => {
    const f = fakePi();
    registerCloseNudge(f.pi, vi.fn(), {});
    expect(f.handlers.size).toBe(0);
  });

  it("a remote worker (MU_REMOTE=1: no mu DB over there) registers nothing; CLOSE is applied by the orchestrator", () => {
    const f = fakePi();
    const run = vi.fn();
    registerCloseNudge(f.pi, run, { ...WORKER, MU_REMOTE: "1" });
    expect(f.handlers.size).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("MU_NUDGE=0: registers nothing", () => {
    const f = fakePi();
    registerCloseNudge(f.pi, vi.fn(), { ...WORKER, MU_NUDGE: "0" });
    expect(f.handlers.size).toBe(0);
  });

  it("settling while owning an IN_PROGRESS task: one entry, continue, one log line", async () => {
    const { emit, run } = setup(
      owned([
        ["design", "IN_PROGRESS"],
        ["later", "OPEN"],
      ]),
    );
    const r = (await emit("agent_before_settle", { outcome: "completed" })) as {
      entries: { type: string; customType: string; content: string; display: boolean }[];
      continue: boolean;
    };
    expect(run.mock.calls[0]?.[0]).toEqual([
      "task",
      "owned-by",
      "worker-1",
      "-w",
      "auth",
      "--json",
      "--full",
    ]);
    expect(r.continue).toBe(true);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      type: "custom_message",
      customType: CLOSE_NUDGE_MESSAGE_TYPE,
      display: true,
    });
    expect(r.entries[0]?.content).toContain("mu task close design -w auth --evidence");
    expect(r.entries[0]?.content).not.toContain("later");
    expect(run.mock.calls.find((c) => c[0][0] === "log")?.[0]).toEqual([
      "log",
      "-w",
      "auth",
      "--kind",
      NUDGE_LOG_KIND,
      "close: worker-1 settled owning design",
    ]);
  });

  it("a delegate's own task (kind=delegate, in a named workstream) is never nudged: its call records and closes it", async () => {
    const mixed: MuResult = {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        data: {
          items: [
            { id: "delegate_rev_1", status: "IN_PROGRESS", kind: "delegate" },
            { id: "design", status: "IN_PROGRESS", kind: "work" },
          ],
          count: 2,
        },
        next: null,
      }),
      stderr: "",
    };
    const only = (items: unknown[]): MuResult => ({
      ...mixed,
      stdout: JSON.stringify({ ok: true, data: { items, count: items.length }, next: null }),
    });
    const a = setup(only([{ id: "delegate_rev_1", status: "IN_PROGRESS", kind: "delegate" }]));
    expect(await a.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(a.run.mock.calls.find((c) => c[0][0] === "log")).toBeUndefined();
    // A real task the same agent owns is still nudged, and only it is named.
    const b = setup(mixed);
    const r = (await b.emit("agent_before_settle", { outcome: "completed" })) as {
      entries: { content: string }[];
    };
    expect(r.entries[0]?.content).toContain("mu task close design -w auth");
    expect(r.entries[0]?.content).not.toContain("delegate_rev_1");
  });

  it("owns nothing in progress: no nudge, no log", async () => {
    const { emit, run } = setup(owned([["later", "OPEN"]]));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires at most once per prompt; the next input re-arms it", async () => {
    const { emit } = setup(owned([["design", "IN_PROGRESS"]]));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeDefined();
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    await emit("input", { text: "answer", source: "extension" });
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeDefined();
  });

  it.each(["aborted", "error"])("outcome %s: no nudge, no mu call", async (outcome) => {
    const { emit, run } = setup(owned([["design", "IN_PROGRESS"]]));
    expect(await emit("agent_before_settle", { outcome })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("a failing mu call: no nudge, no retry within the prompt", async () => {
    const { emit, run } = setup({ code: 3, stdout: "", stderr: "boom" });
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("a capped owned-by read (more=N)", () => {
  // The first page shows only a finished task; the live one is on page two.
  const page = (items: [string, string][], more: number): MuResult => ({
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      data: { items: items.map(([id, status]) => ({ id, status })), count: items.length, more },
      next: null,
    }),
    stderr: "",
  });

  it("reads uncapped (--full): the whole list, so an IN_PROGRESS task past a cap still nudges", async () => {
    const f = fakePi();
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] !== "task") return { code: 0, stdout: "", stderr: "" };
      return args.includes("--full")
        ? page(
            [
              ["done", "CLOSED"],
              ["live", "IN_PROGRESS"],
            ],
            0,
          )
        : page([["done", "CLOSED"]], 1);
    });
    registerCloseNudge(f.pi, run, WORKER);
    const r = (await f.emit("agent_before_settle", { outcome: "completed" })) as {
      entries: { content: string }[];
    };
    expect(r.entries[0]?.content).toContain("mu task close live -w auth");
    expect(run.mock.calls.filter((c) => c[0][0] === "task")).toHaveLength(1);
  });

  it("a result that still says more is unknown, not 'owns nothing': no nudge", async () => {
    const f = fakePi();
    const run = vi.fn(async (args: readonly string[]) =>
      args[0] === "task" ? page([["live", "IN_PROGRESS"]], 5) : { code: 0, stdout: "", stderr: "" },
    );
    registerCloseNudge(f.pi, run, WORKER);
    expect(await f.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(run.mock.calls.filter((c) => c[0][0] === "task")).toHaveLength(1);
  });
});

describe("closeNudgeText", () => {
  it("names every task with its close command and the blocked way out", () => {
    const t = closeNudgeText("auth", ["a", "b"]);
    expect(t).toContain("auth/a, auth/b");
    expect(t).toContain("mu task close a -w auth");
    expect(t).toContain("mu task close b -w auth");
    expect(t).toMatch(/blocked or need an answer/);
  });
});

describe("close nudge and a settle hold", () => {
  it.each(["wake", "blocked"] as const)(
    "skips while held (%s), and the held settle is not the prompt's one nudge",
    async (why) => {
      const f = fakePi();
      let h: typeof why | undefined = why;
      const run = vi.fn(async () => owned([["a", "IN_PROGRESS"]]));
      registerCloseNudge(f.pi, run, WORKER, undefined, () => h);
      expect(await f.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
      expect(run).not.toHaveBeenCalled();
      h = undefined;
      expect(await f.emit("agent_before_settle", { outcome: "completed" })).toBeDefined();
    },
  );

  it("drops the nudge when a hold starts during its read", async () => {
    const f = fakePi();
    let h: "wake" | undefined;
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) h = "wake"; // lands during the first read
      return owned([["a", "IN_PROGRESS"]]);
    });
    registerCloseNudge(f.pi, run, WORKER, undefined, () => h);
    expect(await f.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    h = undefined;
    expect(await f.emit("agent_before_settle", { outcome: "completed" })).toBeDefined();
  });
});
