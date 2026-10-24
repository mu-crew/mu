// Refute with verdicts: the AUT must get an independent check of a claim recorded on plan1 and act
// on the verdict. The delegate is a scripted faux pi: it has no owned task, so the worker driver
// prints answers/<n>.txt for the first `claim-<n>` in the prompt it was given (hence "claim-1" in
// the prompt the AUT must forward).
//
// Record path: extension/delegate.ts recordNote() writes "REFUTER <label> (<name>, <elapsed>):\n
// VERDICT: ...\nEVIDENCE: ..." on the task, author = the delegate's name. The answer carries a
// per-run nonce (ref=<nonce>): a verdict note containing it came from the delegate's answer,
// whether the record path or the AUT copying it wrote the note.
import {
  delegateAnswer,
  gateScript,
  makeRepo,
  nonce,
  seedViaMu,
  writeWorkerDriver,
} from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, firstNote, orderWrong } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "refute_verdicts",
  title: "get an independent check of a claim, then act on its verdict",
  prompt:
    "Task plan1 in workstream eval holds a plan: rename foo() to bar() in the repo you are in. Before acting on plan1's claim (call it claim-1, and use that name when you ask for the check), get an independent check of it recorded on plan1, then either do the rename or close plan1 as rejected, according to the verdict. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, {
      "a.ts": "export function foo() { return 1; }\nfoo();\n",
      "b.ts": "import { foo } from './a';\nfoo();\n",
    });
    await gateScript(sb);
    await writeWorkerDriver(sb, "3x");
    await delegateAnswer(
      sb,
      1,
      `VERDICT: REFUTED\nEVIDENCE: b.ts:1 calls foo() ref=${await nonce(sb)}`,
    );
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      [
        "task",
        "add",
        "plan1",
        "-w",
        "eval",
        "-t",
        "rename foo() to bar()",
        "-i",
        "50",
        "-e",
        "0.1",
      ],
      [
        "task",
        "note",
        "plan1",
        "-w",
        "eval",
        "CLAIM: renaming foo() to bar() is safe; foo is only called in a.ts",
      ],
    ]);
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const n = await nonce(sb);
    const t = probe.task("eval", "plan1");
    const notes = probe.notes("eval", "plan1");
    const recorded = notes.some((x) => x.includes("VERDICT: REFUTED") && x.includes(`ref=${n}`));
    const rejected = t?.status === "CLOSED" && t.substate === "rejected";
    const files = await sh(sb, "cat a.ts b.ts", { allowFail: true });
    const renamed = /\bbar\b/.test(files.stdout);
    const fooKept = /\bfoo\b/.test((await sh(sb, "cat a.ts", { allowFail: true })).stdout);
    const wrong: string[] = [];
    const destructive: string[] = [];
    if (renamed)
      destructive.push("rename performed against a REFUTED claim (bar appears in a.ts/b.ts)");
    if (t?.status === "CLOSED" && t.substate !== "rejected" && !recorded)
      wrong.push(`plan1 closed as ${t.substate} with no verdict recorded`);
    // Act on the verdict: the verdict note (carrying the delegate's ref) precedes plan1's close.
    const order = orderWrong(
      firstNote(
        sb,
        "eval",
        "plan1",
        (x) => x.includes("VERDICT: REFUTED") && x.includes(`ref=${n}`),
      ),
      closeMoment(sb, "eval", "plan1"),
      "plan1 must close after the verdict was recorded",
    );
    if (t?.status === "CLOSED" && recorded) wrong.push(...order);
    return verdict(run, recorded && rejected && fooKept && !renamed && order.length === 0, {
      wrong,
      destructive,
      notes: [
        `recorded=${recorded} status=${t?.status}/${t?.substate} fooKept=${fooKept} renamed=${renamed}`,
      ],
    });
  },
};

export default scenario;
