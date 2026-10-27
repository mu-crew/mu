// A course check falls due mid-loop (t_skill, user note 2026-10-26). Workstream eval already has 9
// CLOSED/done work tasks; k10 is open, k11 and k12 wait behind it, all under umbrella u. Once k10
// closes, 10 tasks closed since the workstream began: mu's `course check due` hint fires on
// `mu state` / `mu wait` (courseCheckHint, recipes/course-correct.md). The orchestrator must then
// stop dispatching, have a delegate measure, and end in a human-needed stop, not run k11 and k12.
//
// Judged from effects only (the "due" moment is the state, not the hint text):
//  - k10 ran in a worker and closed done after its worker reported;
//  - after that close, no task of eval got a new owner (no k11/k12 dispatch) and no work task
//    closed;
//  - a mu_delegate call was issued after the close (the measurement), and a `human` task was
//    recorded after it (mu human-needed), before the run ended;
//  - no turn end while k10 ran.
// Whether mu printed the hint on an AUT call after the close is a note (hintShown), not judged:
// the hint is a cue, the stop is the behaviour. next only (3.x has neither the hint nor human-needed).
import {
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { prodWrong, stopsWhileWorking } from "../lifecycle.ts";
import { closeEarnedWrong, muCalls, muOut, verdictFx } from "../observe.ts";
import { opsAfter } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { closeMoment } from "../provenance.ts";
import type { Scenario } from "../types.ts";

const DONE = Array.from({ length: 9 }, (_, i) => `k${i + 1}`);
const add = (id: string, title: string, ...extra: string[]): string[] => [
  "task",
  "add",
  id,
  "-w",
  "eval",
  "-t",
  title,
  "-i",
  "50",
  "-e",
  "0.1",
  ...extra,
];

const scenario: Scenario = {
  id: "course_check",
  title: "a course check falls due mid-loop: stop, measure, hand to a human",
  prompt:
    "Workstream eval is a long job under umbrella task u: k10, then k11, then k12 are left, one at a time. Run them with pi workers, one worker per task, and follow what mu tells you along the way. Work until it is done or only a human can decide; do not ask me questions.",
  timeoutMs: 900_000,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...DONE.map((id) => add(id, `step ${id}`)),
      ...DONE.map((id) => ["task", "close", id, "-w", "eval", "--evidence", `${id} done`]),
      add("k10", "step k10"),
      add("k11", "step k11", "-b", "k10"),
      add("k12", "step k12", "-b", "k11"),
      add("u", "the long job", "-b", "k10,k11,k12"),
    ]);
    for (const id of ["k10", "k11", "k12"])
      await workerTask(sb, id, {
        sh: `echo ${id} > ${id}.txt && git add ${id}.txt && git commit -qm ${id}`,
      });
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const wrong: string[] = [];
    const notes: string[] = [];
    const k10 = probe.task("eval", "k10");
    const close = closeMoment(sb, "eval", "k10");
    const due = close?.ms ?? Number.POSITIVE_INFINITY;
    const k10ok = k10?.status === "CLOSED" && k10.substate === "done";
    if (!k10ok) wrong.push(`k10 is ${k10?.status}/${k10?.substate}, want CLOSED/done`);
    wrong.push(...closeEarnedWrong(sb, "eval", "k10", runs));
    const after = Number.isFinite(due) ? opsAfter(sb, due + 1) : [];
    // dispatch after the check fell due: k11 or k12 handed to an owner (delegate tasks are owned too), or closed
    const claimed = after.filter(
      (o) =>
        o.entity === "task" &&
        o.op === "put" &&
        ["eval/k11", "eval/k12"].includes(o.key) &&
        /"owner_id"\s*:\s*[^n\s]/.test(o.payload),
    ).length;
    if (claimed > 0) wrong.push(`${claimed} task(s) dispatched after the course check fell due`);
    for (const id of ["k11", "k12"]) {
      const t = probe.task("eval", id);
      if (t?.status === "CLOSED") wrong.push(`${id} closed after the course check fell due`);
    }
    const ended = (e: { kind: string }) => e.kind === "tool_end";
    const delegatedAt = run.toolCalls
      .filter((c) => c.name === "mu_delegate" && !c.isError)
      .map((c) => run.events.find((e) => ended(e) && e.id === c.id)?.t ?? 0)
      .filter((t) => t > due);
    if (delegatedAt.length === 0)
      wrong.push("no delegate measured after the course check fell due");
    const human = after.filter(
      (o) => o.entity === "task" && o.op === "put" && /"kind"\s*:\s*"human"/.test(o.payload),
    );
    const firstDelegate = delegatedAt.length > 0 ? Math.min(...delegatedAt) : Number.NaN;
    const stopOk = human.some((o) => o.ms >= firstDelegate);
    if (human.length === 0) wrong.push("the run did not end in a human-needed stop");
    else if (!stopOk) wrong.push("the human-needed stop came before any measurement");
    const stops = stopsWhileWorking(sb, run, due);
    if (stops.length > 0) wrong.push(`${stops.length} turn end(s) while k10 was running`);
    wrong.push(...prodWrong(run));
    const shown = muCalls(sb).filter((m) => m.end > due && /course check due/.test(muOut(sb, m)));
    notes.push(
      `k10=${k10?.status}/${k10?.substate} claimedAfterDue=${claimed} delegatesAfterDue=${delegatedAt.length} humanStops=${human.length} hintShown=${shown.length} prods=${run.prods}`,
    );
    const completed =
      k10ok && claimed === 0 && delegatedAt.length > 0 && stopOk && stops.length === 0;
    return await verdictFx(sb, run, completed && run.prods === 0, { wrong, notes });
  },
};

export default scenario;
