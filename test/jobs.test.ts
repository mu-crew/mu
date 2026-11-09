// The job kinds and the pane reads (spec 2026-11-09-mu-plugins.md, D1, D8):
// each read asks the multiplexer exactly what its call sites asked before P1,
// and each built-in kind's liveness is that read, unknown kept unknown.

import { afterEach, describe, expect, it } from "vitest";
import { CarrierStopRefusedError } from "../src/carrier-stop.js";
import type { Db } from "../src/db.js";
import { gateLiveness } from "../src/jobs/gate.js";
import { gateJobRef, jobKind, jobLiveness, jobRunning } from "../src/jobs/kinds.js";
import { leaseKind } from "../src/jobs/lease.js";
import { paneUp } from "../src/jobs/pane.js";
import {
  readTmuxViews,
  sessionViews,
  viewPresent,
  viewRunning,
  viewState,
} from "../src/jobs/view.js";
import { type MuxBackend, type PaneResult, setMuxForTests, tmuxBackend } from "../src/mux.js";
import { attachCommand } from "../src/remote-agent.js";
import { installMux } from "./_mux.js";

const db = {} as unknown as Db;
let calls: string[] = [];

/** A tmux-like backend (has `paneResult`) or a herdr-like one (no `paneResult`, has `paneOccupied`). */
function install(o: {
  alive?: boolean | Error;
  result?: PaneResult | Error;
  occupied?: boolean | Error;
}): void {
  calls = [];
  const answer =
    <T>(name: string, v: T | Error) =>
    async (): Promise<T> => {
      calls.push(name);
      if (v instanceof Error) throw v;
      return v;
    };
  const backend: MuxBackend = { ...tmuxBackend, paneAlive: answer("paneAlive", o.alive ?? true) };
  if (o.result === undefined) delete backend.paneResult;
  else backend.paneResult = answer("paneResult", o.result);
  if (o.occupied !== undefined) backend.paneOccupied = answer("paneOccupied", o.occupied);
  setMuxForTests(backend);
}

const exited: PaneResult = { state: "exited", code: 2, signal: null };

afterEach(() => {
  setMuxForTests(undefined);
});

describe("view reads", () => {
  it("viewPresent is paneAlive alone, and a failed probe throws", async () => {
    install({ alive: false, result: { state: "running" } });
    expect(await viewPresent("%1")).toBe(false);
    expect(calls).toEqual(["paneAlive"]);
    install({ alive: new Error("boom") });
    await expect(viewPresent("%1")).rejects.toThrow("boom");
  });

  it("viewPresent uses the backend it is given", async () => {
    install({ alive: false });
    const given: MuxBackend = { ...tmuxBackend, paneAlive: async () => true };
    expect(await viewPresent("%1", given)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("viewState is paneResult; without it or on a throw it is unknown with why", async () => {
    install({ result: exited });
    expect(await viewState("%1")).toEqual(exited);
    install({});
    expect(await viewState("%1")).toEqual({
      state: "unknown",
      reason: "the multiplexer cannot report a pane's exit",
    });
    install({ result: new Error("server gone") });
    expect(await viewState("%1")).toEqual({ state: "unknown", reason: "mux: server gone" });
  });

  it("viewRunning: paneResult first (an exited pane is not running), never paneAlive", async () => {
    install({ alive: true, result: exited, occupied: true });
    expect(await viewRunning("%1", { occupied: true })).toBe(false);
    expect(calls).toEqual(["paneResult"]);
  });

  it("viewRunning without paneResult: paneAlive, or paneOccupied when asked", async () => {
    install({ alive: true, occupied: false });
    expect(await viewRunning("%1")).toBe(true);
    expect(calls).toEqual(["paneAlive"]);
    install({ alive: true, occupied: false });
    expect(await viewRunning("%1", { occupied: true })).toBe(false);
    expect(calls).toEqual(["paneOccupied"]);
    install({ alive: new Error("boom") });
    await expect(viewRunning("%1")).rejects.toThrow("boom");
  });

  it("readTmuxViews: one list-panes -a; a pane it did not list is absent", async () => {
    const mux = installMux("tmux", [["list-panes -a", "%1\tworking\t1700000000\n%2\t\t\n"]]);
    try {
      const view = await readTmuxViews();
      expect(view("%1")).toEqual({
        state: "present",
        murmurState: "working",
        murmurSince: "1700000000",
      });
      expect(view("%2")).toEqual({ state: "present", murmurState: "", murmurSince: "" });
      expect(view("%3")).toEqual({ state: "absent" });
      expect(mux.calls.filter((c) => c.includes("list-panes"))).toHaveLength(1);
    } finally {
      mux.restore();
    }
  });

  it("sessionViews is the backend's listPanes for that session", async () => {
    install({});
    const given: MuxBackend = {
      ...tmuxBackend,
      listPanes: async (s) => (s === "mu-a" ? [{ paneId: "%1" } as never] : []),
    };
    expect((await sessionViews("mu-a", given)).map((p) => p.paneId)).toEqual(["%1"]);
    expect(await sessionViews("mu-b", given)).toEqual([]);
  });

  it("paneUp is viewRunning with occupancy, undefined when the mux cannot say", async () => {
    install({ alive: true, occupied: false });
    expect(await paneUp("%1")).toBe(false);
    install({ result: new Error("boom") });
    expect(await paneUp("%1")).toBeUndefined();
  });
});

describe("job kinds", () => {
  it("every built-in kind is bound; pane and gate handles are the pane, lease's a file", () => {
    expect(jobKind("pane").caps).toEqual({ view: "bound", handle: "pane" });
    expect(jobKind("gate").caps).toEqual({ view: "bound", handle: "pane" });
    expect(jobKind("lease").caps).toEqual({ view: "bound", handle: "file" });
  });

  it("pane: paneUp as liveness", async () => {
    const pane = { kind: "pane", viewPaneId: "%1" } as const;
    install({ result: { state: "running" } });
    expect(await jobLiveness(db, pane)).toEqual({ state: "running" });
    install({ alive: true, occupied: false });
    expect(await jobLiveness(db, pane)).toEqual({ state: "lost", reason: "pane gone" });
    install({ result: new Error("boom") });
    expect((await jobLiveness(db, pane)).state).toBe("unknown");
  });

  it("lease: the carrier pane runs (viewRunning, no occupancy)", async () => {
    const lease = { kind: "lease", viewPaneId: "%1" } as const;
    install({ result: exited });
    expect(await jobLiveness(db, lease)).toEqual({
      state: "lost",
      reason: "carrier pane not running",
    });
    install({ alive: true, occupied: false });
    expect(await jobRunning(db, lease)).toBe(true);
    expect(calls).toEqual(["paneAlive"]);
    install({ result: new Error("boom") });
    expect(await jobLiveness(db, lease)).toEqual({ state: "unknown", reason: "mux: boom" });
    await expect(jobRunning(db, lease)).rejects.toThrow("mux: boom");
  });

  it("lease: stop is runStop on the recorded fence; attach is the attach template", async () => {
    const job = { kind: "lease", viewPaneId: "%1", handle: "not a handle!", host: { name: "h" } };
    await expect(leaseKind.stop(db, { ...job, kind: "lease" })).rejects.toThrow(
      CarrierStopRefusedError,
    );
    expect(leaseKind.attach).toBe(attachCommand);
  });

  it("gate: the pane first; a gone pane is lost, a row without a token unknown", async () => {
    const agent = {
      workstreamName: "ws",
      name: "g1",
      incarnation: 7,
      paneId: "%1",
      gateToken: "00000000-0000-0000-0000-000000000000",
      host: "h",
    };
    install({ result: { state: "running" } });
    expect(await jobLiveness(db, gateJobRef(agent))).toEqual({ state: "running" });
    install({ result: { state: "absent" } });
    expect(await jobLiveness(db, gateJobRef(agent))).toEqual({
      state: "lost",
      reason: "pane gone",
    });
    install({});
    expect(await jobLiveness(db, gateJobRef(agent))).toEqual({
      state: "unknown",
      reason: "the multiplexer cannot report a pane's exit",
    });
    expect(await jobLiveness(db, gateJobRef({ ...agent, gateToken: null }))).toEqual({
      state: "unknown",
      reason: "not a remote command gate",
    });
  });

  it("gate readings map to liveness one to one", () => {
    expect(gateLiveness({ kind: "running" })).toEqual({ state: "running" });
    expect(gateLiveness({ kind: "exited", code: 3 })).toEqual({ state: "ended", exit: 3 });
    expect(gateLiveness({ kind: "dead", reason: "x" })).toEqual({ state: "lost", reason: "x" });
    expect(gateLiveness({ kind: "unknown", reason: "y" })).toEqual({
      state: "unknown",
      reason: "y",
    });
  });
});
