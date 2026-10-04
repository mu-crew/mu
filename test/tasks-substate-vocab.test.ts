import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBSTATE,
  formatPair,
  isValidPair,
  mapLegacyStatus,
  resolvePair,
  TASK_SUBSTATE_ROWS,
  TASK_SUBSTATES,
} from "../src/tasks/status.js";

describe("substate vocabulary", () => {
  it("every default is a member of its status's set", () => {
    for (const [s, d] of Object.entries(DEFAULT_SUBSTATE))
      expect(TASK_SUBSTATES[s as keyof typeof TASK_SUBSTATES]).toContain(d);
  });
  it("rows: one default per status, and cover the map exactly", () => {
    const defaults = TASK_SUBSTATE_ROWS.filter(([, , d]) => d === 1)
      .map(([s]) => s)
      .sort();
    expect(defaults).toEqual(["CLOSED", "IN_PROGRESS", "OPEN"]);
    expect(TASK_SUBSTATE_ROWS).toHaveLength(9);
  });
  it("isValidPair", () => {
    expect(isValidPair("OPEN", "parked")).toBe(true);
    expect(isValidPair("CLOSED", "parked")).toBe(false);
    expect(isValidPair("OPEN", "bogus")).toBe(false);
  });
  it("mapLegacyStatus", () => {
    expect(mapLegacyStatus("REJECTED")).toEqual({ status: "CLOSED", substate: "rejected" });
    expect(mapLegacyStatus("DEFERRED")).toEqual({ status: "OPEN", substate: "parked" });
    expect(mapLegacyStatus("OPEN")).toBeNull();
  });
  it("resolvePair", () => {
    expect(resolvePair("CLOSED", "wontfix")).toEqual({ status: "CLOSED", substate: "wontfix" });
    expect(resolvePair("CLOSED", undefined)).toEqual({ status: "CLOSED", substate: "done" });
    expect(resolvePair("CLOSED", "parked")).toEqual({ status: "CLOSED", substate: "done" });
    expect(resolvePair("OPEN", "triage")).toEqual({ status: "OPEN", substate: "triage" });
    // An unknown substate from a newer peer falls back to the default (D8).
    expect(resolvePair("OPEN", "review")).toEqual({ status: "OPEN", substate: "todo" });
    expect(resolvePair("DEFERRED", "todo")).toEqual({ status: "OPEN", substate: "parked" });
    expect(resolvePair("NOPE", "todo")).toBeNull();
  });
  it("formatPair hides defaults", () => {
    expect(formatPair({ status: "OPEN", substate: "todo" })).toBe("OPEN");
    expect(formatPair({ status: "OPEN", substate: "parked" })).toBe("OPEN/parked");
    expect(formatPair({ status: "CLOSED", substate: "wontfix" })).toBe("CLOSED/wontfix");
  });
});
