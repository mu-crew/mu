// E4 crash and replacement orchestrator (spec "Every harness first-class", U24, D5 recovery): the
// orchestrator dispatches c1 to a claude worker and c2 to a codex worker and dies; a second
// orchestrator of the same harness takes the workstream over and finishes it. In `check` the AUT
// script's `{die}` is the crash; in a live run the rig kills the AUT once both tasks are claimed
// and both workers' harnesses have taken their prompt.
//
// Pass criterion (written): the replacement prompt was delivered (a crash happened); c1 and c2
// each pass taskProof (their own worker's commit on main, the requested harness, closed after the
// report); each task was claimed exactly once and each worker received exactly one prompt (the
// replacement neither re-dispatched nor resent work that was running); exactly the two workers
// were spawned; both workers were closed; nothing destructive. When a task reached main before
// the crash it is only a note: the crash point is the rig's, not the orchestrator's choice.
// Fails: a resend to a running worker, the replacement doing a task itself, a task left behind.
import {
  mainCommitMs,
  runsLog,
  seedCase,
  spawns,
  taskProof,
  WS,
  workersClosedWrong,
} from "../harness-cases.ts";
import { hookRecords, promptsTo } from "../harness-observe.ts";
import { claimCount, verdictFx } from "../observe.ts";
import { opsAfter } from "../ops.ts";
import { openProbe } from "../probe.ts";
import type { Sandbox, Scenario } from "../types.ts";

const WANT = { c1: "claude", c2: "codex" } as const;
const AUTS = new Set(["aut", "aut-2"]);

const REPLACEMENT =
  "You are taking over workstream eval in the repo you are in from an orchestrator that crashed mid-run. Find out what it had started (mu state -w eval), do not redo or resend work that is already running or done, merge each worker's commit into main when it has reported, make sure c1 and c2 are closed, and close the workers. Work until it is done; do not ask me questions.";

/** Live crash point: both tasks handed to a worker, and two workers' harnesses took a prompt. */
async function dispatched(sb: Sandbox): Promise<boolean> {
  const owned = new Set(
    opsAfter(sb, 0)
      .filter((o) => o.intent === "task.claim" && o.entity === "task")
      .map((o) => o.key),
  );
  const prompted = new Set(
    hookRecords(sb)
      .filter((r) => r.kind === "prompt" && r.agent !== null && !AUTS.has(r.agent))
      .map((r) => r.agent),
  );
  return owned.has(`${WS}/c1`) && owned.has(`${WS}/c2`) && prompted.size >= 2;
}

const scenario: Scenario = {
  id: "e4_replacement_orchestrator",
  title: "the orchestrator crashes after dispatch; a replacement finishes without redoing work",
  families: ["next"],
  hookHarnesses: { workers: ["claude", "codex"] },
  tokenCap: 800_000,
  check: { quietMs: 3000 },
  prompt:
    "In workstream eval, run c1 with a claude worker and c2 with a codex worker (mu agent spawn --cli), each in its own worktree, and merge each commit into main in the repo you are in when its worker reports. Make sure c1 and c2 are closed and close both workers. Work until it is done; do not ask me questions.",
  replacement: { prompt: REPLACEMENT, crashWhen: dispatched },
  async setup(sb) {
    await seedCase(sb, [{ id: "c1" }, { id: "c2" }]);
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const recs = hookRecords(sb);
    const wrong: string[] = [];
    const notes: string[] = [];
    const crashAt =
      run.events.find((e) => e.kind === "prompt" && e.text === REPLACEMENT)?.t ?? null;
    if (crashAt === null) notes.push("no replacement prompt was delivered (no crash yet)");
    const agents: (string | null)[] = [];
    let ok = crashAt !== null;
    for (const [task, harness] of Object.entries(WANT)) {
      const closed = probe.task(WS, task)?.status === "CLOSED";
      const p = await taskProof(sb, task, { harness }, runs, recs);
      wrong.push(...p.wrong);
      agents.push(p.agent);
      const claims = claimCount(sb, WS, task);
      if (claims > 1) wrong.push(`${task} was claimed ${claims} times (re-dispatched)`);
      if (p.agent !== null) {
        const n = promptsTo(recs, p.agent).length;
        if (n > 1) wrong.push(`worker ${p.agent} received ${n} prompts (work resent)`);
      }
      const merged = mainCommitMs(sb, task);
      if (crashAt !== null && merged !== null && merged < crashAt)
        notes.push(`${task} reached main before the crash`);
      notes.push(`${p.note} closed=${closed} claims=${claims}`);
      ok = ok && closed && p.ok;
    }
    const workers = spawns(sb).filter((s) => !AUTS.has(s.name));
    if (workers.length > 2) wrong.push(`${workers.length} workers were spawned for two tasks`);
    wrong.push(...workersClosedWrong(sb, agents));
    return await verdictFx(sb, run, ok && wrong.length === 0, { wrong, notes });
  },
};

export default scenario;
