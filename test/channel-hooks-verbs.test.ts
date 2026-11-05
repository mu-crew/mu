// The `hooks` channel's interrupt, abort, fresh, settle and last text (spec
// D4, U9), against a fake hook harness (test/_fake-harness.ts) that writes
// murmur inbox events for pane %3 and answers the keys mu types into it as the
// harness's hooks would: codex and muse report an interrupt, claude reports
// none; claude's `/clear` starts its new session at once, codex's `/new` on the
// first prompt.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import {
  AgentAbortTimeoutError,
  AgentFreshUnconfirmedError,
  AgentInterruptUnrecordedError,
  AgentRestartedError,
  AgentSendGateError,
} from "../src/agents/errors.js";
import { type AgentRow, insertAgent } from "../src/agents.js";
import {
  readHooksPane,
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import {
  channelTarget,
  type DeliveryTarget,
  deliver,
  hooksChannel,
} from "../src/channels/index.js";
import { type Db, openDb } from "../src/db.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { withEnv } from "./_env.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { rmFixtureDir } from "./_fs.js";

const WS = "hv";
const SESSION = "sess-1";
let dir: string;
let db: Db;
let fake: FakeHarness;
/** Whether tmux still has pane %3 (a watch asks every few seconds). */
let paneLive: boolean;

/** tmux's `display-message -p -t %3 <format>`: the pane's fields, or "can't find pane". */
function displayMessage(args: readonly string[]) {
  if (!paneLive) return { stdout: "", stderr: "can't find pane: %3", exitCode: 1 };
  const format = args.at(-1) ?? "";
  const stdout = format
    .replace("#{pane_id}", "%3")
    .replace("#{pane_dead}", "0")
    .replace(/#\{[^}]+\}/g, "");
  return { stdout: `${stdout}\n`, stderr: "", exitCode: 0 };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mhv-"));
  db = openDb({ path: join(dir, "mu.db") });
  fake = fakeHarness(dir, "%3", SESSION);
  setMuxForTests(tmuxBackend);
  paneLive = true;
  setTmuxExecutor(
    async (args) =>
      fake.tmux(args) ??
      (args[0] === "display-message"
        ? displayMessage(args)
        : {
            stdout: args[0] === "list-panes" ? `%3\t${fake.option()}\t2000\n` : "",
            stderr: "",
            exitCode: 0,
          }),
  );
  setMurmurRunnerForTests(async () => null);
  setMurmurPaneRunnerForTests(fake.pane);
  setMurmurHookRunnerForTests(fake.hook);
  setSleepForTests(async () => {});
  resetAgentStateCacheForTests();
});
afterEach(() => {
  setMurmurPaneRunnerForTests(async () => null);
  setMurmurHookRunnerForTests(async () => false);
  resetSleep();
  resetTmuxExecutor();
  setMuxForTests(undefined);
  setMurmurRunnerForTests(null);
  resetAgentStateCacheForTests();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

/** A live `hooks` agent of `cli` on %3: started, three turns settled ("run 3" last), idle. */
function live(cli: "claude" | "codex" | "cursor-agent"): DeliveryTarget {
  const agent: AgentRow = insertAgent(db, {
    name: cli,
    workstream: WS,
    paneId: "%3",
    cli,
    channel: "hooks",
  });
  fake.freshCommand = cli === "claude" ? "/clear" : cli === "codex" ? "/new" : "/new-chat";
  fake.freshMode = cli === "claude" ? "immediate" : "first-prompt";
  fake.onEscape = cli === "claude" ? "silent" : "event";
  fake.emit("session_start", { source: "startup" });
  for (let i = 1; i <= 3; i++) {
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: `run ${i}` });
  }
  return channelTarget(db, agent);
}

/** The keys and paste steps mu sent the pane, in order. */
const typed = () =>
  fake.calls.map((c) =>
    [c[0], ...c.filter((a) => a === "C-u" || a === "Enter" || a === "Escape")].join(" "),
  );
const pastes = () => fake.calls.filter((c) => c[0] === "paste-buffer").length;

/** Run `fn` with `key` set, and return what it returned. */
async function underEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  let out: { v: T } | undefined;
  await withEnv(key, value, async () => {
    out = { v: await fn() };
  });
  if (out === undefined) throw new Error("unreachable");
  return out.v;
}

describe("interrupt on hooks", () => {
  it("claude reports no interrupt: mu writes `interrupted`, the agent reads idle?, and the text is sent", async () => {
    const t = live("claude");
    fake.emit("prompt_submitted");
    const words: (string | null)[] = [];
    setMurmurPaneRunnerForTests(async (pane) => {
      const out = await fake.pane(pane);
      words.push((JSON.parse(out ?? "{}") as { state: string | null }).state);
      return out;
    });
    const r = await hooksChannel.interrupt(t, "go on", { timeoutMs: 1000 });
    expect(r).toEqual({
      transport: "hooks",
      wasBusy: true,
      pending: false,
      stopped: "unconfirmed",
      runs: 4,
      incarnation: SESSION,
      ack: "confirmed",
      runCount: 5,
      sessionId: SESSION,
    });
    expect(fake.muEvents).toEqual([{ event: "interrupted", session_id: SESSION }]);
    // The gate before the paste read mu's unconfirmed idle, and sent into it.
    expect(words).toContain("idle?");
    expect(words.indexOf("idle?")).toBeLessThan(words.lastIndexOf("working"));
    expect(typed()).toEqual([
      "send-keys Escape",
      "send-keys C-u",
      "set-buffer",
      "paste-buffer",
      "send-keys Enter",
    ]);
    expect(fake.submitted).toEqual(["go on"]);
  });

  it("the Escape only closed an overlay: the send gets no ack, reports unknown, and is not resent", async () => {
    const t = live("claude");
    fake.emit("prompt_submitted");
    fake.onEscape = "overlay";
    fake.acks = false;
    const r = await underEnv("MU_SEND_ACK_MS", "500", () =>
      hooksChannel.interrupt(t, "go on", { timeoutMs: 1000 }),
    );
    expect(r).toMatchObject({ wasBusy: true, stopped: "unconfirmed", ack: "unknown" });
    // No fence from an unconfirmed paste: a wait must not count from a guess.
    expect(r.runs).toBeUndefined();
    expect(pastes()).toBe(1);
  });

  it("codex confirms with its own Interrupt: nothing of mu's is written", async () => {
    const t = live("codex");
    fake.emit("prompt_submitted");
    const r = await hooksChannel.interrupt(t, "go on", { timeoutMs: 1000 });
    expect(r).toMatchObject({ wasBusy: true, stopped: "confirmed", ack: "confirmed", runCount: 5 });
    expect(fake.muEvents).toEqual([]);
  });

  it("a harness that reports interrupts but stays silent: AgentAbortTimeoutError, the text never sent", async () => {
    const t = live("codex");
    fake.emit("prompt_submitted");
    fake.onEscape = "overlay";
    const err = await hooksChannel
      .interrupt(t, "go on", { timeoutMs: 500 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentAbortTimeoutError);
    expect(typed()).toEqual(["send-keys Escape"]);
    expect(fake.submitted).toEqual([]);
    expect(fake.muEvents).toEqual([]);
  });

  it("a blocked agent: Escape declines the dialog and the turn's end confirms it", async () => {
    const t = live("codex");
    fake.emit("prompt_submitted");
    fake.emit("permission_requested", { message: "Bash" });
    const r = await hooksChannel.interrupt(t, "do this instead", { timeoutMs: 1000 });
    expect(r).toMatchObject({ wasBusy: true, stopped: "confirmed", ack: "confirmed" });
    expect(fake.submitted).toEqual(["do this instead"]);
  });

  it("claude, and murmur will not record mu's `interrupted`: refused after the Escape, never idle?, nothing sent", async () => {
    const t = live("claude");
    fake.emit("prompt_submitted");
    setMurmurHookRunnerForTests(async () => false);
    const err = await hooksChannel
      .interrupt(t, "go on", { timeoutMs: 1000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentInterruptUnrecordedError);
    expect(typed()).toEqual(["send-keys Escape"]);
    expect(fake.submitted).toEqual([]);
    await expect(hooksChannel.abort(t, { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AgentInterruptUnrecordedError,
    );
    expect((await readHooksPane("%3"))?.state).toBe("working");
  });

  it("a pane murmur cannot report is refused before any key", async () => {
    const t = live("codex");
    setMurmurPaneRunnerForTests(async () => null);
    await expect(hooksChannel.interrupt(t, "x", { timeoutMs: 100 })).rejects.toMatchObject({
      name: "AgentSendGateError",
      state: "unknown",
    });
    expect(fake.calls).toEqual([]);
  });
});

describe("abort on hooks", () => {
  it("codex: Escape, confirmed by its Interrupt; onAbort runs once; nothing pasted", async () => {
    const t = live("codex");
    fake.emit("prompt_submitted");
    let aborts = 0;
    const r = await hooksChannel.abort(t, {
      timeoutMs: 1000,
      onAbort: async (o) => {
        aborts += 1;
        expect(o).toEqual({ before: "busy", pending: false });
      },
    });
    expect(r).toEqual({
      before: "busy",
      after: "idle",
      settled: true,
      aborted: true,
      pending: false,
      stopped: "confirmed",
    });
    expect(aborts).toBe(1);
    expect(pastes()).toBe(0);
  });

  it("claude: unconfirmed, so not settled; mu's `interrupted` makes it read idle?", async () => {
    const t = live("claude");
    fake.emit("prompt_submitted");
    const r = await hooksChannel.abort(t, { timeoutMs: 1000 });
    expect(r).toMatchObject({ aborted: true, settled: false, stopped: "unconfirmed" });
    expect((await readHooksPane("%3"))?.state).toBe("idle?");
  });
});

describe("fresh on hooks", () => {
  it("claude: /clear, then the text once its new session started, confirmed in that session", async () => {
    const t = live("claude");
    const sent = await deliver(t, "start over", { fresh: true });
    expect(sent).toEqual({
      transport: "hooks",
      ack: "confirmed",
      runCount: 1,
      sessionId: `${SESSION}-2`,
    });
    expect(fake.submitted).toEqual(["/clear", "start over"]);
  });

  it("claude: no new session after /clear: AgentFreshUnconfirmedError, the text is not sent", async () => {
    const t = live("claude");
    fake.freshMode = "ignored";
    const err = await underEnv("MU_SEND_ACK_MS", "500", () =>
      deliver(t, "start over", { fresh: true }).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(AgentFreshUnconfirmedError);
    expect((err as Error).message).toContain("the text was not sent");
    expect(fake.submitted).toEqual(["/clear"]);
  });

  it("codex ignored /new: its run in the old session never confirms the fresh send", async () => {
    const t = live("codex");
    fake.freshMode = "ignored";
    const warnings: string[] = [];
    const sent = await underEnv("MU_SEND_ACK_MS", "500", () =>
      deliver(t, "start over", { fresh: true, onUndelivered: (w) => warnings.push(w.message) }),
    );
    expect(sent).toMatchObject({ transport: "hooks", ack: "unknown" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("old session");
    expect(fake.submitted).toEqual(["/new", "start over"]);
  });

  it("a running agent is refused without --force; --force stops the turn first", async () => {
    const t = live("codex");
    fake.emit("prompt_submitted");
    await expect(deliver(t, "start over", { fresh: true })).rejects.toBeInstanceOf(
      AgentSendGateError,
    );
    expect(fake.calls).toEqual([]);
    const sent = await deliver(t, "start over", { fresh: true, force: true });
    expect(sent).toMatchObject({ ack: "confirmed", sessionId: `${SESSION}-2` });
    expect(typed()[0]).toBe("send-keys Escape");
    expect(fake.submitted).toEqual(["/new", "start over"]);
  });
});

describe("settle and last text on hooks", () => {
  const signal = () => new AbortController().signal;

  it("settle returns the turn's last text, its settled count and session", async () => {
    const t = live("codex");
    const w = await hooksChannel.watch(t, signal(), { afterRuns: 3 });
    expect(w?.initial.status).toBe("busy");
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: "done\nCLOSE: T1" });
    expect(await w?.settled).toMatchObject({
      settled: true,
      status: "needs_input",
      source: "murmur",
      runs: 4,
      incarnation: SESSION,
      lastText: "done\nCLOSE: T1",
    });
  });

  it("a running agent's baseline counts only settled turns, so its current turn's end is caught", async () => {
    const t = live("codex");
    fake.emit("prompt_submitted");
    expect(await hooksChannel.baseline(t)).toEqual({ runs: 3, incarnation: SESSION });
    const w = await hooksChannel.watch(t, signal(), {});
    expect(w?.afterRuns).toBe(3);
    fake.emit("turn_stopped", { text: "run 4" });
    expect(await w?.settled).toMatchObject({ settled: true, runs: 4, lastText: "run 4" });
  });

  it("a turn the harness interrupted carries no text, never the previous turn's", async () => {
    const t = live("codex");
    const w = await hooksChannel.watch(t, signal(), { afterRuns: 3 });
    fake.emit("prompt_submitted");
    fake.emit("interrupted");
    const r = await w?.settled;
    expect(r).toMatchObject({ settled: true, runs: 4 });
    expect(r?.lastText).toBeUndefined();
  });

  it("idle? (an interrupt mu wrote) settles with no text", async () => {
    const t = live("claude");
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: "partial" });
    fake.emit("prompt_submitted");
    const w = await hooksChannel.watch(t, signal(), {});
    await fake.hook("%3", { event: "interrupted", session_id: SESSION });
    const r = await w?.settled;
    expect(r).toMatchObject({ settled: true, runs: 5 });
    expect(r?.lastText).toBeUndefined();
  });

  it("a turn that ended before the watch first read it carries no text: murmur cannot say whose it is", async () => {
    const t = live("codex");
    // Interrupted by the harness: murmur keeps run 3's text.
    fake.emit("prompt_submitted");
    fake.emit("interrupted");
    const r = await hooksChannel.lastRun(t, { afterRuns: 3, ms: 100 });
    expect(r).toMatchObject({ settled: true, runs: 4 });
    expect(r?.lastText).toBeUndefined();
    // Failed: its error, never run 3's text.
    fake.emit("prompt_submitted");
    fake.emit("turn_failed", { message: "overloaded" });
    const failed = await hooksChannel.lastRun(t, { afterRuns: 4, ms: 100 });
    expect(failed).toMatchObject({ settled: true, runs: 5, lastError: "overloaded" });
    expect(failed?.lastText).toBeUndefined();
    // Even a turn that did write its text: the read cannot tell it from a kept one.
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: "run 6\nCLOSE: T1" });
    const ended = await hooksChannel.lastRun(t, { afterRuns: 5, ms: 100 });
    expect(ended).toMatchObject({ settled: true, runs: 6 });
    expect(ended?.lastText).toBeUndefined();
  });

  it("idle? that ended before lastRun started carries no text", async () => {
    const t = live("claude");
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: "partial" });
    fake.emit("prompt_submitted");
    await fake.hook("%3", { event: "interrupted", session_id: SESSION });
    const r = await hooksChannel.lastRun(t, { afterRuns: 4, ms: 100 });
    expect(r).toMatchObject({ settled: true, runs: 5 });
    expect(r?.lastText).toBeUndefined();
  });

  it("a text equal to the previous turn's carries none: it cannot be told from a kept one", async () => {
    const t = live("codex");
    const w = await hooksChannel.watch(t, signal(), { afterRuns: 3 });
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: "run 3" });
    const r = await w?.settled;
    expect(r).toMatchObject({ settled: true, runs: 4 });
    expect(r?.lastText).toBeUndefined();
  });

  it("cursor-agent's text that lands after its stop is waited for", async () => {
    const t = live("cursor-agent");
    const w = await hooksChannel.watch(t, signal(), { afterRuns: 3 });
    fake.emit("prompt_submitted", { generation_id: "g4" });
    fake.emit("turn_stopped", { generation_id: "g4" });
    let reads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      // afterAgentResponse, a few reads after the stop was drained.
      if (++reads === 3) fake.emit("turn_stopped", { generation_id: "g4", text: "late" });
      return fake.pane(pane);
    });
    expect(await w?.settled).toMatchObject({ settled: true, runs: 4, lastText: "late" });
  });

  it("a failed turn carries its error and not the previous text", async () => {
    const t = live("codex");
    const w = await hooksChannel.watch(t, signal(), { afterRuns: 3 });
    fake.emit("prompt_submitted");
    fake.emit("turn_failed", { message: "overloaded" });
    const r = await w?.settled;
    expect(r).toMatchObject({ settled: true, lastError: "overloaded" });
    expect(r?.lastText).toBeUndefined();
  });

  it("a dialog ends the watch unsettled, needs_permission", async () => {
    const t = live("codex");
    const w = await hooksChannel.watch(t, signal(), { afterRuns: 3 });
    fake.emit("prompt_submitted");
    fake.emit("permission_requested", { message: "Bash" });
    expect(await w?.settled).toMatchObject({
      settled: false,
      status: "needs_permission",
      reason: "permission dialog: Bash",
      blocked: { kind: "permission", title: "Bash" },
    });
  });

  it("a new session counts its own turns; pinned to the old one, it rejects as a restart", async () => {
    const t = live("codex");
    const free = await hooksChannel.watch(t, signal(), { afterRuns: 3 });
    const pinned = await hooksChannel.watch(t, signal(), { afterRuns: 3, inc: SESSION });
    const caught = pinned?.settled.catch((e: unknown) => e);
    fake.emit("session_start", { source: "startup", session_id: "s2" });
    fake.emit("prompt_submitted", { session_id: "s2" });
    fake.emit("turn_stopped", { session_id: "s2", text: "new session" });
    expect(await free?.settled).toMatchObject({
      settled: true,
      runs: 1,
      incarnation: "s2",
      lastText: "new session",
    });
    expect(await caught).toBeInstanceOf(AgentRestartedError);
  });

  it("a text at murmur's 64 KB cap lost its tail: marked truncated", async () => {
    const t = live("codex");
    const w = await hooksChannel.watch(t, signal(), { afterRuns: 3 });
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: "x".repeat(64 * 1024) });
    expect(await w?.settled).toMatchObject({ settled: true, lastTextTruncated: true });
  });

  it("an aborted watch ends unknown; murmur going silent hands the agent back to polling", async () => {
    const t = live("codex");
    const stop = new AbortController();
    const w = await hooksChannel.watch(t, stop.signal, { afterRuns: 3 });
    stop.abort();
    expect(await w?.settled).toMatchObject({ settled: false, status: "unknown" });
    const w2 = await hooksChannel.watch(t, signal(), { afterRuns: 3 });
    setMurmurPaneRunnerForTests(async () => null);
    expect(await w2?.settled).toMatchObject({
      settled: false,
      status: "unknown",
      reason: "murmur pane did not answer",
    });
  });

  it("a pane that dies under a held watch reads dead, though murmur still has its row running", async () => {
    const t = live("codex");
    fake.emit("prompt_submitted");
    const w = await hooksChannel.watch(t, signal(), {});
    // A few seconds on, tmux no longer has the pane.
    paneLive = false;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6000);
    try {
      expect(await w?.settled).toMatchObject({
        settled: false,
        status: null,
        reason: "the pane is gone",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("lastRun with nothing past the baseline in time: unsettled, never a guess", async () => {
    const t = live("codex");
    const r = await hooksChannel.lastRun(t, { afterRuns: 3, ms: 50 });
    expect(r).toMatchObject({ settled: false });
  });

  it("the wait seam watches a hooks agent from a send's fence and reads the run's text", async () => {
    const t = live("codex");
    const hooks = ctlAgentHooks(db);
    const ref = { kind: "agent" as const, workstream: WS, id: "codex", afterRuns: 3 };
    const handle = await hooks.watchAgent(ref, signal(), { owed: false });
    expect(handle?.afterRuns).toBe(3);
    await deliver(t, "work", {});
    fake.emit("turn_stopped", { text: "worked" });
    expect(await handle?.settled).toMatchObject({ settled: true, runs: 4, lastText: "worked" });
  });
});
