// Remote command gates on a REAL tmux server (a private `-L` socket made here,
// killed here) with the real filled wrapper: the profile's templates are local
// `sh -c`, "remote" HOME is a temp dir. Proves what the mocks cannot: remain-on-exit
// armed before the command can end keeps even an instant exit readable, and
// pane_dead_status / the token-bound record give the exact numeric status.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGate } from "../src/agents/gate.js";
import { closeAgent, getAgent, spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, listHostChannels } from "../src/hosts.js";
import { paneResult, tmux } from "../src/tmux.js";
import { waitForEvents } from "../src/wait.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const haveTmux = ((): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const describeIfTmux = haveTmux ? describe : describe.skip;

describeIfTmux("remote command gates (real tmux, private socket)", () => {
  let dir: string;
  let home: string;
  let db: Db;
  let socket: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["MU_TMUX_SOCKET", "MU_DB_PATH", "MU_STATE_DIR", "MU_SYNC_DIR", "TMUX"];

  const poll = async <T>(fn: () => Promise<T | undefined>): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const v = await fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("poll timed out");
  };
  const gate = (name: string, command: string, host = "dev") =>
    spawnAgent(db, { name, workstream: "auth", host, command });
  const wait = (name: string) =>
    waitForEvents(db, [{ kind: "agent", workstream: "auth", id: name }], {
      callers: [],
      pollMs: 50,
      sync: false,
      timeoutMs: 15_000,
      ...ctlAgentHooks(db),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mrgi-"));
    home = join(dir, "home");
    mkdirSync(home);
    mkdirSync(join(dir, "repo"));
    for (const k of KEYS) saved[k] = process.env[k];
    socket = `mu-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.MU_TMUX_SOCKET = socket;
    delete process.env.TMUX;
    process.env.MU_DB_PATH = join(dir, "mu.db");
    process.env.MU_STATE_DIR = join(dir, "state");
    process.env.MU_SYNC_DIR = "";
    db = openDb({ path: join(dir, "mu.db") });
    ensureWorkstream(db, "auth");
    const sh = `HOME='${home}' /bin/sh -c {cmd}`;
    for (const [name, shell, max] of [
      ["dev", sh, 1],
      ["swallow", `${sh}; exit 0`, null],
    ] as const) {
      addHost(db, {
        name,
        shell,
        exec: sh,
        fetch: "true",
        repo: join(dir, "repo"),
        max_sessions: max,
      });
    }
  });

  afterEach(async () => {
    try {
      await tmux(["kill-server"]);
    } catch {}
    try {
      db.close();
    } catch {}
    rmFixtureDir(dir);
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("an instant exit 23 is retained and read as exactly 23; the pane row survives", async () => {
    const a = await gate("g1", "exit 23");
    const r = await wait("g1");
    expect(r.event.kind).toBe("exited");
    expect(r.exit).toBe(23);
    // This template passes the status through, so the local pane agrees with the record.
    expect(await paneResult(a.paneId)).toEqual({ state: "exited", code: 23, signal: null });
    // The pane stays until an explicit close, with its scrollback.
    expect(getAgent(db, "g1", "auth")?.paneId).toBe(a.paneId);
  });

  it("a slow gate is running (holding the only channel), then exits 7 and frees it", async () => {
    const a = await gate("g2", "sleep 1; exit 7");
    expect(await paneResult(a.paneId)).toEqual({ state: "running" });
    expect(listHostChannels(db, "dev").map((c) => c.kind)).toEqual(["attached"]);
    const r = await wait("g2");
    expect(r.exit).toBe(7);
    expect(listHostChannels(db, "dev")).toEqual([]);
  });

  it("a template that swallows the status still yields the command's 23 (local pane says 0)", async () => {
    const a = await gate("g3", "exit 23", "swallow");
    const p = await poll(async () => {
      const x = await paneResult(a.paneId);
      return x.state === "exited" ? x : undefined;
    });
    expect(p).toEqual({ state: "exited", code: 0, signal: null });
    expect((await wait("g3")).exit).toBe(23);
  });

  it("a killed pane is dead (never a result); a retained one closes cleanly and removes only its record", async () => {
    const a = await gate("g4", "exit 5");
    await poll(async () =>
      (await readGate(db, agentRowOf("g4"))).kind === "exited" ? true : undefined,
    );
    // At cap 1 the next gate admits only once the first transport is proven dead (read above).
    const b = await gate("g5", "sleep 30");
    const files = () =>
      existsSync(join(home, ".local/state/mu-next/remote-gates"))
        ? readdirSync(join(home, ".local/state/mu-next/remote-gates"))
        : [];
    expect(files()).toContain(a.gateToken);
    await tmux(["kill-pane", "-t", b.paneId]);
    const killed = await wait("g5");
    expect(killed.event.kind).toBe("dead");
    expect(killed.exit).toBe(6);
    await closeAgent(db, "g4", { workstream: "auth" });
    expect(files()).not.toContain(a.gateToken);
    expect(getAgent(db, "g4", "auth")).toBeUndefined();
  });

  function agentRowOf(name: string) {
    const r = getAgent(db, name, "auth");
    if (r === undefined) throw new Error(name);
    return r;
  }
});
