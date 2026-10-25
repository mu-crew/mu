// No multiplexer at all: neither tmux nor herdr is on mu's PATH (the AUT's own shell keeps its tools).
// Setup seeds the workstream while tmux still works, then rewrites the sandbox `mu` shim so mu runs
// with a PATH that holds only node, git and sqlite3 and without MU_MUX/MU_TMUX_SOCKET: from then on
// mu sees what it sees on a machine with no multiplexer installed.
//
// Two halves, both judged from effects:
//  - the AUT does DAG work (note, close) with task/sql/sync verbs, which must keep working: n1 holds
//    the exact note, then is closed done, and nothing else was written;
//  - the scripted check (judge, independent of the AUT's words): `doctor` and every agent verb (plus
//    `workstream init` and `state`) refuse with exit 5 and ONE stderr line naming the install, and
//    task add/list/close, `sql`, `db query` and `sync` succeed (sync into a real scratch dir,
//    and a segment must land there). 3.x has no `db query`, `doctor` exits 0 with no refusal and the
//    other refusals run over several lines: that is carried as N/A baseline (lifecycle.native), never a pass.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateScript, makeRepo, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { native } from "../lifecycle.ts";
import { verdictFx } from "../observe.ts";
import { maxSeq, strayOps } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, isBefore, noteMoments, orderWrong } from "../provenance.ts";
import type { Sandbox, Scenario } from "../types.ts";

const NOTE = "checked without a multiplexer";
const seqFile = (sb: Sandbox): string => join(sb.dir, "no_mux.seq");
const nomuxBin = (sb: Sandbox): string => join(sb.dir, "nomux-bin");

/**
 * A PATH holding only node, git and sqlite3, mu's own mux override removed, and a scratch copy of
 * the DB: the runner judges on every settle, so the scripted half must leave the sandbox as it was.
 */
function noMuxEnv(sb: Sandbox, scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...sb.env,
    PATH: nomuxBin(sb),
    MU_DB_PATH: join(scratch, "mu.db"),
    MU_STATE_DIR: join(scratch, "state"),
    MU_SYNC_DIR: join(scratch, "sync"),
  };
  delete env.MU_MUX;
  delete env.MU_TMUX_SOCKET;
  return env;
}

function installNoMux(sb: Sandbox): void {
  mkdirSync(nomuxBin(sb), { recursive: true });
  for (const tool of ["node", "git", "sqlite3"]) {
    const src = join(sb.binDir, tool);
    try {
      symlinkSync(readlinkSync(src), join(nomuxBin(sb), tool));
    } catch {
      // not a link into the sandbox bin (a system tool): reach it by name
      symlinkSync(
        spawnSync("sh", ["-c", `command -v ${tool}`], {
          env: sb.env,
          encoding: "utf8",
        }).stdout.trim(),
        join(nomuxBin(sb), tool),
      );
    }
  }
  const shim = join(sb.binDir, "mu");
  const body = readFileSync(shim, "utf8");
  const run = `env -u MU_MUX -u MU_TMUX_SOCKET PATH=${JSON.stringify(nomuxBin(sb))} node ${JSON.stringify(sb.surface.cli)}`;
  const plain = `node ${JSON.stringify(sb.surface.cli)}`;
  if (!body.includes(plain)) throw new Error("no_mux: mu shim has no node line to wrap");
  writeFileSync(shim, body.split(plain).join(run));
}

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

function mu(sb: Sandbox, scratch: string, args: string[]): Out {
  const r = spawnSync(process.execPath, [sb.surface.cli, ...args], {
    env: noMuxEnv(sb, scratch),
    cwd: sb.repoDir,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const lines = (s: string): string[] => s.split("\n").filter((l) => l.trim() !== "");
const REFUSING = [
  ["doctor"],
  ["agent", "list", "-w", "eval"],
  ["agent", "show", "w1", "-w", "eval"],
  ["agent", "spawn", "w1", "-w", "eval"],
  ["agent", "send", "w1", "hello", "-w", "eval"],
  ["agent", "close", "w1", "-w", "eval"],
  ["workstream", "init", "other"],
  ["state", "-w", "eval"],
];
const WORKING = [
  ["task", "add", "probe", "-w", "eval", "-t", "probe", "-i", "5", "-e", "0.1"],
  ["task", "list", "-w", "eval"],
  ["task", "close", "probe", "-w", "eval", "--evidence", "probe done"],
  ["sql", "SELECT count(*) AS n FROM tasks"],
  ["db", "query", "SELECT 1 AS one"],
  ["sync"],
];

/** The scripted check: what mu does with no multiplexer. */
function noMuxChecks(sb: Sandbox): { wrong: string[]; na: string[]; notes: string[] } {
  const scratch = mkdtempSync(join(tmpdir(), "no-mux-"));
  try {
    mkdirSync(join(scratch, "state"), { recursive: true });
    const copy = spawnSync("sqlite3", [sb.dbPath, `.backup '${join(scratch, "mu.db")}'`], {
      env: sb.env,
      encoding: "utf8",
    });
    if (copy.status !== 0) throw new Error(`could not copy the DB: ${copy.stderr}`);
    return checksIn(sb, scratch);
  } catch (e) {
    return {
      wrong: [
        `the no-multiplexer check could not run: ${e instanceof Error ? e.message : String(e)}`,
      ],
      na: [],
      notes: [],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function checksIn(
  sb: Sandbox,
  scratch: string,
): { wrong: string[]; na: string[]; notes: string[] } {
  const wrong: string[] = [];
  const na: string[] = [];
  const notes: string[] = [];
  for (const args of REFUSING) {
    const r = mu(sb, scratch, args);
    const errs = lines(r.stderr);
    const label = args.slice(0, 2).join(" ");
    // the refusal itself: exit 5, one line on stderr, and it names the install
    const ok = r.code === 5 && errs.length === 1 && /install/i.test(errs[0] ?? "");
    const n = native(
      sb,
      `${label} refuses with one line naming the install`,
      ok,
      `exit ${r.code}, ${errs.length} stderr line(s): ${(errs[0] ?? "").slice(0, 100)}`,
    );
    wrong.push(...n.wrong);
    na.push(...n.na);
    notes.push(...n.notes);
    // and it prints nothing else: a refusal, not a half-done action
    const quiet = args[0] === "doctor" || lines(r.stdout).length === 0;
    const q = native(
      sb,
      `${label} prints nothing to stdout while refusing`,
      quiet,
      `stdout: ${(lines(r.stdout)[0] ?? "").slice(0, 80)}`,
    );
    wrong.push(...q.wrong);
    na.push(...q.na);
  }
  for (const args of WORKING) {
    const r = mu(sb, scratch, args);
    // `mu db query` is a mu-next verb (3.x has no such command): a native guarantee, N/A there
    if (r.code !== 0 && args[1] === "query") {
      const n = native(sb, "db query works with no multiplexer", false, lines(r.stderr)[0] ?? "");
      wrong.push(...n.wrong);
      na.push(...n.na);
    } else if (r.code !== 0)
      wrong.push(
        `${args.slice(0, 2).join(" ")} failed with no multiplexer (exit ${r.code}): ${lines(r.stderr)[0] ?? ""}`,
      );
  }
  // sync really ran: a segment landed in the scratch sync dir (blank MU_SYNC_DIR would make
  // `mu sync` print "sync is off" and exit 0, proving nothing)
  const segments = (() => {
    try {
      return readdirSync(join(scratch, "sync")).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
  })();
  if (segments.length === 0) wrong.push("sync wrote no segment with no multiplexer");
  return { wrong, na, notes };
}

const scenario: Scenario = {
  id: "no_mux",
  title: "no tmux or herdr on the machine: task, sql and sync verbs keep working",
  prompt: `This machine has no tmux and no herdr, so agents cannot run here: do not try to start one. In workstream eval, add the note '${NOTE}' to task n1 (the note text exactly, no extra words), confirm with mu's SQL that eval holds exactly one open task, and close n1 with evidence 'note added'. Work until it is done; do not ask me questions.`,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ["task", "add", "n1", "-w", "eval", "-t", "note it", "-i", "50", "-e", "0.1"],
    ]);
    installNoMux(sb);
    writeFileSync(seqFile(sb), String(maxSeq(sb)));
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const n1 = probe.task("eval", "n1");
    const notes = noteMoments(sb, "eval", "n1").filter((n) => !/^CLAIM\b/.test(n.content));
    const exact = notes.find((n) => n.content.trimEnd() === NOTE);
    const closeOp = closeMoment(sb, "eval", "n1");
    const wrong: string[] = [];
    for (const n of notes)
      if (n !== exact && !/note added/.test(n.content))
        wrong.push(
          `n1 note differs from the requested text: ${JSON.stringify(n.content.slice(0, 80))}`,
        );
    if (exact) wrong.push(...orderWrong(exact, closeOp, "the note must precede the close"));
    for (const s of strayOps(sb, Number(readFileSync(seqFile(sb), "utf8")), ["eval/n1"]))
      wrong.push(`stray write: ${s}`);
    const completed =
      exact !== undefined &&
      closeOp !== null &&
      isBefore(exact, closeOp) &&
      n1?.status === "CLOSED" &&
      n1.substate === "done";
    // the scripted half runs on a scratch copy of the DB: the judge may run many times
    const checks = noMuxChecks(sb);
    return await verdictFx(sb, run, completed, {
      wrong: [...wrong, ...checks.wrong],
      na: checks.na,
      notes: [`n1=${n1?.status}/${n1?.substate} exact=${exact !== undefined}`, ...checks.notes],
    });
  },
};

export default scenario;
