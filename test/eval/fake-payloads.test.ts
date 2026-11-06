import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cursorResponse,
  type FakeEvent,
  type FakeHarness,
  handlersFor,
  hookEnv,
  hookFiles,
  hookHomes,
  LineEditor,
  matcherHits,
  NATIVE,
  newSessionId,
  type PayloadCtx,
  PLACEHOLDER_EMAIL,
  payload,
  readReply,
} from "../../tools/eval/fake-payloads.ts";

const SHAPES = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "hook-payload-shapes.json"), "utf8"),
  ) as {
    shapes: Record<string, string[]>;
  }
).shapes;

const ctx: PayloadCtx = {
  sessionId: "s-1",
  turnId: "t-1",
  cwd: "/repo",
  home: "/home/u",
  model: "m",
  prompt: "hi",
  lastText: "done",
};

/** "<harness> <native>[:status]" -> how the fake builds it. */
function build(key: string): Record<string, unknown> {
  const [h, ev] = key.split(" ") as [FakeHarness, string];
  if (ev === "afterAgentResponse") return cursorResponse(ctx);
  const [name, status] = ev.split(":");
  const kind = (Object.entries(NATIVE[h]) as [FakeEvent, string | null][]).find(
    ([k, n]) =>
      n === name &&
      (status === undefined ||
        (status === "completed" && k === "stop") ||
        (status === "aborted" && k === "interrupt") ||
        (status === "error" && k === "failed")),
  )?.[0];
  if (kind === undefined) throw new Error(`no fake event for ${key}`);
  return payload(h, kind, { ...ctx, ...(status ? { status } : {}) });
}

describe("fake harness payloads", () => {
  it("covers every shape the U0 fixture lists (a vacuous list proves nothing)", () => {
    expect(Object.keys(SHAPES).length).toBeGreaterThanOrEqual(21);
  });

  it.each(Object.keys(SHAPES))("%s carries exactly the U0 keys", (key) => {
    expect(Object.keys(build(key)).sort()).toEqual([...(SHAPES[key] ?? [])].sort());
  });

  it("names the native event in hook_event_name", () => {
    expect(payload("codex", "interrupt", ctx).hook_event_name).toBe("Interrupt");
    expect(payload("cursor-agent", "interrupt", ctx)).toMatchObject({
      hook_event_name: "stop",
      status: "aborted",
    });
    expect(payload("cursor-agent", "failed", ctx)).toMatchObject({ status: "error" });
  });

  it("claude fires nothing on an interrupt, codex no unverified failure", () => {
    expect(() => payload("claude", "interrupt", ctx)).toThrow();
    expect(() => payload("codex", "failed", ctx)).toThrow();
  });

  it("a resumed turn says so the harness's way", () => {
    expect(payload("claude", "stop", { ...ctx, resumed: true }).stop_hook_active).toBe(true);
    expect(payload("cursor-agent", "stop", { ...ctx, resumed: true }).loop_count).toBe(1);
    expect(payload("muse", "stop", ctx).stop_hook_active).toBe(false);
  });

  it("never carries a real account: cursor-agent's email is a placeholder", () => {
    for (const ev of ["session_start", "prompt", "stop", "session_end"] as const)
      expect(payload("cursor-agent", ev, ctx).user_email).toBe(PLACEHOLDER_EMAIL);
    expect(PLACEHOLDER_EMAIL.endsWith(".invalid")).toBe(true);
  });

  it("session ids take each harness's form", () => {
    expect(newSessionId("claude")).toMatch(/^[0-9a-f-]{36}$/);
    const a = newSessionId("codex", 1000);
    const b = newSessionId("codex", 2000);
    expect(a < b).toBe(true);
  });
});

describe("hook config files and handlers", () => {
  it("reads project then user files, claude's in its config dir; codex only its home", () => {
    const o = { projectRoot: "/p", home: "/h" };
    expect(hookFiles("claude", o).map((f) => f.path)).toEqual([
      "/p/.claude/settings.json",
      "/p/.claude/settings.local.json",
      "/h/.claude/settings.json",
    ]);
    expect(hookFiles("claude", { ...o, claudeHome: "/c" }).map((f) => f.path)).toEqual([
      "/p/.claude/settings.json",
      "/p/.claude/settings.local.json",
      "/c/settings.json",
    ]);
    expect(hookFiles("codex", o).map((f) => f.path)).toEqual(["/h/.codex/hooks.json"]);
    expect(hookFiles("codex", { ...o, codexHome: "/c" }).map((f) => f.path)).toEqual([
      "/c/hooks.json",
    ]);
    expect(hookFiles("cursor-agent", o).map((f) => f.path)).toEqual([
      "/p/.cursor/hooks.json",
      "/h/.cursor/hooks.json",
    ]);
    expect(hookFiles("muse", o).map((f) => f.path)).toEqual([
      "/p/.muse/hooks.json",
      "/h/.config/muse/settings.json",
    ]);
  });

  it("hookHomes: CLAUDE_CONFIG_DIR and CODEX_HOME when set; an empty one is unset", () => {
    expect(hookHomes({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" })).toEqual({
      claudeHome: "/c",
      codexHome: "/x",
    });
    expect(hookHomes({ CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" })).toEqual({});
    expect(hookHomes({})).toEqual({});
    const o = { projectRoot: "/p", home: "/h" };
    expect(
      hookFiles("claude", { ...o, ...hookHomes({ CLAUDE_CONFIG_DIR: "" }) }).at(-1)?.path,
    ).toBe("/h/.claude/settings.json");
    expect(hookFiles("codex", { ...o, ...hookHomes({ CODEX_HOME: "" }) })[0]?.path).toBe(
      "/h/.codex/hooks.json",
    );
  });

  it("grouped: every group of the event; a matcher filters only tool events", () => {
    const doc = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "a" },
              { type: "command", command: "b", timeout: 9 },
            ],
          },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "z" }] },
          { matcher: "Read", hooks: [{ command: "r" }] },
        ],
      },
    };
    expect(handlersFor("grouped", doc, "Stop", null)).toEqual([
      { command: "a", timeout: 60, async: false },
      { command: "b", timeout: 9, async: false },
    ]);
    expect(handlersFor("grouped", doc, "PreToolUse", "Bash").map((h) => h.command)).toEqual(["z"]);
    expect(handlersFor("grouped", doc, "SessionStart", null)).toEqual([]);
    expect(handlersFor("grouped", { nope: 1 }, "Stop", null)).toEqual([]);
  });

  it("flat: cursor's handlers sit directly under the event", () => {
    const doc = { version: 1, hooks: { stop: [{ command: "x", timeout: 600, loop_limit: null }] } };
    expect(handlersFor("flat", doc, "stop", null)).toEqual([
      { command: "x", timeout: 600, async: false },
    ]);
  });

  it("async handlers are marked (Muse's Interrupt)", () => {
    const doc = { hooks: { Interrupt: [{ hooks: [{ command: "m", async: true }] }] } };
    expect(handlersFor("grouped", doc, "Interrupt", null)[0]?.async).toBe(true);
  });

  it("matchers are anchored regexes", () => {
    expect(matcherHits("Bash", "Bash")).toBe(true);
    expect(matcherHits("^Bash$", "Bash")).toBe(true);
    expect(matcherHits("Bash", "BashOutput")).toBe(false);
    expect(matcherHits("Edit|Write", "Write")).toBe(true);
    expect(matcherHits(undefined, "Bash")).toBe(true);
  });

  it("Muse's hooks get only its allowlist; the others the full environment", () => {
    const env = { HOME: "/h", PATH: "/b", TMUX: "x", MU_AGENT_NAME: "w1", MURMUR_STATE_DIR: "/s" };
    expect(hookEnv("muse", env)).toEqual({ HOME: "/h", PATH: "/b" });
    expect(hookEnv("claude", env)).toEqual(env);
  });
});

describe("hook replies", () => {
  const r = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });

  it("exit 2 blocks with stderr (claude, codex, muse), never cursor", () => {
    expect(readReply("claude", "stop", r(2, "", "keep going"))).toEqual({
      kind: "block",
      reason: "keep going",
    });
    expect(readReply("cursor-agent", "stop", r(2, "", "x"))).toEqual({ kind: "allow" });
  });

  it("decision block, cursor's followup_message, and an empty allow", () => {
    expect(readReply("codex", "stop", r(0, '{"decision":"block","reason":"wait"}'))).toEqual({
      kind: "block",
      reason: "wait",
    });
    expect(readReply("cursor-agent", "stop", r(0, '{"followup_message":"more"}'))).toEqual({
      kind: "block",
      reason: "more",
    });
    expect(readReply("claude", "stop", r(0, ""))).toEqual({ kind: "allow" });
    expect(readReply("claude", "stop", r(0, "not json"))).toEqual({ kind: "allow" });
  });

  it("tool hooks: a rewrite (muzzle's queue) or a refusal", () => {
    const rewrite = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: "muzzle run -- x" },
      },
    });
    expect(readReply("claude", "pre_tool", r(0, rewrite))).toEqual({
      kind: "rewrite",
      command: "muzzle run -- x",
    });
    expect(
      readReply(
        "cursor-agent",
        "pre_tool",
        r(0, '{"permission":"deny","agent_message":"queue it"}'),
      ),
    ).toEqual({
      kind: "deny",
      reason: "queue it",
    });
  });
});

describe("LineEditor", () => {
  it("a bracketed paste is text; Enter submits it", () => {
    const e = new LineEditor();
    expect(e.feed("\x1b[200~line one\rline two\x1b[201~")).toEqual([]);
    expect(e.feed("\r")).toEqual([{ kind: "submit", text: "line one\nline two" }]);
  });

  it("a lone ESC is the interrupt key; an escape sequence is not", () => {
    const e = new LineEditor();
    expect(e.feed("\x1b")).toEqual([{ kind: "escape" }]);
    expect(e.feed("\x1b[A\x1b[I")).toEqual([]);
  });

  it("C-u clears what was there: no merge with an old prompt", () => {
    const e = new LineEditor();
    e.line = "the interrupted prompt";
    expect(e.feed("\x15\x1b[200~new\x1b[201~\r")).toEqual([
      { kind: "clear" },
      { kind: "submit", text: "new" },
    ]);
  });

  it("without C-u a paste lands after an old line (what claude does after Escape)", () => {
    const e = new LineEditor();
    e.line = "old ";
    expect(e.feed("\x1b[200~new\x1b[201~\r")).toEqual([{ kind: "submit", text: "old new" }]);
  });

  it("an empty line submits nothing", () => {
    expect(new LineEditor().feed("\r\r")).toEqual([]);
  });
});
