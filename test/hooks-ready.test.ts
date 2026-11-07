// A hook harness's ready screen and input line, read from a pane capture
// (spec D4, D6), and which hook commands run murmur's hook (the 60 s first-ack
// window needs them counted however they name murmur).

import { describe, expect, it } from "vitest";
import { runsMurmurHook } from "../src/agent-state.js";
import { inputHolds, screenReady } from "../src/channels/hooks-ready.js";
import { HARNESS_TABLE, HARNESSES } from "../src/harnesses.js";

const codex = HARNESS_TABLE.codex.readyMarks;
if (codex === null) throw new Error("codex has ready marks");

/** A launcher wrapper's output before codex draws (a fresh CODEX_HOME). */
const LAUNCHER = [
  "Codex CLI at Example (https://example.invalid/codex)",
  "Using a model gateway",
  "Installing plugin-a@market for preset guidance (check passed)",
  "Installing plugin-b@market for preset guidance (check passed)",
  "",
].join("\n");

/** codex 0.164's ready screen, empty input. */
const READY = [
  "╭─────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.164.0)          │",
  "│ permissions: YOLO mode              │",
  "╰─────────────────────────────────────╯",
  "",
  "› Ask Codex to do anything",
  "",
  "  ? for shortcuts                                  100% context left",
  "",
].join("\n");

const POINTER =
  "Read your task brief in /tmp/x/worktrees/eval/w2/.mu/brief-w2-manual-x2.md and follow it.";

/** The pane after the live bug: the pointer pasted, its Enter lost. */
const STUCK = [
  "  >_ OpenAI Codex (v0.164.0)",
  "  permissions: YOLO mode",
  `› ${POINTER}`,
  "  Model default · /private/tmp/x/worktrees/eval/w2",
  "",
].join("\n");

describe("screenReady (codex)", () => {
  it("a launcher wrapper's banner and install lines are not ready", () => {
    expect(screenReady(codex, LAUNCHER)).toBe(false);
    expect(screenReady(codex, "")).toBe(false);
  });

  it("codex's own screen is: header or footer, and the › input line", () => {
    expect(screenReady(codex, READY)).toBe(true);
    expect(screenReady(codex, `${LAUNCHER}${READY}`)).toBe(true);
    expect(screenReady(codex, STUCK)).toBe(true);
  });

  it("a mark without the input line, or the input line without a mark, is not", () => {
    expect(screenReady(codex, "  >_ OpenAI Codex (v0.164.0)\n  loading\n")).toBe(false);
    expect(screenReady(codex, "› something\n")).toBe(false);
  });

  it("a dialog (a numbered option under the input mark) is never ready: a paste would answer it", () => {
    const dialog = "  >_ OpenAI Codex (v0.164.0)\n  Trust these hooks?\n› 1. Yes\n  2. No\n";
    expect(screenReady(codex, dialog)).toBe(false);
    expect(screenReady(codex, "│ >_ OpenAI Codex │\n│ › 2. Quit │\n› Ask\n")).toBe(false);
  });

  it("a login shell's prompt (codex exited) is never ready", () => {
    expect(screenReady(codex, `${READY}~/repo main ❯\n`)).toBe(false);
    expect(screenReady(codex, "~/repo main ❯ \n")).toBe(false);
  });

  it("only codex and Muse have marks: claude, cursor-agent and pi report their start", () => {
    expect(HARNESSES.filter((h) => HARNESS_TABLE[h].readyMarks !== null)).toEqual([
      "codex",
      "muse",
    ]);
  });
});

const muse = HARNESS_TABLE.muse.readyMarks;
if (muse === null) throw new Error("muse has ready marks");

/** Muse Code 1.4.15 under its launcher, captured live: the banner, then Muse's own screen. */
const MUSE_BANNER = [
  "Muse Code at Example (https://example.invalid/muse)",
  "Using a model gateway",
  "muse: gate plugins: on (MUSE_EXPERIMENTAL_PLUGINS)",
  "",
].join("\n");
const MUSE_READY = [
  "  Muse Code 1.4.15",
  "  Skills: 57 loaded · 1 warning · 1 detail hidden (ctrl+o to expand)",
  "── Voice input (alt(option)+v to start) ──────────────────────",
  "❯",
  "──────────────────────────────────────────────────────────────",
  "  model-x · high · /private/tmp/x · Launch overrides",
  "",
].join("\n");

describe("screenReady (Muse)", () => {
  it("the launcher's banner is not ready; Muse's header, voice bar and ❯ line are", () => {
    expect(screenReady(muse, MUSE_BANNER)).toBe(false);
    expect(screenReady(muse, `${MUSE_BANNER}${MUSE_READY}`)).toBe(true);
  });

  it("a shell prompt left after Muse exited is not ready", () => {
    expect(screenReady(muse, `${MUSE_BANNER}${MUSE_READY}~/repo ❯\n`)).toBe(false);
  });

  it("the pasted text is held until submitted; after it, the prompt sits above an empty ❯", () => {
    const typed = MUSE_READY.replace("❯", `❯ ${POINTER}`);
    expect(inputHolds(muse, typed, POINTER)).toBe(true);
    const sent = MUSE_READY.replace("── Voice", `❯ ${POINTER}\n◆ OK\n── Voice`);
    expect(inputHolds(muse, sent, POINTER)).toBe(false);
    expect(screenReady(muse, sent)).toBe(true);
  });
});

describe("inputHolds", () => {
  it("the pasted text still in the input line", () => {
    expect(inputHolds(codex, STUCK, POINTER)).toBe(true);
  });

  it("a wrapped text: its first row is the text's start", () => {
    const wrapped = `› ${POINTER.slice(0, 40)}\n  ${POINTER.slice(40)}\n  ? for shortcuts\n`;
    expect(inputHolds(codex, wrapped, POINTER)).toBe(true);
  });

  it("an empty box, a placeholder, or another text is not", () => {
    expect(inputHolds(codex, READY, POINTER)).toBe(false);
    expect(inputHolds(codex, "›\n  ? for shortcuts\n", POINTER)).toBe(false);
    expect(inputHolds(codex, "› Read your notes\n", POINTER)).toBe(false);
    expect(inputHolds(codex, "› Re\n", POINTER)).toBe(false);
  });

  it("reads the last input line: an earlier prompt in the transcript does not count", () => {
    expect(inputHolds(codex, `› ${POINTER}\n  working\n› Ask Codex\n`, POINTER)).toBe(false);
  });
});

describe("runsMurmurHook", () => {
  it.each([
    ["murmur hook codex", "codex"],
    ["  murmur hook codex --x", "codex"],
    ["/opt/tools/bin/murmur hook codex", "codex"],
    ["'/usr/bin/node' '/home/u/src/murmur-next/dist/cli.js' hook codex", "codex"],
    ["MURMUR_STATE_DIR='/tmp/m 2' node '/x/node_modules/murmur/dist/cli.js' hook muse", "muse"],
  ])("%s runs murmur's %s hook", (command, harness) => {
    expect(runsMurmurHook(command, harness)).toBe(true);
  });

  it.each([
    ["murmur hook claude", "codex"],
    ["'/x/muzzle' hook codex", "codex"],
    ["node /x/observer/dist/cli.js hook codex", "codex"],
    ["echo murmur hook", "codex"],
    ["murmurx hook codex", "codex"],
  ])("%s does not run murmur's %s hook", (command, harness) => {
    expect(runsMurmurHook(command, harness)).toBe(false);
  });
});
