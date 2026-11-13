// Tests for the murmur row of src/doctor-summary.ts.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { murmurDoctorCheck } from "../src/doctor-summary.js";

describe("murmurDoctorCheck (per-tick, no live hello)", () => {
  let tempDir: string;
  let murmurRoot: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    tempDir = mkdtempSync(join(tmpdir(), "mu-doctor-summary-"));

    murmurRoot = join(tempDir, "murmur");
    const murmurBin = join(murmurRoot, "bin");
    mkdirSync(murmurBin, { recursive: true });
    writeFileSync(
      join(murmurRoot, "package.json"),
      JSON.stringify({ name: "@mu-crew/murmur", version: "1.0.0" }),
    );
    writeFileSync(join(murmurBin, "murmur"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(murmurBin, "murmur"), 0o755);
    process.env.PATH = murmurBin;
  });

  afterEach(() => {
    const pathKey = "PATH";
    if (originalPath === undefined) delete process.env[pathKey];
    else process.env.PATH = originalPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("murmur not installed warns: the per-tick summary has no live hello to prove the extension", () => {
    process.env.PATH = join(tempDir, "empty-bin");

    const murmur = murmurDoctorCheck("murmur");

    expect(murmur).toEqual({
      name: "murmur",
      status: "warn",
      detail: "murmur not installed: agent state shows unknown",
    });
  });

  it("reports the installed murmur version", () => {
    const murmur = murmurDoctorCheck("murmur");

    expect(murmur).toEqual({
      name: "murmur",
      status: "ok",
      detail: "agent state from murmur 1.0.0",
    });
  });

  it("warns when murmur predates pane-state timing", () => {
    writeFileSync(
      join(murmurRoot, "package.json"),
      JSON.stringify({ name: "@mu-crew/murmur", version: "0.6.1" }),
    );

    const murmur = murmurDoctorCheck("murmur");

    expect(murmur).toEqual({
      name: "murmur",
      status: "warn",
      detail:
        "murmur 0.6.1 is older than 1.0.0; @murmur_pane_since missing, idle/stall timing unknown",
    });
  });

  it("uses herdr as the agent-state source without checking murmur", () => {
    process.env.PATH = join(tempDir, "empty-bin");

    const murmur = murmurDoctorCheck("herdr");

    expect(murmur).toEqual({ name: "murmur", status: "ok", detail: "agent state from herdr" });
  });
});
