// One identity check, at the action boundary (round 2 of pane_identity_liveness). A tmux pane id is
// unique only within one server's lifetime; every path that acts on a pane must reach the
// recorded server inside the SAME tmux call that acts, so a restart between a check and the
// effect cannot land the effect on a recycled id.
//
// Real tmux on a PRIVATE socket (never the suite's shared server). Each test kills only its own.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { spawnAgent as spawnRegistered } from "../src/agents/spawn.js";
import { getAgent, insertAgent, readAgent } from "../src/agents.js";
import type { CarrierJob } from "../src/carrier-jobs.js";
import { planAttach, spawnStep } from "../src/cli/tui/commands.js";
import { type Db, openDb } from "../src/db.js";
import { proveViewGone } from "../src/host-policy.js";
import { addHost, bindHostChannel, type HostLease, reserveHostChannel } from "../src/hosts.js";
import { viewRunning } from "../src/jobs/view.js";
import { requireVerifiedPane } from "../src/mux/pane-ref.js";
import { reconcile } from "../src/reconcile.js";
import { shellWord } from "../src/shell-quote.js";
import {
  capture,
  ensureSession,
  PaneNotFoundError,
  paneAlive,
  paneRef,
  paneResult,
  pasteToPane,
  resetTmuxExecutor,
  sendKeys,
  serverIdentity,
  setTmuxExecutor,
  spawnAgent,
  type TmuxExecutor,
  tmux,
} from "../src/tmux.js";
import { ensureWorkstream, teardownWorkstream, workstreamRevision } from "../src/workstream.js";
import { pollUntil } from "./_env.js";
import { privatePane, tmuxIntegrationAvailable } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { registerTmuxSocket, stopTestTmux } from "./_server-registry.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;
const SLEEP = "sh -c 'echo FOREIGN-PANE; while true; do sleep 60; done'";

describeIfTmux(
  "pane identity is checked in the acting tmux call (real tmux, private socket)",
  () => {
    let dir: string;
    let db: Db;
    let outer: string | undefined;
    let socket: string | undefined;
    let real: TmuxExecutor;
    const ws = "fencews";
    const session = `mu-${ws}`;

    const spawn = (name: string, onPaneCreated?: (id: string, identity?: string) => void) =>
      spawnAgent({
        session,
        window: name,
        name,
        cli: "pi",
        command: SLEEP,
        commandSource: "cli-key",
        env: {},
        ...(onPaneCreated ? { onPaneCreated } : {}),
      });

    /** Kill the private server; a new one's first agent pane recycles the old id. */
    const restartServer = async (): Promise<string> => {
      await real(["kill-server"]).catch(() => {});
      // A server mid-exit answers "server exited unexpectedly" (serverIdentity throws): not gone yet.
      await pollUntil(async () => (await serverIdentity().catch(() => "exiting")) === undefined, {
        description: "old server gone",
      });
      await ensureSession(session);
      return spawn("someone-else");
    };

    /** Run `restart` once, right before the first tmux call whose argv contains `verb`. */
    const restartBefore = (verb: string, restart: () => Promise<unknown>): void => {
      let done = false;
      setTmuxExecutor(async (args) => {
        if (!done && args.some((a) => a.includes(verb))) {
          done = true;
          await restart();
        }
        return real(args);
      });
    };

    /** The recycled pane still prints its marker: it was neither read into the row nor killed. */
    const foreignOutput = (pane: string): Promise<void> =>
      pollUntil(async () => (await capture(await privatePane(pane))).includes("FOREIGN-PANE"), {
        description: "foreign pane output",
      });

    const agentOn = async (name: string): Promise<{ pane: string; identity: string }> => {
      await ensureSession(session);
      const pane = await spawn(name);
      const identity = await serverIdentity(); // no restart in flight yet: the plain lookup is right here
      if (identity === undefined) throw new Error("no server identity");
      insertAgent(db, { name, workstream: ws, paneId: pane, paneIdentity: identity });
      return { pane, identity };
    };

    beforeEach(() => {
      outer = process.env.MU_TMUX_SOCKET;
      socket = registerTmuxSocket();
      process.env.MU_TMUX_SOCKET = socket;
      resetTmuxExecutor();
      real = setTmuxExecutor(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
      resetTmuxExecutor();
      dir = mkdtempSync(join(tmpdir(), "mu-pane-fence-"));
      db = openDb({ path: join(dir, "mu.db") });
      ensureWorkstream(db, ws);
    });

    afterEach(() => {
      resetTmuxExecutor();
      try {
        stopTestTmux(socket);
      } catch {}
      socket = undefined;
      if (outer === undefined) delete process.env.MU_TMUX_SOCKET;
      else process.env.MU_TMUX_SOCKET = outer;
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("pane_birth_identity_race: the identity is the server that created the pane", async () => {
      await ensureSession(session);
      const before = await serverIdentity();
      let born: string | undefined;
      // The server restarts right after the creating call returned: a later lookup would sample B.
      let restarted: Promise<unknown> | undefined;
      setTmuxExecutor(async (args) => {
        const result = await real(args);
        if (restarted === undefined && args.includes("-P")) {
          restarted = (async () => {
            await real(["kill-server"]);
            await pollUntil(
              async () => (await serverIdentity().catch(() => "exiting")) === undefined,
              {
                description: "server gone",
              },
            );
            await real(["new-session", "-d", "-s", "later", "sh -c 'sleep 60'"]);
          })();
          await restarted;
        }
        return result;
      });
      await spawn("worker", (_id, identity) => {
        born = identity;
      });
      resetTmuxExecutor();
      expect(born).toBe(before);
      expect(born).not.toBe(await serverIdentity());
    }, 30_000);

    it("a birth with no identity never rolls back a recycled pane", async () => {
      await ensureSession(session);
      let foreign: string | undefined;
      setTmuxExecutor(async (args) => {
        const result = await real(args);
        if (foreign === undefined && args.includes("-P")) {
          setTmuxExecutor(real);
          foreign = await restartServer();
          return { ...result, stdout: `${result.stdout.split("|")[0]}\n` };
        }
        return result;
      });
      await expect(
        spawnRegistered(db, { name: "worker", workstream: ws, cli: "sh", command: SLEEP }),
      ).rejects.toThrow(/which tmux server/);
      expect(getAgent(db, "worker", ws)).toBeUndefined();
      expect(foreign).toBe("%1");
      expect(await paneAlive("%1")).toBe(true);
    }, 30_000);

    it("pane_action_identity_race: a restart before capture-pane never reads the recycled pane", async () => {
      const { pane } = await agentOn("worker");
      let foreign: string | undefined;
      restartBefore("capture-pane", async () => {
        foreign = await restartServer();
      });
      await expect(readAgent(db, "worker", { workstream: ws })).rejects.toThrow();
      resetTmuxExecutor();
      expect(foreign).toBe(pane); // the id was recycled
      await foreignOutput(pane);
    }, 30_000);

    it("pane_action_identity_race: a restart before kill-pane never kills the recycled pane", async () => {
      const { pane } = await agentOn("worker");
      let foreign: string | undefined;
      restartBefore("kill-pane", async () => {
        foreign = await restartServer();
      });
      await closeAgent(db, "worker", { workstream: ws }).catch(() => {});
      resetTmuxExecutor();
      expect(foreign).toBe(pane);
      expect(await paneAlive(pane)).toBe(true);
      expect(getAgent(db, "worker", ws)).toBeUndefined();
    }, 30_000);

    it("pane_teardown_identity_bypass: teardown after a restart leaves the new server's session", async () => {
      const { pane } = await agentOn("worker");
      const foreign = await restartServer();
      expect(foreign).toBe(pane);
      const result = await teardownWorkstream(db, {
        workstream: ws,
        ifRevision: workstreamRevision(db, ws),
      });
      // The old row is dead for good; the session on the new server is not the workstream's.
      expect(result.killedMux).toBe(false);
      expect(await paneAlive(foreign)).toBe(true);
      await foreignOutput(foreign);
      expect(getAgent(db, "worker", ws)).toBeUndefined();
    }, 30_000);

    it("teardown does not kill a replacement session after reconcile prunes the only row", async () => {
      const { pane } = await agentOn("worker");
      const foreign = await restartServer();
      expect(foreign).toBe(pane);
      expect((await reconcile(db, { workstream: ws })).prunedGhosts).toBe(1);
      const result = await teardownWorkstream(db, {
        workstream: ws,
        ifRevision: workstreamRevision(db, ws),
      });
      expect(result.killedMux).toBe(false);
      expect(await paneAlive(foreign)).toBe(true);
    }, 30_000);

    it.each(["send-keys", "paste-buffer"])(
      "%s refuses a restart immediately before delivery",
      async (verb) => {
        const { pane, identity } = await agentOn("worker");
        const ref = requireVerifiedPane(paneRef(pane, identity));
        let foreign: string | undefined;
        restartBefore(verb, async () => {
          foreign = await restartServer();
        });
        const text = "DO NOT DELIVER\n\tto a different pane";
        const delivery =
          verb === "send-keys" ? sendKeys(ref, [text], { literal: true }) : pasteToPane(ref, text);
        await expect(delivery).rejects.toBeInstanceOf(PaneNotFoundError);
        resetTmuxExecutor();
        expect(foreign).toBe(pane);
        await foreignOutput(pane);
        expect(await capture(await privatePane(pane))).not.toContain("DO NOT DELIVER");
      },
      30_000,
    );

    it("a restart between literal key chunks never sends the remainder to a recycled pane", async () => {
      const { pane, identity } = await agentOn("worker");
      const ref = requireVerifiedPane(paneRef(pane, identity));
      let sends = 0;
      let foreign: string | undefined;
      setTmuxExecutor(async (args) => {
        if (args.some((a) => a.includes("send-keys")) && ++sends === 2) {
          foreign = await restartServer();
        }
        return real(args);
      });
      const text = "\t'🧪 DO NOT DELIVER'\n".repeat(550);
      await expect(sendKeys(ref, [text], { literal: true })).rejects.toBeInstanceOf(
        PaneNotFoundError,
      );
      resetTmuxExecutor();
      expect(sends).toBe(2);
      expect(foreign).toBe(pane);
      await foreignOutput(pane);
      expect(await capture(await privatePane(pane))).not.toContain("DO NOT DELIVER");
    }, 30_000);

    it("a guarded retained spawn preserves multiline command and environment arguments", async () => {
      await ensureSession(session);
      const text = "first\n\tsecond 'é😀'\n  # third";
      const commandOut = join(dir, "command");
      const envOut = join(dir, "env");
      const pane = await spawnAgent({
        session,
        window: "retained",
        name: "retained",
        cli: "sh",
        command: `printf %s ${shellWord(text)} > ${shellWord(commandOut)}\n  printf %s "$MULTILINE" > ${shellWord(envOut)}`,
        commandSource: "cli-key",
        env: { MULTILINE: text },
        retainOnExit: true,
      });
      const ref = await privatePane(pane);
      await pollUntil(async () => (await paneResult(ref)).state === "exited", {
        description: "retained command exited",
      });
      expect(readFileSync(commandOut, "utf8")).toBe(text);
      expect(readFileSync(envOut, "utf8")).toBe(text);
    });

    it("pane_dashboard_identity_bypass: an attach plan runs only on the recorded server", async () => {
      const { pane, identity } = await agentOn("worker");
      const subject = {
        workstream: ws,
        name: "worker",
        tab: null,
        paneId: pane,
        paneIdentity: identity,
      };
      await restartServer();
      const plan = await planAttach(subject);
      if (!plan.ok) throw new Error(plan.reason);
      const step = plan.steps.at(-1);
      if (step === undefined) throw new Error("no step");
      // No terminal here: on the recorded server tmux would fail "not a terminal" (exit 1); the
      // guard refuses first on any other (exit 97).
      const ran = await spawnStep(step);
      expect(ran.code).toBe(97);
      expect(plan.line).toContain("if-shell");
    }, 30_000);

    it("a dashboard attach follows the original pane after its window is renamed and split", async () => {
      const { pane, identity } = await agentOn("worker");
      const subject = {
        workstream: ws,
        name: "worker",
        tab: null,
        paneId: pane,
        paneIdentity: identity,
      };
      const plan = await planAttach(subject);
      if (!plan.ok) throw new Error(plan.reason);
      const step = plan.steps[0];
      if (step === undefined) throw new Error("no attach step");
      await tmux(["rename-window", "-t", pane, "renamed"]);
      const split = await spawn("renamed");
      await tmux(["select-pane", "-t", split]);
      const decoy = await spawn("worker");
      const result = await execa(step.command, ["-C", ...step.args], {
        input: 'display-message -p "attached=#{pane_id}"\ndetach-client\n',
      });
      expect(result.stdout).toContain(`attached=${pane}`);
      expect(result.stdout).not.toContain(`attached=${decoy}`);
    }, 30_000);

    it.each([
      ["agent spawn", ["agent", "spawn", "worker-1"]],
      ["orchestrate", ["orchestrate", "--name", "worker-1"]],
    ])(
      "the copied %s attach command never attaches after a restart",
      async (_verb, argv) => {
        await ensureSession(session);
        const spawned = await runCliJson<{ attach: string; agent: { pane_id: string } }>(
          [...argv, "-w", ws, "--cli", "sh", "--command", SLEEP, "--json"],
          db.name,
        );
        const attach = spawned.data?.attach;
        expect(attach).toMatch(/^tmux -L mu-test-/);
        if (attach === undefined) throw new Error("no generated attach line");
        const run = () =>
          execa("/bin/sh", ["-c", attach.replace(/^tmux /, "exec tmux -C ")], {
            input: 'display-message -p "attached=#{pane_id}"\ndetach-client\n',
            reject: false,
          });
        expect((await run()).stdout).toContain("attached=%1");
        expect(await restartServer()).toBe(spawned.data?.agent.pane_id);
        const refused = await run();
        expect(refused.exitCode).toBe(97);
        expect(refused.stdout).not.toContain("attached=");
      },
      30_000,
    );

    it("pane_carrier_liveness_bypass: a dead carrier no longer holds a host slot or proves a view alive", async () => {
      const { pane, identity } = await agentOn("worker");
      const agent = getAgent(db, "worker", ws);
      if (agent === undefined) throw new Error("row missing");
      addHost(db, { name: "dev", shell: "s", exec: "e", fetch: "f", repo: "/r", max_sessions: 1 });
      const lease: HostLease = await reserveHostChannel(db, "dev", "worker");
      expect(bindHostChannel(db, lease, { agentId: agent.incarnation, paneId: pane })).toBe(true);
      const view = {
        wireState: "bound",
        paneId: pane,
        viewServer: `tmux:${identity}`,
        agentId: agent.incarnation,
      } as CarrierJob;
      expect((await proveViewGone(view)).state).toBe("alive");

      await restartServer(); // the carrier's server is gone; its id lives on, recycled
      expect(identity).not.toBe(await serverIdentity());
      expect(await proveViewGone(view)).toEqual({ state: "gone" });
      await expect(
        reserveHostChannel(db, "dev", "other", { paneAlive: viewRunning }),
      ).resolves.toBeDefined();
    }, 30_000);
  },
);
