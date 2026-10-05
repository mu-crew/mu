// Drill-pin regressions for the popups the first
// bug_filter_drill_opens_wrong_task sweep missed:
//
//   - Tracks: the filter dropped in drill mode, so the drill indexed
//     the UNFILTERED list (f_tui_tracks_filter_drill_wrong_track).
//   - Commits / Log: the drill followed the cursor index, so a new
//     row at the top switched the open drill to another row
//     (f_tui_commits_drill_not_pinned).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement, type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitsPopup } from "../src/cli/tui/popups/commits.js";
import { LogPopup } from "../src/cli/tui/popups/log.js";
import { TracksPopup } from "../src/cli/tui/popups/tracks.js";
import { type Db, openDb } from "../src/db.js";
import type { LogRow } from "../src/logs.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { addNote, addTask, setTaskStatus } from "../src/tasks.js";
import { getParallelTracks } from "../src/tracks.js";
import type { CommitSummary } from "../src/vcs.js";
import {
  CaptureStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
  waitForInkOutput,
} from "./_ink-render.js";

vi.mock("../src/vcs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vcs.js")>();
  return {
    ...actual,
    detectBackend: vi.fn(async () => ({
      name: "git",
      showCommit: async (_path: string, sha: string) => ({
        text: `commit ${sha}\n+ body`,
        truncated: false,
      }),
    })),
  };
});

const openDbs: Db[] = [];
afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.length = 0;
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  const db = openDb({ path: join(mkdtempSync(join(tmpdir(), "mu-tui-drill-pin-")), "mu.db") });
  openDbs.push(db);
  return db;
}

function snapshot(over: Partial<WorkstreamSnapshot>): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, orphans: [], mode: "report-only" },
    },
    tracks: [],
    ready: [],
    inProgress: [],
    blocked: [],
    recentClosed: [],
    parkedCount: 0,
    triage: [],
    taskCount: 0,
    allTasks: [],
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: "git",
    doctor: null,
    ...over,
  };
}

// Owns `mode` the way <App> does.
function Harness({
  popup,
  snap,
  db,
}: {
  popup: typeof CommitsPopup | typeof LogPopup | typeof TracksPopup;
  snap: WorkstreamSnapshot;
  db: Db;
}): ReactElement {
  const [mode, setMode] = useState<"list" | "drill">("list");
  return createElement(popup as unknown as (props: Record<string, unknown>) => ReactElement, {
    yank: async () => {},
    onClose: () => {},
    snapshot: snap,
    fastTickNonce: 0,
    slowTickNonce: 0,
    mode,
    onModeChange: setMode,
    db,
    workstream: "demo",
  });
}

function mount(popup: Parameters<typeof Harness>[0]["popup"], snap: WorkstreamSnapshot, db: Db) {
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({ columns: 120, rows: 30 });
  const instance = render(createElement(Harness, { popup, snap, db }), {
    stdout,
    stdin,
    stderr: process.stderr,
    debug: false,
    patchConsole: false,
  });
  return { stdin, stdout, instance };
}

const frame = (stdout: CaptureStream) => latestRenderedFrame(stdout).join("\n");

describe("TracksPopup: filtered drill opens the track the user selected", () => {
  it("'/bbb' Enter Enter drills bbb_goal, not unfiltered[0] aaa_goal", async () => {
    const db = fixtureDb();
    addTask(db, { workstream: "demo", localId: "aaa_goal", title: "A", impact: 90, effortDays: 1 });
    addTask(db, { workstream: "demo", localId: "bbb_goal", title: "B", impact: 90, effortDays: 1 });
    const tracks = getParallelTracks(db, "demo");
    expect(tracks.map((t) => t.roots[0]?.name)).toEqual(["aaa_goal", "bbb_goal"]);
    const { stdin, stdout, instance } = mount(TracksPopup, snapshot({ tracks }), db);
    await waitForInkOutput(stdout);

    for (const key of ["/", "b", "b", "b", "enter"] as const) await simulateInput(stdin, key);
    await waitForInkOutput(stdout);
    await simulateInput(stdin, "enter");
    await waitForInkOutput(stdout);

    const drill = frame(stdout);
    expect(drill).toContain("Track 1 · bbb_goal");
    expect(drill).not.toContain("aaa_goal");
    instance.unmount();
  });
});

describe("TracksPopup: task-detail leaf stays on the drilled task", () => {
  it("a status change that re-sorts the drill list does not switch the open leaf", async () => {
    const db = fixtureDb();
    for (const id of ["a", "b"]) {
      addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
      addNote(db, id, `note on ${id}`, { workstream: "demo", author: "t" });
    }
    addTask(db, {
      workstream: "demo",
      localId: "g",
      title: "G",
      impact: 90,
      effortDays: 1,
      blockedBy: ["a", "b"],
    });
    const before = snapshot({ tracks: getParallelTracks(db, "demo") });
    const { stdin, stdout, instance } = mount(TracksPopup, before, db);
    await waitForInkOutput(stdout);
    // Drill the track (rows: a, b, g), move to b, open its leaf.
    await simulateInput(stdin, "enter");
    await waitForInkOutput(stdout);
    await simulateInput(stdin, "j");
    await waitForInkOutput(stdout);
    await simulateInput(stdin, "enter");
    await waitForInkOutput(stdout);
    expect(frame(stdout)).toContain("task: b (notes)");

    // b goes IN_PROGRESS and sorts to index 0; a moves to index 1.
    setTaskStatus(db, "b", "IN_PROGRESS", { workstream: "demo" });
    const after = snapshot({ tracks: getParallelTracks(db, "demo") });
    instance.rerender(createElement(Harness, { popup: TracksPopup, snap: after, db }));
    await waitForInkOutput(stdout);
    const leaf = frame(stdout);
    expect(leaf).toContain("task: b (notes)");
    expect(leaf).toContain("note on b");
    expect(leaf).not.toContain("note on a");

    // Esc back to the task list keeps the cursor on b (now row 1/3).
    await simulateInput(stdin, "escape");
    await waitForInkOutput(stdout);
    expect(frame(stdout)).toContain("(1/3)");
    instance.unmount();
  });
});

function commit(sha: string, subject: string): CommitSummary {
  return { sha, subject, body: "", author: "t", authorDate: "2026-01-01T00:00:00Z", relTime: "1m" };
}

describe("CommitsPopup: drill stays on the drilled commit", () => {
  it("a new commit prepended on refresh does not switch the open drill", async () => {
    const db = fixtureDb();
    const before = snapshot({
      recentCommits: [commit("aaaaaaa1", "first"), commit("bbbbbbb2", "second")],
    });
    const { stdin, stdout, instance } = mount(CommitsPopup, before, db);
    await waitForInkOutput(stdout);
    await simulateInput(stdin, "enter");
    await waitForInkOutput(stdout);
    expect(frame(stdout)).toContain("Commits · git · aaaaaaa");

    const after = snapshot({
      recentCommits: [
        commit("ccccccc3", "new"),
        commit("aaaaaaa1", "first"),
        commit("bbbbbbb2", "second"),
      ],
    });
    instance.rerender(createElement(Harness, { popup: CommitsPopup, snap: after, db }));
    await waitForInkOutput(stdout);
    const drill = frame(stdout);
    expect(drill).toContain("Commits · git · aaaaaaa");
    expect(drill).not.toContain("ccccccc");
    instance.unmount();
  });
});

function event(seq: number, payload: string): LogRow {
  return {
    seq,
    workstreamName: "demo",
    source: "system",
    intent: null,
    group: `g${seq}`,
    kind: "event",
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as LogRow;
}

describe("LogPopup: drill stays on the drilled event", () => {
  it("a new event at the top does not switch the open drill", async () => {
    const db = fixtureDb();
    const before = snapshot({ recent: [event(2, "payload two"), event(1, "payload one")] });
    const { stdin, stdout, instance } = mount(LogPopup, before, db);
    await waitForInkOutput(stdout);
    await simulateInput(stdin, "enter");
    await waitForInkOutput(stdout);
    expect(frame(stdout)).toContain("Activity log · #2");

    const after = snapshot({
      recent: [event(3, "payload three"), event(2, "payload two"), event(1, "payload one")],
    });
    instance.rerender(createElement(Harness, { popup: LogPopup, snap: after, db }));
    await waitForInkOutput(stdout);
    const drill = frame(stdout);
    expect(drill).toContain("Activity log · #2");
    expect(drill).toContain("payload two");
    expect(drill).not.toContain("payload three");
    instance.unmount();
  });
});
