// A new tmux pane must come with the server it was created on; a spawn never writes a row that
// reads as a pre-upgrade (unverified) one.

import { describe, expect, it } from "vitest";
import { birthIdentity } from "../src/jobs/view.js";
import type { MuxBackend } from "../src/mux/types.js";

const tmuxLike = { name: "tmux", serverIdentity: async () => "1|2" } as unknown as MuxBackend;
const herdrLike = { name: "herdr" } as unknown as MuxBackend;

describe("birthIdentity", () => {
  it("passes the identity the creating call reported", () => {
    expect(birthIdentity(tmuxLike, "%1", "9|8")).toBe("9|8");
  });
  it("refuses a tmux pane born without one", () => {
    expect(() => birthIdentity(tmuxLike, "%1", undefined)).toThrow(/which tmux server/);
  });
  it("gives none for a backend with no server identity", () => {
    expect(birthIdentity(herdrLike, "p1", undefined)).toBeUndefined();
  });
});
