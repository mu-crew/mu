// `mu hook stop` through a fake hook harness (integration tier: the built
// dist/cli.js; spec D7, U10). A real Claude Code orchestrator is the live
// check; here a node binary named `claude` plays it. It is started through
// mu's own anchor wrapper (src/anchors.ts), so its pid carries an anchor in a
// temp HOME exactly as a mu pane's harness does, and it runs the hook entry the
// way a harness runs one: `sh -c '<entry>'` with the Stop payload on stdin,
// reading the block answer from stdout. A `murmur` on PATH records the
// `continued` events and answers `murmur pane` from a file. The consuming wait
// is the real `mu wait --as`.
//
// Needs dist/ (npm run build). DB-only: no mux opens.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type AnchorRecord, anchorWrapper } from "../src/anchors.js";
import { type Db, openDb } from "../src/db.js";
import { shellQuote } from "../src/shell-quote.js";
import { claimTask } from "../src/tasks/claim.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { addTask, getTask, listNotes } from "../src/tasks.js";
import { closeSettledRun } from "../src/wait-db.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { ensureWorkstream } from "../src/workstream.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const built = existsSync(CLI);

const FAKE_HARNESS = `import { execFileSync } from "node:child_process";
const cmd = process.argv[2] === "nest" ? process.env.FAKE_NEST_CMD : process.env.FAKE_HOOK_CMD;
const input = process.argv[2] === "nest" ? "" : process.env.FAKE_PAYLOAD;
process.stdout.write(execFileSync("/bin/sh", ["-c", cmd], { input, encoding: "utf8" }));
`;
const FAKE_MURMUR = `#!/bin/sh
if [ "$1" = pane ]; then
  [ -n "$MURMUR_PANE_JSON" ] || exit 1
  cat "$MURMUR_PANE_JSON"
  exit 0
fi
printf '%s|' "$*" >> "$MURMUR_LOG"
cat >> "$MURMUR_LOG"
printf '\\n' >> "$MURMUR_LOG"
`;

let dir: string;
let home: string;
let bin: string;
let script: string;
let dbPath: string;
let db: Db;
const kids: ChildProcess[] = [];

const ORCH: AnchorRecord = {
  agent_name: "orch",
  workstream: "auth",
  role: "orchestrator",
  cli: "claude",
  orchestrator: true,
  remote_key: null,
};
const WORKER: AnchorRecord = { ...ORCH, agent_name: "w1", role: "worker", orchestrator: false };

/** The env every process here gets: no inherited mu, tmux or agent identity. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) {
    if (
      k.startsWith("MU_") ||
      k.startsWith("CLAUDE") ||
      k.startsWith("CODEX_") ||
      k.startsWith("CURSOR_") ||
      k.startsWith("MUSE_") ||
      k.startsWith("XDG_") ||
      ["PI_SESSION_ID", "TMUX", "TMUX_PANE"].includes(k)
    )
      delete e[k];
  }
  return {
    ...e,
    HOME: home,
    SHELL: "/bin/sh",
    PATH: `${bin}:${e.PATH ?? "/usr/bin:/bin"}`,
    MU_DB_PATH: dbPath,
    MU_STATE_DIR: dir,
    MU_SYNC_DIR: "",
    MURMUR_LOG: join(dir, "murmur.log"),
    ...extra,
  };
}

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { child: ChildProcess; done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

/** The managed env mu gives a pane (spawn's paneEnv), for `anchor`'s agent. */
function paneEnv(a: {
  agent_name: string;
  cli: string;
  orchestrator: boolean;
}): Record<string, string> {
  return {
    MU_MANAGED_AGENT: "1",
    MU_AGENT_NAME: a.agent_name,
    MU_WORKSTREAM: "auth",
    MU_AGENT_CLI: a.cli,
    ...(a.orchestrator ? { MU_ORCHESTRATOR: "1" } : {}),
  };
}

/** The hook entry as `mu init` would write it, with a short timeout: the wait gets 1 s. */
const HOOK_CMD = () =>
  `${shellQuote(process.execPath)} ${shellQuote(CLI)} hook stop claude --timeout 11`;

/**
 * One Stop of a fake claude anchored as `anchor` (null: no anchor): the harness
 * runs the hook entry with `payload` and prints its stdout.
 */
async function fireStop(
  anchor: AnchorRecord | null,
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cmd = `${shellQuote(join(bin, "claude"))} ${shellQuote(script)} hook`;
  const line = anchor === null ? cmd : anchorWrapper(cmd, anchor, [anchorsDir()]);
  const env = baseEnv({
    TMUX_PANE: "%42",
    FAKE_HOOK_CMD: HOOK_CMD(),
    FAKE_PAYLOAD: JSON.stringify({ hook_event_name: "Stop", ...payload }),
    ...(anchor === null ? {} : paneEnv(anchor)),
    ...extra,
  });
  return run("/bin/sh", ["-c", line], env).done;
}

const anchorsDir = () => join(home, ".local", "state", "mu-next", "anchors");

/** The block answer on the hook's stdout, or null when it let the turn end. */
function blockOf(stdout: string): { decision: string; reason: string } | null {
  const t = stdout.trim();
  return t === "" ? null : (JSON.parse(t) as { decision: string; reason: string });
}

/** The wait result a block's reason carries (its last line). */
function resultIn(reason: string): { firing?: { kind?: string; ref?: string } } {
  return JSON.parse(reason.trim().split("\n").at(-1) ?? "{}") as {
    firing?: { kind?: string; ref?: string };
  };
}

/** The `continued` events the fake murmur recorded, as `<args>|<stdin>` lines. */
function murmurLines(): string[] {
  try {
    return readFileSync(join(dir, "murmur.log"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
  } catch {
    return [];
  }
}

function marks(caller: string): string[] {
  const hash = createHash("sha256").update(caller).digest("hex").slice(0, 16);
  try {
    return readdirSync(join(dir, "waiters", hash));
  } catch {
    return [];
  }
}

const until = async (cond: () => boolean, tries = 100): Promise<void> => {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
};

const close = (id: string) => closeTask(db, id, { workstream: "auth", evidence: "test" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-hook-stop-int-"));
  home = join(dir, "home");
  bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // node under the harnesses' names: the hook's walk matches argv, never the binary.
  symlinkSync(process.execPath, join(bin, "claude"));
  symlinkSync(process.execPath, join(bin, "pi"));
  writeFileSync(join(bin, "murmur"), FAKE_MURMUR);
  chmodSync(join(bin, "murmur"), 0o755);
  script = join(dir, "fake-harness.mjs");
  writeFileSync(script, FAKE_HARNESS);
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  for (const id of ["t1", "t2"]) {
    addTask(db, { localId: id, workstream: "auth", title: id, impact: 50, effortDays: 1 });
  }
});
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  try {
    db.close();
  } catch {}
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe.skipIf(!built)("mu hook stop under a fake claude", () => {
  it("an orchestrator keeps driving through two events and is handed each once", async () => {
    registerOwnedWait(db, "auth/orch", [
      { kind: "task", workstream: "auth", id: "t1" },
      { kind: "task", workstream: "auth", id: "t2" },
    ]);
    close("t1");
    const first = await fireStop(ORCH, { session_id: "s1", stop_hook_active: false });
    expect(first.code, first.stderr).toBe(0);
    const b1 = blockOf(first.stdout);
    expect(b1?.decision).toBe("block");
    expect(resultIn(b1?.reason ?? "").firing).toMatchObject({
      kind: "closed",
      ref: "task:auth/t1",
    });

    close("t2");
    const second = blockOf(
      (await fireStop(ORCH, { session_id: "s1", stop_hook_active: true })).stdout,
    );
    expect(resultIn(second?.reason ?? "").firing).toMatchObject({ ref: "task:auth/t2" });

    // Both delivered: nothing is owed, so the turn ends.
    const third = await fireStop(ORCH, { session_id: "s1", stop_hook_active: true });
    expect(third.code).toBe(0);
    expect(third.stdout.trim()).toBe("");
    // Each block recorded `continued` for the pane; the allow recorded nothing.
    const lines = murmurLines();
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain("hook mu --pane %42|");
      expect(JSON.parse(l.slice(l.indexOf("|") + 1))).toEqual({
        event: "continued",
        session_id: "s1",
      });
    }
  });

  it("allows the stop while a background mu wait holds the caller, and consumes nothing", async () => {
    registerOwnedWait(db, "auth/orch", [{ kind: "task", workstream: "auth", id: "t1" }]);
    const bg = run(
      process.execPath,
      [CLI, "wait", "--as", "auth/orch", "--timeout", "30", "--json"],
      baseEnv(),
    );
    await until(() => marks("auth/orch").length > 0);
    expect(marks("auth/orch")).toHaveLength(1);
    const r = await fireStop(ORCH, { session_id: "s1", stop_hook_active: false });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(murmurLines()).toEqual([]);
    // The background wait still gets the event.
    close("t1");
    const out = await bg.done;
    const doc = JSON.parse(out.stdout) as { data: { firing: { ref: string } } };
    expect(doc.data.firing.ref).toBe("task:auth/t1");
  });

  it("stops after the cap of consecutive empty blocks", async () => {
    registerOwnedWait(db, "auth/orch", [{ kind: "task", workstream: "auth", id: "t1" }]);
    const cap = { MU_KEEP_DRIVING_MAX: "2" };
    const b1 = blockOf(
      (await fireStop(ORCH, { session_id: "s1", stop_hook_active: false }, cap)).stdout,
    );
    expect(b1?.reason).toContain("Workers are still running");
    expect(b1?.reason).toContain("1 of 2");
    const b2 = blockOf(
      (await fireStop(ORCH, { session_id: "s1", stop_hook_active: true }, cap)).stdout,
    );
    expect(b2?.reason).toContain("2 of 2");
    const r3 = await fireStop(ORCH, { session_id: "s1", stop_hook_active: true }, cap);
    expect(r3.stdout.trim()).toBe("");
    expect(murmurLines()).toHaveLength(2);
    // A turn the user starts resets the count.
    const b4 = blockOf(
      (await fireStop(ORCH, { session_id: "s1", stop_hook_active: false }, cap)).stdout,
    );
    expect(b4?.reason).toContain("1 of 2");
  });

  it("allows the stop when nothing is owed", async () => {
    const r = await fireStop(ORCH, { session_id: "s1", stop_hook_active: false });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(murmurLines()).toEqual([]);
  });

  it("a worker that owns an IN_PROGRESS task gets one close nudge per session", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%41", cli: "claude" });
    await claimTask(db, "t1", { workstream: "auth", agentName: "w1" });
    const r1 = await fireStop(WORKER, { session_id: "w-s1", stop_hook_active: false });
    const b = blockOf(r1.stdout);
    expect(b?.decision, r1.stderr).toBe("block");
    expect(b?.reason).toContain("mu task close t1 -w auth");
    const r2 = await fireStop(WORKER, { session_id: "w-s1", stop_hook_active: false });
    expect(r2.stdout.trim()).toBe("");
    const lines = murmurLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--pane %41|");
  });

  it("a worker whose turn ends with a CLOSE block: the Stop closes its task with the report, and a later wait applies nothing", async () => {
    const row = insertAgent(db, {
      name: "w1",
      workstream: "auth",
      paneId: "%41",
      cli: "claude",
      channel: "hooks",
    });
    await claimTask(db, "t1", { workstream: "auth", agentName: "w1" });
    // murmur's view of %41 mid-Stop: session w-s1, the turn's prompt was run 2.
    const paneJson = join(dir, "pane.json");
    writeFileSync(
      paneJson,
      JSON.stringify({
        state: "working",
        agent: { activity: "running", session_id: "w-s1", run_count: 2, updated_at: 1 },
        attention: [],
      }),
    );
    const report =
      'Done.\n\nCLOSE: task=t1 evidence="gate.sh exit 0"\nREPORT:\nFILES: a.ts\nall green\n';
    const r = await fireStop(
      WORKER,
      { session_id: "w-s1", stop_hook_active: false, last_assistant_message: report },
      { MURMUR_PANE_JSON: paneJson },
    );
    expect(r.code, r.stderr).toBe(0);
    // Let go: no block, so the report stays the turn's last text; no `continued`.
    expect(r.stdout.trim()).toBe("");
    expect(murmurLines()).toEqual([]);
    expect(getTask(db, "t1", "auth")?.status).toBe("CLOSED");
    expect(listNotes(db, "t1", "auth").map((n) => ({ kind: n.kind, content: n.content }))).toEqual([
      { kind: "report", content: "FILES: a.ts\nall green\n" },
      { kind: "close", content: "CLOSE: gate.sh exit 0" },
    ]);
    const closeOps = () =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM ops WHERE entity = 'task' AND intent = 'close.apply'")
          .get() as { n: number }
      ).n;
    expect(closeOps()).toBe(1);
    // A wait's settle of that same turn (session, settled runs, text) reads it already applied ...
    const settle = closeSettledRun(
      db,
      { kind: "agent", workstream: "auth", id: "w1" },
      {
        status: "needs_input",
        settled: true,
        incarnation: "w-s1",
        runs: 2,
        lastText: report,
        agentId: row.incarnation,
      },
      true,
    );
    expect(settle).toEqual({
      applied: false,
      task: "t1",
      reason: "already applied",
      replayedClose: true,
    });
    expect(closeOps()).toBe(1);
    // ... and the orchestrator's wait sees the task closed.
    const w = await run(
      process.execPath,
      [CLI, "wait", "task:auth/t1", "--timeout", "5", "--json"],
      baseEnv(),
    ).done;
    expect(w.code, w.stderr).toBe(0);
    expect(JSON.parse(w.stdout)).toMatchObject({
      data: { firing: { kind: "closed", ref: "task:auth/t1" } },
    });
    expect(closeOps()).toBe(1);
    expect(listNotes(db, "t1", "auth")).toHaveLength(2);
  });

  it("a claude -p run by a managed pi orchestrator, or by the claude one, consumes nothing", async () => {
    registerOwnedWait(db, "auth/orch", [{ kind: "task", workstream: "auth", id: "t1" }]);
    close("t1");
    // `claude -p`, exec'd in place by the parent's shell: no shell between the two harnesses.
    const nested = `${shellQuote(join(bin, "claude"))} ${shellQuote(script)} hook -p`;
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "p1",
      stop_hook_active: false,
    });
    // A pi pane is never anchored; it carries the orchestrator's managed env, which claude -p inherits.
    const underPi = run(
      join(bin, "pi"),
      [script, "nest"],
      baseEnv({
        ...paneEnv({ agent_name: "orch", cli: "pi", orchestrator: true }),
        TMUX_PANE: "%42",
        FAKE_NEST_CMD: nested,
        FAKE_HOOK_CMD: HOOK_CMD(),
        FAKE_PAYLOAD: payload,
      }),
    );
    const p = await underPi.done;
    expect(p.code, p.stderr).toBe(0);
    expect(p.stdout.trim()).toBe("");
    // An anchored claude orchestrator's own claude -p.
    const outer = `${shellQuote(join(bin, "claude"))} ${shellQuote(script)} nest`;
    const underClaude = run(
      "/bin/sh",
      ["-c", anchorWrapper(outer, ORCH, [anchorsDir()])],
      baseEnv({
        ...paneEnv(ORCH),
        TMUX_PANE: "%42",
        FAKE_NEST_CMD: nested,
        FAKE_HOOK_CMD: HOOK_CMD(),
        FAKE_PAYLOAD: payload,
      }),
    );
    const c = await underClaude.done;
    expect(c.code, c.stderr).toBe(0);
    expect(c.stdout.trim()).toBe("");
    expect(murmurLines()).toEqual([]);
    // The event is still owed to the orchestrator.
    const w = await run(
      process.execPath,
      [CLI, "wait", "--as", "auth/orch", "--timeout", "5", "--json"],
      baseEnv(),
    ).done;
    expect((JSON.parse(w.stdout) as { data: { firing: { ref: string } } }).data.firing.ref).toBe(
      "task:auth/t1",
    );
  });
  it("a malformed entry still exits 0 with nothing on stdout, never a usage error", () => {
    // claude and codex read a Stop hook's exit 2 as a block that feeds stderr to the model.
    const payload = JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
    for (const args of [
      ["hook", "stop", "claude", "--timeout", "600s"],
      ["hook", "stop", "claude", "--bogus"],
      ["hook", "stop", "claude", "extra", "args"],
      ["hook", "stop"],
      ["hook", "nope"],
      ["hook", "stop", "claude", "--timeout"],
    ]) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        env: baseEnv(),
        input: payload,
        encoding: "utf8",
      });
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      expect(r.stdout, args.join(" ")).toBe("");
    }
  });

  it("a --timeout that is not seconds still keeps driving, on the default", async () => {
    registerOwnedWait(db, "auth/orch", [{ kind: "task", workstream: "auth", id: "t1" }]);
    close("t1");
    const r = await fireStop(
      ORCH,
      { session_id: "s1", stop_hook_active: false },
      { FAKE_HOOK_CMD: `${HOOK_CMD()}s --future-flag` },
    );
    expect(r.code, r.stderr).toBe(0);
    const b = blockOf(r.stdout);
    expect(b?.decision).toBe("block");
    expect(b?.reason).toContain("--timeout 590");
    expect(resultIn(b?.reason ?? "").firing).toMatchObject({ ref: "task:auth/t1" });
  });
});
