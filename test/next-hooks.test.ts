// The executor's `hooks` path (spec D17, U22): `mu task auto --cli claude`
// dispatches a task through the brief file and its pasted pointer; each claude
// `StopFailure` (murmur's `turn_failed`) gets one charged in-place retry that
// clears the pane's `error`, writes the stored brief to the retry's file and
// pastes the pointer again, keyed on the harness session and the turns settled
// before it, up to the run ceiling; a harness whose `turn_failed` row is
// unverified (muse: murmur maps its `StopFailure`) parks the attempt
// `needs_human` (codex reports no failed turn at all, so murmur never raises
// one for it); an unconfirmed hooks attempt is resumed through the inbox, not
// parked blind.
// Real SQLite, real spawn, journal and claim; a fake hook harness
// (test/_fake-harness.ts) stands in for the worker on pane %1 behind a mock tmux.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import { briefFileName } from "../src/agents/hooks-brief.js";
import { getReceipt } from "../src/agents/receipts.js";
import {
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
} from "../src/agents.js";
import { readAttempt } from "../src/auto-attempt.js";
import {
  setMurmurClearRunnerForTests,
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import { hooksTurnFailure } from "../src/channels/index.js";
import { type Db, openDb } from "../src/db.js";
import { openHumanNeeds } from "../src/human-needed.js";
import { executeNext, type NextResult } from "../src/next.js";
import { authorizeTasks } from "../src/task-auto.js";
import { taskIdFor } from "../src/tasks/core.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { getTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let cwd: string;
let home: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let fake: FakeHarness;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mnh-"));
  cwd = mkdtempSync(join(tmpdir(), "mnh-cwd-"));
  // The executor spawns in the caller's cwd: the brief files land there.
  home = process.cwd();
  process.chdir(cwd);
  db = openDb({ path: join(dir, "mu.db") });
  saved = { l: process.env.MU_SPAWN_LIVENESS_MS, a: process.env.MU_SPAWN_ACK_MS };
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  process.env.MU_SPAWN_ACK_MS = "1000";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  // No real `murmur status` behind the batched state read.
  setMurmurRunnerForTests(async () => null);
  resetAgentStateCacheForTests();
  ensureWorkstream(db, "d");
  // The first pane the mock tmux opens is %1: the fake worker's.
  fake = fakeHarness(dir, "%1", "sess-1");
  setMurmurPaneRunnerForTests(fake.pane);
  setMurmurHookRunnerForTests(fake.hook);
  setMurmurClearRunnerForTests(fake.clear);
  state = freshMockState();
  const tmux = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => fake.tmux(args) ?? tmux(args));
});

afterEach(() => {
  mux.restore();
  setMurmurPaneRunnerForTests(null);
  setMurmurHookRunnerForTests(null);
  setMurmurClearRunnerForTests(null);
  setMurmurRunnerForTests(null);
  resetAgentStateCacheForTests();
  resetSleep();
  resetCommandResolverForTests();
  process.chdir(home);
  db.close();
  for (const [k, v] of Object.entries({
    MU_SPAWN_LIVENESS_MS: saved.l,
    MU_SPAWN_ACK_MS: saved.a,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmFixtureDir(dir);
  rmFixtureDir(cwd);
});

const run = () => executeNext(db, { workstream: "d", caller: "orch", ingest: async () => {} });
const kinds = (r: NextResult) => r.moves.map((m) => `${m.kind}:${m.task}`);
const tid = (id: string) => taskIdFor(db, id, "d") ?? 0;
const runsOf = (id: string) =>
  (db.prepare("SELECT runs FROM task_auto WHERE task_id = ?").get(tid(id)) as { runs: number })
    .runs;
const receiptOf = (id: string, key: string) => getReceipt(db, tid(id), key);
const pastes = () => fake.calls.filter((c) => c[0] === "paste-buffer");
const briefPath = (agent: string, key: string) =>
  join(getAgent(db, agent, "d")?.cwd ?? "", ".mu", briefFileName(agent, key));

/** Authorise task `id` for this machine's executor with cli key `cli` (`mu task auto --cli`). */
function task(id: string, cli: string, max = 3): void {
  addTask(db, { workstream: "d", localId: id, title: id });
  addNote(db, id, `BRIEF for ${id}`, { workstream: "d", kind: "brief", author: "orch" });
  authorizeTasks(db, [id], { workstream: "d", cli, worktree: false, maxRuns: max });
}

/**
 * The harness's turn failed: a `StopFailure` (claude) or whatever reached
 * murmur as `turn_failed`. Stamped a minute back, so no event of the test can
 * share its millisecond and read as raised by the failure.
 */
const failTurn = (message = "overloaded_error: Overloaded") =>
  fake.emit("turn_failed", { message, now: Date.now() - 60_000 });

describe("the executor on hooks: dispatch, an in-place retry per verified turn_failed (spec D17)", () => {
  it("claude: dispatched through the brief file; a StopFailure gets one retry that writes the brief file and pastes the pointer; the run closes", async () => {
    task("a", "claude");
    fake.emit("session_start", { source: "startup" });

    // `mu task auto --cli claude`, then `mu next`: one pane, one brief file, one pointer.
    const first = await run();
    expect(kinds(first)).toEqual(["spawn:a"]);
    expect(first.moves[0]).toMatchObject({
      key: "auto:1",
      agent: "a-1",
      cli: "claude",
      state: "sent",
    });
    const delivered = readAttempt(db, tid("a")).record;
    expect(readFileSync(briefPath("a-1", "auto:1"), "utf8")).toBe(delivered?.text);
    expect(fake.submitted).toEqual([expect.stringContaining(briefPath("a-1", "auto:1"))]);
    expect(receiptOf("a", "auto:1")).toMatchObject({
      state: "sent",
      transport: "hooks",
      incarnation: "sess-1",
      runs: 0,
    });
    const worker = getAgent(db, "a-1", "d");
    expect(getTask(db, "a", "d")).toMatchObject({
      status: "IN_PROGRESS",
      ownerId: worker?.incarnation,
    });

    // The turn fails on an API error (claude's StopFailure): ONE retry, in place.
    failTurn();
    const second = await run();
    expect(kinds(second)).toEqual(["retry:a"]);
    // The failure it answers was acknowledged in murmur before the paste.
    expect(fake.clears).toBe(1);
    expect(second.moves[0]).toMatchObject({ key: "auto:2", agent: "a-1", state: "sent" });
    expect(second.moves[0]?.reason).toMatch(/overloaded_error/);
    expect(runsOf("a")).toBe(2);
    // The stored bytes, written to the retry's brief file, and its pointer pasted again.
    const retried = readAttempt(db, tid("a")).record;
    expect(retried).toMatchObject({ key: "auto:2", inPlace: true, retry: true });
    expect(retried?.text).toContain("stopped on an API error");
    expect(readFileSync(briefPath("a-1", "auto:2"), "utf8")).toBe(retried?.text);
    expect(fake.submitted).toHaveLength(2);
    expect(fake.submitted[1]).toContain(briefPath("a-1", "auto:2"));
    expect(fake.submitted[1]).not.toContain("\n");
    // The input line was cleared before each paste, into the same pane: no second worker.
    const clears = fake.calls.filter((c) => c[0] === "send-keys" && c.includes("C-u"));
    expect(clears).toHaveLength(2);
    expect(pastes()).toHaveLength(2);
    expect(state.panes.size).toBe(1);
    expect(getAgent(db, "a-1", "d")?.incarnation).toBe(worker?.incarnation);
    // session_id is the retry's incarnation; the run_count read before the paste is its runs.
    expect(receiptOf("a", "auto:2")).toMatchObject({
      state: "sent",
      transport: "hooks",
      incarnation: "sess-1",
      runs: 1,
      agentId: worker?.incarnation,
    });

    // While the retried turn runs, and after it settles, the old error is gone: no new failure.
    expect(kinds(await run())).toEqual([]);
    fake.emit("turn_stopped", { text: "fixed it" });
    expect(JSON.parse((await fake.pane("%1")) ?? "{}").attention).toEqual([]);
    expect(kinds(await run())).toEqual([]);
    expect(fake.submitted).toHaveLength(2);
    expect(runsOf("a")).toBe(2);

    // The worker closes its task: nothing is left in flight, nothing more is sent.
    closeTask(db, "a", { workstream: "d", evidence: "npm test: green" });
    expect(getTask(db, "a", "d")?.status).toBe("CLOSED");
    const last = await run();
    expect(kinds(last)).toEqual([]);
    expect(fake.submitted).toHaveLength(2);
    expect(runsOf("a")).toBe(2);
  });

  it("claude: a later failure, after the retry's turn settled, gets its own charged retry, and one at the ceiling is reported", async () => {
    task("a", "claude", 3);
    fake.emit("session_start", { source: "startup" });
    await run();
    failTurn();
    expect(kinds(await run())).toEqual(["retry:a"]);
    // The retried turn works, the worker carries on, and a later turn fails afresh.
    fake.emit("turn_stopped", { text: "fixed it" });
    fake.emit("prompt_submitted");
    failTurn("api_error: Internal server error");
    const third = await run();
    expect(kinds(third)).toEqual(["retry:a"]);
    expect(third.moves[0]).toMatchObject({ key: "auto:3", state: "sent" });
    expect(third.moves[0]?.reason).toMatch(/Internal server error/);
    expect(runsOf("a")).toBe(3);
    expect(fake.clears).toBe(2);
    expect(fake.submitted).toHaveLength(3);
    expect(fake.submitted[2]).toContain(briefPath("a-1", "auto:3"));
    expect(receiptOf("a", "auto:3")).toMatchObject({
      state: "sent",
      incarnation: "sess-1",
      runs: 3,
    });

    // The third run's turn fails too: no run is left, so the orchestrator is told, nothing sent.
    failTurn();
    const last = await run();
    expect(kinds(last)).toEqual(["attention:a"]);
    expect(last.moves[0]?.reason).toMatch(/failed turn and a used its 3 run/);
    expect(runsOf("a")).toBe(3);
    expect(fake.submitted).toHaveLength(3);
    expect(fake.clears).toBe(2);
  });

  it("claude: a failure murmur cannot clear is reported, never retried or charged", async () => {
    task("a", "claude");
    fake.emit("session_start", { source: "startup" });
    await run();
    failTurn();
    // `murmur clear` that took nothing away (absent, or another tmux server).
    setMurmurClearRunnerForTests(async () => true);
    const r = await run();
    expect(kinds(r)).toEqual(["attention:a"]);
    expect(r.moves[0]?.reason).toMatch(/could not clear its error/);
    expect(runsOf("a")).toBe(1);
    expect(fake.submitted).toHaveLength(1);
    expect(readAttempt(db, tid("a")).record?.key).toBe("auto:1");
    // Once murmur can clear it, the same failure is retried.
    setMurmurClearRunnerForTests(fake.clear);
    expect(kinds(await run())).toEqual(["retry:a"]);
    expect(runsOf("a")).toBe(2);
  });

  it("muse: its turn_failed row is unverified, so a failed turn parks the attempt needs_human instead of a retry", async () => {
    task("c", "muse");
    // muse reports its session only with its first prompt (U0).
    fake.onSubmit = () => {
      fake.emit("session_start", { source: "startup" });
      fake.emit("prompt_submitted");
    };
    const first = await run();
    expect(kinds(first)).toEqual(["spawn:c"]);
    expect(receiptOf("c", "auto:1")).toMatchObject({ state: "sent", transport: "hooks" });

    // murmur maps muse's StopFailure to turn_failed; no run has recorded one.
    failTurn("stream disconnected");
    const second = await run();
    expect(kinds(second)).toEqual(["needs_human:c"]);
    expect(second.moves[0]).toMatchObject({ key: "auto:1", cli: "muse" });
    expect(second.moves[0]?.reason).toMatch(/turn_failed is not verified/);
    expect(second.stopped).toBe("human");
    expect(readAttempt(db, tid("c")).record?.end?.state).toBe("needs_human");
    const needs = openHumanNeeds(db, "orch");
    expect(needs).toHaveLength(1);
    // The need names the real cause: delivered, and its turn failed; not an unconfirmed delivery.
    expect(needs[0]?.reason).toMatch(/auto:1 of task c was delivered and its turn failed/);
    expect(needs[0]?.reason).toMatch(/stream disconnected/);
    expect(needs[0]?.reason).not.toMatch(/cannot be confirmed/);
    // Nothing was cleared: the error stays for the human.
    expect(fake.clears).toBe(0);
    // Nothing was charged or pasted for it, and the worker keeps its task.
    expect(runsOf("c")).toBe(1);
    expect(fake.submitted).toHaveLength(1);
    expect(getTask(db, "c", "d")?.status).toBe("IN_PROGRESS");

    // Parked is terminal: the next invocation stops on the human need and sends nothing.
    const third = await run();
    expect(third.stopped).toBe("human");
    expect(fake.submitted).toHaveLength(1);
  });

  it("a claude failure in another session than its brief's is reported, never retried", async () => {
    task("a", "claude");
    fake.emit("session_start", { source: "startup" });
    await run();
    fake.emit("session_start", { source: "clear", session_id: "sess-2" });
    fake.emit("prompt_submitted", { session_id: "sess-2" });
    fake.emit("turn_failed", { session_id: "sess-2", message: "boom", now: Date.now() + 60_000 });
    const r = await run();
    expect(kinds(r)).toEqual(["attention:a"]);
    expect(r.moves[0]?.reason).toMatch(/another session/);
    expect(runsOf("a")).toBe(1);
    expect(fake.submitted).toHaveLength(1);
  });
});

describe("an unconfirmed hooks attempt is resumed through the inbox (spec D17)", () => {
  it("the next invocation promotes it to sent once the inbox shows the run: no park, no second paste", async () => {
    task("a", "claude");
    fake.emit("session_start", { source: "startup" });
    fake.acks = false;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      const first = await run();
      expect(first.moves[0]).toMatchObject({ kind: "spawn", state: "unknown" });
    });
    expect(receiptOf("a", "auto:1")).toMatchObject({ state: "unknown", transport: "hooks" });
    fake.emit("prompt_submitted");
    const second = await run();
    expect(second.moves[0]).toMatchObject({
      kind: "replay",
      key: "auto:1",
      state: "sent",
      checked: "accepted",
    });
    expect(receiptOf("a", "auto:1")).toMatchObject({ state: "sent", runs: 0 });
    expect(openHumanNeeds(db, "orch")).toEqual([]);
    expect(pastes()).toHaveLength(1);
  });

  it("with no run in the inbox the probe cannot say: parked needs_human, never re-pasted", async () => {
    task("a", "claude");
    fake.emit("session_start", { source: "startup" });
    fake.acks = false;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      await run();
    });
    const second = await run();
    expect(second.moves[0]).toMatchObject({
      kind: "needs_human",
      key: "auto:1",
      checked: "not-accepted",
    });
    expect(readAttempt(db, tid("a")).record?.end?.state).toBe("needs_human");
    expect(pastes()).toHaveLength(1);
  });
});

describe("hooksTurnFailure: the last turn failed, and nothing happened since", () => {
  const target = () => ({
    agent: {
      name: "w",
      workstreamName: "d",
      paneId: "%1",
      incarnation: 1,
      cli: "claude",
      gateToken: null,
      channel: "hooks" as const,
    },
  });

  it("reads the failed turn's session, settled turns and message", async () => {
    fake.emit("session_start", { source: "startup" });
    fake.emit("prompt_submitted");
    fake.emit("turn_failed", { message: "rate_limit" });
    expect(await hooksTurnFailure(target())).toEqual({
      sessionId: "sess-1",
      runs: 1,
      error: "rate_limit",
    });
  });

  it("an error older than the pane's last event is an earlier turn's: none", async () => {
    fake.emit("session_start", { source: "startup" });
    fake.emit("prompt_submitted");
    fake.emit("turn_failed", { message: "rate_limit", now: 1_000 });
    fake.emit("prompt_submitted", { now: 2_000 });
    expect(await hooksTurnFailure(target())).toBeUndefined();
    fake.emit("turn_stopped", { text: "ok", now: 3_000 });
    expect(await hooksTurnFailure(target())).toBeUndefined();
  });

  it("a pane with no error, or murmur not answering, is none", async () => {
    fake.emit("session_start", { source: "startup" });
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: "ok" });
    expect(await hooksTurnFailure(target())).toBeUndefined();
    setMurmurPaneRunnerForTests(async () => null);
    expect(await hooksTurnFailure(target())).toBeUndefined();
  });
});
