// A provider host's deadline and collects in mu's own reads (plugins spec D10),
// over the fake plugin as a provider whose agents use its channel; the
// multiplexer is a stub. What holds:
//   - a fully watched wait (no polling) wakes at deadline_at − margin and fires
//     the urgent `deadline` event (exit 7) naming the agent, once per host per
//     deadline (a later wait waits on; a new deadline fires again, at once inside
//     its margin); with no deadline nothing changes;
//   - a settle's in-life collect that fails backs off: a warning, collect_next_at
//     set, final_owed untouched; a settle inside the backoff skips;
//   - `mu state`'s notices: an owed final collect of a stopped job, and the
//     deadline margin naming collect and close; none for a plain workstream.

import { afterEach, describe, expect, it } from "vitest";
import { bumpStopGen, getCarrierJobByAgent } from "../src/carrier-jobs.js";
import { collectAtSettles } from "../src/host-policy.js";
import { computeNotices } from "../src/next-hints.js";
import { type AgentReading, type WaitRef, type WaitResult, waitForEvents } from "../src/wait.js";
import { ensureWorkstream } from "../src/workstream.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();
const MARGIN = "MU_HOST_DEADLINE_MARGIN_MS";
const REF: WaitRef = { kind: "agent", workstream: "ws", id: "w1", afterRuns: 0 };
const BUSY: AgentReading = { status: "busy", runs: 0 };

afterEach(() => {
  delete process.env[MARGIN];
});

/** A wait whose only ref is watched (a settle that never comes): it never polls. */
const watched = (timeoutMs: number) =>
  waitForEvents(h.db, [REF], {
    callers: [],
    eventScope: "refs",
    timeoutMs,
    sync: false,
    readAgents: async () => new Map([["ws/w1", BUSY]]),
    watchAgent: async () => ({ initial: BUSY, afterRuns: 0, settled: new Promise(() => {}) }),
  });

describe("the wait's deadline timer (D10)", () => {
  it("a fully watched wait wakes at deadline_at − margin with an urgent deadline", async () => {
    const deadlineAt = Date.now() + 3_600_000;
    await h.setup({}, { hostFacts: { deadlineAt } });
    await h.spawn();
    process.env[MARGIN] = String(deadlineAt - Date.now() - 300);
    const t0 = Date.now();
    const r = await watched(10_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.event).toEqual({ kind: "deadline", ref: REF });
    expect(r.exit).toBe(7);
    expect(r.timedOut).toBe(false);
    expect(r.delivered).toEqual([]);
    // Once per host per deadline (review of P6e2, ruling 3): the next wait waits on.
    expect((await watched(300)).event.kind).toBe("heartbeat");
    // A new deadline is a new margin entry: inside it, at once.
    h.db.prepare("UPDATE hosts SET deadline_at = deadline_at + 1000").run();
    const t1 = Date.now();
    expect((await watched(10_000)).event.kind).toBe("deadline");
    expect(Date.now() - t1).toBeLessThan(2_000);
  });

  it("without a deadline the same wait times out as before", async () => {
    await h.setup();
    await h.spawn();
    const r = await watched(200);
    expect(r.event.kind).toBe("heartbeat");
    expect(r.timedOut).toBe(true);
  });
});

describe("in-life collects at an observed settle (D10)", () => {
  it("a failed collect warns and backs off; final_owed is untouched; inside the backoff it skips", async () => {
    await h.setup({}, { hostFacts: { deadlineAt: Date.now() + 3_600_000 } });
    const a = await h.spawn();
    // A tree and a collect repo the link cannot fetch from: the collect fails.
    h.db
      .prepare(
        "UPDATE carrier_jobs SET tree_path = ?, collect_repo = ?, final_owed = 1 WHERE agent_id = ?",
      )
      .run("/nowhere/tree", h.dir, a.incarnation);
    const settled: Pick<WaitResult, "event" | "refs"> = {
      event: { kind: "settled", ref: REF },
      refs: [{ ref: REF, status: "idle", settled: true, fired: true, dead: false }],
    };
    const warned = await collectAtSettles(h.db, settled, 1000);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/in-life collect of ws\/w1 failed .*mu agent collect w1 -w ws/);
    const job = getCarrierJobByAgent(h.db, a.incarnation);
    expect(job?.collectNextAt).toBeGreaterThan(Date.now());
    expect(job?.collectDelayMs).toBe(1000);
    expect(job?.finalOwed).toBe(true);
    expect(await collectAtSettles(h.db, settled, 1000)).toEqual([]);
    // A ref the wait did not fire collects nothing.
    const idle = { ...settled, refs: [{ ...settled.refs[0], fired: false }] } as typeof settled;
    expect(await collectAtSettles(h.db, idle, 1000)).toEqual([]);
  });
});

describe("mu state's host notices (D10)", () => {
  it("an owed final collect of a stopped job, and the deadline margin naming collect and close", async () => {
    const deadlineAt = Date.now() + 3_600_000;
    await h.setup({}, { hostFacts: { deadlineAt } });
    const a = await h.spawn();
    expect(computeNotices(h.db, { callers: [], workstream: "ws" })).toEqual([]);
    const job = getCarrierJobByAgent(h.db, a.incarnation);
    h.db.prepare("UPDATE carrier_jobs SET final_owed = 1 WHERE token = ?").run(job?.token);
    // A live job owes its final collect from its creation: no notice until it is stopped.
    expect(computeNotices(h.db, { callers: [], workstream: "ws" })).toEqual([]);
    bumpStopGen(h.db, job?.token ?? "");
    process.env[MARGIN] = String(deadlineAt - Date.now() + 1000);
    expect(computeNotices(h.db, { callers: [], workstream: "ws" })).toEqual([
      "final collect owed: ws/w1's job on box: mu agent collect w1 -w ws",
      `host box reaches its deadline at ${new Date(deadlineAt).toISOString()}: collect and close w1: mu agent collect w1 -w ws; mu agent close w1 -w ws`,
    ]);
    ensureWorkstream(h.db, "plain");
    expect(computeNotices(h.db, { callers: [], workstream: "plain" })).toEqual([]);
  });
});
