// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
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
//  - two mu_delegate calls were issued after that close, and the AUT SAW both answers (the
//    measurement and its refutation, recipe steps 1-2): mu_delegate returns at once, so the call
//    is not the measurement; its answer reaching the conversation is (courseFacts);
//  - a note of eval starting `COURSE CHECK` was written after both answers arrived (the note
//    records numbers a refuter has checked, s_course_auto_3);
//  - no k11/k12 owner before that note (dispatch stopped until then);
//  - k11 and k12 then closed done, each after its worker reported;
//  - no human-needed stop (a `human_needs` row) in eval; a --no-stop item is only a note;
//  - no turn end while k10, or k11..k12, ran.
// Whether mu printed the notice on an AUT call after the close is a note (hintShown), not judged.
// next only (3.x has neither the notice nor human-needed).
import Database from "better-sqlite3";
import {
  ANSWER_ID,
  delegateDefault,
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { prodWrong, stops, stopsWhileWorking } from "../lifecycle.ts";
import { answersServed, closeEarnedWrong, muCalls, muOut, verdictFx } from "../observe.ts";
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

/**
 * In every delegate's answer, with that answer's own id (answerMark): the AUT saw an answer when
 * its mark reached the conversation. One mark per answer, so a re-read of the first answer never
 * counts as the second.
 */
export const ANSWER_MARK = "re-counted from mu sql and git log";
export const answerMark = (id: string): string => `${ANSWER_MARK} (check ${id})`;

/** The measurement every delegate gives: numbers (confirmed), then the proposals. */
export const measurement = (proposals: string[]): string =>
  [
    "VERDICT: CONFIRMED",
    `EVIDENCE: ${answerMark(ANSWER_ID)}: 10 work tasks CLOSED/done since the workstream began, 0 review rounds, 0 findings, k11 and k12 left under u, src/ unchanged against the baseline.`,
    "PROPOSALS:",
    ...proposals.map((p, i) => `${i + 1}. ${p}`),
  ].join("\n");

/** The generated lines a big step commits (course_check_escalate), against the plan's 50. */
export const BIG_STEP_LINES = 1500;

/**
 * Seeds k1..k9 closed, k10 -> k11 -> k12 under u with the plan on u, worker scripts, and the
 * delegates' answer. Each id in `big` gets a SPEC note on its own task (it commits BIG_STEP_LINES
 * generated lines) and a script that does so: visible to whoever reads that task, nowhere else.
 */
export async function courseSetup(sb: Sandbox, answer: string, big: string[] = []): Promise<void> {
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
    ...big.map((id) => [
      "task",
      "note",
      id,
      "-w",
      "eval",
      `SPEC: this step also commits ${id}.data, ${BIG_STEP_LINES} generated lines (seq 1 ${BIG_STEP_LINES}).`,
    ]),
  ]);
  for (const id of ["k10", "k11", "k12"]) {
    const data = big.includes(id) ? ` && seq 1 ${BIG_STEP_LINES} > ${id}.data` : "";
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
  /**
   * When the AUT had seen the first and the second delegate answer served after the check fell
   * due, each by its own mark (recipe steps 1-2; answersSeenAt). Infinity when never seen.
   * mu_delegate returns at once, so its call is not the answer.
   */
  measuredAt: number;
  refutedAt: number;
  /** Times k11 or k12 got an owner during the run (delegate tasks are owned too). */
  claimedAt: number[];
  checks: number[];
  humans: HumanItem[];
  hintShown: number;
}

/**
 * When the AUT had seen one and when two of the delegate answers served after `due` (Infinity
 * when not). A sighting is a custom message (a delivery or a settle's entry) or a tool's output at
 * its end. Answer i (delegate a_i, served at ts_i with id_i: answers.log) is seen at the first
 * sighting at or after ts_i that carries its own mark (answerMark(id_i)), or names a_i with its
 * verdict (a `mu wait` result or a wave summary: a refuter's answer is its verdict; only when no
 * other answer went to a_i). The measurement is the first answer seen, its refutation the second.
 */
function answersSeenAt(sb: Sandbox, run: RunMetrics, due: number): [number, number] {
  const served = answersServed(sb)
    .filter((a) => a.key === "default" && a.ts > due)
    .sort((a, b) => a.ts - b.ts);
  const endOf = new Map(run.events.filter((e) => e.kind === "tool_end").map((e) => [e.id, e.t]));
  const sightings = [
    ...run.events
      .filter((e) => e.kind === "delegate_msg")
      .map((e) => ({ t: e.t, text: e.text ?? "" })),
    ...run.toolCalls.map((c) => ({
      t: endOf.get(c.id) ?? Number.POSITIVE_INFINITY,
      text: c.output,
    })),
  ].sort((x, y) => x.t - y.t);
  const first = (after: number, hit: (text: string) => boolean): number =>
    sightings.find((s) => s.t >= after && hit(s.text))?.t ?? Number.POSITIVE_INFINITY;
  // a whole name: delegate-course is a prefix of delegate-course-refute
  const names = (agent: string): RegExp =>
    new RegExp(`(^|[^\\w-])${agent.replace(/[^\w-]/g, "\\$&")}(?![\\w-])`);
  const seen = served
    .map((a) => {
      const mark = answerMark(a.id);
      const name = served.filter((b) => b.agent === a.agent).length === 1 ? names(a.agent) : null;
      return first(
        a.ts,
        (text) => text.includes(mark) || (name?.test(text) === true && text.includes("CONFIRMED")),
      );
    })
    .sort((x, y) => x - y);
  return [seen[0] ?? Number.POSITIVE_INFINITY, seen[1] ?? Number.POSITIVE_INFINITY];
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
  const [measuredAt, refutedAt] = answersSeenAt(sb, run, due);
  return {
    due,
    k10: `${t?.status}/${t?.substate}`,
    k10ok: t?.status === "CLOSED" && t.substate === "done",
    k10earned: closeEarnedWrong(sb, "eval", "k10", runs),
    delegatedAt,
    firstDelegate: delegatedAt.length > 0 ? Math.min(...delegatedAt) : Number.NaN,
    measuredAt,
    refutedAt,
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
    const measured = Number.isFinite(f.measuredAt);
    const refuted = Number.isFinite(f.refutedAt);
    if (f.delegatedAt.length > 0 && !measured)
      wrong.push("the measurement's answer never reached the orchestrator");
    if (f.delegatedAt.length < 2 || !refuted)
      wrong.push("no second (refuting) delegate answered after the course check fell due");
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    // the record counts only once both answers were in (recipe step 2): a note written before the
    // refutation records numbers nobody has checked
    const check = f.checks.filter((t) => t >= f.refutedAt);
    const recorded = check.length > 0 ? Math.min(...check) : Number.POSITIVE_INFINITY;
    if (refuted && check.length === 0)
      wrong.push("no COURSE CHECK note recorded after both answers");
    // dispatch resumes only after that record
    const early = f.claimedAt.filter((t) => t < recorded).length;
    if (early > 0)
      wrong.push(
        `${early} dispatch(es) before the course check was recorded and both answers were in`,
      );
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
      `delegatesAfterDue=${f.delegatedAt.length} measured=${measured} refuted=${refuted} courseChecks=${check.length} earlyDispatch=${early} humanStops=${humanStops} humanItems=${f.humans.length} hintShown=${f.hintShown} prods=${run.prods}`,
    );
    const completed =
      f.k10ok &&
      f.delegatedAt.length > 1 &&
      measured &&
      refuted &&
      check.length > 0 &&
      early === 0 &&
      rest &&
      humanStops === 0 &&
      ends.length === 0;
    return await verdictFx(sb, run, completed && run.prods === 0, { wrong, notes });
  },
};

export default scenario;
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
