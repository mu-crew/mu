// Host channels (v_host_profiles): max_sessions admission, holder identity and
// reclamation. Independent DB connections stand in for separate mu processes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  addHost,
  bindHostChannel,
  HostChannelBusyError,
  listHostChannels,
  releaseHostChannel,
  releaseHostChannelsForAgent,
  reserveHostChannel,
  withHostChannel,
} from "../src/hosts.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let path: string;
let dbs: Db[];
const conn = (): Db => {
  const d = openDb({ path });
  dbs.push(d);
  return d;
};
const profile = (name: string, max: number | null) => ({
  name,
  shell: "s",
  exec: "e",
  fetch: "f",
  repo: "/r",
  max_sessions: max,
});
const holders = (db: Db, host = "dev"): string[] =>
  listHostChannels(db, host)
    .map((c) => c.holder)
    .sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-host-chan-"));
  path = join(dir, "mu.db");
  dbs = [];
});
afterEach(() => {
  for (const d of dbs) {
    try {
      d.close();
    } catch {}
  }
  rmFixtureDir(dir);
});

/** A pid that certainly no longer exists. */
function deadPid(): number {
  const r = spawnSync("true");
  return r.pid;
}

describe("admission", () => {
  it("cap 1: a second holder is refused with one line naming the first", async () => {
    const db = conn();
    addHost(db, profile("dev", 1));
    await withHostChannel(db, "dev", "exec:worker-1", async () => {
      const err = await withHostChannel(db, "dev", "fetch:worker-2", async () => "ran").catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(HostChannelBusyError);
      expect(err.message).not.toContain("\n");
      expect(err.message).toContain("exec:worker-1");
      expect(err.message).toContain("dev");
    });
    expect(await withHostChannel(db, "dev", "fetch:worker-2", async () => "ran")).toBe("ran");
  });

  it("cap 2 admits two and refuses the third; no cap admits all", async () => {
    const db = conn();
    addHost(db, profile("dev", 2));
    addHost(db, profile("free", null));
    const a = await reserveHostChannel(db, "dev", "a");
    const b = await reserveHostChannel(db, "dev", "b");
    await expect(reserveHostChannel(db, "dev", "c")).rejects.toBeInstanceOf(HostChannelBusyError);
    expect(releaseHostChannel(db, a)).toBe(true);
    await reserveHostChannel(db, "dev", "c");
    expect(holders(db)).toEqual(["b", "c"]);
    for (const h of ["x", "y", "z"]) await reserveHostChannel(db, "free", h);
    expect(holders(db, "free")).toEqual(["x", "y", "z"]);
    expect(releaseHostChannel(db, b)).toBe(true);
  });

  it("a cap is per host", async () => {
    const db = conn();
    addHost(db, profile("dev", 1));
    addHost(db, profile("other", 1));
    await reserveHostChannel(db, "dev", "a");
    await reserveHostChannel(db, "other", "a");
  });

  it("an unknown host is not found", async () => {
    await expect(reserveHostChannel(conn(), "nope", "a")).rejects.toThrow(/nope/);
  });

  it("releases in finally, on success and on failure", async () => {
    const db = conn();
    addHost(db, profile("dev", 1));
    await withHostChannel(db, "dev", "a", async () => 1);
    await expect(
      withHostChannel(db, "dev", "a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(holders(db)).toEqual([]);
  });

  it("independent connections racing at cap 2 admit exactly two", async () => {
    addHost(conn(), profile("dev", 2));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => reserveHostChannel(conn(), "dev", `h${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(HostChannelBusyError);
    }
    expect(holders(conn())).toHaveLength(2);
  });

  it("does not hold the write lock while the template runs", async () => {
    const db = conn();
    addHost(db, profile("dev", null));
    const other = conn();
    await withHostChannel(db, "dev", "a", async () => {
      const t = Date.now();
      other.exec("BEGIN IMMEDIATE; COMMIT");
      expect(Date.now() - t).toBeLessThan(500);
    });
  });
});

describe("holder identity: nested and same-holder calls", () => {
  it("the same holder is never admitted twice, and the refused call releases nothing of the first", async () => {
    const db = conn();
    addHost(db, profile("dev", null));
    const first = await reserveHostChannel(db, "dev", "exec:x");
    await expect(reserveHostChannel(conn(), "dev", "exec:x")).rejects.toBeInstanceOf(
      HostChannelBusyError,
    );
    expect(holders(db)).toEqual(["exec:x"]);
    // The refused call's failure path ran withHostChannel's finally: the first lease survives.
    await expect(withHostChannel(db, "dev", "exec:x", async () => 1)).rejects.toBeInstanceOf(
      HostChannelBusyError,
    );
    expect(holders(db)).toEqual(["exec:x"]);
    expect(releaseHostChannel(db, first)).toBe(true);
    expect(holders(db)).toEqual([]);
  });

  it("release is by token: a stale lease cannot free its replacement", async () => {
    const db = conn();
    addHost(db, profile("dev", null));
    const old = await reserveHostChannel(db, "dev", "h");
    expect(releaseHostChannel(db, old)).toBe(true);
    const fresh = await reserveHostChannel(db, "dev", "h");
    expect(releaseHostChannel(db, old)).toBe(false);
    expect(holders(db)).toEqual(["h"]);
    expect(releaseHostChannel(db, fresh)).toBe(true);
  });

  it("nested: a different holder is a second channel (refused at cap 1, admitted at cap 2); an inner failure keeps the outer", async () => {
    const db = conn();
    addHost(db, profile("one", 1));
    addHost(db, profile("two", 2));
    await withHostChannel(db, "one", "outer", async () => {
      await expect(withHostChannel(db, "one", "inner", async () => 1)).rejects.toThrow(/outer/);
    });
    await withHostChannel(db, "two", "outer", async () => {
      await expect(
        withHostChannel(db, "two", "inner", async () => {
          throw new Error("inner fails");
        }),
      ).rejects.toThrow("inner fails");
      expect(holders(db, "two")).toEqual(["outer"]);
    });
    expect(holders(db, "two")).toEqual([]);
  });
});

describe("reclaiming dead holders (fail closed)", () => {
  const insert = (db: Db, holder: string, pid: number, start: string | null = null): void => {
    db.prepare(
      "INSERT INTO host_channels (host, holder, kind, token, pid, pid_start, opened_at) VALUES ('dev', ?, 'transient', 'tok', ?, ?, '2000-01-01T00:00:00Z')",
    ).run(holder, pid, start);
  };

  it("a holder whose pid is gone (ESRCH) is reclaimed", async () => {
    const db = conn();
    addHost(db, profile("dev", 1));
    insert(db, "ghost", deadPid());
    await reserveHostChannel(db, "dev", "new");
    expect(holders(db)).toEqual(["new"]);
  });

  it("a live pid is kept however old the row is (never stale-time guessed)", async () => {
    const db = conn();
    addHost(db, profile("dev", 1));
    insert(db, "live", process.pid);
    await expect(reserveHostChannel(db, "dev", "new")).rejects.toThrow(/live/);
    expect(holders(db)).toEqual(["live"]);
  });

  it("a pid we may not signal (EPERM, pid 1) is kept", async () => {
    const db = conn();
    addHost(db, profile("dev", 1));
    insert(db, "init", 1);
    await expect(reserveHostChannel(db, "dev", "new")).rejects.toThrow(/init/);
  });

  it.runIf(existsSync("/proc/self/stat"))(
    "a reused pid (start time differs) is reclaimed",
    async () => {
      const db = conn();
      addHost(db, profile("dev", 1));
      insert(db, "reused", process.pid, "1");
      await reserveHostChannel(db, "dev", "new");
      expect(holders(db)).toEqual(["new"]);
    },
  );

  it("the reservation records this process's pid", async () => {
    const db = conn();
    addHost(db, profile("dev", null));
    await reserveHostChannel(db, "dev", "me");
    expect(listHostChannels(db, "dev")[0]).toMatchObject({
      holder: "me",
      kind: "transient",
      pid: process.pid,
    });
  });
});

describe("attached channels ride a pane, not an invocation", () => {
  const live = new Map<string, boolean | "throw">();
  const paneAlive = async (p: string): Promise<boolean> => {
    const v = live.get(p);
    if (v === "throw") throw new Error("mux unreachable");
    return v ?? false;
  };
  beforeEach(() => live.clear());

  async function attach(db: Db, holder: string, agentId: number, pane: string) {
    const lease = await reserveHostChannel(db, "dev", holder);
    expect(bindHostChannel(db, lease, { agentId, paneId: pane })).toBe(true);
    return lease;
  }

  it("bind transfers the reservation to agent id + pane (no pid), and it still counts", async () => {
    const db = conn();
    addHost(db, profile("dev", 1));
    live.set("%5", true);
    await attach(db, "agent:ws/w", 7, "%5");
    expect(listHostChannels(db, "dev")[0]).toMatchObject({
      kind: "attached",
      pid: null,
      agent_id: 7,
      pane_id: "%5",
    });
    await expect(reserveHostChannel(db, "dev", "exec:x", { paneAlive })).rejects.toThrow(
      /agent:ws\/w/,
    );
  });

  it("outlives the invocation that opened it: its own pid being gone does not free it", async () => {
    const db = conn();
    addHost(db, profile("dev", 1));
    live.set("%5", true);
    await attach(db, "agent:ws/w", 7, "%5");
    db.prepare("UPDATE host_channels SET pid = ?").run(deadPid()); // even a stray pid column is ignored
    await expect(reserveHostChannel(db, "dev", "exec:x", { paneAlive })).rejects.toBeInstanceOf(
      HostChannelBusyError,
    );
  });

  it("a dead pane frees the slot; a live or unknown one keeps it", async () => {
    const db = conn();
    addHost(db, profile("dev", 1));
    await attach(db, "agent:a", 7, "%5");
    live.set("%5", true);
    await expect(reserveHostChannel(db, "dev", "x", { paneAlive })).rejects.toBeInstanceOf(
      HostChannelBusyError,
    );
    live.set("%5", "throw");
    await expect(reserveHostChannel(db, "dev", "x", { paneAlive })).rejects.toBeInstanceOf(
      HostChannelBusyError,
    );
    live.set("%5", false);
    await reserveHostChannel(db, "dev", "x", { paneAlive });
    expect(holders(db)).toEqual(["x"]);
  });

  it("releaseHostChannelsForAgent binds registry id AND pane: a replacement agent's row is untouched", async () => {
    const db = conn();
    addHost(db, profile("dev", null));
    await attach(db, "agent:a", 7, "%5");
    expect(releaseHostChannelsForAgent(db, 8, "%5")).toBe(0); // same pane, other incarnation
    expect(releaseHostChannelsForAgent(db, 7, "%6")).toBe(0);
    expect(holders(db)).toEqual(["agent:a"]);
    expect(releaseHostChannelsForAgent(db, 7, "%5")).toBe(1);
    expect(holders(db)).toEqual([]);
  });

  it("clearing channels touches nothing else (no agent delete, no task release)", async () => {
    const db = conn();
    addHost(db, profile("dev", null));
    await attach(db, "agent:a", 7, "%5");
    const ops = () => (db.prepare("SELECT COUNT(*) AS c FROM ops").get() as { c: number }).c;
    const before = ops();
    releaseHostChannelsForAgent(db, 7, "%5");
    expect(ops()).toBe(before);
  });

  it("bind only converts a live, matching reservation", async () => {
    const db = conn();
    addHost(db, profile("dev", null));
    const l = await reserveHostChannel(db, "dev", "h");
    expect(bindHostChannel(db, { ...l, token: "wrong" }, { agentId: 1, paneId: "%1" })).toBe(false);
    releaseHostChannel(db, l);
    expect(bindHostChannel(db, l, { agentId: 1, paneId: "%1" })).toBe(false);
  });

  it("the attached lease releases by its token, like any other", async () => {
    const db = conn();
    addHost(db, profile("dev", null));
    const l = await attach(db, "agent:a", 7, "%5");
    expect(releaseHostChannel(db, l)).toBe(true);
    expect(holders(db)).toEqual([]);
  });
});
