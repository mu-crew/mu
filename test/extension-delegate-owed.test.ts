// An answer owed to the transcript survives an interrupt and a reload (fsj U4, mural r5).
// Every interrupt (Esc in a tmux or Rex pane, `mu agent abort` over ctl, murmur stop's ctl
// path or its Escape fallback) reaches the extension as pi's abort: `agent_settled` with
// `aborted: true` (extension/mu-pi.ts ctl `abort` calls ctx.abort()). The answer stays owed,
// `@mu_pending` keeps counting it, and the next runtime of the session re-adopts it.

import { afterEach, describe, expect, it } from "vitest";
import { registerDelegate } from "../extension/delegate.js";
import {
  claimPendingPaneOption,
  setPaneOptionRunnerForTests,
} from "../extension/delegate-pane-option.js";
import { listDelegates } from "../src/delegates.js";
import { cursorKey, recordCursors, SETTLE_TOKEN } from "../src/wait-cursor.js";
import { fakeMu, fakePi, flush, installDelegateEnv, ok, tool } from "./_delegate-fixtures.js";

installDelegateEnv();

const SOCK = "/tmp/tmux-501/default";
const set = (n: number) => ["-S", SOCK, "set-option", "-p", "-t", "%7", "@mu_pending", String(n)];
const unset = ["-S", SOCK, "set-option", "-p", "-t", "%7", "-u", "@mu_pending"];
const ctx = { sessionManager: { getSessionId: () => "s1" } };

/** Claim the pane (as mu-pi's bind does); every later set-option argv lands in the result. */
async function claimed(): Promise<string[][]> {
  process.env.TMUX = `${SOCK},123,0`;
  process.env.TMUX_PANE = "%7";
  const seen: string[][] = [];
  setPaneOptionRunnerForTests(async (argv) => {
    if (argv[2] === "display") return "123\n";
    seen.push([...argv]);
    return "";
  });
  await claimPendingPaneOption(true);
  seen.splice(0);
  return seen;
}
afterEach(() => {
  for (const k of ["TMUX", "TMUX_PANE"]) delete process.env[k];
  setPaneOptionRunnerForTests(null);
});

const ticks = async (n = 6) => {
  for (let i = 0; i < n; i++) await flush();
};
const settled = async (p: ReturnType<typeof fakePi>, aborted = false) => {
  await p.fire("agent_settled", { type: "agent_settled", aborted });
  await new Promise((r) => setImmediate(r));
};
const wakes = (p: ReturnType<typeof fakePi>) =>
  p.sendMessage.mock.calls.filter(
    (c) =>
      (c[0] as { details?: { wake?: unknown } }).details?.wake !== undefined &&
      (c[1] as { triggerTurn?: boolean }).triggerTurn === true,
  );

/** One delegate answered mid-turn: owed, no wake yet (the turn's settle would show it). */
async function answeredMidTurn() {
  const mu = fakeMu();
  const p = fakePi();
  const handle = registerDelegate(p.pi, mu.run);
  await tool(p).execute("a", { task: "one" }, undefined, undefined, ctx);
  await p.fire("agent_start", {});
  p.state.busy = true;
  mu.waits
    .get("delegate-2")
    ?.resolve(ok({ agents: [{ outcome: "done", lastText: "the answer" }] }));
  await ticks();
  const callId = listDelegates(mu.db)[0]?.callId ?? "";
  return { mu, p, handle, callId };
}

describe("owed survives an interrupt", () => {
  it("Esc / ctl abort mid-turn: noted, no wake; the next completed turn that did not show it wakes for it", async () => {
    const { p, callId } = await answeredMidTurn();
    await settled(p, true); // the interrupt
    expect(wakes(p)).toHaveLength(0); // the user stopped: no turn
    const note = p.sendMessage.mock.calls.at(-1);
    expect((note?.[0] as { content?: string } | undefined)?.content).toMatch(
      /^Interrupted: 1 delegate answer/,
    );
    // A second interrupt does not repeat the note.
    await p.fire("agent_start", {});
    await settled(p, true);
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    // The user prompts again; that turn's settle did not show the answer (held, failed): woken.
    p.state.busy = false;
    await p.fire("agent_start", {});
    await settled(p);
    expect(wakes(p)).toHaveLength(1);
    expect((wakes(p)[0]?.[1] as object) ?? {}).toEqual({
      deliverAs: "followUp",
      triggerTurn: true,
    });
    expect(JSON.stringify(wakes(p)[0]?.[0])).toContain(callId);
  });

  it("the next settle shows it: delivered, no wake", async () => {
    const { p, handle, callId } = await answeredMidTurn();
    await settled(p, true);
    await p.fire("agent_start", {});
    handle.delivered([callId]); // the settle wait (settle lane) showed it
    await settled(p);
    expect(wakes(p)).toHaveLength(0);
  });

  it("@mu_pending keeps counting the owed answer across the interrupt until it is shown", async () => {
    const seen = await claimed();
    const { p, handle, callId } = await answeredMidTurn();
    await ticks();
    expect(seen).toEqual([set(1)]); // running, then answered: still owed, no flap
    await settled(p, true);
    await ticks();
    expect(seen).toEqual([set(1)]);
    handle.delivered([callId]);
    await ticks();
    expect(seen).toEqual([set(1), unset]);
  });
});

describe("a reload re-adopts the answers no settle delivered", () => {
  it("re-adopted, @mu_pending restored, woken; a settled one is not", async () => {
    const seen = await claimed();
    const { mu, p, callId } = await answeredMidTurn();
    await ticks();
    for (const h of p.shutdown) await h({ reason: "reload" }, { hasUI: false });
    await ticks();
    expect(seen.at(-1)).toEqual(unset); // the old runtime unsets it
    setPaneOptionRunnerForTests(null);
    const seen2 = await claimed();
    const second = fakePi();
    second.state.busy = true; // the wake queues: the count stays up
    registerDelegate(second.pi, mu.run);
    for (const h of second.handlers.get("session_start") ?? []) await h({ reason: "reload" }, ctx);
    await new Promise((r) => setImmediate(r));
    await ticks();
    expect(seen2).toEqual([set(1)]);
    expect(wakes(second)).toHaveLength(1);
    expect(JSON.stringify(wakes(second)[0]?.[0])).toContain(callId);
    // Once a settle wait delivered it into the transcript, the next runtime owes nothing.
    const c = listDelegates(mu.db)[0];
    recordCursors(mu.db, "pi:s1", [
      { key: cursorKey("delegate", c?.workstream ?? "", callId), token: SETTLE_TOKEN },
    ]);
    const third = fakePi();
    registerDelegate(third.pi, mu.run);
    for (const h of third.handlers.get("session_start") ?? []) await h({ reason: "reload" }, ctx);
    await new Promise((r) => setImmediate(r));
    await ticks();
    expect(wakes(third)).toHaveLength(0);
  });

  it("MU_NUDGE=0: the wake was the delivery, so nothing is re-adopted", async () => {
    process.env.MU_NUDGE = "0";
    try {
      const { mu, p } = await answeredMidTurn();
      for (const h of p.shutdown) await h({ reason: "reload" }, { hasUI: false });
      const second = fakePi();
      registerDelegate(second.pi, mu.run);
      for (const h of second.handlers.get("session_start") ?? [])
        await h({ reason: "reload" }, ctx);
      await new Promise((r) => setImmediate(r));
      await ticks();
      expect(wakes(second)).toHaveLength(0);
    } finally {
      const k = "MU_NUDGE";
      delete process.env[k];
    }
  });
});
