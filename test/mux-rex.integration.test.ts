// Integration tests for src/mux/rex.ts against a REAL Rex server.
//
// Isolation is structural: the suite starts its own private server
// (`rex server run --listen unix://<tmp>/rex.sock --restore=false`) and points
// every call at it with MU_REX_SERVER. The user's Rex server, where their real
// terminals live, is never addressed. Skipped when `rex` is absent.

import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  capture,
  ensureSession,
  killPane,
  killSession,
  listPanes,
  paneAlive,
  paneResult,
  paneStatus,
  resetRexExecutor,
  sendToPane,
  spawnAgent,
} from "../src/mux/rex.js";
import { pollUntil } from "./_env.js";
import { freshWorkstream } from "./_fixture.js";
import { startTestRex } from "./_server-registry.js";

const REX_AVAILABLE =
  spawnSync("rex", ["version"], { stdio: "ignore", timeout: 2000 }).status === 0;
const describeIfRex = REX_AVAILABLE ? describe : describe.skip;

describeIfRex("rex integration (private Rex server)", () => {
  let server: ReturnType<typeof startTestRex> | undefined;
  let session: string;

  beforeAll(async () => {
    server = startTestRex();
    const { address } = server;
    await pollUntil(
      () =>
        spawnSync(
          "rex",
          ["-S", address, "--autostart=false", "api", "call", "server.version", "{}"],
          { stdio: "ignore", timeout: 1000, killSignal: "SIGKILL" },
        ).status === 0,
      { attempts: 100, intervalMs: 50, description: "private rex server did not start" },
    );
    process.env.MU_REX_SERVER = address;
  }, 15_000);

  afterAll(async () => {
    const key = "MU_REX_SERVER";
    delete process.env[key];
    await server?.stop();
  });

  beforeEach(() => {
    resetRexExecutor();
    session = `mu-${freshWorkstream("r")}`;
  });

  afterEach(async () => {
    if (!server || process.env.MU_REX_SERVER !== server.address || !session) return;
    try {
      await killSession(session);
    } catch {
      // best effort
    }
  });

  const spawnIn = (window: string, command: string, extra: { retainOnExit?: boolean } = {}) => {
    if (!server) throw new Error("private Rex fixture has not started");
    return spawnAgent({
      session,
      window,
      name: window,
      cli: "sh",
      command,
      commandSource: "explicit",
      cwd: server.dir,
      env: { MU_AGENT_NAME: window },
      ...extra,
    });
  };

  it("ensures a session with `_mu`, idempotently, and kills it idempotently", async () => {
    expect(await ensureSession(session)).toEqual({ created: true, repaired: false });
    expect(await ensureSession(session)).toEqual({ created: false, repaired: false });
    expect((await listPanes(session)).length).toBe(1);
    await killSession(session);
    await killSession(session);
    expect(await listPanes(session)).toEqual([]);
  });

  it("spawns with the env and cwd, captures, and kills a pane idempotently", async () => {
    const pane = await spawnIn("w1", 'echo "hi $MU_AGENT_NAME in $PWD"; exec sleep 60');
    await pollUntil(async () => (await capture(pane)).includes("hi w1"), {
      description: "spawned command never printed",
    });
    expect(await capture(pane, { lines: 1 })).toMatch(/^hi w1 in .*mu-rex-.*\n$/);
    expect(await capture(pane, { lines: 0 })).toContain("hi w1");
    expect(await paneAlive(pane)).toBe(true);
    expect(await paneResult(pane)).toEqual({ state: "running" });
    const second = await spawnIn("w1", "exec sleep 60");
    const panes = await listPanes(session);
    expect(panes.map((p) => p.paneId)).toEqual(expect.arrayContaining([pane, second]));
    await killPane(pane);
    await killPane(pane);
    expect(await paneAlive(pane)).toBe(false);
    expect(await paneResult(pane)).toEqual({ state: "absent" });
  });

  it("a retained pane reports its exit code; a plain one closes on any exit", async () => {
    const kept = await spawnIn("gate", "exit 5", { retainOnExit: true });
    const plain = await spawnIn("quick", "exit 1");
    await pollUntil(async () => (await paneResult(kept)).state === "exited", {
      description: "retained pane never exited",
    });
    expect(await paneResult(kept)).toEqual({ state: "exited", code: 5, signal: null });
    await pollUntil(async () => !(await paneAlive(plain)), {
      description: "plain pane stayed open",
    });
  });

  it("reads the agent's own OSC 7501 status, not a child tool's", async () => {
    const pane = await spawnIn(
      "status",
      String.raw`printf '\033]7501;state=blocked:kind=permission:app=fake\033\\'; exec sleep 60`,
    );
    await pollUntil(async () => (await paneStatus(pane)) === "needs_permission", {
      description: "blocked report never read",
    });
    const tool = await spawnIn(
      "tool",
      String.raw`sh -c "printf '\033]7501;state=working:app=cargo\033\\\\'"; exec sleep 60`,
    );
    await pollUntil(async () => (await capture(tool)) !== undefined, { description: "tool pane" });
    expect(await paneStatus(tool)).toBeUndefined();
  });

  it("sends a multi-line text as one bracketed paste, then Enter", async () => {
    const pane = await spawnIn("send", String.raw`printf '\033[?2004hREADY\n'; exec cat -v`);
    await pollUntil(async () => (await capture(pane)).includes("READY"), {
      description: "bracketed paste never armed",
    });
    await sendToPane(pane, "line one\nline two");
    await pollUntil(async () => (await capture(pane)).includes("^[[201~"), {
      description: "paste never echoed",
    });
    const text = await capture(pane);
    expect(text).toContain("^[[200~line one\nline two^[[201~");
  });

  it("refuses a multi-line send to a program without bracketed paste", async () => {
    const pane = await spawnIn("raw", "exec cat");
    await expect(sendToPane(pane, "a\nb")).rejects.toThrow(/bracketed paste/);
  });
});
