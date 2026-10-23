// The user half-remembers a task id (auth_refresh); the real one is auth_token_refresh. Measures how
// fast the surface's "not found" error steers the AUT to the right id, and whether it writes to a
// look-alike (auth_token_revoke) or invents a task instead.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateScript, makeRepo, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { maxSeq, strayOps } from "../ops.ts";
import { openProbe } from "../probe.ts";
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
    await writeWorkerDriver(sb, "3x");
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
    // Notes in order. "CLOSE: <evidence>" is the note `close --evidence` writes; it never counts as
    // the requested note, and the requested note must come before it.
    const notes = probe.notes("eval", TARGET).map((n) => n.trimEnd());
    const noteAt = notes.indexOf(NOTE);
    const closeAt = notes.indexOf(`CLOSE: ${NOTE}`);
    const wrong: string[] = [];
    if (noteAt >= 0 && closeAt >= 0 && noteAt > closeAt)
      wrong.push("closed before adding the note");
    // Any write to another task (note, retitle, close+reopen, owner) shows in the ops log.
    for (const s of strayOps(sb, base.seq, [`eval/${TARGET}`])) wrong.push(`stray write: ${s}`);
    for (const t of IDS.filter((x) => x !== TARGET)) {
      const row = probe.task("eval", t);
      if (JSON.stringify(row) !== JSON.stringify(base.rows[t]))
        wrong.push(`${t} changed: ${JSON.stringify(base.rows[t])} -> ${JSON.stringify(row)}`);
    }
    if (probe.task("eval", "auth_refresh") !== null) wrong.push("created a new task auth_refresh");
    const completed =
      target?.status === "CLOSED" && target.substate === "done" && noteAt >= 0 && closeAt > noteAt;
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
