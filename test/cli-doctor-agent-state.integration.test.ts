// `mu doctor` names where agent state comes from. Without murmur on PATH the
// row warns; it never fails, since mu works without murmur.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkPi, linkSkill } from "../src/link.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

describe("mu doctor — agent state source", () => {
  let tempDir: string;
  let dbPath: string;
  let savedPath: string | undefined;
  let savedPiHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-doctor-state-"));
    dbPath = join(tempDir, "mu.db");
    savedPath = process.env.PATH;
    savedPiHome = process.env.MU_PI_HOME;
    process.env.MU_PI_HOME = tempDir;
  });

  afterEach(() => {
    const entryKey = "MU_EXTENSION_ENTRY";
    delete process.env[entryKey];
    process.env.MU_PI_HOME = savedPiHome;
    process.env.PATH = savedPath;
    rmFixtureDir(tempDir);
  });

  it("warns that agent state is unknown when murmur is not on PATH", async () => {
    process.env.PATH = join(tempDir, "empty-bin");
    const { stdout } = await runCli(["doctor"], dbPath);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour
    expect(stdout.replace(/\u001b\[[0-9;]*m/g, "")).toMatch(
      /agent state\s*: WARN murmur not installed: agent state shows unknown/,
    );
  });

  it("reports the same row in --json", async () => {
    process.env.PATH = join(tempDir, "empty-bin");
    const { stdout } = await runCli(["doctor", "--json"], dbPath);
    const report = JSON.parse(stdout) as {
      environment: { agentState: { name: string; status: string } };
    };
    expect(report.environment.agentState).toMatchObject({ name: "murmur", status: "warn" });
  });

  it("prints mu ext / mu skill / ctl rows; linked mu ext makes murmur optional", async () => {
    process.env.PATH = join(tempDir, "empty-bin");
    const entry = join(tempDir, "mu-pi.js");
    writeFileSync(entry, "export default function () {}\n");
    process.env.MU_EXTENSION_ENTRY = entry;
    linkPi();
    linkSkill();
    const { stdout } = await runCli(["doctor"], dbPath);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour
    const plain = stdout.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/agent state\s*: ok not needed for pi agents \(mu extension\)/);
    expect(plain).toMatch(/mu ext\s*: ok \(ctl, mu_delegate\)/);
    expect(plain).toMatch(/mu skill\s*: ok /);
    expect(plain).toMatch(/ctl\s*: ok no pi agents/);
  });

  it("reports environment.ctl and environment.skill in --json", async () => {
    const { stdout } = await runCli(["doctor", "--json"], dbPath);
    const report = JSON.parse(stdout) as {
      environment: {
        ctl: { extension: { status: string }; sockets: { name: string }; agents: unknown[] };
        skill: { name: string; status: string };
      };
    };
    expect(report.environment.ctl.extension).toMatchObject({
      status: "warn",
      detail: "not linked: run mu link pi",
    });
    expect(report.environment.ctl.sockets).toMatchObject({ name: "ctl", status: "ok" });
    expect(report.environment.ctl.agents).toEqual([]);
    expect(report.environment.skill).toMatchObject({ name: "mu skill", status: "warn" });
  });
});
