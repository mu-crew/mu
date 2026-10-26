// Doctor check helpers shared by `mu doctor` (src/cli/doctor.ts): the check
// row shape, the murmur / pi-extension / ctl-socket probes and the version
// helpers behind them.

import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { murmurAvailable, UNKNOWN_REASON } from "./agent-state.js";
import { type AgentRow, expectsCtl } from "./agents.js";
import { type CtlProbe, ctlProbe } from "./ctl/client.js";
import { ctlSocketPath } from "./ctl/path.js";
import { CTL_OPS } from "./ctl/protocol.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  /** Short, stable identifier — the row label. */
  name: string;
  status: DoctorStatus;
  /** Free-form prose for the row's right-hand column. */
  detail: string;
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
 * `muExtOk`: a pi agent's live hello answered (never a file on disk), so
 * pi agents report state over their control socket and a missing murmur only affects other CLIs.
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
      detail:
        opts.muExtOk === true
          ? `murmur ${version} is older than 1.0.0; idle/stall timing unknown for non-pi CLIs (pi agents use ctl)`
          : `murmur ${version} is older than 1.0.0; @murmur_pane_since missing, idle/stall timing unknown`,
    };
  }
  return {
    name: "murmur",
    status: "ok",
    detail: version === null ? "agent state from murmur" : `agent state from murmur ${version}`,
  };
}

/** What to run when no live extension answers: the package is the only install path. */
export const INSTALL_ADVICE = "pi install npm:@mu-crew/mu, then restart pi";

/** A pi agent answered hello: the only proof the extension is loaded. */
export function extensionLive(reports: readonly AgentCtlReport[]): boolean {
  return reports.some((r) => r.probe === "ok");
}

/**
 * The "mu ext" row, from the live ctl probes of the pi agents `mu doctor`
 * just asked (hello's extVersion / ops / features). Never inferred from a
 * file on disk. With no agent to ask the extension is UNKNOWN, not
 * missing, and the row stays ok: a fresh install must not warn. hello
 * cannot prove a skill was loaded, so there is no skill row.
 */
export function ctlExtensionDoctorCheck(reports: readonly AgentCtlReport[]): DoctorCheck {
  const live = reports.find((r) => r.probe === "ok");
  if (live) {
    const features = live.features?.length ? `; ${live.features.join(", ")}` : "";
    const ops = live.opCount === undefined ? "" : `, ${live.opCount} ops`;
    return {
      name: "mu ext",
      status: "ok",
      detail: `${live.extVersion ?? "from source"} (ctl${ops}${features})`,
    };
  }
  if (reports.length === 0) {
    return {
      name: "mu ext",
      status: "ok",
      detail: `unknown: no pi agent running to ask (${INSTALL_ADVICE})`,
    };
  }
  return { name: "mu ext", status: "warn", detail: `no pi agent answered: ${INSTALL_ADVICE}` };
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
  /** ok probes: how many ops hello lists. */
  opCount?: number;
  /** ok probes: the optional features hello lists. */
  features?: string[];
  /** ok probes: protocol ops (CTL_OPS) the extension's hello does not list. */
  missingOps?: string[];
  /** Outdated probes: how `/reload` reaches it. "ctl" when the extension
   *  serves op command, else "respawn" (mu cannot reload it). */
  reloadVia?: "ctl" | "respawn";
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
 * (per `expectsCtl`, the rule send, state and abort use). `stateDir`
 * roots the derived socket path like spawn's (the DB's directory); it
 * defaults to ctlSocketPath's env-derived base. Probes run in
 * parallel, each bounded by `timeoutMs`. Async, so `mu doctor` only:
 * the TUI's per-tick summary stays synchronous and socket-free.
 */
export async function ctlSocketsDoctorCheck(
  agents: readonly AgentRow[],
  opts: { timeoutMs?: number; installedVersion?: string | null; stateDir?: string } = {},
): Promise<{ check: DoctorCheck; agents: AgentCtlReport[] }> {
  const timeoutMs = opts.timeoutMs ?? DOCTOR_CTL_TIMEOUT_MS;
  const installed =
    opts.installedVersion !== undefined ? opts.installedVersion : installedMuVersion();
  const piAgents = agents
    .map((a) => ({ a, socket: ctlSocketPath(a.workstreamName, a.name, opts.stateDir) }))
    .filter(({ a, socket }) => expectsCtl(a, socket));
  const reports = await Promise.all(
    piAgents.map(async ({ a, socket }): Promise<AgentCtlReport> => {
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
        ...(probe.kind === "ok" && probe.ops !== undefined ? { opCount: probe.ops.length } : {}),
        ...(probe.kind === "ok" && probe.features !== undefined
          ? { features: probe.features }
          : {}),
        ...(older || missingOps.length > 0
          ? {
              outdated: true,
              reloadVia: probe.kind === "ok" && probe.ops?.includes("command") ? "ctl" : "respawn",
            }
          : {}),
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
