// `mu agent send` and `mu agent answer` on the `hooks` channel (spec D4, U8),
// through the CLI: a fake hook harness (test/_fake-harness.ts) writes murmur
// inbox events for pane %3 and answers the keys mu types into it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import {
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let fake: FakeHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mash-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, {
    name: "cdx",
    workstream: "auth",
    paneId: "%3",
    cli: "codex",
    channel: "hooks",
  });
  insertAgent(db, { name: "pia", workstream: "auth", paneId: "%1", cli: "pi", channel: "ctl" });
  fake = fakeHarness(dir, "%3", "sess-1");
  fake.emit("session_start", { source: "startup" });
  setSleepForTests(async () => {});
  setMurmurPaneRunnerForTests(fake.pane);
  setMurmurHookRunnerForTests(fake.hook);
  mux = installMux(
    "tmux",
    async (args) =>
      fake.tmux(args) ?? {
        stdout: args[0] === "list-panes" ? `%1\t\t\n%3\t${fake.option()}\t1\n` : "",
        stderr: "",
        exitCode: 0,
      },
  );
});

afterEach(() => {
  mux.restore();
  setMurmurPaneRunnerForTests(async () => null);
  setMurmurHookRunnerForTests(async () => false);
  resetSleep();
  db.close();
  rmFixtureDir(dir);
});

const sendOps = () =>
  (
    db.prepare("SELECT payload FROM ops WHERE intent = 'agent.send' ORDER BY rowid").all() as {
      payload: string;
    }[]
  ).map((r) => r.payload);

describe("mu agent send to a hooks agent", () => {
  it("pastes once and reports the confirming run count", async () => {
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "hello there", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({
      agentName: "cdx",
      transport: "hooks",
      ack: "confirmed",
      runCount: 1,
      delivered: true,
    });
    expect(fake.submitted).toEqual(["hello there"]);
    expect(sendOps()).toEqual([
      expect.stringMatching(/^agent send cdx \(mode=plain transport=hooks.*, 11 bytes\)$/),
    ]);
  });

  it("no ack: delivered false with the unconfirmed reason, exit 0, never resent", async () => {
    fake.acks = false;
    let r: Awaited<ReturnType<typeof runCliJson>> | undefined;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      r = await runCliJson(["agent", "send", "cdx", "hi", "-w", "auth", "--json"], dbPath);
    });
    expect(r?.exitCode).toBeNull();
    expect(r?.data).toMatchObject({
      transport: "hooks",
      ack: "unknown",
      delivered: false,
      undelivered: { reason: "unconfirmed" },
    });
    expect(fake.calls.filter((c) => c[0] === "paste-buffer")).toHaveLength(1);
  });

  it("a blocked agent is refused with exit 4 and the answer hint; nothing is typed", async () => {
    fake.emit("prompt_submitted");
    fake.emit("permission_requested", { message: "Bash" });
    const { doc, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "hi", "-w", "auth", "--force", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(4);
    expect(doc).toMatchObject({ error: "AgentSendGateError" });
    expect(JSON.stringify(doc)).toContain("mu agent answer cdx");
    expect(fake.calls).toEqual([]);
  });

  it("--force is the gate's override on hooks, and still a usage error on a pi plain send", async () => {
    fake.emit("prompt_submitted");
    const refused = await runCliJson(
      ["agent", "send", "cdx", "hi", "-w", "auth", "--json"],
      dbPath,
    );
    expect(refused.exitCode).toBe(4);
    const forced = await runCliJson(
      ["agent", "send", "cdx", "hi", "-w", "auth", "--force", "--json"],
      dbPath,
    );
    expect(forced.exitCode).toBeNull();
    expect(forced.data).toMatchObject({ transport: "hooks", ack: "confirmed", runCount: 2 });
    const pi = await runCliJson(
      ["agent", "send", "pia", "hi", "-w", "auth", "--force", "--json"],
      dbPath,
    );
    expect(pi.exitCode).toBe(2);
    expect(pi.doc).toMatchObject({ error: "UsageError" });
  });

  it("--steer is refused with exit 2, naming the channel; nothing is typed", async () => {
    const { doc, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "hi", "-w", "auth", "--steer", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(2);
    expect(doc).toMatchObject({ error: "AgentSteerUnsupportedError" });
    expect(JSON.stringify(doc)).toContain("hooks channel");
    expect(fake.calls).toEqual([]);
  });

  it("human output names the channel and the run", async () => {
    const r = await runCli(["agent", "send", "cdx", "hello", "-w", "auth"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("via hooks, confirmed: run 1");
  });
});

describe("mu agent answer", () => {
  it("types the choice into a blocked agent's dialog, confirmed by the next event, and records it", async () => {
    fake.emit("prompt_submitted");
    fake.emit("permission_requested", { message: "Bash" });
    const { data, exitCode } = await runCliJson(
      ["agent", "answer", "cdx", "1", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toEqual({ agentName: "cdx", transport: "hooks", keys: ["1"], ack: "confirmed" });
    expect(fake.calls).toEqual([["send-keys", "-t", "%3", "-l", "--", "1"]]);
    expect(sendOps()).toEqual([
      expect.stringContaining("mode=answer transport=hooks ack=confirmed"),
    ]);
  });

  it("refuses an agent with no pending dialog (exit 4), unless --force", async () => {
    const refused = await runCliJson(
      ["agent", "answer", "cdx", "y", "-w", "auth", "--json"],
      dbPath,
    );
    expect(refused.exitCode).toBe(4);
    expect(refused.doc).toMatchObject({ error: "AgentNotBlockedError" });
    expect(fake.calls).toEqual([]);
    let forced: Awaited<ReturnType<typeof runCliJson>> | undefined;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      forced = await runCliJson(
        ["agent", "answer", "cdx", "y", "-w", "auth", "--force", "--json"],
        dbPath,
      );
    });
    expect(forced?.data).toMatchObject({ keys: ["y"], ack: "unknown" });
  });

  it("a pi agent's dialog is answered in its pane (exit 2); a multi-line choice is a usage error", async () => {
    const pi = await runCliJson(["agent", "answer", "pia", "1", "-w", "auth", "--json"], dbPath);
    expect(pi.exitCode).toBe(2);
    expect(pi.doc).toMatchObject({ error: "AgentAnswerUnsupportedError" });
    const bad = await runCliJson(
      ["agent", "answer", "cdx", "1\nrm -rf x", "-w", "auth", "--json"],
      dbPath,
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.doc).toMatchObject({ error: "UsageError" });
    expect(fake.calls).toEqual([]);
  });
});
