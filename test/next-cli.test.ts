// `mu next` result document and exit code (src/cli/next.ts): ONE bounded envelope,
// the summary never cut, moves cut on a record boundary from the end.

import { describe, expect, it } from "vitest";
import { nextData, nextExit } from "../src/cli/next.js";
import type { NextMove, NextResult } from "../src/next.js";
import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../src/output-contract.js";

const result = (over: Partial<NextResult> = {}, moves: NextMove[] = []): NextResult => ({
  workstream: "d",
  dry: false,
  cap: 100,
  used: moves.length,
  moves,
  ...over,
});
const move = (i: number): NextMove => ({
  kind: "retry",
  task: `task-${i}`,
  attempt: 2,
  key: "auto:2",
  agent: `task-${i}-1`,
  cli: "pi",
  state: "sent",
  reason: `API error: ${"x".repeat(400)}`,
});

describe("nextData", () => {
  it("a hundred moves fit 4 KB on the FINAL bytes; the summary and the cut count survive", () => {
    const moves = Array.from({ length: 100 }, (_, i) => move(i));
    const d = nextData(
      result(
        {
          stopped: "cap",
          held: {
            waits: 1,
            event: "settled",
            ref: "agent:d/a",
            exit: 0,
            timedOut: false,
            open: [],
          },
        },
        moves,
      ),
      0,
    );
    expect(Buffer.byteLength(encodeEnvelope(okEnvelope(d)))).toBeLessThanOrEqual(RESULT_BYTES);
    expect(d).toMatchObject({ workstream: "d", used: 100, cap: 100, stopped: "cap", exit: 0 });
    expect((d.held as { event: string }).event).toBe("settled");
    const kept = (d.moves as unknown[]).length;
    expect(kept).toBeGreaterThan(0);
    expect(d.movesCut).toBe(100 - kept);
    expect((d.moves as { task: string }[])[0]?.task).toBe("task-0");
  });

  it("a long reason is clipped, a short result is whole", () => {
    const d = nextData(result({}, [move(1)]), 0);
    expect(d.movesCut).toBeUndefined();
    expect(((d.moves as { reason: string }[])[0]?.reason ?? "").length).toBeLessThanOrEqual(201);
  });
});

describe("nextExit", () => {
  const held = (exit: 0 | 6 | 7 | 130) => ({
    waits: 1,
    event: "x",
    ref: null,
    exit,
    timedOut: false,
    open: [],
  });
  it.each([
    [result(), undefined, 0],
    [result({ stopped: "cap" }), undefined, 0],
    [result({ stopped: "failed" }), undefined, 1],
    [result({ stopped: "human" }), undefined, 7],
    [result({ stopped: "interrupted" }), "SIGINT", 130],
    [result({ stopped: "interrupted" }), "SIGTERM", 143],
    [result({ held: held(6) }), undefined, 6],
    [result({ held: held(7) }), undefined, 7],
    [result({ held: held(0) }), undefined, 0],
  ] as const)("%#", (r, sig, want) => {
    expect(nextExit(r, sig)).toBe(want);
  });
});
