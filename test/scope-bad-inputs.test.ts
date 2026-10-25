// One table of bad scope values, fed to EVERY entry point that takes a
// workstream: CLI flags (scalar, root, list, positional), qualified refs
// (task, agent, `--for`), the injected env, the pi extension's delegate
// record, and the nudge's command parser. Each must refuse the same way:
// exit non-zero (CLI), nothing written, ONE stderr line (plus at most one
// `Next:` line), no help dump. A new entry point is one row in ENTRIES.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDelegate } from "../extension/delegate.js";
import { dispatchedWorkstreams } from "../extension/nudge.js";
import { insertAgent } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { fakeMu, fakePi, installDelegateEnv, tool } from "./_delegate-fixtures.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

const BAD = ["", " a", "a ", "a,, b", "a/ b", "a\nb"] as const;

/** A shell word for `value` (single-quoted). */
const sh = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

/** Prefix for a qualified ref: the bad value itself when it carries a '/'. */
const ref = (bad: string, name: string): string => (bad.includes("/") ? bad : `${bad}/${name}`);

/** CLI entry points: argv for one bad value, plus any env. */
const CLI_ENTRIES: [string, (bad: string) => string[], Record<string, string>?][] = [
  ["task list -w", (b) => ["task", "list", "-w", b]],
  ["root -w", (b) => ["-w", b, "task", "list"]],
  ["state -w", (b) => ["state", "-w", b]],
  ["log -w", (b) => ["log", "-w", b]],
  ["state --all -w", (b) => ["state", "--all", "-w", b]],
  ["log --all -w", (b) => ["log", "--all", "-w", b]],
  ["teardown positional", (b) => ["workstream", "teardown", b]],
  ["teardown positional + -w", (b) => ["workstream", "teardown", "own", "-w", b]],
  ["task show ref", (b) => ["task", "show", ref(b, "t-own")]],
  ["task show ref + -w", (b) => ["task", "show", "own/t-own", "-w", b]],
  ["task claim --for ref", (b) => ["task", "claim", "own/t-own", "--for", ref(b, "self-1")]],
  ["agent send ref", (b) => ["agent", "send", ref(b, "self-1"), "hi"]],
  [
    "injected MU_WORKSTREAM",
    () => ["task", "list"],
    { MU_MANAGED_AGENT: "1", MU_AGENT_NAME: "self-1" },
  ],
];

const ENV_KEYS = [
  "TMUX",
  "TMUX_PANE",
  "HERDR_ENV",
  "MU_SESSION",
  "MU_MANAGED_AGENT",
  "MU_AGENT_NAME",
  "MU_WORKSTREAM",
  "MU_MUX",
  "MU_STATE_DIR",
  "MU_SYNC_DIR",
] as const;

describe("bad scope values: CLI entry points refuse with one line", () => {
  let dir: string;
  let dbPath: string;
  let mux: MuxHarness;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "mu-scope-bad-"));
    dbPath = join(dir, "mu.db");
    process.env.MU_STATE_DIR = dir;
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "own");
    addTask(db, { localId: "t-own", workstream: "own", title: "own", impact: 10, effortDays: 1 });
    insertAgent(db, { name: "self-1", workstream: "own", paneId: "%7" });
    db.close();
    mux = installMux("tmux", [["", { stdout: "", stderr: "no server", exitCode: 1 }]]);
  });

  afterEach(() => {
    mux.restore();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmFixtureDir(dir);
  });

  for (const [entry, argv, env] of CLI_ENTRIES) {
    for (const bad of BAD) {
      it(`${entry} ${JSON.stringify(bad)}`, async () => {
        Object.assign(process.env, env ?? {});
        if (entry === "injected MU_WORKSTREAM") process.env.MU_WORKSTREAM = bad;
        const seeded = openDb({ path: dbPath });
        const before = listLogs(seeded, { limit: 100 }).length;
        seeded.close();
        const r = await runCli(argv(bad), dbPath);
        // `state` prints its failure as the JSON document on stdout (v_state_log); every other verb, one line on stderr.
        const isState = argv(bad).includes("state");
        const stderr = isState
          ? (JSON.parse(r.stdout) as { message: string }).message
          : plain(r.stderr).trim();
        const lines = stderr.split("\n");
        expect(r.exitCode, stderr).not.toBe(0);
        expect(r.exitCode, stderr).not.toBeNull();
        if (isState) expect(r.stderr).toBe("");
        else expect(r.stdout).toBe("");
        // One message line; an optional single `Next:` line may follow.
        const body = lines.filter((l) => !/^\s*(Next|→)/.test(l));
        expect(body, stderr).toHaveLength(1);
        expect(lines.length, stderr).toBeLessThanOrEqual(2);
        expect(stderr).not.toContain("Usage:");
        // Nothing written: the op log did not grow.
        const db = openDb({ path: dbPath });
        try {
          expect(listLogs(db, { limit: 100 })).toHaveLength(before);
        } finally {
          db.close();
        }
      });
    }
  }
});

describe("bad scope values: pi extension entry points refuse", () => {
  installDelegateEnv();

  const records: [string, (b: string) => { task: string; workstream?: string }][] = [
    ["record.workstream", (b) => ({ task: "t", workstream: b })],
    ["record.task prefix", (b) => ({ task: ref(b, "t") })],
  ];
  for (const [entry, record] of records) {
    for (const bad of BAD) {
      it(`delegate ${entry} ${JSON.stringify(bad)}`, async () => {
        const mu = fakeMu();
        const p = fakePi();
        registerDelegate(p.pi, mu.run);
        await expect(tool(p).execute("t", { task: "x", record: record(bad) })).rejects.toThrow(
          /Nothing spawned/,
        );
        expect(mu.calls).toHaveLength(0);
      });
    }
  }

  const env = { MU_MANAGED_AGENT: "1", MU_WORKSTREAM: "decoy" };
  const commands: [string, (b: string) => string][] = [
    ["root -w", (b) => `mu -w ${sh(b)} agent send w1 go`],
    ["verb -w", (b) => `mu agent send w1 go -w ${sh(b)}`],
    ["agent ref", (b) => `mu agent send ${sh(ref(b, "w1"))} go`],
    ["claim ref", (b) => `mu task claim ${sh(ref(b, "t1"))} --for w1`],
    ["claim --for ref", (b) => `mu task claim t1 -w own --for ${sh(ref(b, "w1"))}`],
    ["claim -f ref", (b) => `mu task claim t1 -w own -f${sh(ref(b, "w1"))}`],
    ["claim --for=ref", (b) => `mu task claim t1 -w own --for=${sh(ref(b, "w1"))}`],
  ];
  for (const [entry, command] of commands) {
    for (const bad of BAD) {
      it(`nudge ${entry} ${JSON.stringify(bad)} dispatches nothing`, () => {
        expect(dispatchedWorkstreams(command(bad), env), command(bad)).toBeUndefined();
      });
    }
  }
});
