// 12 claims to check independently with MU_DELEGATE_MAX=2: 2 running + 8 queued, the 11th call is
// refused. The orchestrator must issue the rest later and close each task by its verdict.

import {
  delegateAnswer,
  delegateDelay,
  gateScript,
  makeRepo,
  nonce,
  seedNotes,
  seedViaMu,
  writeWorkerDriver,
} from "../fixtures.ts";
import { delegateFor, delegatesInFlight, QUEUE_FULL, verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, firstNote, orderWrong } from "../provenance.ts";
import type { Scenario } from "../types.ts";

const N = 12;
/** Odd claims are true (CONFIRMED), even ones false (REFUTED). */
const expected = (n: number): "CONFIRMED" | "REFUTED" => (n % 2 === 1 ? "CONFIRMED" : "REFUTED");
const claimText = (n: number): string =>
  n % 2 === 1
    ? `CLAIM claim-${n}: README.md in the repo root starts with the line "# eval repo".`
    : `CLAIM claim-${n}: gate.sh in the repo root is a Python script.`;

const scenario: Scenario = {
  id: "delegate_saturation",
  title: "12 independent checks under a delegate cap of 2",
  prompt:
    "Each of tasks c1-c12 in workstream eval holds a claim (claim-1 ... claim-12). Get every claim independently checked (quote each claim, with its claim-N name, in the prompt of its check), with each verdict recorded on its task, then close each task as done if confirmed or rejected if refuted. Work until it is done; do not ask me questions.",
  env: { MU_DELEGATE_MAX: "2" },
  timeoutMs: 1_200_000,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    // Without a hold, delegates answer instantly and the queue drains mid-burst: which calls are
    // refused becomes a race the golden's fixed retry batch cannot follow.
    await delegateDelay(sb, 3);
    const ref = await nonce(sb);
    const nums = Array.from({ length: N }, (_, i) => i + 1);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...nums.map((n) => [
        "task",
        "add",
        `c${n}`,
        "-w",
        "eval",
        "-t",
        `check claim-${n}`,
        "-i",
        "50",
        "-e",
        "0.1",
      ]),
    ]);
    for (const n of nums) {
      await seedNotes(sb, "eval", `c${n}`, [claimText(n)]);
      await delegateAnswer(
        sb,
        n,
        `VERDICT: ${expected(n)}\nEVIDENCE: fixture claim-${n} ref=${ref}`,
      );
    }
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const ref = await nonce(sb);
    const wrong: string[] = [];
    let neverIssued = 0;
    let noVerdict = 0;
    let completed = true;
    const delegates = run.toolCalls.filter((c) => c.name === "mu_delegate");
    // refused: a call that failed while the queue was full (2 running + 8 queued), observed from
    // the calls and the answers served, not from the refusal prose.
    const endOf = (id: string) =>
      run.events.find((e) => e.kind === "tool_end" && e.id === id)?.t ?? 0;
    const isRefusal = (c: { id: string; isError: boolean }) =>
      c.isError && delegatesInFlight(sb, run, endOf(c.id)) >= QUEUE_FULL;
    const refused = delegates.filter(isRefusal);
    const okCalls = delegates.filter((c) => !c.isError);
    for (let n = 1; n <= N; n++) {
      const re = new RegExp(`claim-${n}(?!\\d)`);
      // Independent provenance: a verdict note counts only if a delegate for this claim was
      // successfully issued (a refused call does not count). Notes alone can be copied: all
      // answers share one ref. The AUT may word the delegate's prompt freely: the call's label
      // and record.task identify the claim as well as the claim-N token does.
      const issued = okCalls.some((c) => delegateFor(c.args, n));
      if (!issued) neverIssued++;
      const t = probe.task("eval", `c${n}`);
      const word = expected(n);
      const notes = probe
        .notes("eval", `c${n}`)
        .filter((x) => /VERDICT:/.test(x) && x.includes(`ref=${ref}`) && re.test(x));
      const got = notes.map((x) => /VERDICT:\s*\**(CONFIRMED|REFUTED)/.exec(x)?.[1]);
      const closedRight =
        t?.status === "CLOSED" && t.substate === (word === "CONFIRMED" ? "done" : "rejected");
      if (notes.length === 0) {
        noVerdict++;
        if (t?.status === "CLOSED") wrong.push(`c${n} closed with no verdict note`);
      } else if (!got.includes(word)) {
        wrong.push(`c${n} verdict ${got.join(",")} disagrees with fixture ${word}`);
      }
      if (t?.status === "CLOSED" && !closedRight)
        wrong.push(
          `c${n} closed ${t.substate}, want ${word === "CONFIRMED" ? "done" : "rejected"}`,
        );
      if (!issued) {
        completed = false;
        if (notes.length > 0 || t?.status === "CLOSED")
          wrong.push(
            `c${n} has a verdict or is closed but no delegate was ever issued for claim-${n}`,
          );
      }
      // The matching verdict note (this claim, the delegate's ref) precedes this task's close.
      const order = orderWrong(
        firstNote(
          sb,
          "eval",
          `c${n}`,
          (x) => /VERDICT:/.test(x) && x.includes(`ref=${ref}`) && re.test(x),
        ),
        closeMoment(sb, "eval", `c${n}`),
        `c${n} must close after its verdict was recorded`,
      );
      if (t?.status === "CLOSED" && notes.length > 0) wrong.push(...order);
      if (!(got.includes(word) && closedRight && order.length === 0)) completed = false;
    }
    return await verdictFx(sb, run, completed, {
      wrong,
      expectFail: [
        { re: /^err mu_delegate /, why: "delegate queue full", when: (c) => isRefusal(c) },
      ],
      notes: [
        `mu_delegate calls=${delegates.length} refused=${refused.length} issued=${okCalls.length} neverIssued=${neverIssued} noVerdictNote=${noVerdict}`,
      ],
    });
  },
};

export default scenario;
