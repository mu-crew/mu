// The one-document rule, walked over EVERY registered verb (the commander
// tree, not a hand-kept list): under `--json`, in leaf position
// (`mu task list --json`) AND root position (`mu --json task list`), stdout is
// exactly one JSON document and stderr is empty, success or failure.
//
// The sole documented exception is the NDJSON stream `mu log --tail`.
// Warning and error paths are pinned below the walk: warnings ride in the
// document, never on stderr.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCommandResolverForTests, setCommandResolverForTests } from "../src/agents.js";
import { buildProgram } from "../src/cli.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliWire } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

/** Leaf verbs and their argv (without --json). `-w probe` is appended when the
 *  verb takes a workstream. A verb missing here fails the coverage test. */
const ARGS: Record<string, string[]> = {
  "workstream init": ["fresh-ws"],
  "workstream list": [],
  "workstream teardown": ["probe"],
  "agent spawn": ["worker-2"],
  "agent send": ["worker-1", "hello"],
  "agent check": ["worker-1", "msg-1"],
  "agent read": ["worker-1"],
  "agent list": [],
  "agent show": ["worker-1"],
  "agent close": ["worker-1"],
  "agent collect": ["worker-1"],
  "agent abort": ["worker-1"],
  "agent wait": ["worker-1", "--timeout", "0.05"],
  "me tasks": [],
  "me next": [],
  "task add": ["t2", "-t", "Two", "-i", "50", "-e", "1"],
  "task list": [],
  "task next": [],
  "task owned-by": ["worker-1"],
  "task note": ["t1", "a note"],
  "task show": ["t1"],
  "task tree": ["t1"],
  "task notes": ["t1"],
  "task close": ["t1"],
  "task open": ["t1"],
  "task park": ["t1"],
  "task accept": ["t1"],
  "task auto": ["t1", "--off"],
  "task unpark": ["t1"],
  "task release": ["t1"],
  "task claim": ["t1", "--self"],
  "task block": ["t1", "--by", "t2"],
  "task unblock": ["t1", "--by", "t2"],
  "task delete": ["t1"],
  "task update": ["t1", "-t", "Renamed"],
  "task reparent": ["t1", "--parent", "t2"],
  "task wait": ["t1", "--timeout", "0.05"],
  wait: ["task:probe/t1", "--timeout", "0.05"],
  log: ["a log line"],
  state: [],
  sql: ["SELECT 1 AS one"],
  sync: [],
  rebuild: ["REBUILD_TARGET"],
  "db backup": ["BACKUP_TARGET"],
  "db compact": [],
  "db forget": ["probe"],
  "db query": ["SELECT 1 AS one"],
  doctor: [],
  "host add": [
    "dev",
    "--shell",
    "sh -c {cmd}",
    "--exec",
    "sh -c {cmd}",
    "--fetch",
    "true",
    "--repo",
    "/r",
  ],
  "host list": [],
  "host show": ["dev"],
  "host rm": ["dev"],
  "host init": ["dev", "--ssh"],
  "host check": ["dev"],
  "human-needed": ["needs a decision"],
  next: ["--dry", "--workers", "2"],
  "pi migrate": [],
  "delegates list": ["--all"],
  "delegates show": ["pi:x:1"],
  "delegates tally": ["--wave", "w"],
  "delegates register": ["pi:x:2", "--caller", "pi:x", "--text", "t"],
  "delegates mark": ["pi:x:1", "running"],
  "delegates finish": [
    "pi:x:1",
    "--outcome",
    "done",
    "--author",
    "d",
    "--text",
    "VERDICT: CONFIRMED",
  ],
  "delegates run": ["pi:x:1"],
  "delegates reissue": ["pi:x:1"],
};

function leafVerbs(cmd: Command, parents: string[] = []): { path: string; cmd: Command }[] {
  return cmd.commands.flatMap((sub) => {
    const path = [...parents, sub.name()];
    return sub.commands.length === 0 ? [{ path: path.join(" "), cmd: sub }] : leafVerbs(sub, path);
  });
}

let dir: string;
let mux: MuxHarness;
let savedHome: string | undefined;

/** One document on stdout, nothing on stderr; returns the parsed document. */
function expectOneDocument(r: { stdout: string; stderr: string }, what: string) {
  expect(r.stderr, `${what}: stderr must be empty`).toBe("");
  const lines = r.stdout.trim().split("\n");
  expect(
    lines,
    `${what}: stdout must be exactly one line, got ${r.stdout.slice(0, 200)}`,
  ).toHaveLength(1);
  const doc = JSON.parse(lines[0] ?? "") as { ok: boolean; exit?: number; data?: unknown };
  expect(typeof doc.ok, `${what}: not an envelope`).toBe("boolean");
  return doc;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mu-wire-"));
  savedHome = process.env.MU_PI_HOME;
  process.env.MU_PI_HOME = join(dir, "home");
  mkdirSync(process.env.MU_PI_HOME, { recursive: true });
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  process.env.MU_SPAWN_CTL_MS = "50"; // no extension answers: ctl "missing"
});

afterAll(() => {
  resetSleep();
  resetCommandResolverForTests();
  for (const k of ["MU_SPAWN_LIVENESS_MS", "MU_SPAWN_CTL_MS"]) delete process.env[k];
  if (savedHome === undefined) delete process.env.MU_PI_HOME;
  else process.env.MU_PI_HOME = savedHome;
  rmFixtureDir(dir);
});

/** The seeded fixture is built ONCE through the CLI (a fresh `openDb` costs ~100 ms of DDL, and
 *  every case seeds, twice for the root-position pair); each case then gets a file copy of the
 *  checkpointed DB and a deep copy of the mock mux state. */
let templateDb = "";
let templateMux: MockState | undefined;

async function buildTemplate(): Promise<void> {
  templateDb = join(dir, "template.db");
  const state = freshMockState();
  const harness = installMux("tmux", mockTmux(state).executor);
  try {
    for (const argv of [
      ["workstream", "init", "probe"],
      ["agent", "spawn", "worker-1", "-w", "probe"],
      ["task", "add", "t1", "-t", "One", "-i", "50", "-e", "1", "-w", "probe"],
    ]) {
      const r = await runCliWire(argv, templateDb);
      expect(r.exitCode ?? 0, `seed ${argv.join(" ")}: ${r.stderr}`).toBe(0);
    }
  } finally {
    harness.restore();
  }
  process.exitCode = undefined;
  const db = new Database(templateDb);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  templateMux = state;
}

/** A fresh mux, DB and fixture per case: worker-1 (a live pane) owns no task, t1 is open. */
async function seed(): Promise<void> {
  if (templateMux === undefined) await buildTemplate();
  dbPath = join(dir, `case-${n++}.db`);
  copyFileSync(templateDb, dbPath);
  mux?.restore();
  mux = installMux("tmux", mockTmux(structuredClone(templateMux as MockState)).executor);
}

let n = 0;
let target = 0; // fresh output path per run: rebuild and backup never overwrite
let dbPath: string;
beforeEach(async () => {
  await seed();
});
afterEach(() => {
  mux.restore();
  process.exitCode = undefined; // `agent wait` / `task wait` set exit codes
  vi.restoreAllMocks();
});

describe("every verb: --json is one document on stdout, stderr empty", () => {
  const verbs = leafVerbs(buildProgram());

  it("the walk covers every registered leaf verb (a new verb needs a row in ARGS)", () => {
    expect(verbs.length).toBeGreaterThan(40);
    expect(verbs.map((v) => v.path).sort()).toEqual(Object.keys(ARGS).sort());
  });

  for (const { path, cmd } of verbs) {
    const takesWs = cmd.options.some((o) => o.long === "--workstream");
    const verbArgv = (): string[] => {
      const base = path.split(" ");
      const args = (ARGS[path] ?? []).map((a) =>
        a === "REBUILD_TARGET"
          ? join(dir, `rebuilt-${target++}.db`)
          : a === "BACKUP_TARGET"
            ? join(dir, `backup-${target++}.db`)
            : a,
      );
      return [...base, ...args, ...(takesWs ? ["-w", "probe"] : [])];
    };

    it(`mu ${path}: leaf position`, async () => {
      const r = await runCliWire([...verbArgv(), "--json"], dbPath);
      expect(r.error).toBeUndefined();
      const doc = expectOneDocument(r, `mu ${path} --json`);
      if (!doc.ok) expect(doc.exit).toBe(r.exitCode);
    });

    it(`mu ${path}: root position gives the same outcome`, async () => {
      const leaf = await runCliWire([...verbArgv(), "--json"], dbPath);
      const leafDoc = expectOneDocument(leaf, `mu ${path} --json`);
      await seed();
      const r = await runCliWire(["--json", ...verbArgv()], dbPath);
      expect(r.error).toBeUndefined();
      const doc = expectOneDocument(r, `mu --json ${path}`);
      expect(doc.ok).toBe(leafDoc.ok);
      expect(r.exitCode).toBe(leaf.exitCode);
    });
  }
});

describe("error and warning paths stay in the one document", () => {
  const run = async (argv: string[]) => {
    const r = await runCliWire(argv, dbPath);
    return { r, doc: expectOneDocument(r, argv.join(" ")) };
  };

  it("typed error, parse error, unknown verb", async () => {
    expect((await run(["task", "show", "ghost", "-w", "probe", "--json"])).doc).toMatchObject({
      ok: false,
      exit: 3,
    });
    expect((await run(["task", "list", "--bogus", "--json"])).doc).toMatchObject({
      ok: false,
      exit: 2,
    });
    expect((await run(["--json", "nonsense"])).doc).toMatchObject({ ok: false, exit: 2 });
  });

  it("a failure's message is one line: commander's did-you-mean is folded in (rr_r4_json_message_multiline)", async () => {
    const { doc } = await run(["task", "list", "--stauts", "OPEN", "-w", "probe", "--json"]);
    const msg = (doc as unknown as { message: string }).message;
    expect(msg).toBe("unknown option '--stauts' (Did you mean --status?)");
    expect(msg).not.toContain("\n");
  });

  it("--report help says what a second report does (rr_r4_report_set_once)", async () => {
    for (const verb of [
      ["task", "note"],
      ["task", "close"],
    ]) {
      const r = await runCliWire([...verb, "--help"], dbPath);
      expect(r.stdout.replace(/\s+/g, " ")).toMatch(
        /last report wins, earlier ones stay in `mu task notes <id> --all`/,
      );
      expect(r.stdout).not.toMatch(/set once/);
    }
  });

  it("agent close: the preview and the --if apply are each one document, stderr empty", async () => {
    const preview = await run(["agent", "close", "worker-1", "-w", "probe", "--json"]);
    expect(preview.doc.ok).toBe(true);
    const data = preview.doc.data as { revision: number; dryRun: boolean };
    expect(data.dryRun).toBe(true);
    expect(Number.isSafeInteger(data.revision)).toBe(true);
    const stale = await run([
      "agent",
      "close",
      "worker-1",
      "-w",
      "probe",
      "--if",
      String(data.revision + 1),
      "--json",
    ]);
    expect(stale.r.exitCode).toBe(4);
    expect(stale.doc).toMatchObject({ ok: false, exit: 4, current_rev: data.revision });
    const apply = await run([
      "agent",
      "close",
      "worker-1",
      "-w",
      "probe",
      "--if",
      String(data.revision),
      "--json",
    ]);
    expect(apply.doc).toMatchObject({ ok: true, data: { killedPane: true, deletedRow: true } });
  });

  it("spawn with a missing control socket: the warning rides in data.warnings", async () => {
    const { r, doc } = await run(["agent", "spawn", "worker-2", "-w", "probe", "--json"]);
    expect(r.exitCode ?? 0).toBe(0);
    expect(doc.ok).toBe(true);
    const warnings = (doc.data as { warnings?: string[] }).warnings ?? [];
    expect(warnings.join("\n")).toContain("no control socket");
  });

  it("spawn --send to an unreachable ctl: one failure document, spawn evidence and warnings in data", async () => {
    const { r, doc } = await run([
      "agent",
      "spawn",
      "worker-2",
      "-w",
      "probe",
      "--send",
      "hello",
      "--json",
    ]);
    expect(r.exitCode).toBe(1);
    expect(doc).toMatchObject({ ok: false, exit: 1 });
    expect((doc.data as { warnings?: string[] }).warnings?.join("\n")).toContain(
      "no control socket",
    );
  });

  it("whitespace-only notes: the warning rides in the document (task note, task add --note)", async () => {
    const note = await run(["task", "note", "t1", "   ", "-w", "probe", "--json"]);
    expect((note.doc.data as { warnings?: string[] }).warnings?.[0]).toMatch(/whitespace/);
    const add = await run([
      "task",
      "add",
      "t3",
      "-t",
      "Three",
      "--note",
      " ",
      "-w",
      "probe",
      "--json",
    ]);
    expect((add.doc.data as { warnings?: string[] }).warnings?.[0]).toMatch(/whitespace/);
  });

  it("agent wait on an unknown state: stderr stays empty and the exit is unchanged (5)", async () => {
    const { r, doc } = await run([
      "agent",
      "wait",
      "worker-1",
      "-w",
      "probe",
      "--timeout",
      "0.05",
      "--json",
    ]);
    expect(doc.ok).toBe(true);
    expect(process.exitCode).toBe(5);
    expect(r.stderr).toBe("");
  });

  it("log write: one envelope carrying the row; --tail stays the documented NDJSON stream", async () => {
    const w = await run(["log", "hello", "-w", "probe", "--json"]);
    expect(w.doc.ok).toBe(true);
    expect(w.doc.data).toMatchObject({
      seq: expect.any(Number),
      entity: "message",
      payload: "hello",
    });
  });
});
