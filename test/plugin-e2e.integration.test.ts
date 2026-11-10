// The plugins spec's end-to-end walkthrough ("End to end: a provisioning
// backend", D16 plugin-e2e) against the fake plugin: a real executable over
// stdio as host provider, link (with push), at-start job kind that outlives its
// host, and streaming channel. Real git on both sides (the fake's link runs
// scripts with a local sh under its home); the multiplexer is a stub, so views
// never run. `mu wait` runs in-process through its CLI command.
//   1 register   2 acquire (a deadline)   3 spawn --worktree --task: push, tree,
//   placeholder claims, job.start carries the brief   5 wait @0 for the first
//   turn   6 the settle's in-life collect   4 send, 5 wait for its settle
//   7 inside the margin: the wait's deadline timer fires `deadline`, notices name
//   collect and close, spawns refuse; close: job.stop, final collect, tree;
//   release.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { getReceipt } from "../src/agents/receipts.js";
import { spawnForTask } from "../src/agents/task-spawn.js";
import { getAgent, sendToAgent } from "../src/agents.js";
import { getCarrierJobByAgent, listCarrierJobs } from "../src/carrier-jobs.js";
import { cmdWait } from "../src/cli/wait.js";
import { drainHost, releaseHost } from "../src/host-lifecycle.js";
import { getHostRecord, HostDeadlineError } from "../src/host-records.js";
import { computeNotices } from "../src/next-hints.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask, taskIdFor } from "../src/tasks.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
const BRIEF = "build t1";
const MARGIN = "MU_HOST_DEADLINE_MARGIN_MS";

let local: string;
let remote: string;
let home: string | undefined;
let cwd: string;
let out: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = process.env.HOME;
  cwd = process.cwd();
  process.env.HOME = h.dir;
  local = join(h.dir, "local");
  remote = join(h.dir, "remote");
  mkdirSync(local);
  local = realpathSync(local);
  git(local, "init", "-q");
  git(local, "commit", "-q", "--allow-empty", "-m", "one");
  process.chdir(local);
  out = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  out.mockRestore();
  err.mockRestore();
  process.chdir(cwd);
  process.env.HOME = home;
  delete process.env[MARGIN];
});

/** `mu wait <refs> -w ws --timeout 20`, in-process: its JSON data and exit. */
async function wait(...refs: string[]): Promise<{ data: Record<string, unknown>; exit: number }> {
  out.mockClear();
  let exit = 0;
  try {
    await cmdWait(
      h.db,
      refs,
      { workstream: "ws", timeout: 20 },
      { signal: new AbortController().signal, which: () => undefined, dispose: () => {} },
    );
  } catch (e) {
    exit = (e as { exitCode?: number }).exitCode ?? -1;
  }
  const line = out.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("{"));
  const env = JSON.parse(line ?? "{}") as { data?: Record<string, unknown> };
  return { data: env.data ?? {}, exit };
}

const collectRef = () => git(local, "rev-parse", "--verify", "-q", "refs/mu/collect/ws/w1").trim();

describe("the provisioning backend walkthrough", () => {
  it("register, acquire, worktree with push, start with the brief, send, wait, collect, deadline, close, release", async () => {
    // 1. Register and 2. acquire: an at-start job kind that outlives its host, a link with push.
    const deadlineAt = Date.now() + 3_600_000;
    await h.setup(
      { firstTurn: "at-start", outlivesHost: true },
      { hostFacts: { deadlineAt } },
      { push: true },
    );
    expect(getHostRecord(h.db, "box")).toMatchObject({ state: "ready", deadline_at: deadlineAt });

    // 3. Spawn a session job with --task: HEAD pushed, the tree made from it, the brief in job.start.
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    const sha = git(local, "rev-parse", "HEAD");
    const spawned = await spawnForTask(h.db, {
      spawn: {
        name: "w1",
        workstream: "ws",
        host: "box",
        cli: "claude",
        worktree: true,
        root: remote,
      },
      task: "t1",
      text: BRIEF,
    });
    expect(spawned.state).toBe("sent");
    const rec = getReceipt(h.db, taskIdFor(h.db, "t1", "ws") ?? -1, "manual:t1");
    expect(rec).toMatchObject({ state: "sent", runs: 0, transport: "cloud" });
    expect(h.calls("link.push")[0]?.params).toMatchObject({ rev: sha, remoteRepo: remote });
    const a = getAgent(h.db, "w1", "ws");
    const tree = a?.cwd ?? "";
    const spec = h.calls("job.start")[0]?.params.spec as { cwd: string; firstPrompt: unknown };
    expect(spec).toMatchObject({ cwd: tree, firstPrompt: { text: BRIEF, msgId: rec?.msgId } });
    expect(h.calls("channel.send")).toHaveLength(0);
    expect(getTask(h.db, "t1", "ws")?.ownerId).toBe(a?.incarnation);
    expect(getCarrierJobByAgent(h.db, a?.incarnation ?? -1)).toMatchObject({
      treeBase: sha,
      collectRepo: local,
      finalOwed: true,
      firstMsgId: rec?.msgId,
    });

    // 5. Wait for the first turn (@0); 6. its settle triggers an in-life collect of the work.
    git(tree, "commit", "-q", "--allow-empty", "-m", "work one");
    const one = git(tree, "rev-parse", "HEAD");
    const first = await wait("agent:w1@0");
    expect(first.exit).toBe(0);
    expect(first.data.firing).toMatchObject({ kind: "settled", runs: 1 });
    expect(collectRef()).toBe(one);
    expect(getAgent(h.db, "w1", "ws")?.collectedHead).toBe(one);
    expect(getCarrierJobByAgent(h.db, a?.incarnation ?? -1)?.finalOwed).toBe(true);

    // 4. Send: a channel.send effect with its msgId, then 5. its settle.
    const sent = await sendToAgent(h.db, "w1", "second", { workstream: "ws" });
    expect(h.calls("channel.send")[0]?.params).toMatchObject({
      text: "second",
      firstPrompt: false,
    });
    expect(sent.runs).toBe(1);
    const second = await wait("agent:w1@1");
    expect(second.data.firing).toMatchObject({ kind: "settled", runs: 2 });

    // 7. Inside the margin: the wait's own timer fires `deadline`, urgent (exit 7).
    process.env[MARGIN] = String(deadlineAt - Date.now() - 500);
    const started = Date.now();
    const dl = await wait("agent:w1@2");
    expect(dl.exit).toBe(7);
    expect(dl.data.firing).toMatchObject({ kind: "deadline", ref: "agent:ws/w1" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const notices = computeNotices(h.db, { callers: [], workstream: "ws" });
    expect(notices.join("\n")).toMatch(/host box reaches its deadline .*mu agent close w1 -w ws/);
    await expect(h.spawn({ name: "w2", firstPrompt: "x" })).rejects.toBeInstanceOf(
      HostDeadlineError,
    );

    // Close: job.stop, then the final collect clears final_owed, then the tree.
    git(tree, "commit", "-q", "--allow-empty", "-m", "work two");
    const two = git(tree, "rev-parse", "HEAD");
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(h.f.backend().stops).toBe(1);
    expect(git(local, "cat-file", "-t", two)).toBe("commit");
    expect(collectRef()).toBe(two);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(listCarrierJobs(h.db)).toHaveLength(0);
    expect(existsSync(tree)).toBe(false);
    expect(computeNotices(h.db, { callers: [], workstream: "ws" })).toEqual([]);

    // Release: no agent, job or recovery row names the host.
    if (getHostRecord(h.db, "box")?.state === "ready") await drainHost(h.db, "box");
    await releaseHost(h.db, "box");
    expect(getHostRecord(h.db, "box")).toBeUndefined();
    expect(h.f.backend().releases).toBe(1);
  });
});
