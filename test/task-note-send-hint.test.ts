// A note on a task that another agent is working on does not reach that
// agent: `mu task note` says so and names the send that does.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mtn-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
  addTask(db, { localId: "t1", workstream: "auth", title: "t1", impact: 50, effortDays: 1 });
  mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
});

afterEach(() => {
  mux.restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const noteArgs = (author: string, ...extra: string[]) => [
  "task",
  "note",
  "t1",
  "rebuild first",
  "--author",
  author,
  "-w",
  "auth",
  ...extra,
];
async function note(author: string) {
  const r = await runCliJson(noteArgs(author, "--json"), dbPath);
  expect(r.exitCode).toBeNull();
  return r;
}
async function noteHuman(author: string) {
  const r = await runCli(noteArgs(author), dbPath);
  expect(r.exitCode).toBeNull();
  return r;
}
const warnings = (data: unknown) => (data as { warnings?: string[] }).warnings ?? [];
const sendHint = (w: string[]) => w.find((x) => x.includes("will not see this note"));
const claim = () => runCli(["task", "claim", "t1", "--for", "worker-1", "-w", "auth"], dbPath);

describe("mu task note send hint", () => {
  it("ctl owner: names the steer with its text argument (json + human)", async () => {
    await claim();
    const hint = sendHint(warnings((await note("orchestrator")).data));
    expect(hint).toBe(
      "worker-1 will not see this note: send it into the running turn (mu agent send worker-1 -w auth --steer - <<'EOF' (the note text, then EOF)), or pass --interrupt instead of --steer if the note makes the current work wasted",
    );
    expect((await noteHuman("orchestrator")).stderr).toContain("worker-1 will not see this note");
  });

  it("hooks owner: no --steer, a send after its turn or an interrupt, with the text argument", async () => {
    insertAgent(db, {
      name: "cc-1",
      workstream: "auth",
      paneId: "%2",
      cli: "claude",
      channel: "hooks",
    });
    await runCli(["task", "claim", "t1", "--for", "cc-1", "-w", "auth"], dbPath);
    const hint = sendHint(warnings((await note("orchestrator")).data));
    expect(hint).toBe(
      "cc-1 will not see this note, and its hooks channel has no mid-turn steer: send it once the turn ends (mu agent wait cc-1 -w auth, then mu agent send cc-1 -w auth - <<'EOF' (the note text, then EOF)), or mu agent send cc-1 -w auth --interrupt - <<'EOF' (the note text, then EOF) if the note makes the current work wasted",
    );
    expect(hint).not.toContain("--steer");
  });

  it("mux owner: a plain send with the text argument, no --steer or --interrupt", async () => {
    insertAgent(db, {
      name: "h-1",
      workstream: "auth",
      paneId: "%3",
      cli: "claude",
      channel: "mux",
    });
    await runCli(["task", "claim", "t1", "--for", "h-1", "-w", "auth"], dbPath);
    expect(sendHint(warnings((await note("orchestrator")).data))).toBe(
      "h-1 will not see this note: send it (mu agent send h-1 -w auth - <<'EOF' (the note text, then EOF))",
    );
  });

  it("the owner's own note: no send hint", async () => {
    await claim();
    expect(sendHint(warnings((await note("worker-1")).data))).toBeUndefined();
  });

  it("OPEN task: no send hint", async () => {
    expect(sendHint(warnings((await note("orchestrator")).data))).toBeUndefined();
  });

  it("CLOSED task: no send hint", async () => {
    await claim();
    await runCli(["task", "close", "t1", "-w", "auth", "--evidence", "test"], dbPath);
    expect(sendHint(warnings((await note("orchestrator")).data))).toBeUndefined();
  });
});
