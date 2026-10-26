// Dispatch-time Next: hints: a new task to a pi agent is sent --fresh;
// steering stays a plain send; a send queued on a busy pi names --interrupt.
// A real unix-socket server stands in for the mu pi extension; the mux
// is the fake tmux harness.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { dispatchHint, nextDispatchHint, waitHint } from "../src/cli/dispatch-hints.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withHello } from "./_ctl-ext.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

type Step = { intent: string; command: string };

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];

beforeEach(() => {
  // Short prefix: the socket path must fit macOS's 104-byte sun_path.
  dir = mkdtempSync(join(tmpdir(), "mdh-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  servers = [];
  setSleepForTests(async () => {});
  mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
});

afterEach(async () => {
  mux.restore();
  resetSleep();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Stand-in extension: status answers `state`/`runs`; send answers ok. */
async function serve(agent: string, state: "busy" | "idle", runs: number): Promise<void> {
  const path = ctlSocketPath("auth", agent, dir);
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string };
        sock.end(encode(withHello(req, { v: 1, ok: true, state, since: 1, runs, pending: false })));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

const pi = { name: "worker-1", cli: "pi", workstreamName: "auth" };
const claude = { name: "worker-2", cli: "claude", workstreamName: "auth" };

describe("dispatchHint", () => {
  it("pi: --fresh; non-pi and plain: today's plain send", () => {
    expect(dispatchHint(pi)).toEqual({
      intent: "Send the first task (fresh session + prompt in one step)",
      command: "mu agent send worker-1 --fresh '...' -w auth",
    });
    expect(dispatchHint(claude)).toEqual({
      intent: "Send work",
      command: "mu agent send worker-2 '...' -w auth",
    });
  });

  it("with a task: the prompt names the task and its notes", () => {
    expect(dispatchHint(pi, { task: { id: "t1", workstream: "auth" } }).command).toBe(
      "mu agent send worker-1 --fresh 'Claim done: work on t1. Read: mu task notes t1 -w auth' -w auth",
    );
  });

  it("the next-dispatch hint is pi-only", () => {
    expect(nextDispatchHint(pi, "auth")?.command).toContain(
      "mu task claim <id> --for worker-1 -w auth && mu agent send worker-1 --fresh",
    );
    expect(nextDispatchHint(claude, "auth")).toBeNull();
  });
});

describe("mu task claim --for", () => {
  function seedTask(id: string): void {
    addTask(db, { localId: id, workstream: "auth", title: id, impact: 50, effortDays: 1 });
  }

  it("pi owner: first next step is the --fresh send of the task (also in --json)", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
    seedTask("t1");
    const r = await runCliJson(
      ["task", "claim", "t1", "--for", "worker-1", "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    const steps = (r.data as { nextSteps: Step[] }).nextSteps;
    expect(steps[0]).toEqual({
      intent: "Send the task to worker-1 (fresh session + prompt in one step)",
      command:
        "mu agent send worker-1 --fresh 'Claim done: work on t1. Read: mu task notes t1 -w auth' -w auth",
    });
  });

  it("non-pi owner: plain send of the task", async () => {
    insertAgent(db, { name: "worker-2", workstream: "auth", paneId: "%2", cli: "claude" });
    seedTask("t2");
    const r = await runCliJson(
      ["task", "claim", "t2", "--for", "worker-2", "-w", "auth", "--json"],
      dbPath,
    );
    const steps = (r.data as { nextSteps: Step[] }).nextSteps;
    expect(steps[0]?.command).toBe(
      "mu agent send worker-2 'Claim done: work on t2. Read: mu task notes t2 -w auth' -w auth",
    );
  });

  it("--self: no send hint", async () => {
    seedTask("t3");
    const r = await runCliJson(["task", "claim", "t3", "--self", "-w", "auth", "--json"], dbPath);
    const steps = (r.data as { nextSteps: Step[] }).nextSteps;
    expect(steps.some((s) => s.command.startsWith("mu agent send"))).toBe(false);
  });
});

describe("mu agent send hints: exactly ONE, the wait", () => {
  function seed(): void {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
  }
  const WAIT = (runs: number) => `mu wait 'agent:auth/worker-1@${runs}#inc-test-1'`;

  // Every state a send can meet (idle after a run, busy, first run) and every
  // mode: the hint list is the wait and nothing else, text and JSON.
  it.each([
    ["plain, idle after a settled run", [], "idle", 3],
    ["plain, busy", [], "busy", 3],
    ["plain, idle on its first run", [], "idle", 0],
    ["--steer, idle", ["--steer"], "idle", 3],
    ["--steer, busy", ["--steer"], "busy", 3],
    ["--fresh", ["--fresh"], "idle", 3],
  ] as const)("%s: JSON nextSteps is exactly the one wait hint", async (_n, flags, state, runs) => {
    seed();
    await serve("worker-1", state, runs);
    const r = await runCliJson(
      ["agent", "send", "worker-1", "go", ...flags, "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    const body = r.data as { nextSteps: Step[]; msgId: string };
    expect(body.nextSteps).toEqual([
      {
        intent: `Wait for the response to ${body.msgId} (returns its final text)`,
        command: WAIT(runs),
      },
    ]);
  });

  it("text output ends with exactly one hint: Next: plus the wait line, nothing after", async () => {
    seed();
    await serve("worker-1", "busy", 3);
    const r = await runCli(["agent", "send", "worker-1", "go", "-w", "auth"], dbPath);
    expect(r.exitCode).toBeNull();
    const lines = stripVTControlCharacters(r.stdout).trimEnd().split("\n");
    const i = lines.indexOf("Next:");
    expect(i).toBeGreaterThan(0);
    expect(lines.slice(i + 1)).toHaveLength(1);
    expect(lines[lines.length - 1]).toMatch(/ : mu wait 'agent:auth\/worker-1@3#inc-test-1'$/);
    expect(r.stdout).not.toContain("--interrupt");
    expect(r.stdout).not.toContain("--fresh");
    expect(r.stdout).not.toContain("mu log");
  });
});

// ─── the wait hint after a send (README: reference hint) ─────────────────

/** Words of `line` as a POSIX shell parses them (via `sh`, printing each argv word). */
function shWords(line: string): string[] {
  const out = execFileSync("sh", ["-c", `printf '%s\\0' ${line}`], { encoding: "utf8" });
  return out.split("\0").slice(0, -1);
}

describe("waitHint: executable as printed", () => {
  it("is ONE quoted typed ref: mu wait 'agent:<ws>/<name>@<runs>#<inc>'", () => {
    expect(waitHint({ name: "worker-1", workstreamName: "auth" }, 4, "7f0a-1").command).toBe(
      "mu wait 'agent:auth/worker-1@4#7f0a-1'",
    );
  });

  it("without an incarnation (an older extension) the # part is omitted, not blank", () => {
    expect(waitHint({ name: "w", workstreamName: "auth" }, 0).command).toBe(
      "mu wait agent:auth/w@0",
    );
  });

  it.each([
    ["plain", "worker-1", "auth", "3c1f9e0a-aaaa-4bbb-8ccc-0123456789ab"],
    ["an id that needs quoting", "worker-1", "auth", "inc with space; rm -rf /"],
    ["an apostrophe in the id", "worker-1", "auth", "it's"],
    ["a shell-hostile workstream", "w", "a b$c", "i"],
    ["a shell-hostile agent name", "a b;c", "auth", "i"],
  ])(
    "%s: the shell parses it into exactly the intended words (sh, not a regex)",
    (_n, name, ws, inc) => {
      const cmd = waitHint({ name, workstreamName: ws }, 12, inc).command;
      expect(cmd).not.toMatch(/<|\.\.\./);
      expect(shWords(cmd)).toEqual(["mu", "wait", `agent:${ws}/${name}@12#${inc}`]);
      // and `sh -n` agrees it is well formed
      execFileSync("sh", ["-n", "-c", cmd]);
    },
  );

  it("every send path prints it: plain, --fresh, --interrupt (CLI, real hint text)", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
    await serve("worker-1", "idle", 4);
    for (const flags of [[], ["--fresh"], ["--interrupt"]]) {
      const r = await runCliJson(
        ["agent", "send", "worker-1", ...flags, "go", "-w", "auth", "--json"],
        dbPath,
      );
      expect(r.exitCode, flags.join(" ")).toBeNull();
      const steps = (r.data as { nextSteps: Step[] }).nextSteps;
      const wait = steps.find((s) => s.command.startsWith("mu wait"));
      expect(wait?.command, flags.join(" ")).toMatch(/^mu wait 'agent:auth\/worker-1@\d+#\S+'$/);
      expect(shWords(wait?.command ?? "")[0]).toBe("mu");
    }
  });
});
