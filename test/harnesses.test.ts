// The harness table (spec D6): one frozen row per blessed harness, the facts U0
// observed, and `null` exactly where U0 left a fact unverified.

import { describe, expect, it } from "vitest";
import { HARNESS_TABLE, HARNESSES, harnessFor, isHarness } from "../src/harnesses.js";

function deeplyFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

describe("HARNESS_TABLE", () => {
  it("has one row per blessed harness, keyed by its own id", () => {
    expect(Object.keys(HARNESS_TABLE).sort()).toEqual([...HARNESSES].sort());
    for (const id of HARNESSES) expect(HARNESS_TABLE[id].id).toBe(id);
  });

  it("is frozen all the way down", () => {
    expect(deeplyFrozen(HARNESS_TABLE)).toBe(true);
    expect(() => {
      (HARNESS_TABLE.claude.events.turn_stopped as { name: string }[]).push({ name: "x" });
    }).toThrow();
  });

  it("pi stays on ctl; the other four default to the hooks channel", () => {
    expect(HARNESS_TABLE.pi.defaultChannel).toBe("ctl");
    for (const id of HARNESSES.filter((h) => h !== "pi")) {
      expect(HARNESS_TABLE[id].defaultChannel).toBe("hooks");
    }
  });

  it("the key-driven four clear the input with C-u and interrupt with Escape; pi has no clear key", () => {
    for (const id of HARNESSES) expect(HARNESS_TABLE[id].interruptKey).toBe("Escape");
    for (const id of HARNESSES.filter((h) => h !== "pi")) {
      expect(HARNESS_TABLE[id].clearInputKey).toBe("C-u");
    }
    expect(HARNESS_TABLE.pi.clearInputKey).toBeNull();
  });

  it("records the per-harness facts U0 observed", () => {
    expect(HARNESS_TABLE.claude.freshCommand).toBe("/clear");
    expect(HARNESS_TABLE["cursor-agent"].freshCommand).toBe("/new-chat");
    expect(HARNESS_TABLE.codex.events.interrupted).toEqual([{ name: "Interrupt" }]);
    expect(HARNESS_TABLE.claude.events.interrupted).toEqual([]);
    expect(HARNESS_TABLE["cursor-agent"].events.permission_requested).toEqual([]);
    expect(HARNESS_TABLE.muse.hookEnv).toBe("allowlist");
    expect(HARNESS_TABLE.muse.canBlockOnStop).toBe(false);
    expect(HARNESS_TABLE["cursor-agent"].neverStore).toContain("CURSOR_ASKPASS_SECRET");
    expect(HARNESS_TABLE["cursor-agent"].sessionsBackedUp).toBe(false);
    expect(HARNESS_TABLE.codex.trustFlag.join(" ")).toContain("<realpath>");
  });

  it("leaves exactly the facts U0 did not verify unknown (null)", () => {
    const open: string[] = [];
    for (const id of HARNESSES) {
      const h = HARNESS_TABLE[id];
      if (h.events.turn_failed === null) open.push(`${id}.turn_failed`);
      if (h.sessions === null) open.push(`${id}.sessions`);
      if (h.skillLocation === null) open.push(`${id}.skillLocation`);
    }
    expect(open.sort()).toEqual(
      [
        "codex.turn_failed",
        "muse.turn_failed",
        "pi.turn_failed",
        "muse.sessions",
        "codex.skillLocation",
        "cursor-agent.skillLocation",
      ].sort(),
    );
  });

  it("tells cursor-agent's stop outcomes apart by status", () => {
    const e = HARNESS_TABLE["cursor-agent"].events;
    expect(e.turn_stopped).toEqual([{ name: "stop", status: "completed" }]);
    expect(e.turn_failed).toEqual([{ name: "stop", status: "error" }]);
    expect(e.interrupted).toEqual([{ name: "stop", status: "aborted" }]);
  });

  it("maps each native event (with its qualifier) to at most one normalized event", () => {
    for (const id of HARNESSES) {
      const seen = new Map<string, string>();
      for (const [normalized, natives] of Object.entries(HARNESS_TABLE[id].events)) {
        for (const n of natives ?? []) {
          const key = `${n.name}|${n.status ?? ""}`;
          expect(seen.get(key), `${id} ${key}`).toBeUndefined();
          seen.set(key, normalized);
        }
      }
    }
  });

  it("carries murmur's argv-match fields: pi and cursor-agent run under an interpreter", () => {
    for (const id of HARNESSES) expect(HARNESS_TABLE[id].names).toContain(id);
    expect(HARNESS_TABLE.pi.packages).toEqual(["pi-coding-agent"]);
    expect(HARNESS_TABLE["cursor-agent"].packages).toEqual(["cursor-agent"]);
  });

  it("never points a skill at the shared ~/.agents/skills directory", () => {
    for (const id of HARNESSES)
      expect(HARNESS_TABLE[id].skillLocation ?? "").not.toContain(".agents");
  });
});

describe("harnessFor", () => {
  it("finds a blessed harness by its cli key and nothing else", () => {
    expect(harnessFor("cursor-agent")?.displayName).toBe("cursor-agent");
    expect(harnessFor("pi")?.defaultChannel).toBe("ctl");
    expect(harnessFor("sh")).toBeUndefined();
    expect(harnessFor("constructor")).toBeUndefined();
    expect(isHarness("codex")).toBe(true);
    expect(isHarness("toString")).toBe(false);
    expect(isHarness(7)).toBe(false);
  });
});
