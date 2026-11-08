// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// One note that summarises four tasks: the umbrella u gets a single note quoting each of m1-m4's
// reports.
//
// m1-m4 are CLOSED; each has a brief note `MB-<k>-<nonce>` and a report note `MR-<k>-<nonce>`
// (several lines, so a one-line read cuts it). m5 is CLOSED too but outside the umbrella (its report
// `MR-5-<nonce>` must stay out). Judged from the ops log and the notes, never from the AUT's words:
//  - exactly one note added to u after setup, holding every `MR-<k>-<nonce>` of m1-m4;
//  - that note holds no brief marker and nothing of m5;
//  - no note or status change on any other task, and no other write.
// R4 scenario of the hill-r2 rig (docs/specs/2026-11-07-hill-r2-tournament.md §2.2), group c3.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, nonce, seedNotes, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { verdictFx } from "../observe.ts";
import { maxSeq, opsSince, opTask } from "../ops.ts";
import { noteMoments } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import type { Scenario } from "../types.ts";

const WS = "eval";
const PARTS = ["m1", "m2", "m3", "m4"];
const report = (k: number, n: string): string =>
  `MR-${k}-${n}: part ${k} is done.\nTests: ${40 + k} passed.\nFollow-up: none.`;

const scenario: Scenario = {
  id: "multi_notes",
  title: "one umbrella note summarising four tasks' reports",
  families: ["next"],
  prompt:
    "In workstream eval, tasks m1, m2, m3 and m4 are finished parts of the umbrella task u. Add ONE note to u that summarises the four, quoting what each part's report says. Work until it is done; do not ask me questions.",
  timeoutMs: 300_000,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    // the nonce lives in the worker dir (no worker runs here)
    await writeWorkerDriver(sb);
    const n = await nonce(sb);
    const add = (id: string, title: string): string[] => [
      "task",
      "add",
      id,
      "-w",
      WS,
      "-t",
      title,
      "-i",
      "50",
      "-e",
      "0.1",
    ];
    await seedViaMu(sb, [
      ["workstream", "init", WS],
      add("u", "token refresh, all parts"),
      ...[...PARTS, "m5"].map((id) => add(id, `part ${id}`)),
    ]);
    for (const [i, id] of [...PARTS, "m5"].entries()) {
      const k = i + 1;
      await seedNotes(sb, WS, id, [`MB-${k}-${n}: implement part ${k}.`]);
      await sh(sb, `mu task note ${id} -w ${WS} --report - <<'EOF'\n${report(k, n)}\nEOF`);
      await seedViaMu(sb, [["task", "close", id, "-w", WS, "--evidence", `part ${k} merged`]]);
    }
    writeFileSync(join(sb.dir, "setup-seq"), String(maxSeq(sb)));
  },
  async judge(sb, run) {
    const n = await nonce(sb);
    const seqFile = join(sb.dir, "setup-seq");
    const since = existsSync(seqFile) ? Number(readFileSync(seqFile, "utf8")) : 0;
    const wrong: string[] = [];
    const ops = opsSince(sb, since);
    const stray = ops.filter((o) => opTask(o) !== `${WS}/u`);
    for (const o of stray) wrong.push(`a write outside u: ${o.intent ?? "?"} ${o.key}`);
    const added = noteMoments(sb, WS, "u").filter((m) => (m.seq ?? 0) > since);
    if (added.length !== 1) wrong.push(`${added.length} notes added to u (want exactly one)`);
    const note = added[0]?.content ?? "";
    const missing = PARTS.filter((_, i) => !note.includes(`MR-${i + 1}-${n}`));
    if (added.length > 0 && missing.length > 0)
      wrong.push(`u's note lacks the report of ${missing.join(", ")}`);
    if (/MB-\d-/.test(note)) wrong.push("u's note quotes a brief, not a report");
    if (note.includes(`MR-5-${n}`)) wrong.push("u's note quotes m5, which is not part of u");
    const completed = added.length === 1 && missing.length === 0;
    return await verdictFx(sb, run, completed, {
      wrong,
      notes: [`notes on u=${added.length} missing=${missing.join(",") || "-"} ops=${ops.length}`],
    });
  },
};

export default scenario;
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
