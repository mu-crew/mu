// The wire state machine of a file kind's job record (src/carrier-wire.ts, ladder placement
// §10), driven on a real SQLite record with a deterministic schedule: two paths decide on the
// SAME snapshot (one revision), then commit in a fixed order. Every ordered pair of
// transitions legal from a state is run both ways; the second always lost when the first
// moved the record, and a lost transition leaves the record and the job file untouched. Two
// exceptions, by design: `--abandon-job` (the operator's override, from any state and
// revision) and a second `begin release` (its proof was on the same revision, and a released
// record opens no view again: a close resuming a rollback's release).

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abandonCarrierJob,
  type CarrierJob,
  fillCarrierJob,
  getCarrierJob,
  releaseCarrierJob,
  reserveCarrierJob,
  type WireState,
} from "../src/carrier-jobs.js";
import {
  beginRelease,
  bindView,
  claimJobFile,
  dispatchView,
  markFileJobLaunch,
  removeJobFile,
  unbindView,
} from "../src/carrier-wire.js";
import { type Db, openDb } from "../src/db.js";
import { proveViewGone } from "../src/host-policy.js";
import { type MuxBackend, tmuxBackend } from "../src/mux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcw-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "ws");
  file = join(dir, "w1.job");
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

const SERVER = "tmux:1|1";

/** A file kind's record in `state`, holding job-1 (published in its job file). */
function recordIn(state: WireState | null): CarrierJob {
  db.prepare("DELETE FROM carrier_jobs").run();
  const r = reserveCarrierJob(db, {
    workstream: "ws",
    name: "w1",
    host: "box",
    hostStop: null,
    plugin: { kind: "k", name: "fake" },
  });
  if (r === undefined) throw new Error("not reserved");
  fillCarrierJob(db, r.token, "job-1");
  writeFileSync(file, "job-1\n");
  const at = () => getCarrierJob(db, r.token) as CarrierJob;
  if (state === "dispatching" || state === "bound") dispatchView(db, at());
  if (state === "bound") bindView(db, at(), "%1", SERVER);
  if (state === "released") beginRelease(db, at());
  if (state === null) {
    db.prepare("UPDATE carrier_jobs SET wire_state = NULL WHERE token = ?").run(r.token);
  }
  const now = at();
  expect(now.wireState).toBe(state);
  return now;
}

/** Each transition on snapshot `r`: whether it took (the record and the file as it says). */
const transitions: Record<string, (r: CarrierJob) => boolean> = {
  "claim file": (r) => claimJobFile(db, r, file) !== undefined,
  "dispatch (spawn)": (r) => dispatchView(db, r) !== undefined,
  "dispatch (reattach)": (r) => dispatchView(db, r, ["claimed", "bound"]) !== undefined,
  bind: (r) => bindView(db, r, "%2", SERVER) !== undefined,
  unbind: (r) => unbindView(db, r, "%1") !== undefined,
  "begin release": (r) => beginRelease(db, r) !== undefined,
  "remove file": (r) => removeJobFile(db, r, file, "job-1") !== undefined,
  "finish release": (r) => releaseCarrierJob(db, r),
  abandon: (r) => abandonCarrierJob(db, r),
};
const names = Object.keys(transitions);

/** From each state, on a fresh snapshot: which transitions take. */
const legal: Record<string, string[]> = {
  claimed: [
    "claim file",
    "dispatch (spawn)",
    "dispatch (reattach)",
    "begin release",
    "remove file",
    "finish release",
    "abandon",
  ],
  dispatching: ["bind", "abandon"],
  bound: ["dispatch (reattach)", "unbind", "begin release", "abandon"],
  released: ["begin release", "remove file", "finish release", "abandon"],
  // A record older than the column: no state moves; only a lease's file and release (whose
  // close proves its pane by the row rule) and the operator's abandon. A file kind's close
  // never gets there: its proof is unknown.
  legacy: ["remove file", "finish release", "abandon"],
};
const stateOf = (s: string): WireState | null => (s === "legacy" ? null : (s as WireState));

/** The record and the file, as a lost transition must leave them. */
const observe = (token: string) => ({
  row: getCarrierJob(db, token),
  file: existsSync(file) ? readFileSync(file, "utf8") : undefined,
  aside: readdirSync(dir).filter((n) => n.includes(".stale-")).length,
});

describe("each state's legal transitions", () => {
  for (const [state, ok] of Object.entries(legal)) {
    it.each(names)(`${state}: %s`, (t) => {
      const r = recordIn(stateOf(state));
      const before = observe(r.token);
      const took = transitions[t]?.(r) ?? false;
      expect(took).toBe(ok.includes(t));
      if (!took) expect(observe(r.token)).toEqual(before);
    });
  }
});

describe("every pair decided on one revision, committed in order", () => {
  const pairs = Object.entries(legal).flatMap(([state, ok]) =>
    ok.flatMap((first) => ok.map((second) => ({ state, first, second }))),
  );
  it.each(pairs)(
    "$state: $first, then $second on the same snapshot",
    ({ state, first, second }) => {
      const snap = recordIn(stateOf(state));
      expect(transitions[first]?.(snap)).toBe(true);
      const mid = getCarrierJob(db, snap.token);
      const moved = mid === undefined || mid.wireRev !== snap.wireRev;
      const before = observe(snap.token);
      const took = transitions[second]?.(snap) ?? false;
      if (mid !== undefined && second === "abandon") expect(took).toBe(true);
      else if (mid?.wireState === "released" && second === "begin release") expect(took).toBe(true);
      else if (moved) {
        // The first moved the record: the second's decision is stale and loses, touching nothing.
        expect(took).toBe(false);
        expect(observe(snap.token)).toEqual(before);
      } else {
        // The first acted without moving it (a file removal, a resumed release): the second is
        // as legal as on a fresh read of the same state.
        expect(mid?.wireState).toBe(snap.wireState);
        expect(took).toBe(legal[state]?.includes(second));
      }
    },
  );
});

describe("the file is touched only by the revision's owner", () => {
  it("a claim moves an earlier reservation's file aside, inside the transition", () => {
    const r = recordIn("claimed");
    expect(claimJobFile(db, r, file)?.moved?.read).toEqual({ kind: "handle", job: "job-1" });
    expect(existsSync(file)).toBe(false);
  });

  it("a released reservation's late claim leaves its replacement's file alone", () => {
    const stale = recordIn("claimed");
    expect(releaseCarrierJob(db, stale)).toBe(true);
    const next = recordIn("claimed");
    writeFileSync(file, "job-2\n");
    expect(claimJobFile(db, stale, file)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("job-2\n");
    expect(getCarrierJob(db, next.token)).toBeDefined();
  });

  it("removal keeps a file naming another handle", () => {
    const r = recordIn("released");
    writeFileSync(file, "job-2\n");
    expect(removeJobFile(db, r, file, "job-1")).toEqual({ kept: "handle job-2" });
    expect(existsSync(file)).toBe(true);
  });
});

describe("the view proof", () => {
  /** A mux whose server is `id` and whose live panes are `panes`. */
  const mux = (id: string | undefined, panes: string[]): MuxBackend => ({
    ...tmuxBackend,
    serverIdentity: async () => id,
    paneAlive: async (p) => panes.includes(typeof p === "string" ? p : p.paneId),
    // The server-fenced probe: another identity (or none) answering is foreign.
    paneOnServer: async (p, identity) =>
      identity !== id ? "foreign" : panes.includes(p) ? "present" : "absent",
  });
  const bound = (server: string | null) => {
    const r = recordIn("dispatching");
    bindView(db, r, "%1", server);
    return getCarrierJob(db, r.token) as CarrierJob;
  };
  const live = `tmux:${process.pid}|1`;

  it.each([
    { state: "claimed", want: "gone" },
    { state: "released", want: "gone" },
    { state: "dispatching", want: "unknown" },
    { state: "legacy", want: "unknown" },
  ])("$state: $want", async ({ state, want }) => {
    const r = recordIn(stateOf(state));
    expect((await proveViewGone(r, mux("1|1", []))).state).toBe(want);
  });

  it("bound: asked of its server only; gone there is gone, alive is alive", async () => {
    expect((await proveViewGone(bound(live), mux(`${process.pid}|1`, []))).state).toBe("gone");
    expect((await proveViewGone(bound(live), mux(`${process.pid}|1`, ["%1"]))).state).toBe("alive");
  });

  // wire_view_proof_wrong_mux_server, fast tier: another MU_TMUX_SOCKET has no such pane.
  it("bound on a live server this mu does not drive: unknown, whatever the other answers", async () => {
    const p = await proveViewGone(bound(live), mux(undefined, []));
    expect(p).toMatchObject({ state: "unknown", why: expect.stringMatching(/does not drive/) });
    expect((await proveViewGone(bound(live), mux("7|7", []))).state).toBe("unknown");
  });

  // pane_file_view_provenance_aba: a recycled %1 on a restarted server is not the record's view.
  it("bound on a server whose process is gone: gone, even with a live %1 on today's server", async () => {
    const dead = "tmux:999999|1";
    expect((await proveViewGone(bound(dead), mux("8|8", ["%1"]))).state).toBe("gone");
  });

  it("bound with no recorded server (its birth server changed or did not answer): unknown", async () => {
    const p = await proveViewGone(bound(null), mux("1|1", []));
    expect(p).toMatchObject({ state: "unknown", why: expect.stringMatching(/no recorded mux/) });
  });

  // wire_view_backend_name_is_not_server: a backend name is no server identity.
  it("a server recorded by backend name alone, or on another backend, is unknown", async () => {
    const herdr = {
      ...mux(undefined, []),
      name: "herdr",
      serverIdentity: undefined,
      paneOnServer: undefined,
    } as never;
    expect((await proveViewGone(bound("herdr"), herdr)).state).toBe("unknown");
    expect((await proveViewGone(bound("rex"), herdr)).state).toBe("unknown");
    expect((await proveViewGone(bound("rex:i-1"), mux("i-1", []))).state).toBe("unknown");
  });

  // D15 (wire_rex_presence_and_birth_aba): Rex's "absent" is not tied to the server that
  // answered it, so a view on a backend without carrierViews is never proven gone there.
  it("bound on a backend without carrierViews: unknown, even when its server answers absent", async () => {
    const rex = { ...mux("i-1", []), name: "rex", carrierViews: false } as MuxBackend;
    const p = await proveViewGone(bound("rex:i-1"), rex);
    expect(p).toMatchObject({ state: "unknown", why: expect.stringMatching(/tmux-only/) });
    expect((await proveViewGone(bound("rex:i-1"), { ...rex, carrierViews: true })).state).toBe(
      "gone",
    );
  });
});

// wire_rev is nullable: an ADD COLUMN on an old DB (or a copy without the default) may leave
// NULL. Every read and compare-and-swap takes NULL as revision 0.
describe("a record whose wire_rev is NULL", () => {
  const nullRev = (state: WireState | null): CarrierJob => {
    const r = recordIn(state);
    db.prepare("UPDATE carrier_jobs SET wire_rev = NULL WHERE token = ?").run(r.token);
    const raw = db.prepare("SELECT wire_rev FROM carrier_jobs WHERE token = ?").get(r.token);
    expect(raw).toEqual({ wire_rev: null });
    const now = getCarrierJob(db, r.token) as CarrierJob;
    expect(now.wireRev).toBe(0);
    return now;
  };

  it("goes through a full lease: claim, start intent, dispatch, bind, release, file, delete", () => {
    const r = nullRev("claimed");
    const claim = claimJobFile(db, r, file);
    expect(claim?.rev).toBe(1);
    expect(claim?.moved?.read).toMatchObject({ kind: "handle", job: "job-1" });
    writeFileSync(file, "job-1\n");
    const stale = { token: r.token, wireRev: 0 };
    expect(markFileJobLaunch(db, stale, "i-1")).toBeUndefined();
    const launched = markFileJobLaunch(db, { token: r.token, wireRev: 1 }, "i-1");
    expect(launched).toBe(2);
    const dispatched = dispatchView(db, { token: r.token, wireRev: 2 });
    expect(dispatched).toBe(3);
    const bound = bindView(db, { token: r.token, wireRev: 3 }, "%1", SERVER);
    expect(bound).toBe(4);
    expect(getCarrierJob(db, r.token)).toMatchObject({
      wireState: "bound",
      paneId: "%1",
      viewServer: SERVER,
      launch: "intent",
      instance: "i-1",
    });
    const released = beginRelease(db, { token: r.token, wireRev: 4 });
    expect(released).toBe(5);
    expect(removeJobFile(db, { token: r.token, wireRev: 5 }, file, "job-1")).toBe("removed");
    expect(existsSync(file)).toBe(false);
    const done = getCarrierJob(db, r.token) as CarrierJob;
    expect(releaseCarrierJob(db, done)).toBe(true);
    expect(getCarrierJob(db, r.token)).toBeUndefined();
  });

  it("an older record (no state, NULL revision) still releases as a lease", () => {
    const r = nullRev(null);
    expect(removeJobFile(db, r, file, "job-1")).toBe("removed");
    expect(releaseCarrierJob(db, r)).toBe(true);
    expect(getCarrierJob(db, r.token)).toBeUndefined();
  });

  it("a released record at NULL resumes its release at revision 0", () => {
    const r = recordIn("released");
    db.prepare("UPDATE carrier_jobs SET wire_rev = NULL WHERE token = ?").run(r.token);
    expect(beginRelease(db, { token: r.token, wireRev: 0 })).toBe(0);
  });
});
