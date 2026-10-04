import { describe, expect, it } from "vitest";
import { delegateOutcome } from "../src/agents.js";

const st = (o: { fired?: boolean; dead?: boolean; lastText?: string; lastError?: string }) => ({
  fired: o.fired ?? false,
  dead: o.dead ?? false,
  ...(o.lastText !== undefined ? { lastText: o.lastText } : {}),
  ...(o.lastError !== undefined ? { lastError: o.lastError } : {}),
});

describe("delegateOutcome", () => {
  it("settled with text is done", () => {
    expect(delegateOutcome(st({ fired: true, lastText: "answer" }), false)).toBe("done");
  });
  it("settled with empty or absent text is empty", () => {
    expect(delegateOutcome(st({ fired: true, lastText: "" }), false)).toBe("empty");
    expect(delegateOutcome(st({ fired: true }), false)).toBe("empty");
  });
  it("settled on an API error is error, even with partial text", () => {
    expect(delegateOutcome(st({ fired: true, lastError: "529 overloaded" }), false)).toBe("error");
    expect(
      delegateOutcome(st({ fired: true, lastText: "half", lastError: "Connection error." }), false),
    ).toBe("error");
  });
  it("a dead pane or socket is died, even on timeout", () => {
    expect(delegateOutcome(st({ dead: true }), false)).toBe("died");
    expect(delegateOutcome(st({ dead: true }), true)).toBe("died");
  });
  it("unfinished at timeout is timeout; otherwise pending", () => {
    expect(delegateOutcome(st({}), true)).toBe("timeout");
    expect(delegateOutcome(st({}), false)).toBe("pending");
  });
});
