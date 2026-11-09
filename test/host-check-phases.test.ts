// `host check` is composed from phased check steps (spec 2026-11-09-mu-plugins.md, D11,
// unit P5): the template link owns `reach` (reachable, repo), the lease kind `template`
// (shell, stop, attach) and `agent` (job); checkHost keeps only mu's own steps and reaches
// the seams' through `caps.checks` and `checkSteps`. The output itself is pinned by
// test/host-check-golden.integration.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { templateLink } from "../src/host-link.js";
import { gateKind } from "../src/jobs/gate.js";
import { leaseKind } from "../src/jobs/lease.js";
import { paneKind } from "../src/jobs/pane.js";
import { SRC } from "./_imports.js";

const text = (file: string): string => readFileSync(join(SRC, file), "utf8");

describe("host check phases", () => {
  it("each built-in declares the phases it has steps for", () => {
    // The link's caps never touch the db: a null one is never read here.
    const link = templateLink(null as never);
    expect(link.caps.checks).toEqual(["reach"]);
    expect(typeof link.checkSteps).toBe("function");
    expect(leaseKind.caps.checks).toEqual(["template", "agent"]);
    expect(typeof leaseKind.checkSteps).toBe("function");
    for (const k of [paneKind, gateKind]) {
      expect(k.caps.checks).toBeUndefined();
      expect(k.checkSteps).toBeUndefined();
    }
  });

  it("hosts.ts makes none of the seams' steps and reads no job handle", () => {
    const hosts = text("hosts.ts");
    expect(hosts).not.toMatch(/step: "(shell|stop|attach|job|reachable|repo)"/);
    expect(hosts).not.toMatch(/\bgetCarrierJobByName\b|\bleaseTemplateSteps\b|\bleaseJobStep\b/);
    expect(hosts.match(/\.checkSteps\(/g)?.length).toBe(2);
  });

  it("the seams' steps live on the seams", () => {
    const link = text("host-link.ts");
    for (const s of ["reachable", "repo"]) expect(link).toContain(`"${s}"`);
    const lease = text("jobs/lease.ts");
    for (const s of ["shell", "stop", "attach", "job"]) expect(lease).toContain(`step: "${s}"`);
  });
});
