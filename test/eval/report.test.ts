import { describe, expect, it } from "vitest";
import { HEADERS, toMarkdown } from "../../tools/eval/report.ts";
import type { RunResult } from "../../tools/eval/types.ts";

function result(over: {
  scenario: string;
  completed: boolean;
  tokens: number;
  muCalls: number;
  muErrors: number;
  wrong?: number;
  destructive?: number;
  prods?: number;
  aborted?: "timeout" | null;
  model?: string;
}): RunResult {
  return {
    scenario: over.scenario,
    surface: "3x",
    model: over.model ?? "haiku",
    rep: 1,
    startedAt: "2026-01-01T00:00:00Z",
    metrics: {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: over.tokens, cost: 0 },
      turns: 1,
      toolCalls: [],
      muCalls: over.muCalls,
      muErrors: over.muErrors,
      prods: over.prods ?? 0,
      wallMs: 1,
      aborted: over.aborted ?? null,
      lastError: null,
      finalText: "",
    },
    verdict: {
      completed: over.completed,
      wrong: Array.from({ length: over.wrong ?? 0 }, () => "w"),
      destructive: Array.from({ length: over.destructive ?? 0 }, () => "d"),
      notes: [],
    },
  };
}

describe("toMarkdown", () => {
  const rows = [
    result({ scenario: "a", completed: true, tokens: 1000, muCalls: 4, muErrors: 1, wrong: 1 }),
    result({
      scenario: "a",
      completed: false,
      tokens: 3000,
      muCalls: 6,
      muErrors: 0,
      prods: 1,
      aborted: "timeout",
    }),
    result({
      scenario: "b",
      completed: true,
      tokens: 500,
      muCalls: 2,
      muErrors: 0,
      destructive: 1,
    }),
  ];
  const lines = toMarkdown(rows).trimEnd().split("\n");

  it("has the exact column headers", () => {
    expect(lines[0]).toBe(
      "| Scenario | Surface | Model | Completed | Mean tokens | Mean mu calls | Mean mu errors | Wrong | Destructive | Prods | Aborted |",
    );
    expect(HEADERS).toHaveLength(11);
    expect(lines[1]).toBe("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  });
  it("has one row per scenario x surface x model with means and sums", () => {
    expect(lines[2]).toBe("| a | 3x | haiku | 1/2 | 2000 | 5.0 | 0.5 | 1 | 0 | 1 | 1 |");
    expect(lines[3]).toBe("| b | 3x | haiku | 1/1 | 500 | 2.0 | 0.0 | 0 | 1 | 0 | 0 |");
  });
  it("ends with a totals row per surface x model", () => {
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("| **total** | 3x | haiku | 2/3 | 1500 | 4.0 | 0.3 | 1 | 1 | 1 | 1 |");
  });
  it("separates models", () => {
    const two = toMarkdown([
      ...rows,
      result({
        scenario: "a",
        model: "sonnet",
        completed: true,
        tokens: 10,
        muCalls: 1,
        muErrors: 0,
      }),
    ]);
    expect(two.split("\n").filter((l) => l.includes("**total**"))).toHaveLength(2);
  });
});
