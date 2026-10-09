import { describe, expect, it } from "vitest";
import { isWorkspaceClean } from "../src/workspace.js";

describe("isWorkspaceClean", () => {
  it("never reports a cp -a (none) workspace as clean", async () => {
    const row = {
      agentName: "w",
      workstreamName: "ws",
      backend: "none" as const,
      path: "/tmp",
      parentRef: null,
      createdAt: "",
    };
    expect(await isWorkspaceClean(row)).toBe(false);
  });
});
