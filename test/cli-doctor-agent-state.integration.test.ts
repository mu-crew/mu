// `mu doctor` names where agent state comes from. Without murmur on PATH the
// row warns; it never fails, since mu works without murmur.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

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
    const { data } = await runCliJson(["doctor", "--json"], dbPath);
    const report = data as {
      environment: { agentState: { name: string; status: string } };
    };
    expect(report.environment.agentState).toMatchObject({ name: "murmur", status: "warn" });
  });

  it("prints mu ext as unknown (never a file check) and no skill row when no pi agent runs", async () => {
    process.env.PATH = join(tempDir, "empty-bin");
    // A legacy shim on disk must not make the row claim anything.
    const ext = join(tempDir, ".pi", "agent", "extensions");
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "mu.ts"), "// mu:shim\n");
    const { stdout } = await runCli(["doctor"], dbPath);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour
    const plain = stdout.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/mu ext\s*: ok unknown: no pi agent running to ask/);
    expect(plain).not.toMatch(/mu skill/);
    expect(plain).toMatch(/ctl\s*: ok no pi agents/);
  });

  it("reports environment.ctl.extension (unknown, ok) and no skill in --json", async () => {
    const { data } = await runCliJson(["doctor", "--json"], dbPath);
    const report = data as {
      environment: {
        ctl: { extension: { status: string }; sockets: { name: string }; agents: unknown[] };
        skill?: unknown;
      };
    };
    expect(report.environment.ctl.extension).toMatchObject({ name: "mu ext", status: "ok" });
    expect(report.environment.ctl.extension).toMatchObject({
      detail: expect.stringContaining("unknown"),
    });
    expect(report.environment.ctl.sockets).toMatchObject({ name: "ctl", status: "ok" });
    expect(report.environment.ctl.agents).toEqual([]);
    expect(report.environment.skill).toBeUndefined();
  });
});
