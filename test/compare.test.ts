import { describe, expect, it } from "vitest";
import { compareStrings } from "../src/compare.js";

describe("compareStrings", () => {
  it("orders by code unit, locale-free", () => {
    expect(["a_b", "a0", "a-b", "B", "a"].sort(compareStrings)).toEqual([
      "B",
      "a",
      "a-b",
      "a0",
      "a_b",
    ]);
  });
  it("returns 0 for equal strings", () => {
    expect(compareStrings("x", "x")).toBe(0);
  });
});
