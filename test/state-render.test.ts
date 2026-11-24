// Tests for the unified `mu state` verb.
//
// `mu state` prints one canonical JSON document (no card). It accepts variadic
// `-w X[,Y]...` / `-w X -w Y` and `--all`. The bounded, caller-scoped contract
// is pinned in state-output-contract.test.ts; these drive the real CLI.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalNoColor = vi.hoisted(() => process.env.NO_COLOR);

// Force colorless output for the whole file (literal-substring
// assertions vs ANSI escapes). The `pc` instance is baked at
// src/output.ts module-load time; vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.NO_COLOR = "1";
});

afterAll(() => {
  if (originalNoColor === undefined) {
    const key = "NO_COLOR";
    delete process.env[key];
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});

import { runCli, runCliJson } from "./_runCli.js";
import { softTeardown } from "./_teardown.js";

// ── default read ─────────────────────────

describe("mu state — default (full) mode", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-full-"));
    dbPath = join(tempDir, "mu.db");
    await runCliJson(["workstream", "init", "ws", "--json"], dbPath);
    await runCliJson(
      ["task", "add", "alpha", "-w", "ws", "--title", "A", "-i", "50", "-e", "1", "--json"],
      dbPath,
    );
    await runCliJson(
      ["task", "add", "beta", "-w", "ws", "--title", "B", "-i", "60", "-e", "1", "--json"],
      dbPath,
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("is one JSON document by default, with the section lists under SQL column names", async () => {
    const { data, stdout, exitCode } = await runCliJson(["state", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).not.toContain("State of mu-");
    expect(data.workstreams).toHaveLength(1);
    const w = data.workstreams[0];
    expect(w.workstream).toBe("ws");
    expect(w.agents).toEqual([]);
    expect(w.orphans).toEqual([]);
    expect(w.ready.map((t: { id: string }) => t.id)).toEqual(["beta", "alpha"]);
    expect(w.ready[0]).toMatchObject({ title: "B", status: "OPEN", impact: 60, effort_days: 1 });
    expect(w.blocked).toEqual([]);
    expect(w.in_progress).toEqual([]);
    expect(w.recent_closed).toEqual([]);
    expect(w.counts).toMatchObject({ tasks: 2, ready: 2 });
    // The card's old keys, tracks and recent-ops section are gone: `mu log` owns the ops.
    for (const gone of ["workstreamName", "tracks", "recent", "remoteWorkers", "inProgress"]) {
      expect(w).not.toHaveProperty(gone);
    }
  });

  it("a REMOTE: note is just prose: remote workers are agents with host/cwd/base (state-output-contract)", async () => {
    await runCli(
      ["task", "note", "alpha", "-w", "ws", "REMOTE: dev:~/ws/worker-1\nREMOTE_BASE: worker-1:abc"],
      dbPath,
    );
    const { data } = await runCliJson(["state", "-w", "ws"], dbPath);
    expect(data.workstreams[0].agents).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("dev:~/ws");
  });

  it("a multi-workstream read is the same document with one entry each, in order", async () => {
    await runCliJson(["workstream", "init", "ws2", "--json"], dbPath);
    await runCliJson(
      ["task", "add", "gamma", "-w", "ws2", "--title", "G", "-i", "10", "-e", "1", "--json"],
      dbPath,
    );
    const { data, exitCode } = await runCliJson(["state", "-w", "ws,ws2"], dbPath);
    expect(exitCode).toBeNull();
    expect(data.workstreams).toEqual([
      expect.objectContaining({
        workstream: "ws",
        ready: expect.arrayContaining([
          expect.objectContaining({ id: "alpha", title: "A", status: "OPEN" }),
          expect.objectContaining({ id: "beta", title: "B", status: "OPEN" }),
        ]),
        blocked: [],
      }),
      expect.objectContaining({
        workstream: "ws2",
        ready: [expect.objectContaining({ id: "gamma", title: "G", status: "OPEN" })],
        blocked: [],
      }),
    ]);
  });
});

// ── mutual exclusion + cross-workstream ────────────────────────────

describe("mu state — mutual-exclusion + cross-workstream", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-mux-"));
    dbPath = join(tempDir, "mu.db");
    for (const w of ["alpha", "beta", "gamma"]) {
      await runCliJson(["workstream", "init", w, "--json"], dbPath);
      await runCliJson(
        ["task", "add", `t_${w}`, "-w", w, "--title", `T-${w}`, "-i", "50", "-e", "1", "--json"],
        dbPath,
      );
    }
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("--all + -w errors as a UsageError (mutually exclusive)", async () => {
    const { data, doc, exitCode } = await runCliJson(["state", "--all", "-w", "alpha"], dbPath);
    expect(exitCode).toBe(2);
    expect(doc.ok).toBe(false);
    expect(data).toBeUndefined();
    expect(doc.message).toContain("mutually exclusive");
  });

  it("cross-workstream reads exactly the named workstreams (-w X,Y)", async () => {
    const { data, exitCode } = await runCliJson(["state", "-w", "alpha,beta"], dbPath);
    expect(exitCode).toBeNull();
    expect(data.workstreams.map((w: { workstream: string }) => w.workstream)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("-w with one bad name errors as WorkstreamNotFoundError", async () => {
    const { doc, exitCode } = await runCliJson(["state", "-w", "alpha,nope"], dbPath);
    expect(exitCode).toBe(3);
    expect(doc).toMatchObject({ ok: false, error: "WorkstreamNotFoundError" });
    expect(doc.message).toContain("nope");
  });
});

// ── classifyEventVerb regression: emitted SDK events are recognised ──
//
// v2-log-verb retired the prose parser (classifyEventVerb). Rendering now
// keys on `intent` via src/log-render.ts. These tests pin the FORMATTER
// contract and then drive representative SDK verbs, asserting that every
// op a real session emits renders as prose a human can read.
describe("the op formatter", () => {
  it("renders every known intent with a verb and no raw JSON", async () => {
    const { KNOWN_INTENTS, renderOp } = await import("../src/log-render.js");
    expect(KNOWN_INTENTS.length).toBeGreaterThan(0);
    for (const intent of KNOWN_INTENTS) {
      const r = renderOp({
        intent,
        kind: intent.slice(0, intent.indexOf(".")),
        workstreamName: "alpha/t1",
        payload: '{"status":"OPEN"}',
        source: "system",
        op: "put",
      });
      expect(r, `intent '${intent}' should render`).not.toBeNull();
      expect(r?.verb.length).toBeGreaterThan(0);
    }
  });

  it("returns null for intentless prose so callers show it verbatim", async () => {
    const { renderOp } = await import("../src/log-render.js");
    for (const payload of [
      "random freeform message",
      "approve granted slug",
      "snapshot capture foo",
    ]) {
      expect(
        renderOp({
          intent: null,
          kind: "message",
          workstreamName: "alpha",
          payload,
          source: "user",
          op: "put",
        }),
      ).toBeNull();
    }
  });

  it("recognises payloads emitted by representative SDK state-changing verbs", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const {
      closeAgent,
      insertAgent,
      resetCommandResolverForTests,
      setCommandResolverForTests,
      spawnAgent,
    } = await import("../src/agents.js");
    const { openDb } = await import("../src/db.js");
    const { KNOWN_INTENTS, KNOWN_VERBS, renderOp } = await import("../src/log-render.js");
    const { listLogs } = await import("../src/logs.js");
    const {
      addBlockEdge,
      addNote,
      addTask,
      closeTask,
      deleteTask,
      removeBlockEdge,
      openTask,
      reparentTask,
    } = await import("../src/tasks.js");
    const { claimTask, releaseTask } = await import("../src/tasks/claim.js");
    const { resetTmuxExecutor, setTmuxExecutor } = await import("../src/tmux.js");
    const { ensureWorkstream } = await import("../src/workstream.js");
    const { freshMockState, mockTmux } = await import("./_verbs-mock.js");

    const tempDir = mkdtempSync(join(tmpdir(), "mu-state-render-events-"));
    const db = openDb({ path: join(tempDir, "mu.db") });
    const { waitForEvents } = await import("../src/wait.js");
    const { ctlAgentHooks } = await import("../src/wait-ctl.js");
    const originalStateDir = process.env.MU_STATE_DIR;
    const originalSpawnLiveness = process.env.MU_SPAWN_LIVENESS_MS;
    process.env.MU_STATE_DIR = join(tempDir, "state");
    process.env.MU_SPAWN_LIVENESS_MS = "0";

    const captured = new Map<string, string>();
    const captureNewEvents = (fn: () => unknown | Promise<unknown>): Promise<void> =>
      Promise.resolve().then(() => {
        // Only hand-written emitEvent survivors are prose. Captured ops
        // carry JSON payloads and a typed intent, and are classified by
        // intent (v2-log-verb), never by prefix — so scope this audit to
        // the entities emitEvent still writes.
        const localEntities = ["agent", "workstream"];
        const isLocalEmit = (r: {
          kind: string;
          intent: string | null;
          payload: string;
        }): boolean =>
          r.intent !== null && localEntities.includes(r.kind) && !r.payload.startsWith("{");
        const rows = listLogs(db, {}).filter(isLocalEmit);
        const highWater = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.seq));
        return Promise.resolve(fn()).then(() => {
          for (const event of listLogs(db, { since: highWater })) {
            if (!isLocalEmit(event)) continue;
            const rendered = renderOp(event);
            expect(rendered, `op should render: ${event.intent} ${event.payload}`).not.toBeNull();
            // Every emitted intent must be one the formatter knows, or
            // mu log would fall back to the unknown-intent shape.
            expect(KNOWN_INTENTS, `${event.intent} must be known`).toContain(event.intent);
            if (rendered) captured.set(rendered.verb, event.payload);
          }
        });
      });

    try {
      setCommandResolverForTests(async (command) => ({
        ok: true,
        binary: command,
        resolvedPath: command,
      }));
      await captureNewEvents(() => ensureWorkstream(db, "events"));
      await captureNewEvents(() => ensureWorkstream(db, "agents"));
      const tmuxState = freshMockState();
      const { executor } = mockTmux(tmuxState);
      setTmuxExecutor(executor);
      await captureNewEvents(() => spawnAgent(db, { name: "worker-1", workstream: "agents" }));
      await captureNewEvents(() => closeAgent(db, "worker-1", { workstream: "agents" }));
      resetTmuxExecutor();

      await captureNewEvents(() =>
        addTask(db, {
          localId: "base",
          workstream: "events",
          title: "Base",
          impact: 50,
          effortDays: 1,
        }),
      );
      addTask(db, {
        localId: "blocked",
        workstream: "events",
        title: "Blocked",
        impact: 40,
        effortDays: 1,
      });
      await captureNewEvents(() => addNote(db, "base", "note", { workstream: "events" }));
      await captureNewEvents(() => addBlockEdge(db, "events", "blocked", "base"));
      await captureNewEvents(() => reparentTask(db, "blocked", [], { workstream: "events" }));
      await captureNewEvents(() => addBlockEdge(db, "events", "blocked", "base"));
      await captureNewEvents(() => removeBlockEdge(db, "events", "blocked", "base"));
      await captureNewEvents(() =>
        claimTask(db, "base", { self: true, actor: "tester", workstream: "events" }),
      );
      await captureNewEvents(() => releaseTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() => openTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() =>
        closeTask(db, "base", { workstream: "events", evidence: "test" }),
      );
      await captureNewEvents(() => openTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() =>
        deleteTask(db, "blocked", "events", {
          dryRun: false,
        }),
      );

      addTask(db, {
        localId: "stalled",
        workstream: "events",
        title: "Stalled",
        impact: 30,
        effortDays: 1,
      });
      insertAgent(db, {
        name: "idle-1",
        workstream: "events",
        paneId: "%16",
      });
      await claimTask(db, "stalled", {
        agentName: "idle-1",
        workstream: "events",
        evidence: "stall fixture",
      });
      db.prepare("UPDATE agents SET updated_at = ? WHERE name = ?").run(
        "2000-01-01T00:00:00.000Z",
        "idle-1",
      );
      await captureNewEvents(() =>
        waitForEvents(db, [{ kind: "task", workstream: "events", id: "stalled" }], {
          callers: [],
          sync: false,
          onStall: "warn",
          timeoutMs: 1,
          stuckAfterMs: 1,
          ...ctlAgentHooks(db),
        }),
      );

      ensureWorkstream(db, "doomed");
      await captureNewEvents(async () => {
        setTmuxExecutor(async (args) => {
          // A missing session, as real tmux reports it to any session probe.
          if (args[0] === "has-session" || args[0] === "list-panes")
            return { stdout: "", stderr: "can't find session: doomed", exitCode: 1 };
          return { stdout: "", stderr: "unexpected tmux call", exitCode: 1 };
        });
        await softTeardown(db, "doomed");
      });
      resetTmuxExecutor();

      // v2-retire-log-shim: the 11 task.* / workstream.init /
      // workstream.teardown prose emits are GONE — each duplicated a
      // capture-trigger op that already had a real intent and key. What
      // survives is exactly the set no trigger can see: `agents`
      // is machine-local, and `agent stalled` mutates nothing.
      const expected = ["agent close", "agent spawn"];
      expect([...captured.keys()].sort()).toEqual(expected.sort());
      // Every verb the session produced must be one the formatter
      // declares, so a new emitter cannot be added without teaching the
      // formatter about it (v2-log-verb replaced the prefix list with
      // the intent-keyed verb table).
      const knownVerbs = new Set(KNOWN_VERBS);
      for (const verb of captured.keys()) {
        expect(knownVerbs, `${verb} must be a declared verb`).toContain(verb);
      }
    } finally {
      resetCommandResolverForTests();
      resetTmuxExecutor();
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
      if (originalStateDir === undefined) {
        const key = "MU_STATE_DIR";
        delete process.env[key];
      } else {
        process.env.MU_STATE_DIR = originalStateDir;
      }
      if (originalSpawnLiveness === undefined) {
        const key = "MU_SPAWN_LIVENESS_MS";
        delete process.env[key];
      } else {
        process.env.MU_SPAWN_LIVENESS_MS = originalSpawnLiveness;
      }
    }
  });
});
