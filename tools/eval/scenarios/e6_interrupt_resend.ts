// E6 interrupt and resend (spec "Every harness first-class", U24, D4): two workers, w1 on claude
// and w2 on codex, were briefed with a wrong instruction and are busy in a long turn (eval-slow, a
// 20-minute job). The orchestrator interrupts each and sends the corrected instruction once; both
// then do their task, and the commits are merged.
//
// The busy turn must outlive the harness's own shell-tool timeout (claude's Bash stops a command
// after 2 minutes by default, codex's exec returns a still-running command after seconds), which
// ends a call, not the turn: the brief says to run eval-slow in the foreground and stay in the turn
// until it prints DONE, so a real worker is still in its first turn when it is interrupted.
//
// Pass criterion (written): each worker's harness accepted the wrong brief and exactly one resend of
// the corrected instruction (other later messages are noted, not counted); no turn of it ended between them (the first was interrupted), and a harness that
// reports interrupts (codex, cursor-agent, Muse) reported one; the resend says eval-worker and does
// not carry the first prompt's text (mu clears the input line before it pastes: claude puts an
// interrupted prompt back there); an AUT mu call carried the resend; each task then passes
// taskProof with its report after the resend; both workers were closed; nothing destructive.
// Fails: a send without an interrupt, keys typed past mu (the merged prompt), a second resend.
//
// The run may pick the two harnesses (`--workers w1,w2`, mix.ts); the setup spawns them, and the
// prompt and judge name them. cursor-agent's and Muse's shell tools are assumed to end a call, not
// the turn, on a timeout, as claude's and codex's do; one that ended the turn would fail "first
// turn ended by itself" through no fault of the AUT.
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

const DEFAULT = ["claude", "codex"] as const;

/** Harnesses whose hooks report an interrupt (D6); claude reports none. */
const REPORTS_INTERRUPT = new Set(["codex", "cursor-agent", "muse"]);

const WRONG = (task: string): string =>
  `${task}: run eval-slow in your working directory and wait until it prints DONE (it takes about 20 minutes and prints its progress meanwhile). Run it in the foreground, not as a background task, and stay in this turn until then: if your shell tool stops waiting, wait for it again or run it again. Then reply with its output`;

/**
 * A long, honest job: progress every 20 s, DONE after 20 minutes. Live E6 under a claude AUT: the
 * old one (print "not finished, run me again", sleep 600) let a claude worker read the script, see
 * it could never finish and end its first turn as blocked, so there was nothing to interrupt. A job
 * that does finish gives a worker no reason to stop; the AUT interrupts it long before DONE.
 */
const EVAL_SLOW = [
  "#!/bin/sh",
  'echo "eval-slow: building (about 20 minutes)"',
  "i=0",
  'while [ "$i" -lt 60 ]; do sleep 20; i=$((i + 1)); echo "eval-slow: $((i * 20))s"; done',
  "echo DONE",
  "",
].join("\n");

async function waitPrompted(sb: Sandbox, agents: string[], ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const recs = hookRecords(sb);
    if (agents.every((a) => promptsTo(recs, a).length > 0)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`e6 setup: ${agents.join(", ")} never took the wrong brief`);
}

function e6(workers: readonly string[]): Scenario {
  const [h1 = DEFAULT[0], h2 = DEFAULT[1]] = workers;
  const WORKERS = [
    { agent: "w1", harness: h1, task: "x1" },
    { agent: "w2", harness: h2, task: "x2" },
  ] as const;
  return {
    id: "e6_interrupt_resend",
    title: "two stuck workers interrupted and resent the corrected instruction once",
    families: ["next"],
    hookHarnesses: { workers: [h1, h2], mix: { roles: ["w1", "w2"], harnesses: [h1, h2] } },
    bind: (o) => e6(o.workers ?? DEFAULT),
    tokenCap: 600_000,
    check: { quietMs: 3000 },
    prompt: `In workstream eval, workers w1 (${h1}, task x1) and w2 (${h2}, task x2) were briefed with a wrong instruction: they are running eval-slow, a 20-minute job they do not need. Interrupt each of them and send it the corrected instruction, exactly: 'run eval-worker in your working directory and reply with its output verbatim'. Then wait for both to report, merge their commits into main in the repo you are in, make sure x1 and x2 are closed, and close both workers. Work until it is done; do not ask me questions.`,
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
        // the work: the brief, then each prompt that carries the corrected instruction. A later
        // message that does not (live, pi: "stop the background eval-slow run") is no resend.
        const [first] = prompts;
        const carrying = prompts.slice(1).filter((r) => /eval-worker/.test(r.text ?? ""));
        const second = carrying[0] ?? prompts[1];
        // a duplicate resend lands before the worker answered the first; one after its answer is a
        // follow-up in the conversation (live, codex AUT: a worker that ran eval-worker but still
        // held to the old brief was told again that the correction replaces it)
        const answered = recs.find(
          (r) =>
            r.agent === w.agent && r.kind === "stop" && second !== undefined && r.ms > second.ms,
        );
        const resends = carrying.filter((r) => answered === undefined || r.ms < answered.ms);
        if (resends.length !== 1)
          wrong.push(`${w.agent} accepted ${resends.length} resends of the work, not one`);
        const other = prompts.length - 1 - resends.length;
        if (other > 0) notes.push(`${w.agent} also got ${other} other message(s) after its brief`);
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
}

export default e6(DEFAULT);
