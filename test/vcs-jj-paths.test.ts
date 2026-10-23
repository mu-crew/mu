// Fast-tier tests for the jj path helper that needs no jj binary: the
// jj workspace name a mu workspace path gets. Real-jj coverage lives in
// test/workspace-backends.integration.test.ts.

import { describe, expect, it } from "vitest";

import { jjWorkspaceName } from "../src/vcs/jj.js";

describe("jjWorkspaceName", () => {
  it("is <workstream>/<agent>, so same-named agents in two workstreams differ", () => {
    const a = jjWorkspaceName("/s/workspaces/auth/worker-1");
    const b = jjWorkspaceName("/s/workspaces/billing/worker-1");
    expect(a).toBe("auth/worker-1");
    expect(b).toBe("billing/worker-1");
  });

  it("ignores a trailing slash", () => {
    expect(jjWorkspaceName("/s/workspaces/auth/worker-1/")).toBe("auth/worker-1");
  });
});
