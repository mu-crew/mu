// A note whose text holds quote and shell metacharacters. The AUT must pass it literally (stdin
// heredoc); a double-quoted argument expands $HOME and runs `pwd`. Measures quoting mistakes and
// guessed-flag errors ("unknown option") on the way to the right call.
import { gateScript, makeRepo, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const EXPECTED = "it's fine: $HOME and `pwd` stay literal";

const scenario: Scenario = {
  id: "guessed_flag",
  title: "record a note with quotes, $HOME and backticks literally",
  prompt: `In workstream eval, add a note to task g1 whose text is exactly the next line, character for character (the line itself, no surrounding quotes):\n${EXPECTED}\nThen mark g1 done with evidence 'note added'. Work until it is done; do not ask me questions.`,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb, "3x");
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ["task", "add", "g1", "-w", "eval", "-t", "literal note", "-i", "50", "-e", "0.1"],
    ]);
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const g1 = probe.task("eval", "g1");
    // CLAIM/CLOSE lines are mu's own notes; the evidence note on close does not count.
    const notes = probe.notes("eval", "g1").filter((n) => !/^(CLAIM|CLOSE)\b/.test(n));
    const exact = notes.some((n) => n.trimEnd() === EXPECTED);
    const wrong = notes
      .filter((n) => n.trimEnd() !== EXPECTED && n.trimEnd() !== "note added")
      .map((n) => `g1 note differs from the requested text: ${JSON.stringify(n.slice(0, 120))}`);
    const unknownOpt = run.toolCalls.filter(
      (c) => c.isError && /unknown option/.test(c.output),
    ).length;
    const completed = exact && g1?.status === "CLOSED" && g1.substate === "done";
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
