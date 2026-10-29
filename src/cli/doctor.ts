// mu — `mu doctor` diagnostic verb (human + --json forms).
//
// Reports:
//   - environment: the active mux + its ambient env facts
//   - db: tables present, schema_version, integrity (--deep: quick_check), journal_mode, foreign_keys
//   - workstream: the injected worker scope, if any (never read from the session)
//   - state: per-workstream agent / task / log counts + reconcile drift
//   - disk: state-dir vs DB reconciliation (both directions) + residue
//
// Read-only (the reconcile pass uses mode: "report-only" so polling doesn't
// race in-flight spawns; see PENDING_PANE_PREFIX).

import { dirname } from "node:path";
import { listAgents, listLiveAgents } from "../agents.js";
import { captureDoctorCheck } from "../capture.js";
import { emitJson, injectedWorkstream } from "../cli.js";
import { planCompact } from "../compact.js";
import { CURRENT_SCHEMA_VERSION, type Db, defaultDbPath, EXPECTED_TABLES } from "../db.js";
import { checkOldDelegates } from "../delegate-prune.js";
import { checkDiskRecon, formatBytes, measureWorktreeUsage } from "../disk-recon.js";
import {
  ctlExtensionDoctorCheck,
  ctlSocketsDoctorCheck,
  type DoctorCheck,
  extensionLive,
  leaseJobHintLine,
  leaseJobHints,
  murmurDoctorCheck,
} from "../doctor-summary.js";
import {
  ABANDONED_IDLE_DAYS,
  checkDormantWorkstreams,
  FINISHED_IDLE_DAYS,
  findDormantWorkstreams,
} from "../dormant.js";
import {
  checkCheapDriftInvariant,
  checkDrift,
  DriftDetectedError,
  driftRemediation,
  formatDriftRecord,
} from "../drift.js";
import {
  checkCloseGuards,
  checkFleetHazards,
  checkOrphanedAgents,
  checkSegmentVersion,
  checkUnpublishedOps,
  type FleetHazard,
  HazardFailError,
} from "../fleet-hazards.js";
import { activeMux, type MuxHealth, NoMultiplexerError } from "../mux.js";
import { pc } from "../output.js";
import { type EdgeCycle, findEdgeCycles } from "../tasks/edges.js";
import { summarizeWorkstream } from "../workstream.js";
import { forgetHint } from "./db.js";
import { failureWithData } from "./handle.js";

/** Cap on the `quick_check` lines doctor prints or reports. */
const INTEGRITY_LINES = 10;

/**
 * Page-level integrity (`PRAGMA quick_check`), deep tier only: it reads every
 * page, so the default doctor stays cheap and says so. Anything but a lone
 * "ok" is a failure (exit 5, row name `integrity`).
 */
export function checkDbIntegrity(
  db: Db,
  deep: boolean,
): { mode: "deep" | "skipped"; ok: boolean | null; problems: string[] } {
  if (!deep) return { mode: "skipped", ok: null, problems: [] };
  let lines: string[];
  try {
    lines = (db.pragma("quick_check") as { quick_check: string }[]).map((r) => r.quick_check);
  } catch (err) {
    // A page too damaged to read throws instead of reporting.
    lines = [err instanceof Error ? err.message : String(err)];
  }
  const ok = lines.length === 1 && lines[0] === "ok";
  return { mode: "deep", ok, problems: ok ? [] : lines.slice(0, INTEGRITY_LINES) };
}

/** Column width for the `label : value` environment block. Wide enough
 *  for the longest label any backend contributes — `$HERDR_WORKSPACE_ID`
 *  at 19 — so the colons stay in one column on every mux. */
const LABEL_WIDTH = 19;
const pad = (s: string): string => s.padEnd(LABEL_WIDTH);

/** Where agent state comes from: herdr on herdr, murmur otherwise. A
 *  live mu extension makes murmur optional for pi agents. */
function agentStateCheck(health: MuxHealth | undefined, muExtLive: boolean): DoctorCheck {
  return murmurDoctorCheck(health?.name === "herdr" ? "herdr" : "murmur", {
    muExtOk: muExtLive,
  });
}

function cycleFix(c: EdgeCycle): string {
  return `mu task unblock ${c.blocked} --by ${c.blocker} -w ${c.workstream}`;
}

function printCheck(label: string, check: DoctorCheck): void {
  const colour = check.status === "ok" ? pc.green : check.status === "warn" ? pc.yellow : pc.red;
  const word = check.status === "ok" ? "ok" : check.status.toUpperCase();
  console.log(`  ${pad(label)}: ${colour(word)} ${pc.dim(check.detail)}`);
}

/**
 * Health of the active mux, or undefined when NO backend resolves.
 * Never throws: doctor's whole job is reporting a broken substrate,
 * so `NoMultiplexerError` here is a finding, not a failure.
 */
async function muxHealth(): Promise<MuxHealth | undefined> {
  try {
    return await (await activeMux()).healthCheck();
  } catch {
    return undefined;
  }
}

/** No multiplexer works here (none detected, or the forced one does not
 *  answer): doctor prints its whole report first, then fails with the
 *  one-line install advice, exit 5. A binary with no client attached is
 *  NOT this case: detached servers start on demand. */
function noMuxFailure(health: MuxHealth | undefined): NoMultiplexerError | null {
  if (health?.ok === true) return null;
  return new NoMultiplexerError(health === undefined ? ["tmux", "herdr"] : [health.name]);
}

/** Render a hazard list as doctor rows plus a remediation block per
 *  non-ok finding. Shared by the fleet and disk sections, which differ
 *  only in what they check. Returns true iff anything needs attention. */
function printHazards(hazards: readonly FleetHazard[]): boolean {
  let sawProblem = false;
  for (const hazard of hazards) {
    const colour =
      hazard.severity === "fail" ? pc.red : hazard.severity === "warn" ? pc.yellow : pc.green;
    const label = hazard.severity === "ok" ? "ok" : hazard.severity.toUpperCase();
    console.log(`  ${hazard.name.padEnd(16)} : ${colour(label)} ${pc.dim(hazard.detail)}`);
    if (hazard.severity !== "ok") sawProblem = true;
  }
  for (const hazard of hazards) {
    if (hazard.severity === "ok" || hazard.remediation === undefined) continue;
    console.log("");
    for (const line of hazard.remediation) console.log(`  ${line}`);
  }
  return sawProblem;
}

export async function cmdDoctor(
  db: Db,
  opts: { json?: boolean; deep?: boolean; disk?: boolean } = {},
): Promise<void> {
  if (opts.json) {
    return cmdDoctorJson(db, opts);
  }
  console.log(pc.bold("mu doctor"));

  // ─ Environment
  //
  // The backend reports DATA (name / version / its own env facts);
  // doctor owns every string below. A second mux with different
  // ambient vars needs no change here.
  console.log(pc.bold("\nenvironment"));
  const health = await muxHealth();
  if (health === undefined) {
    console.log(`  multiplexer      : ${pc.red("NONE")} — install tmux ≥ 3.0`);
  } else {
    const label = pad(health.name);
    if (health.ok) console.log(`  ${label}: ${pc.green("ok")} (${health.version ?? "?"})`);
    else console.log(`  ${label}: ${pc.red("NOT FOUND")} — ${health.remediation}`);
    for (const fact of health.env) {
      console.log(`  ${pad(fact.name)}: ${fact.value ? pc.green(fact.value) : pc.dim("not set")}`);
    }
  }
  const ctlSockets = await ctlSocketsDoctorCheck(listAgents(db), { stateDir: dirname(db.name) });
  const muExt = ctlExtensionDoctorCheck(ctlSockets.agents);
  printCheck("agent state", agentStateCheck(health, extensionLive(ctlSockets.agents)));
  printCheck("mu ext", muExt);
  printCheck("ctl", ctlSockets.check);

  // ─ DB + schema
  console.log(pc.bold("\ndb"));
  console.log(`  path             : ${pc.dim(defaultDbPath())}`);
  let integrityFailed = false;
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length === 0) {
      console.log(`  schema           : ${pc.green("ok")} (${EXPECTED_TABLES.length} tables)`);
    } else {
      console.log(`  schema           : ${pc.red("missing")} — ${missing.join(", ")}`);
    }
    // Schema version: openDb refuses any DB older or newer than
    // CURRENT_SCHEMA_VERSION (SchemaTooOldError / SchemaTooNewError,
    // exit 4; there is no migration ladder). A mismatch here means the
    // row changed after open, e.g. an external SQLite client.
    try {
      const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
        | { version: number }
        | undefined;
      const v = row?.version;
      if (v === undefined) {
        console.log(
          `  schema_version   : ${pc.red("missing row")} (expected ${CURRENT_SCHEMA_VERSION})`,
        );
      } else if (v === CURRENT_SCHEMA_VERSION) {
        console.log(`  schema_version   : ${pc.green(String(v))}`);
      } else if (v < CURRENT_SCHEMA_VERSION) {
        console.log(
          `  schema_version   : ${pc.yellow(String(v))} (code expects ${CURRENT_SCHEMA_VERSION}; openDb refuses older DBs, so the row changed after open)`,
        );
      } else {
        console.log(
          `  schema_version   : ${pc.red(String(v))} (code expects ${CURRENT_SCHEMA_VERSION}; possible downgrade or future-version DB)`,
        );
      }
    } catch {
      console.log(
        `  schema_version   : ${pc.red("unreadable")} (schema_version table missing or wrong shape)`,
      );
    }
    const integrity = checkDbIntegrity(db, opts.deep === true);
    if (integrity.mode === "skipped") {
      console.log(
        `  integrity        : ${pc.dim("skipped (run `mu doctor --deep` for PRAGMA quick_check)")}`,
      );
    } else if (integrity.ok) {
      console.log(`  integrity        : ${pc.green("ok")} (quick_check)`);
    } else {
      integrityFailed = true;
      console.log(`  integrity        : ${pc.red("FAIL")} (quick_check)`);
      for (const line of integrity.problems) console.log(`      ${line}`);
    }
    const capture = captureDoctorCheck(db);
    const paint =
      capture.status === "ok" ? pc.green : capture.status === "warn" ? pc.yellow : pc.red;
    console.log(`  capture          : ${paint(capture.status)} (${capture.detail})`);
    const journal = db.pragma("journal_mode", { simple: true });
    console.log(
      `  journal_mode     : ${journal === "wal" ? pc.green(String(journal)) : pc.yellow(String(journal))}`,
    );
    const fk = db.pragma("foreign_keys", { simple: true });
    console.log(`  foreign_keys     : ${fk === 1 ? pc.green("on") : pc.red(`off (${fk})`)}`);
  } catch (err) {
    console.log(
      `  schema           : ${pc.red("FAIL")} — ${err instanceof Error ? err.message : err}`,
    );
  }

  // ─ Workstream (doctor is machine-wide; per-workstream stats only for a
  // managed worker's injected scope; nothing is read from the session)
  console.log(pc.bold("\nworkstream"));
  const currentWorkstream: string | null = injectedWorkstream() ?? null;
  if (currentWorkstream !== null) {
    console.log(`  current          : ${pc.green(currentWorkstream)}`);
  } else {
    console.log(
      `  current          : ${pc.dim("none")} (doctor reads the whole machine; pass nothing, or use mu state -w <name>)`,
    );
  }

  // ─ Per-workstream stats (current only; --all stretch)
  if (currentWorkstream) {
    const ws = currentWorkstream;
    console.log(pc.bold(`\nstate (workstream=${ws})`));
    const summary = await summarizeWorkstream(db, { workstream: ws });
    const counts = {
      agents: summary.agentCount,
      tasks: summary.taskCount,
      ready: countReady(db, ws),
      blocked: countBlocked(db, ws),
      inProgress: countInProgressByWorkstream(db, ws),
      logs: countLogsByWorkstream(db, ws),
    };
    console.log(`  agents           : ${counts.agents}`);
    console.log(
      `  tasks            : ${counts.tasks} (ready ${counts.ready}, blocked ${counts.blocked}, in-progress ${counts.inProgress})`,
    );
    console.log(`  ops rows         : ${counts.logs}`);

    // Reconciliation: ghost detection (DB rows with dead panes) + orphans.
    // mu doctor is diagnostic — mode: "report-only" so it never
    // deletes rows AND never writes to the DB / tmux titles just for
    // being polled (would race in-flight spawns; see
    // PENDING_PANE_PREFIX).
    try {
      const view = await listLiveAgents(db, { workstream: ws, mode: "report-only" });
      const ghosts = view.report.prunedGhosts;
      const ghostNote =
        ghosts > 0
          ? pc.yellow(
              `${ghosts} ghost pane${ghosts === 1 ? "" : "s"} would be reaped by \`mu state\` or \`mu agent list\``,
            )
          : pc.green("none");
      console.log(`  ghosts           : ${ghostNote}`);
      const orphanColor = view.orphans.length > 0 ? pc.yellow : pc.green;
      console.log(
        `  orphan panes     : ${orphanColor(String(view.orphans.length))}${view.orphans.length > 0 ? pc.dim(" (run `mu agent list` to see them)") : ""}`,
      );
    } catch (err) {
      console.log(
        `  reconcile        : ${pc.dim("skipped")} (${err instanceof Error ? err.message : err})`,
      );
    }
  }

  // ─ Mixed-fleet hazards (cheap: two path compares, one statfs, one scan)
  //
  // These run in the DEFAULT doctor because they are cheap AND
  // PREVENTABLE — each one is a condition the operator can fix before it
  // costs them data, unlike drift which is a bug report.
  console.log(pc.bold("\nfleet"));
  const fleet = [
    ...checkFleetHazards(db, { dbPath: defaultDbPath() }),
    checkSegmentVersion(db, process.env.MU_SYNC_DIR),
    checkUnpublishedOps(db, process.env.MU_SYNC_DIR),
    checkOrphanedAgents(db),
  ];
  let sawHazard = printHazards(fleet);

  // Sync can merge states the local close guards refuse (open blockers
  // under a done task, a close with no evidence note). Warn rows only.
  console.log(pc.bold("\nclose guards"));
  if (printHazards(checkCloseGuards(db))) sawHazard = true;

  // Sync can merge two valid edges into a cycle; its members block each
  // other until one closes. Report-only: the fix is an existing verb.
  console.log(pc.bold("\ndag"));
  const cycles = findEdgeCycles(db);
  if (cycles.length === 0) {
    console.log(`  ${"cycles".padEnd(16)} : ${pc.green("ok")} ${pc.dim("no dependency cycles")}`);
  } else {
    sawHazard = true;
    console.log(
      `  ${"cycles".padEnd(16)} : ${pc.yellow("WARN")} ${pc.dim(`${cycles.length} dependency cycle(s); members block each other until one closes. Applying every fix below breaks them all`)}`,
    );
    for (const c of cycles) {
      console.log(`      ${c.workstream}: ${[...c.path, c.path[0]].join(" -> ")}`);
      console.log(pc.dim(`      break it: ${cycleFix(c)}`));
    }
  }

  // ─ Housekeeping: workstreams that look torn-down-able
  //
  // Deliberately its own section rather than a `fleet` row: fleet is
  // about a MIXED FLEET corrupting itself, and this is about a single
  // box accumulating finished work. Severity is always `ok`, so this
  // never contributes to `sawHazard` — a tidy-up opportunity is not a
  // fault, and treating it as one would make doctor cry wolf forever.
  console.log(pc.bold("\nhousekeeping"));
  const dormant = checkDormantWorkstreams(db, { currentWorkstream });
  console.log(
    `  ${dormant.name.padEnd(16)} : ${dormant.severity === "ok" && dormant.remediation === undefined ? pc.green("ok") : pc.yellow("note")} ${pc.dim(dormant.detail)}`,
  );
  // Printed directly rather than through `printHazards`, which shows a
  // remediation block only for non-`ok` findings. This finding is
  // deliberately `ok` AND has the names — which are the entire point of
  // the row — in its remediation, so routing it through that helper
  // would report a count and withhold the list.
  if (dormant.remediation !== undefined) {
    console.log("");
    for (const line of dormant.remediation) console.log(`  ${line}`);
  }
  const oldDelegates = checkOldDelegates(db);
  console.log(
    `  ${oldDelegates.name.padEnd(16)} : ${oldDelegates.remediation === undefined ? pc.green("ok") : pc.yellow("note")} ${pc.dim(oldDelegates.detail)}`,
  );
  if (oldDelegates.remediation !== undefined) {
    console.log("");
    for (const line of oldDelegates.remediation) console.log(`  ${line}`);
  }
  // A hint, never a hazard: a lease job that ended normally leaves its reservation
  // until the next close of the name, and that is ordinary.
  const leaseJobs = leaseJobHints(db);
  console.log(
    `  ${"lease-job".padEnd(16)} : ${
      leaseJobs.length === 0
        ? `${pc.green("ok")} ${pc.dim("no lease job reservation outlives its agent")}`
        : `${pc.yellow("hint")} ${pc.dim(`${leaseJobs.length} lease job reservation(s) whose agent is gone; each close stops its job (a host gone for good: --abandon-job)`)}`
    }`,
  );
  for (const h of leaseJobs) console.log(pc.dim(`      ${leaseJobHintLine(h)}`));

  // ─ Disk ↔ DB reconciliation
  //
  // The only section that reads the filesystem. Default tier is readdir
  // + stat (~1ms); recursive byte accounting is --disk, because its cost
  // scales with the worktrees rather than with mu's state.
  console.log(pc.bold("\ndisk"));
  const disk = checkDiskRecon(db);
  if (printHazards(disk)) sawHazard = true;
  if (opts.disk === true) {
    const usage = measureWorktreeUsage(db);
    const total = usage.reduce((n, u) => n + u.bytes, 0);
    const reclaimable = usage.filter((u) => u.orphan).reduce((n, u) => n + u.bytes, 0);
    console.log(
      `\n  ${"worktree bytes".padEnd(16)} : ${formatBytes(total)} across ${usage.length} worktree(s)${
        reclaimable > 0 ? pc.yellow(` — ${formatBytes(reclaimable)} in orphan dirs`) : ""
      }`,
    );
    for (const u of usage) {
      const tag = u.orphan ? pc.yellow(" orphan") : "";
      console.log(
        `      ${formatBytes(u.bytes).padStart(6)}  ${u.workstreamName}/${u.agentName}${tag}`,
      );
    }
  } else {
    console.log(
      pc.dim("  (run `mu doctor --disk` for per-worktree byte usage — walks every worktree)"),
    );
  }

  // ─ Ops-log drift
  //
  // TIERED ON PURPOSE. The full rebuild-and-diff is ~0.6ms per op
  // (measured: 2.2s on a 1000-task / 3461-op DB), which is too slow to
  // put in a reflexively-run command. So the default runs a ~1ms
  // invariant and points at --deep; --deep runs the real thing.
  console.log(pc.bold("\nops log"));
  if (opts.deep === true) {
    const report = checkDrift(db);
    const compared = Object.entries(report.rowsCompared)
      .map(([t, n]) => `${n} ${t}`)
      .join(", ");
    if (report.clean) {
      console.log(
        `  drift            : ${pc.green("ok")} ${pc.dim(`rebuild matches live tables (${compared}, ${report.elapsedMs}ms)`)}`,
      );
    } else {
      console.log(
        `  drift            : ${pc.red("FAIL")} ${report.totalDrift} divergence(s) ${pc.dim(`(${report.elapsedMs}ms)`)}`,
      );
      for (const record of report.records) console.log(`      ${formatDriftRecord(record)}`);
      if (report.totalDrift > report.records.length) {
        console.log(pc.dim(`      … and ${report.totalDrift - report.records.length} more`));
      }
      console.log("");
      for (const line of driftRemediation()) console.log(`  ${line}`);
      // Non-zero exit so CI and wrapper scripts notice. Thrown last so
      // the whole report is printed first.
      throw new DriftDetectedError(report.totalDrift, report.records);
    }
  } else {
    const cheap = checkCheapDriftInvariant(db);
    if (cheap.clean) {
      console.log(
        `  drift (shallow)  : ${pc.green("ok")} ${pc.dim(`every live row has ops (${cheap.elapsedMs}ms) — run \`mu doctor --deep\` for the full rebuild diff`)}`,
      );
    } else {
      console.log(
        `  drift (shallow)  : ${pc.red("FAIL")} ${cheap.totalUnexplained} row(s) with NO ops explaining their existence`,
      );
      for (const row of cheap.unexplainedRows) {
        console.log(`      ${row.table} ${row.key}: no op names this key`);
      }
      console.log(pc.dim("      capture missed these rows entirely. Run `mu doctor --deep`."));
      console.log("");
      for (const line of driftRemediation()) console.log(`  ${line}`);
      throw new DriftDetectedError(cheap.totalUnexplained, []);
    }
  }
  const size = opsSizeHint(db);
  if (size) {
    console.log(`  size             : ${pc.yellow("hint")} ${size.line}`);
    for (const c of size.commands) console.log(pc.dim(`      ${c}`));
  }
  if (sawHazard) {
    console.log(
      pc.dim("\nSee the fleet / disk sections above: at least one finding needs attention."),
    );
  }
  // A `fail` row (today: the DB inside MU_SYNC_DIR) is a hard failure,
  // not a hint, so it exits non-zero like drift. Thrown last so the
  // whole report is printed first.
  const failed = failedHazardNames([...fleet, ...disk]);
  if (integrityFailed) failed.push("integrity");
  if (failed.length > 0) throw new HazardFailError(failed);
  const noMux = noMuxFailure(health);
  if (noMux !== null) throw noMux;
}

/** Names of the `fail`-severity rows, the ones that make doctor exit 5. */
function failedHazardNames(hazards: readonly { name: string; severity: string }[]): string[] {
  return hazards.filter((h) => h.severity === "fail").map((h) => h.name);
}

/** The ops-log size hint: torn-down history worth forgetting, largest
 *  first, and redundant tombstones worth compacting. Undefined when
 *  neither is worth a line. */
function opsSizeHint(db: Db): { line: string; commands: string[] } | undefined {
  const forgettable = forgetHint(db);
  const tomb = planCompact(db);
  const parts: string[] = [];
  const commands: string[] = [];
  if (forgettable) {
    parts.push(
      `${forgettable.total} torn-down workstreams hold ${forgettable.ops} ops (${formatBytes(forgettable.bytes)}); largest: ${forgettable.top.join(", ")}`,
    );
    commands.push(
      "see them:    mu workstream list --torn-down",
      `forget some: mu db forget ${forgettable.top.join(" ")}`,
    );
  }
  if (tomb.bytes >= 1024 * 1024) {
    parts.push(`${tomb.tombstones} redundant note tombstones (${formatBytes(tomb.bytes)})`);
    commands.push("compact:     mu db compact");
  }
  return parts.length === 0 ? undefined : { line: parts.join("; "), commands };
}

/**
 * JSON form of `mu doctor`. Same checks the human form runs, collected
 * into a single structured record for piping. Surfaces 'ok' / 'warn' /
 * 'fail' for each subsystem so callers can match on a single field.
 */
export async function cmdDoctorJson(
  db: Db,
  opts: { deep?: boolean; disk?: boolean } = {},
): Promise<void> {
  // environment
  const health = await muxHealth();
  const ctlSockets = await ctlSocketsDoctorCheck(listAgents(db), { stateDir: dirname(db.name) });
  const muExt = ctlExtensionDoctorCheck(ctlSockets.agents);
  const env = {
    // `mux` is the backend-agnostic key. `tmux` is kept as an alias for
    // back-compat with scripts that grew around the pre-MuxBackend
    // shape; it reports the ACTIVE backend, whatever it is.
    mux: health ?? { name: null, ok: false, version: null },
    tmux: { ok: health?.ok ?? false, version: health?.version ?? null },
    ...Object.fromEntries(health?.env.map((f) => [f.name.replace(/^\$/, ""), f.value]) ?? []),
    agentState: agentStateCheck(health, extensionLive(ctlSockets.agents)),
    ctl: { extension: muExt, sockets: ctlSockets.check, agents: ctlSockets.agents },
  };

  // db / schema
  let dbReport: Record<string, unknown>;
  let integrity: ReturnType<typeof checkDbIntegrity> | undefined;
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
    let schemaVersion: number | null = null;
    let schemaVersionStatus: "ok" | "missing" | "stale" | "future" | "unreadable";
    try {
      const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
        | { version: number }
        | undefined;
      const v = row?.version;
      if (v === undefined) schemaVersionStatus = "missing";
      else {
        schemaVersion = v;
        if (v === CURRENT_SCHEMA_VERSION) schemaVersionStatus = "ok";
        else if (v < CURRENT_SCHEMA_VERSION) schemaVersionStatus = "stale";
        else schemaVersionStatus = "future";
      }
    } catch {
      schemaVersionStatus = "unreadable";
    }
    const journal = db.pragma("journal_mode", { simple: true });
    const fk = db.pragma("foreign_keys", { simple: true });
    integrity = checkDbIntegrity(db, opts.deep === true);
    dbReport = {
      path: defaultDbPath(),
      schema: { ok: missing.length === 0, expected: EXPECTED_TABLES, missing, present: tables },
      schemaVersion: {
        value: schemaVersion,
        expected: CURRENT_SCHEMA_VERSION,
        status: schemaVersionStatus,
      },
      integrity,
      journalMode: journal,
      foreignKeys: fk === 1,
    };
  } catch (err) {
    dbReport = { error: err instanceof Error ? err.message : String(err) };
  }

  // workstream
  const currentWorkstream: string | null = injectedWorkstream() ?? null;

  // per-workstream stats (only when resolvable)
  let workstreamStats: Record<string, unknown> | null = null;
  if (currentWorkstream) {
    const ws = currentWorkstream;
    const summary = await summarizeWorkstream(db, { workstream: ws });
    const counts = {
      agents: summary.agentCount,
      tasks: summary.taskCount,
      ready: countReady(db, ws),
      blocked: countBlocked(db, ws),
      inProgress: countInProgressByWorkstream(db, ws),
      logs: countLogsByWorkstream(db, ws),
    };
    let reconcile: Record<string, unknown> | null = null;
    try {
      // mu doctor --json: report-only for the same reason as the human path.
      const view = await listLiveAgents(db, { workstream: ws, mode: "report-only" });
      reconcile = {
        prunedGhosts: view.report.prunedGhosts,
        orphanCount: view.orphans.length,
      };
    } catch (err) {
      reconcile = { skipped: true, reason: err instanceof Error ? err.message : String(err) };
    }
    workstreamStats = { workstreamName: ws, ...counts, reconcile };
  }

  // Mixed-fleet hazards: same three checks the human path runs.
  const hazards = [
    ...checkFleetHazards(db, { dbPath: defaultDbPath() }),
    checkSegmentVersion(db, process.env.MU_SYNC_DIR),
    checkUnpublishedOps(db, process.env.MU_SYNC_DIR),
    checkOrphanedAgents(db),
  ].map((h) => ({
    name: h.name,
    severity: h.severity,
    detail: h.detail,
  }));

  const closeGuards = checkCloseGuards(db).map((h) => ({
    name: h.name,
    severity: h.severity,
    detail: h.detail,
    remediation: h.remediation ?? [],
  }));
  const dagCycles = findEdgeCycles(db).map((c) => ({ ...c, fix: cycleFix(c) }));

  // Disk ↔ DB: same checks as the human path. Remediation lines ride
  // along here (unlike `fleet`, which drops them) because the whole
  // point of the section is that an agent reading --json can act on it.
  const disk = checkDiskRecon(db).map((h) => ({
    name: h.name,
    severity: h.severity,
    detail: h.detail,
    remediation: h.remediation ?? [],
  }));

  // Housekeeping: the dormant list, with its rows STRUCTURED rather
  // than only prose. An agent reading --json should be able to pick a
  // name without parsing the remediation block, and the `kind` field is
  // the whole finding — `finished` is safe to tear down, `abandoned`
  // needs a look first.
  const dormantHazard = checkDormantWorkstreams(db, { currentWorkstream });
  const housekeeping = {
    dormantWorkstreams: {
      name: dormantHazard.name,
      severity: dormantHazard.severity,
      detail: dormantHazard.detail,
      remediation: dormantHazard.remediation ?? [],
      workstreams: findDormantWorkstreams(db, { currentWorkstream }),
      thresholds: { finishedIdleDays: FINISHED_IDLE_DAYS, abandonedIdleDays: ABANDONED_IDLE_DAYS },
    },
    leaseJobs: leaseJobHints(db),
    oldDelegates: (() => {
      const h = checkOldDelegates(db);
      return {
        name: h.name,
        severity: h.severity,
        detail: h.detail,
        remediation: h.remediation ?? [],
      };
    })(),
  };
  const worktreeUsage = opts.disk === true ? measureWorktreeUsage(db) : null;

  // Drift: shallow by default, full rebuild diff under --deep. Same
  // tiering as the human path, for the same measured reason.
  let drift: Record<string, unknown>;
  let driftFailure: DriftDetectedError | null = null;
  if (opts.deep === true) {
    const report = checkDrift(db);
    drift = {
      mode: "deep",
      ok: report.clean,
      totalDrift: report.totalDrift,
      records: report.records,
      rowsCompared: report.rowsCompared,
      elapsedMs: report.elapsedMs,
    };
    if (!report.clean) driftFailure = new DriftDetectedError(report.totalDrift, report.records);
  } else {
    const cheap = checkCheapDriftInvariant(db);
    drift = {
      mode: "shallow",
      ok: cheap.clean,
      totalUnexplained: cheap.totalUnexplained,
      unexplainedRows: cheap.unexplainedRows,
      elapsedMs: cheap.elapsedMs,
      hint: "run `mu doctor --deep --json` for the full rebuild diff",
    };
    if (!cheap.clean) driftFailure = new DriftDetectedError(cheap.totalUnexplained, []);
  }

  const report = {
    environment: env,
    db: dbReport,
    workstream: { currentName: currentWorkstream },
    state: workstreamStats,
    fleet: hazards,
    housekeeping,
    closeGuards,
    dagCycles,
    disk,
    worktreeUsage,
    drift,
    size: opsSizeHint(db) ?? null,
    remediation: drift.ok === true ? [] : driftRemediation(),
  };
  // ONE document per invocation: a clean report is the success envelope; a
  // failing one is the failure envelope with the same report in `data`, so a
  // --json consumer still gets the integrity facts beside the non-zero exit.
  const failed = failedHazardNames([...hazards, ...disk]);
  if (integrity?.ok === false) failed.push("integrity");
  const failure =
    driftFailure ?? (failed.length > 0 ? new HazardFailError(failed) : noMuxFailure(health));
  if (failure !== null) throw failureWithData(failure, report);
  emitJson(report);
}

// agents/tasks counts come from summarizeWorkstream() (src/workstream.ts) —
// it already runs the same JOIN-on-workstreams SELECTs for its summary, so
// we don't keep a second copy of those queries here. The four helpers below
// (in-progress / logs / ready / blocked) are doctor-only views that
// summarizeWorkstream doesn't expose.
function countInProgressByWorkstream(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t
           JOIN workstreams ws ON ws.id = t.workstream_id
          WHERE ws.name = ? AND t.status = 'IN_PROGRESS'`,
      )
      .get(workstream) as { n: number }
  ).n;
}
function countLogsByWorkstream(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        // ops.key is the natural key ('' = machine-wide), so no join.
        // The workstream's own ops have key = <ws>; its tasks, notes and
        // edges all start with '<ws>/' (src/capture.ts § Natural keys).
        // A range, not LIKE: '_' in a workstream name is a LIKE wildcard,
        // and '0' is the byte after '/'.
        "SELECT COUNT(*) AS n FROM ops WHERE key = ? OR (key >= ? AND key < ?)",
      )
      .get(workstream, `${workstream}/`, `${workstream}0`) as { n: number }
  ).n;
}
function countReady(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ready v
           JOIN workstreams ws ON ws.id = v.workstream_id
          WHERE ws.name = ?`,
      )
      .get(workstream) as { n: number }
  ).n;
}
function countBlocked(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM blocked v
           JOIN workstreams ws ON ws.id = v.workstream_id
          WHERE ws.name = ?`,
      )
      .get(workstream) as { n: number }
  ).n;
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireDoctorCommand is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { handle, JSON_OPT } from "../cli.js";

export function wireDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Environment + state health check")
    .option(...JSON_OPT)
    .option(
      "--deep",
      "also run PRAGMA quick_check, and rebuild the ops log into a temp DB and diff it against the live tables (slower: ~0.6ms per op)",
    )
    .option(
      "--disk",
      "also measure per-worktree disk usage (walks every worktree; the disk↔DB reconciliation itself always runs)",
    )
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean; deep?: boolean; disk?: boolean };
      return handle((db) => cmdDoctor(db, opts), this as Command)();
    });
}
