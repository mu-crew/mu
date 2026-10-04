// Tests for src/doctor-summary.ts (feat_card_9_doctor, workstream
// `tui-impl`). The summary is the SDK seam consumed by the TUI's
// slot-9 Doctor card; it slices the textual `mu doctor` checks into
// a per-tick-cheap structured shape.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  countProblems,
  type DoctorCheck,
  loadDoctorSummary,
  MURMUR_NOT_NEEDED_DETAIL,
  remediationParagraph,
  yankCommandForCheck,
} from "../src/doctor-summary.js";
import { linkPi, linkSkill } from "../src/link.js";
import type { WorkstreamSnapshot } from "../src/state.js";

const EMPTY_VIEW = {
  agents: [],
  orphans: [],
  report: { prunedGhosts: 0, orphans: [], mode: "report-only" as const },
};

function emptySnapshot(over: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: EMPTY_VIEW,
    tracks: [],
    ready: [],
    inProgress: [],
    blocked: [],
    recentClosed: [],
    parkedCount: 0,
    triage: [],
    allTasks: [],
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
    ...over,
  };
}

describe("loadDoctorSummary", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;
  let murmurRoot: string;
  let originalPath: string | undefined;
  let originalPiDir: string | undefined;
  let originalPiHome: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalPiDir = process.env.PI_CODING_AGENT_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "mu-doctor-summary-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });

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

    // The mu extension + skill, linked into a temp home (never ~).
    originalPiHome = process.env.MU_PI_HOME;
    process.env.MU_PI_HOME = tempDir;
    const entry = join(tempDir, "mu-pi.js");
    writeFileSync(entry, "export default function () {}\n");
    process.env.MU_EXTENSION_ENTRY = entry;
    linkPi();
    linkSkill();
  });

  afterEach(() => {
    const pathKey = "PATH";
    const piDirKey = "PI_CODING_AGENT_DIR";
    const entryKey = "MU_EXTENSION_ENTRY";
    const piHomeKey = "MU_PI_HOME";
    delete process.env[entryKey];
    if (originalPiHome === undefined) delete process.env[piHomeKey];
    else process.env.MU_PI_HOME = originalPiHome;
    if (originalPath === undefined) delete process.env[pathKey];
    else process.env.PATH = originalPath;
    if (originalPiDir === undefined) delete process.env[piDirKey];
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    try {
      db.close();
    } catch {
      /* noop */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("on a fresh DB without a snapshot, every check passes", () => {
    const s = loadDoctorSummary(db, null);
    // schema, schema_version, journal_mode, foreign_keys, plus the
    // fleet-hazard and shallow-drift rows (v2-doctor-drift). No
    // snapshot-derived rows since snapshot is null.
    //
    // Asserted BY NAME rather than by count: a hard-coded length breaks
    // every time a check is added, which says nothing about correctness.
    const names = s.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "schema",
        "schema_version",
        "journal_mode",
        "foreign_keys",
        "db-filesystem",
        "name-case",
        "drift",
        "murmur",
        "mu ext",
        "mu skill",
      ]),
    );
    expect(s.checks.every((c) => c.status === "ok")).toBe(true);
    expect(s.problemCount).toBe(0);
  });

  it("murmur not installed is ok when the mu extension is linked", () => {
    process.env.PATH = join(tempDir, "empty-bin");

    const murmur = loadDoctorSummary(db, null).checks.find((check) => check.name === "murmur");

    expect(murmur).toMatchObject({ status: "ok", detail: MURMUR_NOT_NEEDED_DETAIL });
  });

  it("warns when murmur is not installed and the mu extension is not linked", () => {
    process.env.PATH = join(tempDir, "empty-bin");
    rmSync(join(tempDir, ".pi"), { recursive: true });

    const murmur = loadDoctorSummary(db, null).checks.find((check) => check.name === "murmur");

    expect(murmur).toEqual({
      name: "murmur",
      status: "warn",
      detail: "murmur not installed: agent state shows unknown",
    });
  });

  it("warns when the murmur pi extension is not linked (mu ext missing)", () => {
    rmSync(join(tempDir, ".pi"), { recursive: true });
    rmSync(join(process.env.PI_CODING_AGENT_DIR ?? "", "extensions", "murmur.ts"));

    const murmur = loadDoctorSummary(db, null).checks.find((check) => check.name === "murmur");

    expect(murmur).toEqual({
      name: "murmur",
      status: "warn",
      detail: "murmur pi extension not linked: run murmur link pi",
    });
  });

  it("reports the installed murmur version", () => {
    const murmur = loadDoctorSummary(db, null).checks.find((check) => check.name === "murmur");

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

    const murmur = loadDoctorSummary(db, null).checks.find((check) => check.name === "murmur");

    expect(murmur).toEqual({
      name: "murmur",
      status: "warn",
      detail:
        "murmur 0.6.1 is older than 1.0.0; @murmur_pane_since missing, idle/stall timing unknown",
    });
  });

  it("uses herdr as the agent-state source without checking murmur", () => {
    process.env.PATH = join(tempDir, "empty-bin");

    const murmur = loadDoctorSummary(db, null, "herdr").checks.find(
      (check) => check.name === "murmur",
    );

    expect(murmur).toEqual({ name: "murmur", status: "ok", detail: "agent state from herdr" });
  });

  it("each fresh-DB check carries a non-empty detail string", () => {
    const s = loadDoctorSummary(db, null);
    for (const c of s.checks) {
      expect(c.detail.length).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it("includes the four core DB checks by name", () => {
    const s = loadDoctorSummary(db, null);
    const names = new Set(s.checks.map((c) => c.name));
    expect(names.has("schema")).toBe(true);
    expect(names.has("schema_version")).toBe(true);
    expect(names.has("journal_mode")).toBe(true);
    expect(names.has("foreign_keys")).toBe(true);
  });

  it("when snapshot is provided, adds agents/panes/workspaces rows", () => {
    const s = loadDoctorSummary(db, emptySnapshot());
    const names = new Set(s.checks.map((c) => c.name));
    expect(names.has("agents")).toBe(true);
    expect(names.has("panes")).toBe(true);
    expect(names.has("workspaces")).toBe(true);
    // Base + fleet/drift rows + 3 snapshot-derived. Asserted as "the
    // snapshot rows were ADDED to whatever the base set is" rather than
    // a magic total.
    const base = loadDoctorSummary(db, null).checks.length;
    expect(s.checks.length).toBe(base + 3);
  });

  it("ghosts > 0 → agents row is warn with ghost count in detail", () => {
    const snap = emptySnapshot({
      view: {
        ...EMPTY_VIEW,
        report: { ...EMPTY_VIEW.report, prunedGhosts: 2 },
      },
    });
    const s = loadDoctorSummary(db, snap);
    const agents = s.checks.find((c) => c.name === "agents");
    expect(agents).toBeDefined();
    expect(agents?.status).toBe("warn");
    expect(agents?.detail).toMatch(/2 ghost panes/);
  });

  it("singular vs plural ghost-pane count uses pluralisation", () => {
    const oneGhost = emptySnapshot({
      view: { ...EMPTY_VIEW, report: { ...EMPTY_VIEW.report, prunedGhosts: 1 } },
    });
    const sOne = loadDoctorSummary(db, oneGhost);
    expect(sOne.checks.find((c) => c.name === "agents")?.detail).toMatch(/1 ghost pane;/);
  });

  it("workspace orphan dirs surface as a workspaces warn row", () => {
    const snap = emptySnapshot({
      workspaceOrphans: [
        // shape per WorkspaceOrphan; only the array length matters
        // for the warn detection (cast loosely so we don't drag in
        // the full row schema for the test).
        { agentName: "lost-1", path: "/tmp/lost", dbExists: false } as never,
      ],
    });
    const s = loadDoctorSummary(db, snap);
    const ws = s.checks.find((c) => c.name === "workspaces");
    expect(ws?.status).toBe("warn");
    expect(ws?.detail).toMatch(/1 orphan dir/);
  });

  it("problemCount tracks the number of warn+fail rows", () => {
    const snap = emptySnapshot({
      view: { ...EMPTY_VIEW, report: { ...EMPTY_VIEW.report, prunedGhosts: 1 } },
      workspaceOrphans: [{ agentName: "x", path: "/tmp/x", dbExists: false } as never],
    });
    const s = loadDoctorSummary(db, snap);
    // agents (warn) + workspaces (warn) = 2; everything else ok.
    expect(s.problemCount).toBe(2);
  });
});

// These two helpers used to live in src/cli/tui/popups/doctor.tsx;
// they're pure DoctorCheck-shape utilities and moved here per
// review_tui_doctor_remediation_lives_in_popup. Tests moved
// alongside.
describe("yankCommandForCheck", () => {
  it("maps each known check name to a useful verb", () => {
    expect(yankCommandForCheck({ name: "murmur", status: "warn" })).toBe("murmur link pi");
    expect(yankCommandForCheck({ name: "agents", status: "warn" })).toBe("mu state");
    expect(yankCommandForCheck({ name: "panes", status: "warn" })).toBe("mu agent adopt");
    expect(yankCommandForCheck({ name: "workspaces", status: "warn" })).toBe(
      "mu workspace orphans",
    );
  });

  it("schema-shape checks yank a `# ...` comment line (no actionable mutation)", () => {
    for (const name of ["schema", "schema_version", "journal_mode", "foreign_keys"]) {
      const cmd = yankCommandForCheck({ name, status: "fail" });
      expect(cmd.startsWith("#"), `expected '# ...' for ${name}, got: ${cmd}`).toBe(true);
      expect(cmd).toContain("mu doctor");
    }
  });

  it("forward-compat: unknown check name falls back to `mu doctor`", () => {
    expect(yankCommandForCheck({ name: "future_check", status: "ok" })).toBe("mu doctor");
  });
});

describe("remediationParagraph", () => {
  function check(name: string): DoctorCheck {
    return { name, status: "warn", detail: "" };
  }

  it("returns a non-empty paragraph for every known check name", () => {
    for (const name of [
      "murmur",
      "agents",
      "panes",
      "workspaces",
      "schema",
      "schema_version",
      "journal_mode",
      "foreign_keys",
    ]) {
      const lines = remediationParagraph(check(name));
      expect(lines.length, `expected non-empty paragraph for ${name}`).toBeGreaterThan(0);
      // Each paragraph line should be non-empty prose (not just
      // whitespace) so the popup drill body renders cleanly.
      for (const ln of lines) expect(ln.trim().length).toBeGreaterThan(0);
    }
  });

  it("forward-compat: unknown check name falls back to a `mu doctor` hint", () => {
    const lines = remediationParagraph(check("future_check"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(" ")).toContain("mu doctor");
  });
});

describe("countProblems", () => {
  it("returns 0 for an empty list", () => {
    expect(countProblems([])).toBe(0);
  });

  it("counts every non-OK row once", () => {
    expect(
      countProblems([
        { name: "a", status: "ok", detail: "" },
        { name: "b", status: "warn", detail: "" },
        { name: "c", status: "fail", detail: "" },
        { name: "d", status: "ok", detail: "" },
        { name: "e", status: "fail", detail: "" },
      ]),
    ).toBe(3);
  });
});
