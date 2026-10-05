import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement, type ReactElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POPUP_CHROME_TOP } from "../src/cli/tui/app.js";
import type { PopupActionEnvelope } from "../src/cli/tui/keys.js";
import { ReadyPopup } from "../src/cli/tui/popups/ready.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { addTask, type TaskRow } from "../src/tasks.js";
import { CaptureStream, createInkCaptureStream, createInkInputStream } from "./_ink-render.js";

let dir = "";
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-tui-mouse-doubleclick-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
  CaptureStream.cleanup();
});

describe("popup double-click actions", () => {
  function seed(n: number): TaskRow[] {
    return Array.from({ length: n }, (_, i) =>
      addTask(db, {
        workstream: "demo",
        localId: `task_${String(i).padStart(2, "0")}`,
        title: `Task ${i}`,
        impact: 50,
        effortDays: 1,
      }),
    );
  }

  it("clickRow on an unscrolled list drills the clicked row", async () => {
    const tasks = seed(6);
    const stdout = createInkCaptureStream({ columns: 120, rows: 24 });
    const stdin = createInkInputStream();
    const instance = render(readyPopupElement({ db, tasks, popupActions: [] }), {
      stdout,
      stdin,
      stderr: process.stderr,
      debug: false,
      patchConsole: false,
    });

    const popupActions: PopupActionEnvelope[] = [
      { seq: 1, action: { kind: "clickRow", row: 5 - POPUP_CHROME_TOP } },
    ];
    instance.rerender(readyPopupElement({ db, tasks, popupActions }));
    await waitFor(() => expect(stdout.output).toContain("Tasks · task_03 (notes)"));
    instance.unmount();
  });

  it("clickRow maps through the scroll window when the list is scrolled", async () => {
    // 24 rows → viewport 21. With 40 tasks and the cursor on the last
    // row the window starts at 40 - 21 = 19, so body row 0 is task_19,
    // not task_00 (f_tui_dblclick_row_index_ignores_scroll).
    const tasks = seed(40);
    const stdout = createInkCaptureStream({ columns: 120, rows: 24 });
    const stdin = createInkInputStream();
    const instance = render(readyPopupElement({ db, tasks, popupActions: [] }), {
      stdout,
      stdin,
      stderr: process.stderr,
      debug: false,
      patchConsole: false,
    });

    let popupActions: PopupActionEnvelope[] = [{ seq: 1, action: { kind: "jumpBottom" } }];
    instance.rerender(readyPopupElement({ db, tasks, popupActions }));
    await waitFor(() => expect(stdout.output).toContain("Tasks · popup (40/40)"));

    popupActions = [...popupActions, { seq: 2, action: { kind: "clickRow", row: 0 } }];
    instance.rerender(readyPopupElement({ db, tasks, popupActions }));
    await waitFor(() => expect(stdout.output).toContain("Tasks · task_19 (notes)"));
    expect(stdout.output).not.toContain("Tasks · task_00 (notes)");
    instance.unmount();
  });
});

interface HarnessProps {
  db: Db;
  tasks: TaskRow[];
  popupActions: PopupActionEnvelope[];
}

// Owns `mode` like <App> does, so a clickRow really opens the drill and
// its title names WHICH row the click resolved to.
function Harness({ db, tasks, popupActions }: HarnessProps): ReactElement {
  const [mode, setMode] = useState<"list" | "drill">("list");
  return createElement(ReadyPopup, {
    yank: async () => {},
    onClose: () => {},
    snapshot: snapshotWithReady(tasks),
    fastTickNonce: 0,
    mode,
    onModeChange: setMode,
    db,
    workstream: "demo",
    popupActions,
  });
}

function readyPopupElement(opts: HarnessProps): ReactElement {
  return createElement(Harness, opts);
}

function snapshotWithReady(ready: TaskRow[]): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, orphans: [], mode: "report-only" },
    },
    tracks: [],
    ready,
    inProgress: [],
    blocked: [],
    recentClosed: [],
    parkedCount: 0,
    triage: [],
    taskCount: 0,
    allTasks: ready,
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(String(lastError));
}
