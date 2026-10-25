// A note whose text holds quote and shell metacharacters. The AUT must pass it literally (stdin
// heredoc); a double-quoted argument expands $HOME and runs `pwd`. Measures quoting mistakes and
// guessed-flag errors ("unknown option") on the way to the right call.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateScript, makeRepo, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { verdictFx } from "../observe.ts";
import { maxSeq, strayOps } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, isBefore, noteMoments, orderWrong } from "../provenance.ts";
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
    // The exact text was written by a note op that precedes the task.close op; the close's evidence
    // ("note added") is any other note carrying that text (3.x files it under intent task.note, next
    // under task.close, with a display prefix: neither is assumed). CLAIM notes are mu's.
    const ops = noteMoments(sb, "eval", "g1").filter((n) => !/^CLAIM\b/.test(n.content));
    const exact = ops.find((n) => n.content.trimEnd() === EXPECTED);
    const evidence = ops.find((n) => n !== exact && n.content.includes("note added"));
    const closeOp = closeMoment(sb, "eval", "g1");
    const wrong = ops
      .filter((n) => n !== exact && n !== evidence)
      .map(
        (n) =>
          `g1 note differs from the requested text: ${JSON.stringify(n.content.slice(0, 120))}`,
      );
    if (!evidence) wrong.push("g1 was not closed with the evidence 'note added'");
    if (exact) wrong.push(...orderWrong(exact, closeOp, "the note must precede the close"));
    for (const s of strayOps(sb, Number(readFileSync(seqFile(sb), "utf8")), ["eval/g1"]))
      wrong.push(`stray write: ${s}`);
    const unknownOpt = run.toolCalls.filter(
      (c) => c.isError && /unknown option/.test(c.output),
    ).length;
    const completed =
      exact !== undefined &&
      evidence !== undefined &&
      closeOp !== null &&
      isBefore(exact, closeOp) &&
      g1?.status === "CLOSED" &&
      g1.substate === "done";
    return await verdictFx(sb, run, completed, {
      wrong,
      notes: [
        `exact=${exact !== undefined} g1=${g1?.status}/${g1?.substate} unknownOption=${unknownOpt}`,
        `muCalls=${run.muCalls} muErrors=${run.muErrors}`,
      ],
    });
  },
};

export default scenario;
