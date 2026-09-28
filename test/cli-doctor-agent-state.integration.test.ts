// `mu doctor` names where agent state comes from. Without murmur on PATH the
// row warns; it never fails, since mu works without murmur.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

describe("mu doctor — agent state source", () => {
  let tempDir: string;
  let dbPath: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-doctor-state-"));
    dbPath = join(tempDir, "mu.db");
    savedPath = process.env.PATH;
  });

  afterEach(() => {
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
});
