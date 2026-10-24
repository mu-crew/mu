import { describe, expect, it } from "vitest";
import { commitHintCommand } from "../src/cli/tasks/lifecycle.js";

describe("close commit hint (fast tier)", () => {
  it("names a commit form that also picks up untracked files, from any cwd", () => {
    expect(commitHintCommand("/state/worktrees/ws/w1", "Fix it")).toBe(
      "git -C '/state/worktrees/ws/w1' add -A && git -C '/state/worktrees/ws/w1' commit -m 'Fix it'",
    );
  });

  it("single-quotes a title containing an apostrophe", () => {
    expect(commitHintCommand("/w", "it's done")).toContain(`-m 'it'\\''s done'`);
  });
});
