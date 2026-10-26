// The extension runner's abort: SIGTERM, then resolve only once the child
// EXITED (a mu spawn rolls back on SIGTERM). Real `sh` children.
import { describe, expect, it } from "vitest";
import { runChild } from "../extension/mu-run.js";

describe("runChild abort", () => {
  it("waits for a child that traps TERM to finish its cleanup", async () => {
    const ctl = new AbortController();
    const done = runChild(
      "sh",
      ["-c", "trap 'sleep 0.3; echo rolled-back; exit 143' TERM; echo up; sleep 10 & wait"],
      ctl.signal,
    );
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    ctl.abort();
    const r = await done;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r.code).toBe(143);
    expect(r.stdout).toContain("rolled-back");
  });

  it("an already-aborted signal still runs and reaps the child", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await runChild("sh", ["-c", "sleep 10"], ctl.signal);
    expect(r.code).not.toBe(0);
  });
});
