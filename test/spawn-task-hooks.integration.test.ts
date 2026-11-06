// spawn --task --worktree of a codex worker on the `hooks` channel (spec D17,
// U20), in a real git repo: the brief file and its `.mu/.gitignore` leave the
// worktree clean (status and `git add -A` see nothing), and codex is launched
// with the trust flag on the worktree's real path and its auto-approve
// preset, with no prompt. The multiplexer is the mock tmux; a fake hook
// harness (test/_fake-harness.ts) stands in for codex on pane %1.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnForTask,
} from "../src/agents.js";
import {
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { gitIn, initGitRepo } from "./_git.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

let tmp: string;
let root: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let fake: FakeHarness;
const envKeys = ["MU_STATE_DIR", "MU_SPAWN_CTL_MS", "MU_SPAWN_LIVENESS_MS"] as const;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "mu-sth-")));
  root = join(tmp, "repo");
  execFileSync("mkdir", ["-p", root]);
  initGitRepo(root);
  process.env.MU_STATE_DIR = join(tmp, "state");
  process.env.MU_SPAWN_CTL_MS = "0";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  db = openDb({ path: join(tmp, "mu.db") });
  ensureWorkstream(db, "auth");
  addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1 });
  fake = fakeHarness(tmp, "%1", "sess-1");
  // codex starts its session with its first prompt (U0).
  fake.onSubmit = () => {
    fake.emit("session_start", { source: "startup" });
    fake.emit("prompt_submitted");
  };
  setMurmurPaneRunnerForTests(fake.pane);
  setMurmurHookRunnerForTests(fake.hook);
  state = freshMockState();
  const tmux = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => fake.tmux(args) ?? tmux(args));
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
});

afterEach(() => {
  try {
    mux.restore();
    setMurmurPaneRunnerForTests(null);
    setMurmurHookRunnerForTests(null);
    resetSleep();
    resetCommandResolverForTests();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    for (const k of envKeys) delete process.env[k];
  } catch {}
});

describe("a hooks worker's brief in a mu worktree", () => {
  it("leaves the worktree clean, and codex starts trusted there, with no prompt", async () => {
    const text = "fix the bug\n";
    const out = await spawnForTask(db, {
      task: "t1",
      text,
      spawn: { name: "worker-1", workstream: "auth", cli: "codex", worktree: true, root },
    });
    expect(out).toMatchObject({ state: "sent", brief: "recorded" });
    const wt = getAgent(db, "worker-1", "auth")?.cwd ?? "";
    expect(readFileSync(join(wt, ".mu", "brief-worker-1-manual-t1.md"), "utf8")).toBe(text);
    // Nothing for git to see, before or after `git add -A`.
    expect(gitIn(wt, "status", "--porcelain", "--untracked-files=all")).toBe("");
    gitIn(wt, "add", "-A");
    expect(gitIn(wt, "diff", "--cached", "--name-only")).toBe("");
    // The trust flag names the worktree's real path; the brief never rides the launch.
    const cmd = state.panes.get("%1")?.command ?? "";
    expect(cmd).toContain(`projects={"${realpathSync(wt)}"={trust_level="trusted"}}`);
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("fix the bug");
    expect(fake.submitted).toHaveLength(1);
  });
});
