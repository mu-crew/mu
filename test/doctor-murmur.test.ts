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
  let originalPiDir: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalPiDir = process.env.PI_CODING_AGENT_DIR;
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

    const piDir = join(tempDir, "pi");
    mkdirSync(join(piDir, "extensions"), { recursive: true });
    writeFileSync(join(piDir, "extensions", "murmur.ts"), "");
    process.env.PI_CODING_AGENT_DIR = piDir;
  });

  afterEach(() => {
    const pathKey = "PATH";
    const piDirKey = "PI_CODING_AGENT_DIR";
    if (originalPath === undefined) delete process.env[pathKey];
    else process.env.PATH = originalPath;
    if (originalPiDir === undefined) delete process.env[piDirKey];
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
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

  it("warns when the murmur pi extension is not linked", () => {
    rmSync(join(process.env.PI_CODING_AGENT_DIR ?? "", "extensions", "murmur.ts"));

    const murmur = murmurDoctorCheck("murmur");

    expect(murmur).toEqual({
      name: "murmur",
      status: "warn",
      detail: "murmur pi extension not linked: run murmur link pi",
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
