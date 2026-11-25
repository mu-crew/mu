// A remote pane's last line after a ctl handshake that ended without ok: when it is read as a
// shell prompt (strong evidence pi never started), and how the warning words either case.
import { describe, expect, it } from "vitest";
import { AgentCtlUnreachableError } from "../src/agents/errors.js";
import {
  detectSpawnStartupError,
  lastPaneLine,
  looksLikeShellPrompt,
} from "../src/agents/spawn-ready.js";

const PROMPTS = [
  "user@dev0 ~ %",
  "dev0%",
  "user@host:~$",
  "[user@host repo]$",
  "root@box:/srv#",
  "sh-3.2$",
  "bash-5.2#",
  "$",
  "~/repo ❯",
];
const STARTUP_OUTPUT = [
  "Downloading extension bundle: 64%",
  "Downloading extension bundle 64 %",
  "Loading providers <anthropic>",
  "[=======>",
  'Warning: No models match pattern "some-model"',
  "Installing @scope/pkg@1.2.3",
];

describe("looksLikeShellPrompt", () => {
  it.each(PROMPTS)("reads %j as a prompt", (line) => {
    expect(looksLikeShellPrompt(line)).toBe(true);
  });
  it.each(STARTUP_OUTPUT)("does not read startup output %j as a prompt", (line) => {
    expect(looksLikeShellPrompt(line)).toBe(false);
  });
});

describe("the ctl warning on a remote pane", () => {
  const warn = (scrollback: string): string => {
    const line = lastPaneLine(scrollback) ?? "";
    const pane = { line, shellPrompt: looksLikeShellPrompt(line) };
    return new AgentCtlUnreachableError("w", "ws", "/s.sock", "refused", "dev", pane).message;
  };

  it.each(STARTUP_OUTPUT)("reports %j with uncertainty, never as pi never started", (line) => {
    const msg = warn(`pi v1.0\n${line}\nchannel 3: open failed: connect failed: x\n`);
    expect(msg).toContain(
      `the pane's last line (not enough to tell whether pi started): ${JSON.stringify(line)}`,
    );
    expect(msg).not.toMatch(/shell prompt|likely never started|in the template/);
  });
});

describe("ssh forward noise in the pane", () => {
  const NOISE = "channel 3: open failed: connect failed: No such file or directory";
  it("cuts noise appended to an unterminated prompt, so the prompt still reads as one", () => {
    const sb = `Last login: today\nsh-3.2$ ${NOISE}${NOISE}\r\n${NOISE}\n`;
    expect(lastPaneLine(sb)).toBe("sh-3.2$");
    expect(looksLikeShellPrompt(lastPaneLine(sb) ?? "")).toBe(true);
  });
  it("a flood of probe lines does not hide the last real line", () => {
    const sb = `user@dev0 ~ %${"\n".concat(NOISE).repeat(500)}\n`;
    expect(lastPaneLine(sb)).toBe("user@dev0 ~ %");
  });
  it("noise on a prompt line is not a startup error", () => {
    expect(detectSpawnStartupError(`sh-3.2$ ${NOISE}\n${NOISE}\n`)).toBeUndefined();
  });
});
