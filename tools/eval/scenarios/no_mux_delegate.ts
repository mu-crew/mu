// Delegates with no multiplexer installed: neither tmux nor herdr is reachable from the caller's
// pi, its mu shim, or the delegate's pi (setup removes the sandbox's tmux shim; the sandbox PATH is
// system dirs plus <sandbox>/bin, and setup asserts neither binary resolves there). TMUX, TMUX_PANE,
// HERDR_ENV and MU_MUX are unset. pi, node and git stay reachable.
//
// Two claims (c1 true, c2 false) need independent checks recorded on their tasks, then closes by the
// verdict. Judged from effects only:
//  - a mu_delegate call was issued for each claim and the faux delegate served its answer (it ran);
//  - a verdict note carrying the run's nonce precedes each close, closed done / rejected;
//  - no agents row and no tmux server exist: the check ran without a pane;
//  - no turn end while work runs, prods == 0.
// 3.x hides mu_delegate without a mux, so its run cannot do the job (expected baseline non-support).
import { accessSync, constants, rmSync } from "node:fs";
import { join } from "node:path";
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
import { native, prodWrong, stopsWhileWorking } from "../lifecycle.ts";
import { answersServed, delegateFor, verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, firstNote, orderWrong } from "../provenance.ts";
import type { Sandbox, Scenario } from "../types.ts";

const CLAIMS = [1, 2] as const;
const expected = (n: number): "CONFIRMED" | "REFUTED" => (n === 1 ? "CONFIRMED" : "REFUTED");
const claimText = (n: number): string =>
  n === 1
    ? `CLAIM claim-${n}: README.md in the repo root starts with the line "# eval repo".`
    : `CLAIM claim-${n}: gate.sh in the repo root is a Python script.`;

/** tmux or herdr on the sandbox PATH, as a path; undefined when neither resolves. */
function muxOnPath(sb: Sandbox): string | undefined {
  for (const d of (sb.env.PATH ?? "").split(":"))
    for (const bin of ["tmux", "herdr"])
      try {
        accessSync(join(d, bin), constants.X_OK);
        return join(d, bin);
      } catch {
        // not here
      }
  return undefined;
}

const scenario: Scenario = {
  id: "no_mux_delegate",
  title: "independent checks with no tmux or herdr on the machine",
  prompt:
    "This machine has no tmux and no herdr. Workstream eval has two claims in tasks c1 and c2 (claim-1 and claim-2). Get each claim independently checked (quote the claim, with its claim-N name, in the prompt of its check) with the verdict recorded on its task, then close each task as done if confirmed or rejected if refuted. Work until it is done; do not ask me questions, and do not stop while work is still running.",
  timeoutMs: 600_000,
  check: { quietMs: 3000, maxProds: 1 },
  env: { MU_MUX: "", MU_TMUX_SOCKET: "" },
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await delegateDelay(sb, 2);
    const ref = await nonce(sb);
    await seedViaMu(sb, [
      ["task", "add", "c1", "-w", "eval", "-t", "check claim-1", "-i", "50", "-e", "0.1"],
      ["task", "add", "c2", "-w", "eval", "-t", "check claim-2", "-i", "50", "-e", "0.1"],
    ]);
    for (const n of CLAIMS) {
      await seedNotes(sb, "eval", `c${n}`, [claimText(n)]);
      await delegateAnswer(
        sb,
        n,
        `VERDICT: ${expected(n)}\nEVIDENCE: fixture claim-${n} ref=${ref}`,
      );
    }
    // From here on no multiplexer exists for the caller, its mu or a delegate.
    rmSync(join(sb.binDir, "tmux"), { force: true });
    const left = muxOnPath(sb);
    if (left) throw new Error(`no_mux_delegate: ${left} is still on PATH`);
    const leaked = ["TMUX", "TMUX_PANE", "HERDR_ENV"].filter((k) => sb.env[k] !== undefined);
    if (leaked.length > 0)
      throw new Error(`no_mux_delegate: caller env still has ${leaked.join(", ")}`);
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const ref = await nonce(sb);
    const wrong: string[] = [];
    let completed = true;
    const issuedCalls = run.toolCalls.filter((c) => c.name === "mu_delegate" && !c.isError);
    const served = answersServed(sb);
    for (const n of CLAIMS) {
      const t = probe.task("eval", `c${n}`);
      const word = expected(n);
      const re = new RegExp(`claim-${n}(?!\\d)`);
      const isVerdict = (x: string): boolean =>
        /VERDICT:/.test(x) && x.includes(`ref=${ref}`) && re.test(x);
      const noted = probe.notes("eval", `c${n}`).filter(isVerdict);
      const got = noted.map((x) => /VERDICT:\s*\**(CONFIRMED|REFUTED)/.exec(x)?.[1]);
      const wasIssued = issuedCalls.some((c) => delegateFor(c.args, n));
      if (!wasIssued) wrong.push(`no delegate was issued for claim-${n}`);
      const ran = served.some((a) => a.key === String(n));
      const closedRight =
        t?.status === "CLOSED" && t.substate === (word === "CONFIRMED" ? "done" : "rejected");
      if (t?.status === "CLOSED" && !closedRight)
        wrong.push(
          `c${n} closed ${t.substate}, want ${word === "CONFIRMED" ? "done" : "rejected"}`,
        );
      if (noted.length === 0) {
        if (t?.status === "CLOSED") wrong.push(`c${n} closed with no delegate verdict recorded`);
      } else if (!got.includes(word)) {
        wrong.push(`c${n} verdict ${got.join(",")} disagrees with fixture ${word}`);
      }
      const order = orderWrong(
        firstNote(sb, "eval", `c${n}`, isVerdict),
        closeMoment(sb, "eval", `c${n}`),
        `c${n} must close after its verdict was recorded`,
      );
      if (t?.status === "CLOSED" && noted.length > 0) wrong.push(...order);
      if (!(wasIssued && ran && got.includes(word) && closedRight && order.length === 0))
        completed = false;
    }
    // A delegate ran with no multiplexer at all: no agent row and no pane in any workstream.
    const rows = probe.workstreams().flatMap((ws) => probe.agents(ws).map((a) => `${ws}/${a}`));
    const nm = native(
      sb,
      "delegates ran with no multiplexer (no agent row, no pane)",
      rows.length === 0 && served.length >= CLAIMS.length,
      `agents=${rows.join(",") || "none"} answersServed=${served.length}`,
    );
    wrong.push(...nm.wrong);
    const lastClose = Math.max(...["c1", "c2"].map((id) => closeMoment(sb, "eval", id)?.ms ?? 0));
    const stops = stopsWhileWorking(sb, run, lastClose);
    if (stops.length > 0) wrong.push(`${stops.length} turn end(s) while work was running`);
    wrong.push(...prodWrong(run));
    return await verdictFx(sb, run, completed && run.prods === 0 && stops.length === 0, {
      wrong,
      na: nm.na,
      notes: [
        `delegatesIssued=${issuedCalls.length} answersServed=${served.length} agents=${rows.length} prods=${run.prods}`,
        ...nm.notes,
      ],
    });
  },
};

export default scenario;
