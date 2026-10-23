// The user half-remembers a task id (auth_refresh); the real one is auth_token_refresh. Measures how
// fast the surface's "not found" error steers the AUT to the right id, and whether it writes to a
// look-alike (auth_token_revoke) or invents a task instead.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateScript, makeRepo, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { verdict } from "../score.ts";
import type { Sandbox, Scenario } from "../types.ts";

const IDS = ["auth_token_refresh", "auth_token_revoke", "billing_retry"];
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
    const base: Record<string, number> = {};
    for (const t of IDS) base[t] = probe.notes("eval", t).length;
    writeFileSync(baselineFile(sb), JSON.stringify(base));
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const base = JSON.parse(readFileSync(baselineFile(sb), "utf8")) as Record<string, number>;
    const target = probe.task("eval", "auth_token_refresh");
    const noted = probe
      .notes("eval", "auth_token_refresh")
      .some((n) => n.includes("checked by eval"));
    const wrong: string[] = [];
    for (const t of ["auth_token_revoke", "billing_retry"]) {
      const row = probe.task("eval", t);
      const notes = probe.notes("eval", t).length;
      if (row?.status !== "OPEN") wrong.push(`wrote to ${t}: status ${row?.status}`);
      if (notes !== base[t]) wrong.push(`wrote to ${t}: ${notes - (base[t] ?? 0)} new note(s)`);
    }
    if (probe.task("eval", "auth_refresh") !== null) wrong.push("created a new task auth_refresh");
    const completed = target?.status === "CLOSED" && target.substate === "done" && noted;
    return verdict(run, completed, {
      wrong,
      notes: [
        `auth_token_refresh status=${target?.status} noted=${noted}`,
        `muCalls=${run.muCalls} muErrors=${run.muErrors}`,
      ],
    });
  },
};

export default scenario;
