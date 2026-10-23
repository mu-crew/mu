// Misc verbs from src/agents.ts: isValidAgentName.
//
// Split out of test/verbs.test.ts under
// testreview_test_files_past_800loc — see the sibling
// test/verbs-*.test.ts files for the rest of the verbs.

import { describe, expect, it } from "vitest";
import { isValidAgentName } from "../src/agents.js";

// ─── isValidAgentName ─────────────────────────────────────────────────

describe("isValidAgentName", () => {
  it("accepts lowercase identifiers", () => {
    expect(isValidAgentName("alice")).toBe(true);
    expect(isValidAgentName("a")).toBe(true);
    expect(isValidAgentName("worker_1")).toBe(true);
    expect(isValidAgentName("worker-1")).toBe(true);
    expect(isValidAgentName("a".repeat(32))).toBe(true);
  });

  it("rejects names that don't start with a letter", () => {
    expect(isValidAgentName("1alice")).toBe(false);
    expect(isValidAgentName("_alice")).toBe(false);
    expect(isValidAgentName("-alice")).toBe(false);
  });

  it("rejects uppercase, spaces, special chars", () => {
    expect(isValidAgentName("Alice")).toBe(false);
    expect(isValidAgentName("alice bob")).toBe(false);
    expect(isValidAgentName("alice/bob")).toBe(false);
    expect(isValidAgentName("alice@bob")).toBe(false);
  });

  it("rejects empty and >32 char names", () => {
    expect(isValidAgentName("")).toBe(false);
    expect(isValidAgentName("a".repeat(33))).toBe(false);
  });
});
