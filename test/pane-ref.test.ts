import { expect, expectTypeOf, it } from "vitest";
import { birthIdentity, killView, rowRef, viewCapture, viewPresent } from "../src/jobs/view.js";
import { nativePaneId, TmuxPaneBirthError } from "../src/mux/pane-ref.js";
import { tmuxBackend } from "../src/mux.js";
import type {
  attachCommands,
  capture,
  killPane,
  killPaneCommand,
  killSession,
  pasteToPane,
  sendKeys,
  setPaneOption,
} from "../src/tmux.js";
import { installMux } from "./_mux.js";

it("tmux effects cannot take a raw pane id, only a ref built from the row", () => {
  type Target =
    | Parameters<
        | typeof capture
        | typeof killPane
        | typeof killPaneCommand
        | typeof pasteToPane
        | typeof sendKeys
        | typeof setPaneOption
      >[0]
    | Parameters<typeof killSession>[1]
    | NonNullable<Parameters<typeof attachCommands>[0]["pane"]>;
  expectTypeOf<string>().not.toExtend<Target>();
  expectTypeOf<string>().not.toExtend<
    Parameters<typeof tmuxBackend.killPane | typeof tmuxBackend.capture>[0]
  >();
});

it.each([undefined, "malformed"])("a tmux birth with %s identity is uncertain", (identity) => {
  expect(() => birthIdentity(tmuxBackend, "%5", identity)).toThrow(TmuxPaneBirthError);
});

// A legacy row (spawned before `agents.pane_identity`) keeps the check mu made before the
// column: its pane is acted on by id, unguarded. A row WITH an identity is always guarded.
it("a legacy row is captured, typed into and killed by its bare id", async () => {
  const mux = installMux("tmux", [
    ["display-message", "%5\n"],
    ["capture-pane", "hello\n"],
    ["send-keys", ""],
    ["kill-pane", ""],
  ]);
  try {
    expect(await viewPresent("%5", tmuxBackend, null)).toBe(true);
    expect(await viewCapture("%5", null, { lines: 0 }, tmuxBackend)).toContain("hello");
    await tmuxBackend.sendKeys?.(rowRef(tmuxBackend, "%5", null), ["Enter"]);
    await killView(tmuxBackend, "%5", null);
    expect(mux.calls).toEqual([
      ["display-message", "-t", "%5", "-p", "#{pane_id}"],
      ["capture-pane", "-t", "%5", "-p"],
      ["send-keys", "-t", "%5", "--", "Enter"],
      ["kill-pane", "-t", "%5"],
    ]);
  } finally {
    mux.restore();
  }
});

it("a row with an identity acts only through the server guard; a legacy row by bare id", () => {
  const guarded = tmuxBackend.killPaneCommand(rowRef(tmuxBackend, "%5", "4242|1700000000"));
  expect(guarded.args.slice(-5)).toEqual([
    "if-shell",
    "-F",
    "#{==:#{pid}|#{start_time},4242|1700000000}",
    "kill-pane -t %5",
    'run-shell "exit 97"',
  ]);
  expect(killPaneCommandOf("%5").args.slice(-3)).toEqual(["kill-pane", "-t", "%5"]);
  expect(killPaneCommandOf("%5").args).not.toContain("if-shell");
});

it("a legacy row's ref is refused for a malformed id and on another backend", () => {
  expect(() => killPaneCommandOf("bogus")).toThrow(/not a tmux pane/);
  expect(() => nativePaneId(rowRef(tmuxBackend, "%5", null))).toThrow(/another backend/);
});

const killPaneCommandOf = (id: string) =>
  tmuxBackend.killPaneCommand(rowRef(tmuxBackend, id, null));
