// Characterisation for a7_wait_drain_rca (dogfood-switch F2; linuxpc crew-mu 2026-11-04).
// Pins TODAY's behaviour, not the wanted one: every wait delivers exactly ONE ready owned
// delegate report, also when it names an explicit target that is not ready, so N finished
// answers take N waits before the wait reaches the thing it was asked about. The `--wave
// --all` case pins the one path that already drains a wave in one result. A fix that changes
// the one-per-call rule must flip the marked expectations, never lose an answer (every call
// is still delivered exactly once). Real SQLite; no agents.

import { describe, expect, it } from "vitest";
import { type WaitResult, waitForEvents } from "../src/wait.js";
import { answer, mkDelegate, mkTask, taskRef, useWaitDb } from "./_wait-fixtures.js";

const env = useWaitDb();
const base = { pollMs: 1, sync: false, callers: ["pi:s"], timeoutMs: 30 } as const;
const label = (r: WaitResult): string =>
  r.event.ref === null ? r.event.kind : `${r.event.kind}:${r.event.ref.id}`;

describe("owned delegate reports come one per wait (current behaviour, a7_wait_drain_rca)", () => {
  it("an explicit wait on an open task returns each finished owned answer first, one per call", async () => {
    mkTask(env.db, "t");
    const calls = [1, 2, 3].map(() => mkDelegate(env.db, "pi:s"));
    for (const c of calls) answer(env.db, c);
    const got: string[] = [];
    for (let i = 0; i < 4; i++) got.push(label(await waitForEvents(env.db, [taskRef("t")], base)));
    // CURRENT: three waits on task:w/t end on unrelated answers before the target is even
    // considered (src/wait.ts select: urgency(delegate)=3 outranks target-ness; first = ready[0]).
    expect(got).toEqual([...calls.map((c) => `delegate:${c}`), "heartbeat"]);
  });

  it("--all on an explicit target: an owned answer is urgent, still one per call", async () => {
    mkTask(env.db, "t");
    const calls = [1, 2].map(() => mkDelegate(env.db, "pi:s"));
    for (const c of calls) answer(env.db, c);
    const opts = { ...base, mode: "all" } as const;
    const got: string[] = [];
    for (let i = 0; i < 3; i++) got.push(label(await waitForEvents(env.db, [taskRef("t")], opts)));
    // CURRENT: src/wait.ts select, `urgent` = a non-target delegate ends --all early.
    expect(got).toEqual([...calls.map((c) => `delegate:${c}`), "heartbeat"]);
  });

  it("--wave (first) with every call answered: one call per wait, the tally already 3/3", async () => {
    const calls = [1, 2, 3].map(() => mkDelegate(env.db, "pi:s", { wave: "rv" }));
    for (const c of calls) answer(env.db, c);
    const opts = { ...base, wave: { name: "rv" } } as const;
    const got: WaitResult[] = [];
    for (let i = 0; i < 4; i++) got.push(await waitForEvents(env.db, [], opts));
    // CURRENT: the linuxpc `for i in 1..5; mu wait --wave refute-adopt` loop.
    expect(got.map(label)).toEqual([...calls.map((c) => `delegate:${c}`), "heartbeat"]);
    expect(got[0]?.delivered.map((r) => r.id)).toEqual([calls[0]]);
  });

  it("--wave --all drains the wave in ONE result: every call delivered, none owed after", async () => {
    const calls = [1, 2, 3].map(() => mkDelegate(env.db, "pi:s", { wave: "rv" }));
    for (const c of calls) answer(env.db, c);
    const opts = { ...base, wave: { name: "rv" }, mode: "all" } as const;
    const r = await waitForEvents(env.db, [], opts);
    expect(r.event.kind).toBe("delegate");
    // Consumes beyond the one `firing` names: all three, each in the snapshots it printed.
    expect(r.delivered.map((d) => d.id).sort()).toEqual([...calls].sort());
    const shown = r.refs.filter((s) => s.ref.kind === "delegate" && s.fired);
    expect(shown.map((s) => s.ref.id).sort()).toEqual([...calls].sort());
    expect(label(await waitForEvents(env.db, [], { ...base, wave: { name: "rv" } }))).toBe(
      "heartbeat",
    );
  });

  it("--wave --all: an owned answer of ANOTHER wave still preempts it, one per call", async () => {
    const other = mkDelegate(env.db, "pi:s", { wave: "old" });
    answer(env.db, other);
    const calls = [1, 2].map(() => mkDelegate(env.db, "pi:s", { wave: "rv" }));
    for (const c of calls) answer(env.db, c);
    const opts = { ...base, wave: { name: "rv" }, mode: "all" } as const;
    const first = await waitForEvents(env.db, [], opts);
    // CURRENT: the non-target owned delegate is `urgent` under --all and fires alone.
    expect(label(first)).toBe(`delegate:${other}`);
    expect(first.delivered.map((d) => d.id)).toEqual([other]);
    const second = await waitForEvents(env.db, [], opts);
    expect(second.delivered.map((d) => d.id).sort()).toEqual([...calls].sort());
  });
});
