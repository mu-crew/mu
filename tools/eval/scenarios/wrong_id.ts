// The user half-remembers a task id (auth_refresh); the real one is auth_token_refresh. Measures how
// fast the surface's "not found" error steers the AUT to the right id, and whether it writes to a
// look-alike (auth_token_revoke) or invents a task instead.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateScript, makeRepo, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { maxSeq, strayOps } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, isBefore, noteMoments } from "../provenance.ts";
import { verdict } from "../score.ts";
import type { Sandbox, Scenario } from "../types.ts";

const IDS = ["auth_token_refresh", "auth_token_revoke", "billing_retry"];
const TARGET = "auth_token_refresh";
const NOTE = "checked by eval";
const baselineFile = (sb: Sandbox) => join(sb.dir, "wrong_id.baseline.json");

const scenario: Scenario = {
  id: "wrong_id",
  title: "the user's task id is a near-miss; find the real one",
  prompt:
    "In workstream eval, add a note 'checked by eval' to the auth token refresh task (I think it is called auth_refresh), then close it with that as evidence. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...IDS.map((t) => [
        "task",
        "add",
        t,
        "-w",
        "eval",
        "-t",
        t.replaceAll("_", " "),
        "-i",
        "50",
        "-e",
        "0.5",
      ]),
    ]);
    const probe = openProbe(sb);
    const rows = Object.fromEntries(IDS.map((t) => [t, probe.task("eval", t)]));
    writeFileSync(baselineFile(sb), JSON.stringify({ seq: maxSeq(sb), rows }));
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const base = JSON.parse(readFileSync(baselineFile(sb), "utf8")) as {
      seq: number;
      rows: Record<string, ReturnType<typeof probe.task>>;
    };
    const target = probe.task("eval", TARGET);
    // The requested note is the note op with exactly that text, and it must precede the task.close
    // op; the close's evidence is any other note carrying the text (3.x files it under task.note,
    // next under task.close, with a display prefix: neither is assumed).
    const ops = noteMoments(sb, "eval", TARGET).filter((n) => !/^CLAIM\b/.test(n.content));
    const own = ops.find((n) => n.content.trimEnd() === NOTE);
    const evidence = ops.find((n) => n !== own && n.content.includes(NOTE));
    const closeOp = closeMoment(sb, "eval", TARGET);
    const noteAt = own ? 1 : -1;
    const closeAt = evidence ? 2 : -1;
    const wrong: string[] = [];
    if (own && closeOp && !isBefore(own, closeOp)) wrong.push("closed before adding the note");
    // Any write to another task (note, retitle, close+reopen, owner) shows in the ops log.
    for (const s of strayOps(sb, base.seq, [`eval/${TARGET}`])) wrong.push(`stray write: ${s}`);
    for (const t of IDS.filter((x) => x !== TARGET)) {
      const row = probe.task("eval", t);
      if (JSON.stringify(row) !== JSON.stringify(base.rows[t]))
        wrong.push(`${t} changed: ${JSON.stringify(base.rows[t])} -> ${JSON.stringify(row)}`);
    }
    if (probe.task("eval", "auth_refresh") !== null) wrong.push("created a new task auth_refresh");
    const completed =
      target?.status === "CLOSED" &&
      target.substate === "done" &&
      own !== undefined &&
      evidence !== undefined &&
      closeOp !== null &&
      isBefore(own, closeOp);
    return verdict(run, completed, {
      wrong,
      notes: [
        `${TARGET} status=${target?.status} noteAt=${noteAt} closeAt=${closeAt}`,
        `muCalls=${run.muCalls} muErrors=${run.muErrors}`,
      ],
    });
  },
};

export default scenario;
