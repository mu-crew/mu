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
    items: tasks.map(([name, status]) => ({ name, status })),
    count: tasks.length,
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

describe("closeNudgeText", () => {
  it("names every task with its close command and the blocked way out", () => {
    const t = closeNudgeText("auth", ["a", "b"]);
    expect(t).toContain("auth/a, auth/b");
    expect(t).toContain("mu task close a -w auth");
    expect(t).toContain("mu task close b -w auth");
    expect(t).toMatch(/blocked or need an answer/);
  });
});
