import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MuResult } from "../extension/delegate.js";
import {
  dispatchedWorkstreams,
  keepDrivingRule,
  type MuNudgeCtx,
  NUDGE_LOG_KIND,
  NUDGE_MESSAGE_TYPE,
  nudgeText,
  registerNudge,
} from "../extension/nudge.js";

const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", "mu", "SKILL.md"), "utf8");

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

// `mu state --json` with one -w prints the bare card (the shape a real
// e2e run hit); several, or none, print { workstreams: [...] }.
const card = (ws: string, names: string[]): MuResult => ({
  code: 0,
  stdout: JSON.stringify({ workstreamName: ws, inProgress: names.map((name) => ({ name })) }),
  stderr: "",
});
const multi = (cards: [string, string[]][]): MuResult => ({
  code: 0,
  stdout: JSON.stringify({
    workstreams: cards.map(([w, names]) => ({
      workstreamName: w,
      inProgress: names.map((name) => ({ name })),
    })),
  }),
  stderr: "",
});

const bash = (command: string) => ({ toolName: "bash", toolCallId: "t1", input: { command } });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MU_NUDGE;
  delete process.env.MU_NUDGE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MU_NUDGE;
  else process.env.MU_NUDGE = saved;
});

function setup(state: MuResult) {
  const f = fakePi();
  const run = vi.fn(async (args: readonly string[]) =>
    args[0] === "state" ? state : { code: 0, stdout: "", stderr: "" },
  );
  registerNudge(f.pi, run, SKILL);
  return { ...f, run };
}

describe("keep-driving rule source", () => {
  it("SKILL.md carries the markers and a non-empty paragraph", () => {
    const rule = keepDrivingRule(SKILL);
    expect(rule).toBeDefined();
    expect(rule).toMatch(/^\*\*While workers run, keep driving\.\*\*/);
    expect(rule).not.toContain("<!--");
  });

  it("is undefined without the markers, and then registers nothing", () => {
    expect(keepDrivingRule("no markers here")).toBeUndefined();
    const f = fakePi();
    registerNudge(f.pi, vi.fn(), "no markers here");
    expect(f.handlers.size).toBe(0);
  });
});

describe("dispatchedWorkstreams", () => {
  it.each([
    ["mu agent send worker-1 -w auth --fresh 'x'", ["auth"]],
    ["mu agent spawn worker-1 --workspace -w=ignored --workstream auth", ["auth"]],
    ["mu task claim build -w auth --for worker-1", ["auth"]],
    ["mu task claim auth/build --for worker-1", ["auth"]],
    ["mu agent send worker-1 --fresh 'go'", [""]],
    ["cd x && mu agent send a -w one 'p' && mu agent send b -w two 'q'", ["one", "two"]],
    ["node dist/cli.js agent send a -w x", undefined],
    ["/usr/bin/mu agent send a -w x 'p'", ["x"]],
    // Separators inside quotes are part of the word, before and after --for.
    ["mu agent send w1 'do a && b; c | d' -w auth", ["auth"]],
    ["mu task claim --evidence 'brief; refuted' --for w1 build -w auth", ["auth"]],
    ["mu task claim build --for w1 --evidence 'a | b' -w auth", ["auth"]],
    ["mu agent send a 'x; y' -w one && mu agent send b -w two 'p'", ["one", "two"]],
    // The same claim parse as dispatchedTasks: -f, --for=, a leading --for.
    ["mu task claim t1 -f w1 -w ws", ["ws"]],
    ["mu task claim t1 --for=w1 -w ws", ["ws"]],
    ["mu task claim --for w1 ws/t1", ["ws"]],
    ["MU_X=1 mu task claim t1 --for w1 -w ws", ["ws"]],
    ["mu agent send w1 \\\n  -w ws 'go'", ["ws"]],
    ["grep x <<< foo\nmu task claim t1 --for w1 -w ws", ["ws"]],
    ["echo $((1<<2))\nmu agent send w1 -w ws 'go'", ["ws"]],
  ])("%s", (cmd, want) => {
    expect(dispatchedWorkstreams(cmd)).toEqual(want);
  });

  it.each([
    "mu task claim build -w auth --self",
    "mu state -w auth",
    "mu agent send helper-1 -w scratch --fresh 'x'",
    "echo mu",
    "echo 'x && mu agent send w1 -w auth go'",
    // mu as an argument, or inside a heredoc body, is not a command.
    "grep mu agent send foo",
    "cat <<'EOF'\nmu agent send w1 x -w ws\nEOF",
    "cat <<-EOF > brief.md\n\tmu task claim t1 --for w1 -w ws\n\tEOF",
  ])("not a dispatch: %s", (cmd) => {
    expect(dispatchedWorkstreams(cmd)).toBeUndefined();
  });
});

describe("registerNudge", () => {
  it("no dispatch in the run: no nudge, no mu call", async () => {
    const { emit, run } = setup(card("auth", ["build"]));
    await emit("tool_call", bash("ls"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("dispatch + nothing in progress: no nudge", async () => {
    const { emit, run } = setup(card("auth", []));
    await emit("tool_call", bash("mu agent send worker-1 -w auth --fresh 'go'"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual(["state", "--json", "--events", "0", "-w", "auth"]);
  });

  it("dispatch + work in progress: one visible entry, continue, one log line", async () => {
    const { emit, run } = setup(card("auth", ["build", "docs"]));
    await emit("tool_call", bash("mu agent send worker-1 -w auth --fresh 'go'"));
    const r = (await emit("agent_before_settle", { outcome: "completed" })) as {
      entries: { type: string; customType: string; content: string; display: boolean }[];
      continue: boolean;
    };
    expect(r.continue).toBe(true);
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0];
    expect(e).toMatchObject({
      type: "custom_message",
      customType: NUDGE_MESSAGE_TYPE,
      display: true,
    });
    expect(e?.content).toContain(keepDrivingRule(SKILL) ?? "unreachable");
    expect(e?.content).toContain(
      "mu task wait auth/build auth/docs --first --on-stall exit --json",
    );
    const log = run.mock.calls.find((c) => c[0][0] === "log")?.[0];
    expect(log).toEqual([
      "log",
      "-w",
      "auth",
      "--kind",
      NUDGE_LOG_KIND,
      "keep-driving: 2 in progress",
    ]);
  });

  it("reads the multi-workstream shape too", async () => {
    const { emit } = setup(
      multi([
        ["one", ["a"]],
        ["two", ["b"]],
      ]),
    );
    await emit("tool_call", bash("mu agent send x -w one 'p' && mu agent send y -w two 'q'"));
    const r = (await emit("agent_before_settle", { outcome: "completed" })) as {
      entries: { content: string }[];
    };
    expect(r.entries[0]?.content).toContain("mu task wait one/a two/b");
  });

  it("fires at most once per prompt", async () => {
    const { emit } = setup(card("auth", ["build"]));
    await emit("tool_call", bash("mu agent send worker-1 -w auth 'go'"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeDefined();
    await emit("tool_call", bash("mu agent send worker-1 -w auth 'again'"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
  });

  it("a new input re-arms it, but only after a fresh dispatch", async () => {
    const { emit } = setup(card("auth", ["build"]));
    await emit("tool_call", bash("mu agent send worker-1 -w auth 'go'"));
    await emit("agent_before_settle", { outcome: "completed" });
    await emit("input", { text: "status?", source: "interactive" });
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    await emit("tool_call", bash("mu agent send worker-1 -w auth 'go'"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeDefined();
  });

  it.each(["aborted", "error"])("outcome %s: no nudge", async (outcome) => {
    const { emit, run } = setup(card("auth", ["build"]));
    await emit("tool_call", bash("mu agent send worker-1 -w auth 'go'"));
    expect(await emit("agent_before_settle", { outcome })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("a failing mu state: no nudge, and no retry within the prompt", async () => {
    const { emit, run } = setup({ code: 3, stdout: "", stderr: "no such workstream" });
    await emit("tool_call", bash("mu agent send worker-1 -w auth 'go'"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("MU_NUDGE=0: registers nothing", () => {
    process.env.MU_NUDGE = "0";
    const f = fakePi();
    registerNudge(f.pi, vi.fn(), SKILL);
    expect(f.handlers.size).toBe(0);
  });
});

describe("nudgeText", () => {
  it("caps the wait hint and counts the rest", () => {
    const refs = Array.from({ length: 10 }, (_, i) => `w/t${i}`);
    const t = nudgeText("RULE", refs);
    expect(t.startsWith("[mu] RULE\n")).toBe(true);
    expect(t).toContain("10 task(s) IN_PROGRESS");
    expect(t).toContain("w/t7 --first");
    expect(t).not.toContain("w/t8 ");
    expect(t).toContain("(+2 more)");
  });
});
