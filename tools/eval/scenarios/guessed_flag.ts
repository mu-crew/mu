// A note whose text holds quote and shell metacharacters. The AUT must pass it literally (stdin
// heredoc); a double-quoted argument expands $HOME and runs `pwd`. Measures quoting mistakes and
// guessed-flag errors ("unknown option") on the way to the right call.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateScript, makeRepo, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { maxSeq, strayOps } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { verdict } from "../score.ts";
import type { Sandbox, Scenario } from "../types.ts";

const seqFile = (sb: Sandbox) => join(sb.dir, "guessed_flag.seq");
const EXPECTED = "it's fine: $HOME and `pwd` stay literal";

const scenario: Scenario = {
  id: "guessed_flag",
  title: "record a note with quotes, $HOME and backticks literally",
  prompt: `In workstream eval, add a note to task g1 whose text is exactly the next line, character for character (the line itself, no surrounding quotes):\n${EXPECTED}\nThen mark g1 done with evidence 'note added'. Work until it is done; do not ask me questions.`,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ["task", "add", "g1", "-w", "eval", "-t", "literal note", "-i", "50", "-e", "0.1"],
      ["task", "add", "g2", "-w", "eval", "-t", "other task", "-i", "40", "-e", "0.1"],
    ]);
    writeFileSync(seqFile(sb), String(maxSeq(sb)));
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const g1 = probe.task("eval", "g1");
    // The exact text, then mu's own "CLOSE: note added" (what `close --evidence` writes), in that
    // order. CLAIM notes are mu's.
    const notes = probe
      .notes("eval", "g1")
      .filter((n) => !/^CLAIM\b/.test(n))
      .map((n) => n.trimEnd());
    const exactAt = notes.indexOf(EXPECTED);
    const closeAt = notes.indexOf("CLOSE: note added");
    const exact = exactAt >= 0;
    const wrong = notes
      .filter((n) => n !== EXPECTED && n !== "CLOSE: note added")
      .map((n) => `g1 note differs from the requested text: ${JSON.stringify(n.slice(0, 120))}`);
    if (exact && closeAt >= 0 && closeAt < exactAt) wrong.push("closed g1 before adding the note");
    for (const s of strayOps(sb, Number(readFileSync(seqFile(sb), "utf8")), ["eval/g1"]))
      wrong.push(`stray write: ${s}`);
    const unknownOpt = run.toolCalls.filter(
      (c) => c.isError && /unknown option/.test(c.output),
    ).length;
    const completed =
      exact && closeAt > exactAt && g1?.status === "CLOSED" && g1.substate === "done";
    return verdict(run, completed, {
      wrong,
      notes: [
        `exact=${exact} g1=${g1?.status}/${g1?.substate} unknownOption=${unknownOpt}`,
        `muCalls=${run.muCalls} muErrors=${run.muErrors}`,
      ],
    });
  },
};

export default scenario;
