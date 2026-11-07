// Help strings that state what the code does. Each pins a claim checked against
// its code path, so a stale string (a backend missing, "pi" where hook harnesses
// also stop) fails here:
// - --steer: ctl delivers it (src/channels/ctl-deliver.ts), hooks refuse it
//   (src/channels/hooks.ts AgentSteerUnsupportedError), mux ignores the mode
//   and sends plainly (src/channels/mux.ts send).
// - --timeout on send --interrupt and abort: hooks.ts stopTurn waits only where
//   the harness reports its own interrupt (codex, muse, cursor-agent); claude and
//   remote workers return unconfirmed without polling.
// - the verdict form is SKILL.md's, which parseVerdict accepts.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { parseVerdict } from "../src/delegate-verdict.js";
import { say } from "../src/messages.js";

function verb(path: string[]): Command {
  let cmd: Command = buildProgram();
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`no verb ${path.join(" ")}`);
    cmd = next;
  }
  return cmd;
}

function optionHelp(path: string[], flag: string): string {
  const opt = verb(path).options.find((o) => o.long === flag);
  if (!opt) throw new Error(`no ${flag} on ${path.join(" ")}`);
  return opt.description;
}

const TIMEOUT_CLAIMS = [
  "pi",
  "local hook harness that reports its interrupt (codex, muse, cursor-agent)",
  "claude and remote hook workers are not waited on",
];

describe("help text matches the code", () => {
  it("mu --help names every multiplexer", () => {
    expect(buildProgram().description()).toContain("tmux, herdr or Rex panes");
  });

  it("send --steer is pi only, refused by hooks, a plain send on mux", () => {
    const steer = optionHelp(["agent", "send"], "--steer");
    expect(steer).toMatch(/^pi \(control socket\) only/);
    expect(steer).toContain("A hook harness refuses it");
    expect(steer).toContain("another CLI in a herdr or Rex pane gets a plain send");
  });

  it.each([[["agent", "send"]], [["agent", "abort"]]])(
    "%j --timeout names what it waits on",
    (path) => {
      const timeout = optionHelp(path, "--timeout");
      for (const claim of TIMEOUT_CLAIMS) expect(timeout).toContain(claim);
      expect(timeout).not.toContain("for pi to settle");
    },
  );

  it("task verdict --help and check.verdict_line show the VERDICT: <id> form", () => {
    const form = "`VERDICT: <id> CONFIRMED|REFUTED|UNVERIFIED <line>`";
    expect(verb(["task", "verdict"]).description()).toContain(form);
    expect(say("check.verdict_line")).toContain(form);
    // The form shown is one the parser takes.
    expect(parseVerdict("VERDICT: review_x CONFIRMED ok\nEVIDENCE: e")).toBe("CONFIRMED");
  });
});
