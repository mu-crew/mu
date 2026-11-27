// `@mu_pending` on the pi's own tmux pane: set on each change of the delegate
// count, unset at 0 and on shutdown, nothing outside tmux, failures swallowed.

import { afterEach, describe, expect, it } from "vitest";
import { registerDelegate } from "../extension/delegate.js";
import {
  claimPendingPaneOption,
  clearPendingPaneOption,
  ownTmuxPane,
  pendingOptionArgv,
  reportPendingPaneOption,
  setPaneOptionRunnerForTests,
} from "../extension/delegate-pane-option.js";
import { fakeMu, fakePi, flush, installDelegateEnv, ok, tool } from "./_delegate-fixtures.js";

/** Run `fn` with $TMUX/$TMUX_PANE as given (undefined: unset); _setup clears both. */
async function withEnv(
  env: { TMUX?: string; TMUX_PANE?: string; TERM_PROGRAM?: string },
  fn: () => Promise<void>,
) {
  const keys = ["TMUX", "TMUX_PANE", "TERM_PROGRAM"] as const;
  for (const k of keys) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const k of keys) delete process.env[k];
  }
}

installDelegateEnv();

const SOCK = "/tmp/tmux-501/default";
const inTmux = { TMUX: `${SOCK},123,0`, TMUX_PANE: "%7" };
const set = (n: number) => ["-S", SOCK, "set-option", "-p", "-t", "%7", "@mu_pending", String(n)];
const unset = ["-S", SOCK, "set-option", "-p", "-t", "%7", "-u", "@mu_pending"];

/** Record every set-option argv; the server answers `#{pid}` with `pid`. */
function record(fail = false, pid = "123"): string[][] {
  const seen: string[][] = [];
  setPaneOptionRunnerForTests(async (argv) => {
    if (argv[2] === "display") return `${pid}\n`;
    seen.push([...argv]);
    if (fail) throw new Error("tmux: no server");
    return "";
  });
  return seen;
}

/** A pane this pi owns, claimed and unset at start (the first entry). */
async function claimed(fail = false): Promise<string[][]> {
  const seen = record(fail);
  await claimPendingPaneOption(true);
  expect(seen.splice(0)).toEqual([unset]);
  return seen;
}

afterEach(() => setPaneOptionRunnerForTests(async () => undefined));

describe("@mu_pending pane option", () => {
  it("reads its pane from $TMUX/$TMUX_PANE and fails closed on anything else", () => {
    expect(ownTmuxPane(inTmux)).toEqual({ socket: SOCK, pane: "%7", pid: "123" });
    // The socket is everything before the last two fields: paths may hold commas.
    expect(ownTmuxPane({ TMUX: "/tmp/a,b/sock,123,0", TMUX_PANE: "%7" })).toEqual({
      socket: "/tmp/a,b/sock",
      pane: "%7",
      pid: "123",
    });
    expect(ownTmuxPane({ TMUX: "/tmp/anything", TMUX_PANE: "%7" })).toBeUndefined();
    expect(ownTmuxPane({ TMUX: `${SOCK},x,0`, TMUX_PANE: "%7" })).toBeUndefined();
    expect(ownTmuxPane({ TMUX: `${SOCK},123,`, TMUX_PANE: "%7" })).toBeUndefined();
    expect(ownTmuxPane({ ...inTmux, TERM_PROGRAM: "rex" })).toBeUndefined();
    expect(ownTmuxPane({})).toBeUndefined();
    expect(ownTmuxPane({ TMUX: inTmux.TMUX })).toBeUndefined();
    expect(ownTmuxPane({ TMUX_PANE: "%7" })).toBeUndefined();
    expect(ownTmuxPane({ TMUX: ",1,0", TMUX_PANE: "%7" })).toBeUndefined();
    expect(ownTmuxPane({ TMUX: inTmux.TMUX, TMUX_PANE: "7; rm" })).toBeUndefined();
    expect(pendingOptionArgv(SOCK, "%7", 2)).toEqual(set(2));
    expect(pendingOptionArgv(SOCK, "%7", 0)).toEqual(unset);
  });

  it("sends each change once, in order, and nothing for an unchanged count", async () => {
    await withEnv(inTmux, async () => {
      const seen = await claimed();
      await reportPendingPaneOption(1);
      await reportPendingPaneOption(1);
      await reportPendingPaneOption(2);
      await reportPendingPaneOption(0);
      await reportPendingPaneOption(0);
      expect(seen).toEqual([set(1), set(2), unset]);
    });
  });

  it("coalesces changes made while a write is in flight to the latest", async () => {
    await withEnv(inTmux, async () => {
      const seen = await claimed();
      void reportPendingPaneOption(1);
      void reportPendingPaneOption(2);
      await reportPendingPaneOption(3);
      expect(seen).toEqual([set(1), set(3)]);
    });
  });

  it("the last write wins across microtask boundaries (1 -> 0, 1 -> clear)", async () => {
    await withEnv(inTmux, async () => {
      const seen = await claimed();
      // A change right after the loop's last check must start a new write,
      // at every microtask offset, not ride a settling drain.
      for (let hop = 0; hop < 8; hop++) {
        for (const last of ["report", "clear"] as const) {
          seen.splice(0);
          const first = reportPendingPaneOption(1);
          for (let i = 0; i < hop; i++) await Promise.resolve();
          const second = last === "report" ? reportPendingPaneOption(0) : clearPendingPaneOption();
          await Promise.all([first, second]);
          for (let i = 0; i < 8; i++) await Promise.resolve();
          expect(seen.at(-1), `hop ${hop} ${last}`).toEqual(unset);
        }
      }
    });
  });

  it("a non-number count unsets instead of looping", async () => {
    await withEnv(inTmux, async () => {
      const seen = await claimed();
      await reportPendingPaneOption(2);
      await reportPendingPaneOption(Number.NaN);
      expect(seen).toEqual([set(2), unset]);
    });
  });

  it("session start unsets a predecessor's value, or writes the count already owed", async () => {
    await withEnv(inTmux, async () => {
      const seen = record();
      await claimPendingPaneOption(true);
      expect(seen).toEqual([unset]);
    });
    await withEnv(inTmux, async () => {
      const seen = record();
      void reportPendingPaneOption(2); // re-adopted before the claim
      await claimPendingPaneOption(true);
      expect(seen).toEqual([set(2)]);
    });
  });

  it("a nested pi never writes: not at start, on a change, or at shutdown", async () => {
    await withEnv(inTmux, async () => {
      const seen = record();
      await claimPendingPaneOption(false);
      await reportPendingPaneOption(2);
      await clearPendingPaneOption();
      expect(seen).toEqual([]);
    });
  });

  it("writes nothing before the claim, or when the server's pid is not $TMUX's", async () => {
    await withEnv(inTmux, async () => {
      const seen = record(false, "999");
      await reportPendingPaneOption(2);
      expect(seen).toEqual([]);
      await claimPendingPaneOption(true);
      await reportPendingPaneOption(3);
      await clearPendingPaneOption();
      expect(seen).toEqual([]);
    });
  });

  it("touches nothing outside tmux", async () => {
    await withEnv({ TMUX: undefined, TMUX_PANE: undefined }, async () => {
      const seen = record();
      await claimPendingPaneOption(true);
      await reportPendingPaneOption(2);
      await clearPendingPaneOption();
      expect(seen).toEqual([]);
    });
  });

  it("swallows a failing tmux call", async () => {
    await withEnv(inTmux, async () => {
      const seen = await claimed(true);
      await expect(reportPendingPaneOption(1)).resolves.toBeUndefined();
      await expect(clearPendingPaneOption()).resolves.toBeUndefined();
      expect(seen).toEqual([set(1), unset]);
    });
  });

  it("the delegate tool sets it while a delegate is out and unsets it when it answers", async () => {
    await withEnv(inTmux, async () => {
      const seen = await claimed();
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("t", { task: "x" });
      await flush();
      expect(seen).toEqual([set(1)]);
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "error", lastError: "x" }] }));
      await flush();
      await flush();
      expect(seen).toEqual([set(1), unset]);
    });
  });

  it("session_shutdown unsets it with a delegate still out", async () => {
    await withEnv(inTmux, async () => {
      const seen = await claimed(true);
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("t", { task: "x" });
      await flush();
      for (const h of p.shutdown) await h({}, { hasUI: true, ui: { notify: () => {} } });
      expect(seen).toEqual([set(1), unset]);
    });
  });
});
