// A payload that looks like another verb does not change how a log op renders.

import { describe, expect, it } from "vitest";
import { renderOp } from "../src/log-render.js";

// v2-log-verb RETIRED classifyEventVerb entirely: prose prefix matching
// is gone, and rendering keys on `intent`. What replaced these mechanics
// tests lives in test/log-render.test.ts (exhaustive intent coverage,
// "payload text cannot override the intent", unknown-intent fallback).
// The one property worth restating at this layer is that a payload that
// LOOKS like a verb no longer decides anything.
describe("rendering keys on intent, not prose", () => {
  it("a payload that looks like another verb does not change the rendered verb", () => {
    const rendered = renderOp({
      intent: "task.close",
      kind: "task",
      workstreamName: "demo/t1",
      payload: '{"status":"CLOSED","title":"agent spawn worker-9"}',
      source: "system",
      op: "put",
    });
    expect(rendered?.verb).toBe("task close");
  });

  it("an intentless row is not classified at all (shown verbatim)", () => {
    expect(
      renderOp({
        intent: null,
        kind: "message",
        workstreamName: "demo",
        payload: "agent spawn worker-9",
        source: "user",
        op: "put",
      }),
    ).toBeNull();
  });
});
