import { expect, expectTypeOf, it } from "vitest";
import { birthIdentity, killView, viewCapture, viewPresent } from "../src/jobs/view.js";
import { type paneRef, TmuxPaneBirthError } from "../src/mux/pane-ref.js";
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

it("tmux effects cannot take a raw pane id or an unverified ref", () => {
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
  expectTypeOf<ReturnType<typeof paneRef>>()
    .extract<{ kind: "unverified" }>()
    .not.toExtend<Target>();
  expectTypeOf<string>().not.toExtend<
    Parameters<typeof tmuxBackend.killPane | typeof tmuxBackend.capture>[0]
  >();
});

it.each([undefined, "malformed"])("a tmux birth with %s identity is uncertain", (identity) => {
  expect(() => birthIdentity(tmuxBackend, "%5", identity)).toThrow(TmuxPaneBirthError);
});

it("a legacy row can observe presence, but cannot capture or kill the observed pane", async () => {
  const mux = installMux("tmux", [["display-message", "%5\n"]]);
  try {
    expect(await viewPresent("%5", tmuxBackend, null)).toBe(true);
    await expect(viewCapture("%5", null, {}, tmuxBackend)).rejects.toThrow(
      /no recorded server identity/,
    );
    await expect(killView(tmuxBackend, "%5", null)).rejects.toThrow(/no recorded server identity/);
    expect(mux.calls).toEqual([["display-message", "-t", "%5", "-p", "#{pane_id}"]]);
  } finally {
    mux.restore();
  }
});
