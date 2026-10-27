// A refused delegate call never started and nothing will start it: it is not owed to the settle
// wait (rr_r2_refused_settle_loop), is no wave target, and an explicit ref to it is refused.
// Real SQLite and the real engine; no agents.

import { describe, expect, it } from "vitest";
import { registerDelegateCall } from "../src/delegates.js";
import { WaitNothingError, WaitRefError, waitForEvents } from "../src/wait.js";
import { answer, delegateRef, mkDelegate, useWaitDb } from "./_wait-fixtures.js";

const env = useWaitDb();
const fast = { pollMs: 1, sync: false, timeoutMs: 30 } as const;
const refuse = (caller: string, callId: string, wave?: string): void => {
  registerDelegateCall(env.db, {
    callId,
    caller,
    workstream: "scratch",
    state: "refused",
    request: { text: "never starts" },
    ...(wave !== undefined ? { wave } : {}),
  });
};

describe("a refused delegate call is not owed", () => {
  it("a bare wait with only a refused call has nothing to wait on", async () => {
    refuse("pi:r", "refused-1");
    await expect(waitForEvents(env.db, [], { ...fast, callers: ["pi:r"] })).rejects.toBeInstanceOf(
      WaitNothingError,
    );
  });

  it("the settle after a saturated wave finishes drains, it does not heartbeat on the refused call", async () => {
    refuse("pi:r", "refused-2");
    const run = mkDelegate(env.db, "pi:r");
    answer(env.db, run);
    const first = await waitForEvents(env.db, [], { ...fast, callers: ["pi:r"] });
    expect(first.event.ref?.id).toBe(run);
    await expect(waitForEvents(env.db, [], { ...fast, callers: ["pi:r"] })).rejects.toBeInstanceOf(
      WaitNothingError,
    );
  });

  it("--wave --all completes without the refused sibling, whose tally still counts it", async () => {
    const run = mkDelegate(env.db, "pi:r", { wave: "w" });
    refuse("pi:r", "refused-3", "w");
    answer(env.db, run);
    const r = await waitForEvents(env.db, [], {
      ...fast,
      callers: ["pi:r"],
      mode: "all",
      wave: { workstream: "scratch", name: "w" },
    });
    expect(r.timedOut).not.toBe(true);
    expect(r.tally?.refused).toEqual(["refused-3"]);
  });

  it("an explicit ref to a refused call is refused with the reissue hint", async () => {
    refuse("pi:r", "refused-4");
    await expect(
      waitForEvents(env.db, [delegateRef("refused-4")], { ...fast, callers: ["pi:r"] }),
    ).rejects.toThrow(WaitRefError);
    await expect(
      waitForEvents(env.db, [delegateRef("refused-4")], { ...fast, callers: ["pi:r"] }),
    ).rejects.toThrow(/reissue/);
  });
});
