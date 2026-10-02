// Doctor summary — a TUI-friendly slice of `mu doctor`'s checks.
//
// The full `mu doctor` verb (src/cli/doctor.ts) renders a textual card
// with: tmux/env presence, DB schema integrity, schema_version,
// journal_mode, foreign_keys, per-workstream agent/task/log counts,
// and reconcile drift (would-be-pruned ghosts + orphan panes). The
// TUI's slot-9 Doctor card needs the same SIGNAL but at poll-tick
// cost: an array of checks the card can render row-by-row.
//
// Per feat_card_9_doctor (workstream `tui-impl`), promoted from the
// last reserved slot in design_global_keymap.
//
// CHEAPNESS RULES (so this is safe to run on every snapshot tick):
//   - Synchronous DB pragmas + COUNT(*)-shape SELECTs only.
//   - Reads `view.report.prunedGhosts` and `view.orphans` straight
//     out of the WorkstreamSnapshot — `loadWorkstreamSnapshot`
//     already runs `listLiveAgents(...)` once per tick, which populates
//     `report.prunedGhosts`.
//   - Reads `workspaceOrphans` straight out of the snapshot too.
//   - NO subprocess shellouts. The `tmux -V` check from the textual
//     `mu doctor` is intentionally OMITTED here — the TUI is
//     already running inside a terminal so tmux's binary presence
//     is implicit, and adding a per-tick subprocess fork to a
//     polled dashboard is the wrong tradeoff. If a future task
//     wants tmux-presence on the dashboard, add it as a
//     once-per-session probe in <App> (mirrors probeClipboardBackend),
//     not as a per-tick check here.
//
// CHECK SHAPE (matches the textual doctor's per-row vocabulary):
//   { name, status: "ok" | "warn" | "fail", detail }
//
// The card filters to non-OK rows for its body; subtitle counts
// warn+fail. When everything is OK the card renders a quiet
// "all healthy" line so the operator's eye learns to read the
// presence of rows as "something needs attention."

import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { murmurAvailable, UNKNOWN_REASON } from "./agent-state.js";
import { type AgentRow, resolveCliCommand, speaksMuCtl } from "./agents.js";
import { type CtlProbe, ctlProbe } from "./ctl/client.js";
import { ctlSocketPath } from "./ctl/path.js";
import { CTL_OPS } from "./ctl/protocol.js";
import { CURRENT_SCHEMA_VERSION, type Db, defaultDbPath, EXPECTED_TABLES } from "./db.js";
import { checkCheapDriftInvariant } from "./drift.js";
import { checkFleetHazards } from "./fleet-hazards.js";
import { inspectLinks, type LinkOptions } from "./link.js";
import type { WorkstreamSnapshot } from "./state.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  /** Short, stable identifier — used as the row label. Lowercase
   *  one-word tokens so the column-aligned card layout looks tidy. */
  name: string;
  status: DoctorStatus;
  /** Free-form prose for the row's right-hand column. Kept short so
   *  the card's CLIP column doesn't truncate it on common widths. */
  detail: string;
}

export interface DoctorSummary {
  /** Every check that ran, in stable display order. The card filters
   *  to non-OK rows for its body but keeps the OK rows so the popup
   *  (when it ships under feat_more_cards_umbrella) can render the
   *  full list. */
  checks: readonly DoctorCheck[];
  /** Convenience: how many rows are warn or fail. Card subtitle
   *  reads this directly. Pure derivation from `checks`. */
  problemCount: number;
}

/**
 * Compute the doctor summary for a workstream. Pure-ish: runs cheap
 * synchronous DB queries + reads from the supplied snapshot. Callers
 * that don't want to compute a snapshot first (or are running inside
 * `loadWorkstreamSnapshot` mid-build) can omit `snapshot` — the
 * snapshot-derived checks (ghosts / orphans / workspace-orphans) are
 * skipped in that case.
 */
export function loadDoctorSummary(
  db: Db,
  snapshot: WorkstreamSnapshot | null,
  agentStateSource: "murmur" | "herdr" = "murmur",
): DoctorSummary {
  const checks: DoctorCheck[] = [];

  // ─ schema (table presence) ──────────────────────────────────────
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
      checks.push({
        name: "schema",
        status: "ok",
        detail: `${EXPECTED_TABLES.length} tables`,
      });
    } else {
      checks.push({
        name: "schema",
        status: "fail",
        detail: `missing: ${missing.join(", ")}`,
      });
    }
  } catch (err) {
    checks.push({
      name: "schema",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─ schema_version ────────────────────────────────────────────────
  try {
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
      | { version: number }
      | undefined;
    const v = row?.version;
    if (v === undefined) {
      checks.push({
        name: "schema_version",
        status: "fail",
        detail: `missing row (expected ${CURRENT_SCHEMA_VERSION})`,
      });
    } else if (v === CURRENT_SCHEMA_VERSION) {
      checks.push({ name: "schema_version", status: "ok", detail: String(v) });
    } else if (v < CURRENT_SCHEMA_VERSION) {
      checks.push({
        name: "schema_version",
        status: "warn",
        detail: `${v} (code expects ${CURRENT_SCHEMA_VERSION})`,
      });
    } else {
      checks.push({
        name: "schema_version",
        status: "fail",
        detail: `${v} (code expects ${CURRENT_SCHEMA_VERSION}; downgrade?)`,
      });
    }
  } catch {
    checks.push({
      name: "schema_version",
      status: "fail",
      detail: "unreadable",
    });
  }

  // ─ journal_mode ─────────────────────────────────────────────────
  try {
    const journal = db.pragma("journal_mode", { simple: true });
    if (journal === "wal") {
      checks.push({ name: "journal_mode", status: "ok", detail: String(journal) });
    } else {
      checks.push({
        name: "journal_mode",
        status: "warn",
        detail: `${journal} (expected wal)`,
      });
    }
  } catch (err) {
    checks.push({
      name: "journal_mode",
      status: "warn",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─ foreign_keys ─────────────────────────────────────────────────
  try {
    const fk = db.pragma("foreign_keys", { simple: true });
    if (fk === 1) {
      checks.push({ name: "foreign_keys", status: "ok", detail: "on" });
    } else {
      checks.push({
        name: "foreign_keys",
        status: "fail",
        detail: `off (${fk})`,
      });
    }
  } catch (err) {
    checks.push({
      name: "foreign_keys",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─ snapshot-derived checks (ghosts / orphans) ───────────────────
  if (snapshot !== null) {
    const ghosts = snapshot.view.report.prunedGhosts;
    if (ghosts === 0) {
      checks.push({ name: "agents", status: "ok", detail: "no ghost panes" });
    } else {
      checks.push({
        name: "agents",
        status: "warn",
        detail: `${ghosts} ghost pane${ghosts === 1 ? "" : "s"}; run \`mu state\` or \`mu agent list\` to reap`,
      });
    }
    const orphanPanes = snapshot.view.orphans.length;
    if (orphanPanes === 0) {
      checks.push({ name: "panes", status: "ok", detail: "no orphan panes" });
    } else {
      checks.push({
        name: "panes",
        status: "warn",
        detail: `${orphanPanes} orphan pane${orphanPanes === 1 ? "" : "s"}; run \`mu agent adopt\``,
      });
    }
    const orphanWorkspaces = snapshot.workspaceOrphans.length;
    if (orphanWorkspaces === 0) {
      checks.push({ name: "workspaces", status: "ok", detail: "no orphan dirs" });
    } else {
      checks.push({
        name: "workspaces",
        status: "warn",
        detail: `${orphanWorkspaces} orphan dir${orphanWorkspaces === 1 ? "" : "s"}; run \`mu workspace orphans\``,
      });
    }
  }

  const muExt = ctlExtensionDoctorCheck();
  checks.push(murmurDoctorCheck(agentStateSource, { muExtOk: muExt.status === "ok" }));
  checks.push(muExt, skillDoctorCheck());

  // ─ Mixed-fleet hazards + the SHALLOW drift invariant.
  //
  // Both obey this file's cheapness rules: the fleet checks are two path
  // comparisons, one statfs and one indexed scan; the drift invariant is
  // four indexed NOT EXISTS queries (~1ms on a 200-task DB). NO rebuild
  // here — `checkDrift` is ~0.6ms per op and would make the TUI's poll
  // tick take seconds. The deep check belongs to `mu doctor --deep`, and
  // the row below says so when it is clean, so the operator knows the
  // dashboard is showing a smoke alarm rather than a proof.
  for (const hazard of checkFleetHazards(db, { dbPath: defaultDbPath() })) {
    // Skip the inert "no sync configured" row: on a single-machine setup
    // it would be permanent noise in a dashboard whose whole design is
    // "rows appearing means something needs attention".
    if (hazard.severity === "ok" && hazard.name === "db-vs-sync") continue;
    checks.push({ name: hazard.name, status: hazard.severity, detail: hazard.detail });
  }

  const cheapDrift = checkCheapDriftInvariant(db);
  checks.push(
    cheapDrift.clean
      ? {
          name: "drift",
          status: "ok",
          detail: "every row has ops; `mu doctor --deep` for full diff",
        }
      : {
          name: "drift",
          status: "fail",
          detail: `${cheapDrift.totalUnexplained} row(s) with no ops; run \`mu doctor --deep\``,
        },
  );

  return { checks, problemCount: countProblems(checks) };
}

function resolveExecutable(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}

function murmurVersion(executable: string): string | null {
  let dir = dirname(executable);
  const root = parse(dir).root;
  while (dir !== root) {
    const packagePath = join(dir, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
        if (
          typeof pkg === "object" &&
          pkg !== null &&
          "name" in pkg &&
          pkg.name === "@mu-crew/murmur" &&
          "version" in pkg &&
          typeof pkg.version === "string"
        ) {
          return pkg.version;
        }
      } catch {
        // An unrelated or unreadable package.json does not end the walk.
      }
    }
    dir = dirname(dir);
  }
  return null;
}

function olderThanMurmurOne(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match !== null && Number(match[1]) < 1;
}

/** Detail of the murmur row when murmur is absent but pi agents are
 *  covered by the mu extension's control socket. */
export const MURMUR_NOT_NEEDED_DETAIL =
  "not needed for pi agents (mu extension); used for other CLIs";

/**
 * The agent-state source row. Shared by the TUI card and `mu doctor`.
 * `muExtOk`: the mu pi extension is linked, so pi agents report state
 * over their control socket and a missing murmur only affects other CLIs.
 */
export function murmurDoctorCheck(
  agentStateSource: "murmur" | "herdr",
  opts: { muExtOk?: boolean } = {},
): DoctorCheck {
  if (agentStateSource === "herdr") {
    return { name: "murmur", status: "ok", detail: "agent state from herdr" };
  }

  const executable = resolveExecutable("murmur");
  if (opts.muExtOk === true && (executable === null || !murmurAvailable())) {
    return { name: "murmur", status: "ok", detail: MURMUR_NOT_NEEDED_DETAIL };
  }
  if (executable === null) {
    return {
      name: "murmur",
      status: "warn",
      detail: `${UNKNOWN_REASON.murmurMissing}: agent state shows unknown`,
    };
  }
  if (!murmurAvailable()) {
    return {
      name: "murmur",
      status: "warn",
      detail: `${UNKNOWN_REASON.extensionMissing}: run murmur link pi`,
    };
  }

  const version = murmurVersion(executable);
  if (version !== null && olderThanMurmurOne(version)) {
    return {
      name: "murmur",
      status: "warn",
      detail: `murmur ${version} is older than 1.0.0; @murmur_pane_since missing, idle/stall timing unknown`,
    };
  }
  return {
    name: "murmur",
    status: "ok",
    detail: version === null ? "agent state from murmur" : `agent state from murmur ${version}`,
  };
}

const RELINK = "run mu link pi";

/** The "mu ext" row: is the mu pi extension shim installed and live? */
export function ctlExtensionDoctorCheck(opts?: LinkOptions): DoctorCheck {
  const { extension } = inspectLinks(opts);
  switch (extension.state) {
    case "ok":
      return {
        name: "mu ext",
        status: "ok",
        detail:
          process.env.MU_DELEGATE === "0"
            ? "(ctl; mu_delegate disabled by MU_DELEGATE=0)"
            : "(ctl, mu_delegate)",
      };
    case "stale-copy":
      return { name: "mu ext", status: "warn", detail: `stale copy: ${RELINK}` };
    case "dangling":
      return { name: "mu ext", status: "warn", detail: `dangling: ${RELINK}` };
    default:
      return { name: "mu ext", status: "warn", detail: `not linked: ${RELINK}` };
  }
}

/** The "mu skill" row: is `~/.agents/skills/mu` this package's skill? */
export function skillDoctorCheck(opts?: LinkOptions): DoctorCheck {
  const { skill } = inspectLinks(opts);
  switch (skill.state) {
    case "ok":
      return { name: "mu skill", status: "ok", detail: skill.target ?? skill.path };
    case "foreign":
      return {
        name: "mu skill",
        status: "warn",
        detail: `foreign skill at ~/.agents/skills/mu (${skill.target ?? "not a symlink"})`,
      };
    case "dangling":
      return { name: "mu skill", status: "warn", detail: `dangling: ${RELINK}` };
    default:
      return { name: "mu skill", status: "warn", detail: `not linked: ${RELINK}` };
  }
}

/** Per-agent probe budget for the doctor "ctl" row. */
export const DOCTOR_CTL_TIMEOUT_MS = 500;

export interface AgentCtlReport {
  workstream: string;
  agent: string;
  socket: string;
  probe: CtlProbe["kind"];
  /** ok probes: the mu version the agent's extension was built from. */
  extVersion?: string;
  /** ok probes whose extension is older than the installed mu, or lacks ops. */
  outdated?: boolean;
  /** ok probes: protocol ops (CTL_OPS) the extension's hello does not list. */
  missingOps?: string[];
}

/**
 * The installed mu version, from the package.json one directory above
 * this module (src/ in source mode, dist/ when bundled). Null if unreadable.
 */
export function installedMuVersion(): string | null {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    const v =
      typeof pkg === "object" && pkg !== null ? (pkg as { version?: unknown }).version : null;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** a < b on the numeric major.minor.patch prefix; false when either is unparsable. */
export function versionOlder(a: string, b: string): boolean {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0;
  }
  return false;
}

/**
 * Is an ok probe's extension older than the installed mu? An extension
 * without `ops` in hello predates version reporting, so it is older. One
 * with ops but no extVersion runs from source (tests, dev): not flagged.
 * Missing ops are checked separately (`probeMissingOps`), because a pi that
 * loaded the extension before an op landed reports the SAME version.
 */
function probeOutdated(probe: CtlProbe, installed: string | null): boolean {
  if (probe.kind !== "ok") return false;
  if (probe.ops === undefined) return true;
  if (probe.extVersion === undefined || installed === null) return false;
  return versionOlder(probe.extVersion, installed);
}

/** CTL_OPS entries an ok probe's hello does not list; [] when it predates ops. */
function probeMissingOps(probe: CtlProbe): string[] {
  if (probe.kind !== "ok" || probe.ops === undefined) return [];
  const served = new Set<string>(probe.ops);
  return CTL_OPS.filter((op) => !served.has(op));
}

/**
 * The "ctl" row: probe the control socket of every agent that runs pi
 * (per `speaksMuCtl`, the rule spawn's handshake uses). Probes run in
 * parallel, each bounded by `timeoutMs`. Async, so `mu doctor` only:
 * the TUI's per-tick summary stays synchronous and socket-free.
 */
export async function ctlSocketsDoctorCheck(
  agents: readonly AgentRow[],
  opts: { timeoutMs?: number; installedVersion?: string | null } = {},
): Promise<{ check: DoctorCheck; agents: AgentCtlReport[] }> {
  const timeoutMs = opts.timeoutMs ?? DOCTOR_CTL_TIMEOUT_MS;
  const installed =
    opts.installedVersion !== undefined ? opts.installedVersion : installedMuVersion();
  const piAgents = agents.filter((a) => speaksMuCtl(a.cli, resolveCliCommand(a.cli)));
  const reports = await Promise.all(
    piAgents.map(async (a): Promise<AgentCtlReport> => {
      const socket = ctlSocketPath(a.workstreamName, a.name);
      const probe = await ctlProbe(socket, timeoutMs);
      const older = probeOutdated(probe, installed);
      const missingOps = probeMissingOps(probe);
      return {
        workstream: a.workstreamName,
        agent: a.name,
        socket,
        probe: probe.kind,
        ...(probe.kind === "ok" && probe.extVersion !== undefined
          ? { extVersion: probe.extVersion }
          : {}),
        ...(older || missingOps.length > 0 ? { outdated: true } : {}),
        ...(missingOps.length > 0 ? { missingOps } : {}),
      };
    }),
  );
  const bad = reports.filter((r) => r.probe !== "ok" || r.outdated);
  const describe = (r: AgentCtlReport): string => {
    const who = `${r.workstream}/${r.agent}`;
    if (!r.outdated) return `${who}: ${r.probe}`;
    if (r.missingOps && !(r.extVersion && installed && versionOlder(r.extVersion, installed)))
      return `${who}: extension lacks ops: ${r.missingOps.join(", ")}`;
    return `${who}: extension ${r.extVersion ?? "(unknown)"} older than installed ${installed ?? "mu"}`;
  };
  let check: DoctorCheck;
  if (reports.length === 0) check = { name: "ctl", status: "ok", detail: "no pi agents" };
  else if (bad.length === 0) {
    check = {
      name: "ctl",
      status: "ok",
      detail: `${reports.length}/${reports.length} pi agents reachable`,
    };
  } else {
    check = {
      name: "ctl",
      status: "warn",
      detail: bad.map(describe).join(", "),
    };
  }
  return { check, agents: reports };
}

/** Count of warn + fail rows. Pure; exported for unit tests. */
export function countProblems(checks: readonly DoctorCheck[]): number {
  let n = 0;
  for (const c of checks) if (c.status !== "ok") n++;
  return n;
}

/**
 * Return the full check array (OK + warn + fail) in stable display
 * order. Used by the TUI's slot-9 Doctor popup
 * (feat_popup_9_doctor, workstream `tui-impl`) which renders every
 * row — not just the non-OK subset Card 9 surfaces.
 *
 * Thin wrapper over `loadDoctorSummary` so the SDK seam stays
 * single: `loadDoctorSummary` is the source of truth for the
 * check vocabulary, and the popup's `loadDoctorChecks` view is
 * just `.checks`. Pure-ish (same cheap synchronous DB reads as
 * `loadDoctorSummary`).
 */
export function loadDoctorChecks(
  db: Db,
  snapshot: WorkstreamSnapshot | null,
): readonly DoctorCheck[] {
  return loadDoctorSummary(db, snapshot).checks;
}

// ─── pure helpers (per-check remediation hints) ────────────────────
//
// These map a `DoctorCheck.name` to either (a) a single-line
// informational shell command suitable for yank/paste, or (b) a
// short multi-line paragraph explaining the failure shape. They
// originally lived next to the slot-9 Doctor popup
// (src/cli/tui/popups/doctor.tsx) but moved here per
// review_tui_doctor_remediation_lives_in_popup: neither function
// has any rendering concern (both return plain strings) and the
// popup's `renderDrillBody` was the only render-layer caller.
// Living here keeps every per-check fact in one file so adding a
// new check is a single touchpoint, and lets future SDK consumers
// (e.g. a `mu doctor --remediation` flag) reach the same data
// without depending on the TUI render layer.
//
// READ-ONLY by construction. Even when a check is `fail`, the yank
// recipe is the diagnostic verb the operator should RUN MANUALLY,
// never a mutating fix. Schema-shape checks (no actionable
// mutation) yank a `# ...` comment line so the muscle-memory of
// `y` still gives feedback.

/**
 * Map a check row to the most useful informational command the
 * operator might paste. Read-only by construction: `mu agent list`,
 * `mu workspace orphans`, `mu doctor` are all SELECT-shape verbs;
 * `# ...` lines are visibly inert. Per the slot-9 popup spec KEY
 * MAP block this is INFORMATIONAL, never a mutating recipe — so
 * even when the check is `fail`, we yank the diagnostic verb the
 * operator should RUN MANUALLY, not a fix command.
 *
 * Pure; exported for unit tests + SDK reuse.
 */
export function yankCommandForCheck(check: Pick<DoctorCheck, "name" | "status">): string {
  switch (check.name) {
    case "murmur":
      return "murmur link pi";
    case "mu ext":
    case "mu skill":
      return "mu link pi";
    case "ctl":
      return "mu agent list";
    case "agents":
      // Diagnostic/reaping read: `mu state` and `mu agent list` both
      // reconcile missing panes. Prefer the canonical state card; the
      // detailed agent list remains in the doctor detail text.
      return "mu state";
    case "panes":
      // Orphan tmux panes — the standard adoption recipe.
      return "mu agent adopt";
    case "workspaces":
      // Diagnostic: list orphan workspace dirs. Operator decides
      // whether to `mu workspace free` from the list output.
      return "mu workspace orphans";
    case "drift":
      // The full rebuild-and-diff. Read-only: it writes only to a temp
      // DB and never touches live state.
      return "mu doctor --deep";
    case "db-vs-sync":
    case "db-filesystem":
      // Environment hazards: the fix is an env-var change the operator
      // must make deliberately, so yank the inspection, not a mutation.
      return "# check MU_DB_PATH / MU_SYNC_DIR; see `mu doctor` for the full explanation";
    case "name-case":
      return 'mu sql "SELECT name FROM workstreams ORDER BY LOWER(name)"';
    case "schema":
    case "schema_version":
    case "journal_mode":
    case "foreign_keys":
      // No actionable mutation an operator should yank for
      // schema-shape checks (the migration runner is the SDK seam,
      // not a CLI verb). Yank a no-op comment so the muscle memory
      // of `y` still gives feedback. When fail, the textual
      // `mu doctor` carries the full diagnostic.
      return `# ${check.name}: see \`mu doctor\` for full diagnostic`;
    default:
      // Forward-compat: any future check name falls back to the
      // textual `mu doctor` verb. Read-only.
      return "mu doctor";
  }
}

/**
 * A short paragraph (one paragraph per check name) explaining the
 * shape of the failure / warning. Returned as a `readonly string[]`
 * so the popup's drill body can interleave the lines with other
 * content; CLI consumers can `.join("\n")` themselves.
 *
 * Pure; exported for unit tests + SDK reuse.
 */
export function remediationParagraph(check: DoctorCheck): readonly string[] {
  switch (check.name) {
    case "murmur":
      return [
        "Install murmur with `npm i -g @mu-crew/murmur`, then run",
        "`murmur init` and `murmur link pi`. Restart running pi sessions.",
      ];
    case "mu ext":
    case "mu skill":
      return [
        "Run `mu link pi` to install the mu pi extension shim and the mu",
        "skill symlink, then restart running pi sessions so they load it.",
      ];
    case "ctl":
      return [
        "mu talks to pi agents over a per-agent control socket served by",
        "the mu pi extension. `missing`: no socket (extension not loaded,",
        "or the agent predates `mu link pi`). `refused`: socket present but",
        "not answering. `version`: protocol mismatch; upgrade mu or pi.",
        "Run `mu link pi`, then respawn the agent. `extension X older than",
        "installed Y`: the agent's pi loaded an older mu build; type /reload",
        "in its pane (`mu agent send <a> '/reload' --via mux`) or respawn it.",
      ];
    case "agents":
      return [
        "A 'ghost pane' is a registered agent whose tmux pane is gone.",
        "Doctor only reports the count. Run `mu state` or `mu agent list`",
        "to reap ghost agents and return their IN_PROGRESS tasks to OPEN.",
        "The TUI is read-only, but its slow tick uses the same state reap.",
      ];
    case "panes":
      return [
        "An 'orphan pane' is a live tmux pane in the workstream's",
        "session that mu doesn't know about. Adopt it via",
        "`mu agent adopt <pane-id>` to register it as a managed agent,",
        "or kill it manually if it's not yours.",
      ];
    case "workspaces":
      return [
        "An 'orphan workspace dir' is a per-agent VCS workspace under",
        "the workstream that has no matching mu agent row. Run",
        "`mu workspace orphans -w <ws>` to list them, then",
        "`mu workspace free <agent>` to release each one.",
      ];
    case "drift":
      return [
        "Drift means the ops log and the live tables disagree, and since",
        "undo/sync/history are ALL projections of that one log, a",
        "capture bug breaks all of them at once. This row is the shallow",
        "check (every live row must have at least one op naming its key);",
        "it cannot see an uncaptured UPDATE. Run `mu doctor --deep` for the",
        "full rebuild-and-diff, which names the exact table/key/field.",
        "Back up before acting: if capture missed a mutation the LIVE rows",
        "hold real work and rebuilding would discard it.",
      ];
    case "db-vs-sync":
      return [
        "MU_DB_PATH is inside MU_SYNC_DIR. A live WAL-mode SQLite DB is",
        "three files whose mutual consistency IS its durability; a file",
        "syncer copying them out of order, or resurrecting a peer's stale",
        "-wal, silently corrupts the DB. Move the DB out of the synced",
        "folder — mu syncs append-only per-machine segments precisely so",
        "the database file itself never has to travel.",
      ];
    case "db-filesystem":
      return [
        "The DB appears to be on a network mount (NFS/SMB/FUSE). SQLite's",
        "WAL mode needs working POSIX advisory locks and a shared-memory",
        "file, and network filesystems provide neither dependably: expect",
        "'database is locked' without contention, or corruption with it.",
        "Keep the DB on local disk and sync segments instead.",
      ];
    case "name-case":
      return [
        "Two workstream names differ only by letter case. They coexist on",
        "Linux but collide on macOS (APFS) and Windows (NTFS), and a",
        "workstream name IS a tmux session name and seeds workspace paths.",
        "A Mac in the fleet would see one session where Linux sees two.",
        "Rename one side before adding a Mac: export, re-init under a new",
        "name, tear down the old one.",
      ];
    case "schema":
      return [
        "Missing tables typically mean an older mu binary opened the",
        "DB without running migrations. Rebuild mu (npm run build)",
        "and re-open; openDb runs the migration block on every",
        "process start.",
      ];
    case "schema_version":
      return [
        "Schema version mismatch means the DB was opened by a",
        "different mu binary than the one running now. If `<` the",
        "expected version, openDb should have migrated — check the",
        "build. If `>` the expected, you may have a downgrade in",
        "progress; restore from a snapshot rather than continuing.",
      ];
    case "journal_mode":
      return [
        "WAL is the default journal mode for SQLite under mu. A",
        "different mode (e.g. `delete`) means an external tool",
        "rewrote the DB pragma. Re-open the DB with mu to restore.",
      ];
    case "foreign_keys":
      return [
        "Foreign keys must be ON for mu's CASCADE deletes to work.",
        "An OFF value usually means an external SQLite client opened",
        "the DB without `PRAGMA foreign_keys = ON`. Re-open with mu.",
      ];
    default:
      return ["See `mu doctor` for the canonical textual diagnostic."];
  }
}
