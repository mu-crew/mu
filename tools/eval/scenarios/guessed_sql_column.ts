// SQL against mu's database to find the owner of the highest-impact IN_PROGRESS task. The schema
// names are easy to guess wrong (tasks.owner, tasks.workstream, agents.agent_name); `tasks.id` is
// valid but is the integer key, not the task's name. A failed query is counted; a valid query with
// the wrong answer only shows in the end state (note on the wrong task / wrong agent).
// Judged by effects: the query's content (tasks, impact) and what mu returned, the note op's text
// and order, and the ops log (nothing else written). Not by the verbs the AUT spelled.
// Setup: w1, w2 are live agents (no workspace, no script); a decoy OPEN task has the top impact.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateScript, makeRepo, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { type MuCall, muCalls, muOut, verdictFx } from "../observe.ts";
import { maxSeq, opsSince } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { firstNote, orderWrong } from "../provenance.ts";
import type { Sandbox, Scenario } from "../types.ts";

// id, impact. s7 is the decoy (OPEN, highest overall); s4 is the highest-impact IN_PROGRESS (w2).
const TASKS: [string, number][] = [
  ["s1", 30],
  ["s2", 45],
  ["s3", 62],
  ["s4", 81],
  ["s5", 24],
  ["s6", 57],
  ["s7", 96],
  ["s8", 70],
];
const OWNED: Record<string, string> = { s2: "w1", s3: "w1", s4: "w2", s6: "w2" };
const CLOSED_AT_SETUP = ["s5"];
// Derived, not hard-coded: the highest-impact task that is owned and not closed at setup.
const TOP = (() => {
  const impact = new Map(TASKS);
  const live = Object.keys(OWNED).filter((t) => !CLOSED_AT_SETUP.includes(t));
  const task = live.reduce((a, b) => ((impact.get(b) ?? 0) > (impact.get(a) ?? 0) ? b : a));
  return { task, agent: OWNED[task] as string };
})();
const baselineFile = (sb: Sandbox) => join(sb.dir, "guessed_sql_column.baseline.json");

const scenario: Scenario = {
  id: "guessed_sql_column",
  title: "owner of the top-impact IN_PROGRESS task via SQL",
  prompt:
    "Using SQL against mu's database, tell me which agent owns the highest-impact IN_PROGRESS task in workstream eval, then add a note 'top owner: <agent>' to that task. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...TASKS.map(([t, i]) => [
        "task",
        "add",
        t,
        "-w",
        "eval",
        "-t",
        `task ${t}`,
        "-i",
        String(i),
        "-e",
        "0.5",
      ]),
      ["agent", "spawn", "w1", "-w", "eval"],
      ["agent", "spawn", "w2", "-w", "eval"],
      ...Object.entries(OWNED).map(([t, a]) => ["task", "claim", t, "-w", "eval", "--for", a]),
      ["task", "close", "s5", "-w", "eval", "--evidence", "seed"],
    ]);
    const probe = openProbe(sb);
    const base: Record<string, number> = {};
    for (const [t] of TASKS) base[t] = probe.notes("eval", t).length;
    writeFileSync(baselineFile(sb), JSON.stringify({ seq: maxSeq(sb), notes: base }));
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const { seq, notes: base } = JSON.parse(readFileSync(baselineFile(sb), "utf8")) as {
      seq: number;
      notes: Record<string, number>;
    };
    const added: string[] = [];
    let newNotes = 0;
    for (const [t] of TASKS) {
      const notes = probe.notes("eval", t);
      const fresh = notes.slice(base[t] ?? 0);
      newNotes += fresh.length;
      for (const n of fresh) added.push(`${t}: ${n.trimEnd()}`);
    }
    const want = `${TOP.task}: top owner: ${TOP.agent}`;
    const wrong: string[] = [];
    for (const a of added)
      if (a !== want) wrong.push(`unexpected note ${JSON.stringify(a.slice(0, 120))}`);
    // Every write since setup is in the ops log whoever made it (mu sql included). The only
    // allowed ones are the note's own ops (intent task.note) on the top task.
    for (const o of opsSince(sb, seq))
      if (o.intent !== "task.note" || o.key.split("#")[0] !== `eval/${TOP.task}`)
        wrong.push(`stray write: ${o.intent ?? "?"} ${o.entity} ${o.key}`);
    // The task is to use SQL: a successful read of the asked data must come before the note. The
    // read is judged by what mu did, not by the verb or flags spelled: an AUT invocation that
    // succeeded, whose argv carries a query over tasks and impact (the query's own content) and
    // whose own output (tee'd before any pipe) is the answer: the top task and its owner. A task
    // list, a sqlite_master query or a note write does not read the asked data.
    const calls = muCalls(sb);
    const out = (m: MuCall) => muOut(sb, m);
    const relevant = (m: MuCall) =>
      m.exit === 0 &&
      /\btasks\b/i.test(m.argv) &&
      /\bimpact\b/i.test(m.argv) &&
      new RegExp(`\\b${TOP.task}\\b`).test(out(m)) &&
      new RegExp(`\\b${TOP.agent}\\b`).test(out(m));
    const read = calls.find(relevant);
    // the note: the op that wrote the requested text on the top task (kind and verb irrelevant)
    const note = firstNote(sb, "eval", TOP.task, (c) => c.trim() === `top owner: ${TOP.agent}`);
    if (!read)
      wrong.push("no successful query that read the asked tasks/impact and returned the answer");
    else if (note)
      wrong.push(
        ...orderWrong(
          { label: "the query returned", ms: read.end },
          note,
          "the note must follow the query",
        ),
      );
    const completed = newNotes === 1 && added[0] === want && read !== undefined && note !== null;
    const failedQueries = calls.filter((m) => m.exit !== 0 && /\btasks\b|\bagents\b/i.test(m.argv));
    return await verdictFx(sb, run, completed, {
      wrong,
      notes: [
        `newNotes=${newNotes} added=${JSON.stringify(added)}`,
        `failedQueries=${failedQueries.length} muCalls=${run.muCalls} muErrors=${run.muErrors}`,
      ],
    });
  },
};

export default scenario;
