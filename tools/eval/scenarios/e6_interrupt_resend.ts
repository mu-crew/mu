// E6 interrupt and resend (spec "Every harness first-class", U24, D4): two workers, w1 on claude
// and w2 on codex, were briefed with a wrong instruction and are stuck in a turn that never ends
// (eval-slow). The orchestrator interrupts each and sends the corrected instruction once; both
// then do their task, and the commits are merged.
//
// The stuck turn must outlive the harness's own shell-tool timeout (claude's Bash stops a command
// after 2 minutes by default, codex's exec returns a still-running command after seconds), which
// ends a call, not the turn: the brief says to run eval-slow again until it prints DONE, and it
// never does, so a real worker keeps re-running it in the same turn until it is interrupted.
//
// Pass criterion (written): each worker's harness accepted exactly two prompts, the wrong brief and
// one resend; no turn of it ended between them (the first was interrupted), and a harness that
// reports interrupts (codex, cursor-agent, Muse) reported one; the resend says eval-worker and does
// not carry the first prompt's text (mu clears the input line before it pastes: claude puts an
// interrupted prompt back there); an AUT mu call carried the resend; each task then passes
// taskProof with its report after the resend; both workers were closed; nothing destructive.
// Fails: a send without an interrupt, keys typed past mu (the merged prompt), a second resend.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  caseVerdict,
  reportRun,
  runsLog,
  seedCase,
  taskProof,
  WS,
  workersClosedWrong,
} from "../harness-cases.ts";
import { hookRecords, promptsTo } from "../harness-observe.ts";
import { muCalls, names } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { mu } from "../sandbox.ts";
import type { Sandbox, Scenario } from "../types.ts";

const WORKERS = [
  { agent: "w1", harness: "claude", task: "x1" },
  { agent: "w2", harness: "codex", task: "x2" },
] as const;

/** Harnesses whose hooks report an interrupt (D6); claude reports none. */
const REPORTS_INTERRUPT = new Set(["codex", "cursor-agent", "muse"]);

const WRONG = (task: string): string =>
  `${task}: run eval-slow in your working directory; each time it stops without printing DONE, run it again, until it prints DONE; then reply with its output`;

/** Never prints DONE: one run takes 10 minutes, and a stopped one says to run it again. */
const EVAL_SLOW =
  '#!/bin/sh\necho "eval-slow: working on the old spec; not finished, run me again"\nexec sleep 600\n';

async function waitPrompted(sb: Sandbox, agents: string[], ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const recs = hookRecords(sb);
    if (agents.every((a) => promptsTo(recs, a).length > 0)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`e6 setup: ${agents.join(", ")} never took the wrong brief`);
}

const scenario: Scenario = {
  id: "e6_interrupt_resend",
  title: "two stuck workers interrupted and resent the corrected instruction once",
  families: ["next"],
  hookHarnesses: { workers: ["claude", "codex"] },
  tokenCap: 600_000,
  check: { quietMs: 3000 },
  prompt:
    "In workstream eval, workers w1 (claude, task x1) and w2 (codex, task x2) were briefed with a wrong instruction: they are running eval-slow, which never finishes. Interrupt each of them and send it the corrected instruction, exactly: 'run eval-worker in your working directory and reply with its output verbatim'. Then wait for both to report, merge their commits into main in the repo you are in, make sure x1 and x2 are closed, and close both workers. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await seedCase(sb, [{ id: "x1" }, { id: "x2" }]);
    const slow = join(sb.binDir, "eval-slow");
    writeFileSync(slow, EVAL_SLOW);
    chmodSync(slow, 0o755);
    // a fake worker's first turn is the wrong brief (eval-slow), its next the resend
    const steps = [
      { calls: [{ bash: "eval-slow" }] },
      { calls: [{ bash: "eval-worker" }] },
      { textFromLastResult: true },
      { calls: [{ bash: "eval-worker" }] },
      { textFromLastResult: true },
    ];
    for (const w of WORKERS) {
      writeFileSync(join(sb.workerDir, `${w.agent}.json`), JSON.stringify(steps));
      const r = await mu(sb, [
        "agent",
        "spawn",
        w.agent,
        "-w",
        WS,
        "--cli",
        w.harness,
        "--worktree",
        "--task",
        w.task,
        "--send",
        WRONG(w.task),
        "--json",
      ]);
      if (r.code !== 0)
        throw new Error(`e6 setup: spawn ${w.agent} failed: ${r.stderr || r.stdout}`);
    }
    await waitPrompted(
      sb,
      WORKERS.map((w) => w.agent),
      60_000,
    );
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const recs = hookRecords(sb);
    const calls = muCalls(sb);
    const wrong: string[] = [];
    const notes: string[] = [];
    let ok = true;
    for (const w of WORKERS) {
      const prompts = promptsTo(recs, w.agent);
      const [first, second] = prompts;
      if (prompts.length !== 2)
        wrong.push(`${w.agent} accepted ${prompts.length} prompts, not the brief and one resend`);
      if (first !== undefined && second !== undefined) {
        const between = recs.filter(
          (r) => r.agent === w.agent && r.ms > first.ms && r.ms < second.ms,
        );
        if (between.some((r) => r.kind === "stop"))
          wrong.push(`${w.agent}'s first turn ended by itself: it was not interrupted`);
        if (REPORTS_INTERRUPT.has(w.harness) && !between.some((r) => r.kind === "interrupt"))
          wrong.push(`${w.agent} (${w.harness}) reported no interrupt before the resend`);
        const text = second.text ?? "";
        if (!/eval-worker/.test(text)) wrong.push(`${w.agent}'s resend does not say eval-worker`);
        const old = (first.text ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
        if (old !== "" && text.replace(/\s+/g, " ").includes(old))
          wrong.push(
            `${w.agent}'s resend carries the first prompt's text (merged into the old input)`,
          );
        if (
          !calls.some(
            (m) =>
              m.start <= second.ms + 400 &&
              names(m.argv, w.agent) &&
              m.argv.includes("eval-worker"),
          )
        )
          wrong.push(`no mu call of the orchestrator carried ${w.agent}'s resend`);
        const rep = reportRun(runs, w.task);
        if (rep !== undefined && rep.ts < second.ms)
          wrong.push(`${w.task} reported before the resend`);
      }
      const p = await taskProof(sb, w.task, { harness: w.harness }, runs, recs);
      wrong.push(...p.wrong);
      const closed = probe.task(WS, w.task)?.status === "CLOSED";
      notes.push(`${p.note} prompts=${prompts.length} closed=${closed}`);
      ok = ok && closed && p.ok;
    }
    wrong.push(
      ...workersClosedWrong(
        sb,
        WORKERS.map((w) => w.agent),
      ),
    );
    return await caseVerdict(sb, run, ok && wrong.length === 0, { wrong, notes });
  },
};

export default scenario;
