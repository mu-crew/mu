import { describe, expect, it } from "vitest";
import { commitHintCommand } from "../src/cli/tasks/lifecycle.js";

describe("close commit hint (fast tier)", () => {
  it("names a commit form per backend that also picks up untracked files", () => {
    expect(commitHintCommand("git", "w1", "ws", "Fix it")).toBe(
      "cd $(mu workspace path w1 -w ws) && git add -A && git commit -m 'Fix it'",
    );
    expect(commitHintCommand("jj", "w1", "ws", "Fix it")).toBe(
      "cd $(mu workspace path w1 -w ws) && jj commit -m 'Fix it'",
    );
    expect(commitHintCommand("sl", "w1", "ws", "Fix it")).toBe(
      "cd $(mu workspace path w1 -w ws) && sl commit --addremove -m 'Fix it'",
    );
  });

  it("single-quotes a title containing an apostrophe", () => {
    expect(commitHintCommand("git", "w1", "ws", "it's done")).toContain(`-m 'it'\\''s done'`);
  });
});
