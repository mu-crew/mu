// spawn --task on the `hooks` channel (spec D17, U20): the worker is launched
// with no prompt; inside the journaled attempt mu waits for its session_start,
// writes the brief to `.mu/brief-<agent>-<attempt key>.md` (with
// `.mu/.gitignore`), pastes ONE line pointing at it, and confirms it by
// run_count. An unconfirmed paste is UNKNOWN, and a replay promotes it to
// `sent` only once the inbox shows the run. A fake hook harness
// (test/_fake-harness.ts) stands in for the worker on pane %1.

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { briefFileName } from "../src/agents/hooks-brief.js";
import { getReceipt, requestSha, reserveReceipt, updateReceipt } from "../src/agents/receipts.js";
import {
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
  spawnForTask,
} from "../src/agents.js";
import {
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask, selectTaskNotes, taskIdFor } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { rmFixtureDir } from "./_fs.js";
import { installMurmurHooks } from "./_murmur-hooks.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let cwd: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let fake: FakeHarness;
/** Every `murmur pane` read, in order (the pane id each asked about). */
let reads: string[];
/** How many reads came before the (first) paste. */
let readsAtPaste: number;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "msth-"));
  cwd = mkdtempSync(join(tmpdir(), "msth-cwd-"));
  db = openDb({ path: join(dir, "mu.db") });
  saved = { l: process.env.MU_SPAWN_LIVENESS_MS, a: process.env.MU_SPAWN_ACK_MS };
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  process.env.MU_SPAWN_ACK_MS = "1000";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  ensureWorkstream(db, "auth");
  addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1 });
  // The first pane the mock tmux opens is %1: the fake worker's.
  fake = fakeHarness(dir, "%1", "sess-1");
  reads = [];
  readsAtPaste = -1;
  setMurmurPaneRunnerForTests(async (pane) => {
    reads.push(pane);
    return fake.pane(pane);
  });
  setMurmurHookRunnerForTests(fake.hook);
  state = freshMockState();
  const tmux = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    if (args[0] === "paste-buffer" && readsAtPaste < 0) readsAtPaste = reads.length;
    return fake.tmux(args) ?? tmux(args);
  });
});

afterEach(() => {
  mux.restore();
  setMurmurPaneRunnerForTests(null);
  setMurmurHookRunnerForTests(null);
  resetSleep();
  resetCommandResolverForTests();
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

const TEXT = "do the thing\nline two: build it, test it, close it\n";
const req = (cli = "claude") => ({
  task: "t1",
  text: TEXT,
  spawn: { name: "worker-1", workstream: "auth", cli, cwd },
});
const receipt = () => getReceipt(db, taskIdFor(db, "t1", "auth") ?? 0, "manual:t1");
const briefs = () =>
  selectTaskNotes(db, "t1", { workstream: "auth" }).notes.filter((n) => n.kind === "brief");
const briefPath = () => join(cwd, ".mu", briefFileName("worker-1", "manual:t1"));
const pastes = () => fake.calls.filter((c) => c[0] === "paste-buffer");
const paneCmd = (id: string) => state.panes.get(id)?.command ?? "";

describe("a hooks worker's task brief: a file and a one-line pointer (spec D17)", () => {
  it("claude: waits for session_start, writes the brief file, pastes one pointer, confirmed by run_count", async () => {
    // The session starts on the third read, as a harness that takes a moment to boot.
    const pane = fake.pane;
    setMurmurPaneRunnerForTests(async (id) => {
      reads.push(id);
      if (reads.length === 3) fake.emit("session_start", { source: "startup" });
      return pane(id);
    });
    const out = await spawnForTask(db, req());
    // Two empty readiness reads, the one that saw the session, then the paste gate's.
    expect(readsAtPaste).toBe(4);
    expect(out).toMatchObject({ state: "sent", replay: false, brief: "recorded" });
    // The exact bytes, in a per-agent, per-attempt file, and a .gitignore that hides the dir.
    expect(briefFileName("worker-1", "manual:t1")).toBe("brief-worker-1-manual-t1.md");
    expect(readFileSync(briefPath(), "utf8")).toBe(TEXT);
    expect(readFileSync(join(cwd, ".mu", ".gitignore"), "utf8")).toBe("*\n");
    // Only the pointer went through the paste: one line naming the file.
    expect(fake.submitted).toHaveLength(1);
    expect(fake.submitted[0]).toContain(briefPath());
    expect(fake.submitted[0]).not.toContain("\n");
    expect(fake.submitted[0]).not.toContain("do the thing");
    // The receipt: hooks, the session as incarnation, the turns settled before the brief's run.
    expect(receipt()).toMatchObject({
      state: "sent",
      transport: "hooks",
      incarnation: "sess-1",
      runs: 0,
    });
    expect(getTask(db, "t1", "auth")?.ownerId).toBe(getAgent(db, "worker-1", "auth")?.incarnation);
    expect(briefs().map((n) => n.content)).toEqual([TEXT]);
    // Launched with no prompt: the pane's command is the harness and its preset, nothing else.
    expect(paneCmd("%1")).toMatch(/ mu-anchor 'claude --permission-mode acceptEdits'$/);
    expect(paneCmd("%1")).not.toContain("do the thing");
  });

  it("claude: the pointer waits for session_start; without one in MU_SPAWN_ACK_MS it is pasted anyway and only an ack can confirm it", async () => {
    // No session_start ever (its hooks are not installed, say): no read sees a row.
    fake.acks = false;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      const out = await spawnForTask(db, req());
      expect(out).toMatchObject({ state: "unknown", replay: false, brief: "pending" });
    });
    // The readiness polls (1000 ms at 250 ms: five reads), then the paste gate's read.
    expect(readsAtPaste).toBe(6);
    expect(pastes()).toHaveLength(1);
    expect(receipt()).toMatchObject({ state: "unknown", transport: "hooks" });
  });

  it("codex: its session starts only with the first prompt, so nothing waits for it", async () => {
    // codex fires SessionStart with its first prompt (U0): the real order.
    fake.onSubmit = () => {
      fake.emit("session_start", { source: "startup" });
      fake.emit("prompt_submitted");
    };
    await withEnv("MU_SPAWN_ACK_MS", "60000", async () => {
      const out = await spawnForTask(db, req("codex"));
      expect(out).toMatchObject({ state: "sent", brief: "recorded" });
    });
    // One readiness read and the paste gate's read before the paste, not 241 polls.
    expect(readsAtPaste).toBe(2);
    expect(fake.submitted).toHaveLength(1);
    expect(receipt()).toMatchObject({
      state: "sent",
      transport: "hooks",
      incarnation: "sess-1",
      runs: 0,
    });
    expect(paneCmd("%1")).toMatch(/ mu-anchor 'codex -s workspace-write -a never'$/);
  });

  it("killed between pane and claim: the replay claims, writes and pastes once; a second replay sends nothing", async () => {
    fake.emit("session_start", { source: "startup" });
    // The first run got as far as the pane, journaled, and died before the claim.
    const spawned = await spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      cli: "claude",
      cwd,
    });
    const id = taskIdFor(db, "t1", "auth") ?? 0;
    reserveReceipt(db, {
      taskId: id,
      attemptKey: "manual:t1",
      name: "worker-1",
      workstream: "auth",
      requestSha: requestSha({ name: "worker-1", nextFree: false, text: TEXT }),
      msgId: "reserved-msg-1",
    });
    updateReceipt(db, id, "manual:t1", {
      state: "pane",
      agentId: spawned.incarnation,
      paneId: spawned.paneId,
    });
    expect(getTask(db, "t1", "auth")?.ownerId).toBeNull();
    expect(existsSync(join(cwd, ".mu"))).toBe(false);

    const out = await spawnForTask(db, req());
    expect(out).toMatchObject({ state: "sent", replay: false, brief: "recorded" });
    expect(getTask(db, "t1", "auth")?.ownerId).toBe(spawned.incarnation);
    const again = await spawnForTask(db, req());
    expect(again).toMatchObject({ state: "sent", replay: true, brief: "kept" });

    // Exactly one brief: one file, one pasted pointer, one pinned note; no second pane.
    expect(readdirSync(join(cwd, ".mu")).sort()).toEqual([
      ".gitignore",
      "brief-worker-1-manual-t1.md",
    ]);
    expect(pastes()).toHaveLength(1);
    expect(fake.submitted).toHaveLength(1);
    expect(briefs()).toHaveLength(1);
    expect(state.panes.size).toBe(1);
  });

  it("a worker that never submits ends unknown; reconcile promotes it to sent once its inbox shows the run", async () => {
    fake.emit("session_start", { source: "startup" });
    fake.acks = false;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      const out = await spawnForTask(db, req());
      expect(out).toMatchObject({ state: "unknown", brief: "pending" });
    });
    // The baseline the replay compares against: the session and its count before the pointer.
    expect(receipt()).toMatchObject({
      state: "unknown",
      transport: "hooks",
      incarnation: "sess-1",
      runs: 0,
    });
    expect(briefs()).toEqual([]);
    // The pane and the claim are kept: the prompt may be running.
    expect(getTask(db, "t1", "auth")?.status).toBe("IN_PROGRESS");

    // Nothing in the inbox yet: still unknown, and never re-pasted.
    const quiet = await spawnForTask(db, req());
    expect(quiet).toMatchObject({ state: "unknown", replay: true, checked: "not-accepted" });
    expect(pastes()).toHaveLength(1);

    // The worker took the pointer late (a dialog closed, a slow start): its run reaches the inbox.
    fake.emit("prompt_submitted");
    const promoted = await spawnForTask(db, req());
    expect(promoted).toMatchObject({
      state: "sent",
      replay: true,
      checked: "accepted",
      brief: "recorded",
    });
    expect(receipt()).toMatchObject({ state: "sent", incarnation: "sess-1", runs: 0 });
    expect(briefs().map((n) => n.content)).toEqual([TEXT]);
    expect(pastes()).toHaveLength(1);
  });

  it("a run from before the pointer never promotes: only a count above the baseline does", async () => {
    fake.emit("session_start", { source: "startup" });
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: "earlier" });
    fake.acks = false;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      await spawnForTask(db, req());
    });
    expect(receipt()).toMatchObject({ state: "unknown", incarnation: "sess-1", runs: 1 });
    expect(await spawnForTask(db, req())).toMatchObject({ state: "unknown", replay: true });
    fake.emit("prompt_submitted");
    expect(await spawnForTask(db, req())).toMatchObject({ state: "sent", replay: true });
    expect(receipt()?.runs).toBe(1);
  });

  it("codex never acks: no session at the baseline, and its first run in any session promotes", async () => {
    // codex reports its session only with its first prompt, and this one took the pointer late.
    fake.acks = false;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      const out = await spawnForTask(db, req("codex"));
      expect(out).toMatchObject({ state: "unknown", brief: "pending" });
    });
    expect(receipt()).toMatchObject({ state: "unknown", transport: "hooks", incarnation: null });
    expect(await spawnForTask(db, req("codex"))).toMatchObject({
      state: "unknown",
      checked: "not-accepted",
    });
    fake.emit("session_start", { source: "startup" });
    fake.emit("prompt_submitted");
    expect(await spawnForTask(db, req("codex"))).toMatchObject({
      state: "sent",
      replay: true,
      checked: "accepted",
      brief: "recorded",
    });
    expect(receipt()).toMatchObject({ state: "sent", incarnation: "sess-1", runs: 0 });
    expect(pastes()).toHaveLength(1);
  });

  it("a run in another session than the baseline's never promotes (a /clear and a prompt typed by hand)", async () => {
    fake.emit("session_start", { source: "startup" });
    fake.acks = false;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      await spawnForTask(db, req());
    });
    expect(receipt()).toMatchObject({ state: "unknown", incarnation: "sess-1", runs: 0 });
    fake.emit("session_start", { source: "clear", session_id: "sess-2" });
    fake.emit("prompt_submitted", { session_id: "sess-2" });
    expect(await spawnForTask(db, req())).toMatchObject({
      state: "unknown",
      replay: true,
      checked: "not-accepted",
    });
    expect(briefs()).toEqual([]);
  });

  it("a dialog at the paste is refused before anything is typed: unsent, rolled back", async () => {
    fake.emit("session_start", { source: "startup" });
    fake.emit("permission_requested", { message: "Bash" });
    await expect(spawnForTask(db, req())).rejects.toThrow(/permission|dialog|Bash|blocked/i);
    expect(pastes()).toHaveLength(0);
    expect(receipt()?.state).toBe("failed");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(getTask(db, "t1", "auth")?.ownerId).toBeNull();
  });
});

describe("spawn --send (no --task) to a first-prompt harness", () => {
  /** murmur on PATH with codex's and muse's hooks: the exemption needs them for a local worker. */
  let restoreHooks: () => void;
  beforeEach(() => {
    restoreHooks = installMurmurHooks(dir, ["codex", "muse"]);
  });
  afterEach(() => restoreHooks());
  /** codex and muse report their session only with the first prompt (U0): the real order. */
  const firstPromptStarts = (): void => {
    fake.onSubmit = () => {
      fake.emit("session_start", { source: "startup" });
      fake.emit("prompt_submitted");
    };
  };

  it.each(["codex", "muse"])(
    "%s: no murmur row yet, the pane is live: pasted without --force, confirmed by run 1",
    async (cli) => {
      firstPromptStarts();
      const r = await runCliJson(
        ["agent", "spawn", "worker-1", "-w", "auth", "--cli", cli, "--send", "hello", "--json"],
        join(dir, "mu.db"),
      );
      expect(r.exitCode).toBeNull();
      expect(r.data).toMatchObject({
        send: { ok: true, transport: "hooks", delivered: true },
      });
      expect(fake.submitted).toEqual(["hello"]);
    },
  );

  it("claude (its session starts at once): no row still reads unknown and is refused", async () => {
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--cli", "claude", "--send", "hello", "--json"],
      join(dir, "mu.db"),
    );
    expect(r.exitCode).toBe(4);
    expect(JSON.stringify(r.doc)).toContain("no row for the pane");
    expect(pastes()).toHaveLength(0);
  });
});
