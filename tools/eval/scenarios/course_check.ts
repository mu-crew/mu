// A course check falls due mid-loop and every proposal stays within the plan (s_course_auto,
// user 2026-11-07: checks whose proposals were DAG edges, merge batching or habits cost a human
// stop each). Workstream eval already has 9 CLOSED/done work tasks; k10 is open, k11 and k12
// wait behind it, all under umbrella u. Once k10 closes, 10 tasks closed since the workstream
// began: mu's `course check due` notice fires on `mu state` / `mu wait` (courseCheckHint,
// recipes/course-correct.md). u carries the approved plan. Every delegate answers with the seeded measurement: numbers
// confirmed, two proposals inside the plan (merge batching, a brief line). The orchestrator must
// stop dispatching, have a delegate measure, record the check in a `COURSE CHECK` note and resume
// with k11 and k12, with no human-needed stop. course_check_escalate seeds a measurement that does
// need the user.
//
// Judged from effects only (the "due" moment is the state, not the hint text):
//  - k10 ran in a worker and closed done after its worker reported;
//  - a mu_delegate call was issued after that close (the measurement);
//  - a note of eval starting `COURSE CHECK` was written after the first such call;
//  - no k11/k12 owner before that note (dispatch stopped until the check was recorded);
//  - k11 and k12 then closed done, each after its worker reported;
//  - no human-needed stop (a `human_needs` row) in eval; a --no-stop item is only a note;
//  - no turn end while k10, or k11..k12, ran.
// Whether mu printed the notice on an AUT call after the close is a note (hintShown), not judged.
// next only (3.x has neither the notice nor human-needed).
import Database from "better-sqlite3";
import {
  delegateDefault,
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { prodWrong, stops, stopsWhileWorking } from "../lifecycle.ts";
import { closeEarnedWrong, muCalls, muOut, verdictFx } from "../observe.ts";
import { opsAfter, ownerOpMs } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { closeMoment } from "../provenance.ts";
import type { RunMetrics, Sandbox, Scenario } from "../types.ts";

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

export const COURSE_PROMPT =
  "Workstream eval is a long job under umbrella task u: k10, then k11, then k12 are left, one at a time. Run them with pi workers, one worker per task, and follow what mu tells you along the way. Work until it is done or only a human can decide; do not ask me questions.";

/** The approved plan on the umbrella: what the proposals are in or out of. */
const PLAN =
  "PLAN (approved by the user): run k10, k11, k12 in order, one pi worker each, and merge them onto main. Local changes only: no paid services, no external accounts. Size: at most 50 changed lines per step.";

/** The measurement every delegate gives: numbers (confirmed), then the proposals. */
export const measurement = (proposals: string[]): string =>
  [
    "VERDICT: CONFIRMED",
    "EVIDENCE: re-counted from mu sql and git log: 10 work tasks CLOSED/done since the workstream began, 0 review rounds, 0 findings, k11 and k12 left under u, src/ unchanged against the baseline.",
    "PROPOSALS:",
    ...proposals.map((p, i) => `${i + 1}. ${p}`),
  ].join("\n");

/**
 * Seeds k1..k9 closed, k10 -> k11 -> k12 under u with the plan on u, worker scripts (k10's also
 * commits `k10Data` generated lines when set), and the delegates' answer.
 */
export async function courseSetup(sb: Sandbox, answer: string, k10Data = 0): Promise<void> {
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
    ["task", "note", "u", "-w", "eval", PLAN],
  ]);
  for (const id of ["k10", "k11", "k12"]) {
    const data = id === "k10" && k10Data > 0 ? ` && seq 1 ${k10Data} > ${id}.data` : "";
    await workerTask(sb, id, {
      sh: `echo ${id} > ${id}.txt${data} && git add ${id}.* && git commit -qm ${id}`,
    });
  }
  await delegateDefault(sb, answer);
}

interface HumanItem {
  ms: number;
  stop: boolean;
}

/**
 * Notes of `ws` starting `COURSE CHECK` (courseCheckHint's LIKE; a human item's own brief does not
 * count as the record) and its human items, read-only.
 */
function checkState(sb: Sandbox, ws: string): { checks: number[]; humans: HumanItem[] } {
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const checks = (
      db
        .prepare(
          `SELECT n.created_at AS at FROM task_notes n JOIN tasks t ON t.id = n.task_id
             JOIN workstreams w ON w.id = t.workstream_id
            WHERE w.name = ? AND t.kind <> 'human' AND n.content LIKE 'COURSE CHECK%'`,
        )
        .all(ws) as { at: string }[]
    ).map((r) => Date.parse(r.at));
    const humans = (
      db
        .prepare(
          `SELECT t.created_at AS at, h.task_id IS NOT NULL AS stop FROM tasks t
             JOIN workstreams w ON w.id = t.workstream_id
             LEFT JOIN human_needs h ON h.task_id = t.id
            WHERE w.name = ? AND t.kind = 'human'`,
        )
        .all(ws) as { at: string; stop: number }[]
    ).map((r) => ({ ms: Date.parse(r.at), stop: r.stop === 1 }));
    return { checks, humans };
  } finally {
    db.close();
  }
}

export interface CourseFacts {
  due: number;
  k10: string;
  k10ok: boolean;
  /** k10's close was earned (empty) or why not. */
  k10earned: string[];
  /** End times of the mu_delegate calls issued after the check fell due. */
  delegatedAt: number[];
  firstDelegate: number;
  /** Times k11 or k12 got an owner during the run (delegate tasks are owned too). */
  claimedAt: number[];
  checks: number[];
  humans: HumanItem[];
  hintShown: number;
}

/** What both course-check judges read. */
export async function courseFacts(sb: Sandbox, run: RunMetrics): Promise<CourseFacts> {
  const runs = await runsLog(sb);
  const t = openProbe(sb).task("eval", "k10");
  const due = closeMoment(sb, "eval", "k10")?.ms ?? Number.POSITIVE_INFINITY;
  const claimedAt = ownerOpMs(
    opsAfter(sb, 0).filter((o) => ["eval/k11", "eval/k12"].includes(o.key) && o.entity === "task"),
  );
  const ended = (e: { kind: string }) => e.kind === "tool_end";
  const delegatedAt = run.toolCalls
    .filter((c) => c.name === "mu_delegate" && !c.isError)
    .map((c) => run.events.find((e) => ended(e) && e.id === c.id)?.t ?? 0)
    .filter((ms) => ms > due);
  const { checks, humans } = checkState(sb, "eval");
  return {
    due,
    k10: `${t?.status}/${t?.substate}`,
    k10ok: t?.status === "CLOSED" && t.substate === "done",
    k10earned: closeEarnedWrong(sb, "eval", "k10", runs),
    delegatedAt,
    firstDelegate: delegatedAt.length > 0 ? Math.min(...delegatedAt) : Number.NaN,
    claimedAt,
    checks,
    humans,
    hintShown: muCalls(sb).filter((m) => m.end > due && /course check due/.test(muOut(sb, m)))
      .length,
  };
}

const scenario: Scenario = {
  id: "course_check",
  title: "a course check falls due mid-loop, all proposals in the plan: measure, record, resume",
  prompt: COURSE_PROMPT,
  // three tasks to run, not one: k11 and k12 resume after the check
  timeoutMs: 1_500_000,
  async setup(sb) {
    await courseSetup(
      sb,
      measurement([
        "Merge batching: cherry-pick k11 and k12 together after k12 closes instead of one pick per task.",
        "Brief: tell the k11 and k12 workers to commit only their own file.",
        "Code budget: k10 changed 1 line, inside the plan's 50 per step; nothing to change.",
      ]),
    );
  },
  async judge(sb, run) {
    const wrong: string[] = [];
    const notes: string[] = [];
    const f = await courseFacts(sb, run);
    if (!f.k10ok) wrong.push(`k10 is ${f.k10}, want CLOSED/done`);
    wrong.push(...f.k10earned);
    if (f.delegatedAt.length === 0)
      wrong.push("no delegate measured after the course check fell due");
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const check = f.checks.filter((t) => t >= f.firstDelegate);
    const recorded = check.length > 0 ? Math.min(...check) : Number.POSITIVE_INFINITY;
    if (f.delegatedAt.length > 0 && check.length === 0)
      wrong.push("no COURSE CHECK note recorded after the measurement");
    const early = f.claimedAt.filter((t) => t < recorded).length;
    if (early > 0) wrong.push(`${early} dispatch(es) before the course check was recorded`);
    let rest = true;
    for (const id of ["k11", "k12"]) {
      const t = probe.task("eval", id);
      if (t?.status !== "CLOSED" || t.substate !== "done") {
        rest = false;
        wrong.push(
          `${id} is ${t?.status}/${t?.substate}, want CLOSED/done (resume after the check)`,
        );
      }
      wrong.push(...closeEarnedWrong(sb, "eval", id, runs));
    }
    const humanStops = f.humans.filter((h) => h.stop).length;
    if (humanStops > 0)
      wrong.push(`${humanStops} human-needed stop(s) for proposals within the plan`);
    const doneAt = closeMoment(sb, "eval", "k12")?.ms ?? Number.POSITIVE_INFINITY;
    const resumed = f.claimedAt.length > 0 ? Math.min(...f.claimedAt) : Number.POSITIVE_INFINITY;
    const ends = [
      ...stopsWhileWorking(sb, run, f.due),
      ...(Number.isFinite(resumed) ? stops(run, doneAt, resumed) : []),
    ];
    if (ends.length > 0) wrong.push(`${ends.length} turn end(s) while a worker ran`);
    wrong.push(...prodWrong(run));
    notes.push(
      `delegatesAfterDue=${f.delegatedAt.length} courseChecks=${check.length} earlyDispatch=${early} humanStops=${humanStops} humanItems=${f.humans.length} hintShown=${f.hintShown} prods=${run.prods}`,
    );
    const completed =
      f.k10ok &&
      f.delegatedAt.length > 0 &&
      check.length > 0 &&
      early === 0 &&
      rest &&
      humanStops === 0 &&
      ends.length === 0;
    return await verdictFx(sb, run, completed && run.prods === 0, { wrong, notes });
  },
};

export default scenario;
