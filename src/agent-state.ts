import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { execa } from "execa";
import { expectsCtl } from "./agents/transport.js";
import { ctlProbe } from "./ctl/client.js";
import { ctlSocketPath } from "./ctl/path.js";
import type { CtlState } from "./ctl/protocol.js";
import { activeMux } from "./mux/detect.js";
import { tmux } from "./tmux.js";

export type RuntimeState = "busy" | "needs_input" | "needs_permission" | "unknown";
export type StateSource = "murmur" | "herdr" | "ctl" | "none";
/** How a pi agent's control socket answered; "n/a" for non-pi agents. */
export type CtlLink = "ok" | "missing" | "refused" | "n/a";

export interface StateReading {
  state: RuntimeState;
  source: StateSource;
  since: number | null;
  alive: boolean;
  reason?: string;
  /** Set for agents that expect a control socket. */
  ctl?: Exclude<CtlLink, "n/a">;
}

export interface StateAgentRef {
  name: string;
  workstreamName: string;
  paneId: string;
  /** When set and it names pi, the control socket is the state source. */
  cli?: string;
}

/** Per-agent budget for the control-socket status read. */
const CTL_STATE_PROBE_MS = 1000;

/** ctl's idle maps to needs_input, the same as murmur's idle. */
export function ctlRuntimeState(state: CtlState): RuntimeState {
  return state === "busy" ? "busy" : "needs_input";
}

export const UNKNOWN_REASON = {
  murmurMissing: "murmur not installed",
  extensionMissing: "murmur pi extension not linked",
  noRow: "murmur has no row",
  stale: "remote snapshot stale",
  herdrNone: "herdr reports no state",
  paneGone: "pane gone",
  ctlMissing: "ctl missing",
  ctlRefused: "ctl refused",
} as const;

export type MurmurRunner = () => Promise<string | null>;

const MURMUR_CACHE_MS = 10_000;
let murmurRunnerForTests: MurmurRunner | null = null;
let murmurCache: { at: number; stdout: string | null } | undefined;

export function agentKey(a: { name: string; workstreamName: string }): string {
  return `${a.workstreamName}/${a.name}`;
}

export function ambiguousReason(n: number): string {
  return `ambiguous: ${n} hosts`;
}

function murmurOnPath(): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    try {
      accessSync(join(dir, "murmur"), constants.X_OK);
      return true;
    } catch {
      // Keep scanning PATH.
    }
  }
  return false;
}

function murmurExtensionLinked(): boolean {
  const piDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return existsSync(join(piDir, "extensions", "murmur.ts"));
}

export function murmurAvailable(): boolean {
  return murmurOnPath() && murmurExtensionLinked();
}

const defaultMurmurRunner: MurmurRunner = async () => {
  try {
    const result = await execa("murmur", ["status", "--json"], {
      timeout: 5_000,
      reject: false,
    });
    return result.exitCode === 0 ? (result.stdout ?? "") : null;
  } catch {
    return null;
  }
};

export function setMurmurRunnerForTests(run: MurmurRunner | null): void {
  murmurRunnerForTests = run;
}

export function resetAgentStateCacheForTests(): void {
  murmurCache = undefined;
}

function unknown(reason: string, alive = true, source: StateSource = "none"): StateReading {
  return { state: "unknown", source, since: null, alive, reason };
}

function mapMurmurState(token: string, since: number | null): StateReading {
  let state: RuntimeState;
  switch (token) {
    case "working":
      state = "busy";
      break;
    case "blocked":
      state = "needs_permission";
      break;
    case "idle":
    case "done":
    case "crashed":
      state = "needs_input";
      break;
    default:
      return unknown(`unrecognised murmur state ${token}`, true, "murmur");
  }
  return { state, source: "murmur", since, alive: true };
}

function parseSince(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

async function readMurmur(now: number): Promise<string | null> {
  if (murmurCache !== undefined && now - murmurCache.at < MURMUR_CACHE_MS) {
    return murmurCache.stdout;
  }
  let stdout: string | null;
  try {
    stdout = await (murmurRunnerForTests ?? defaultMurmurRunner)();
  } catch {
    stdout = null;
  }
  murmurCache = { at: now, stdout };
  return stdout;
}

interface MurmurPane {
  local?: unknown;
  agent_name?: unknown;
  workstream?: unknown;
  activity?: unknown;
  attention?: unknown;
  freshness?: unknown;
  updated_at?: unknown;
}

function remotePanes(stdout: string): MurmurPane[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || !("panes" in parsed)) return [];
    const panes = parsed.panes;
    if (!Array.isArray(panes)) return [];
    return panes.filter((pane): pane is MurmurPane => typeof pane === "object" && pane !== null);
  } catch {
    return [];
  }
}

function remoteReading(agent: StateAgentRef, panes: readonly MurmurPane[]): StateReading {
  const matches = panes.filter(
    (pane) =>
      pane.local === false &&
      pane.agent_name === agent.name &&
      pane.workstream === agent.workstreamName,
  );
  if (matches.length === 0) {
    return unknown(
      murmurExtensionLinked() ? UNKNOWN_REASON.noRow : UNKNOWN_REASON.extensionMissing,
    );
  }
  if (matches.length > 1) return unknown(ambiguousReason(matches.length));
  const row = matches[0];
  if (row === undefined) return unknown(UNKNOWN_REASON.noRow);
  if (row.freshness !== "fresh") return unknown(UNKNOWN_REASON.stale);

  const kinds = Array.isArray(row.attention)
    ? new Set(
        row.attention.flatMap((entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "kind" in entry &&
          typeof entry.kind === "string"
            ? [entry.kind]
            : [],
        ),
      )
    : new Set<string>();
  const state: RuntimeState = kinds.has("crashed")
    ? "needs_input"
    : kinds.has("blocked")
      ? "needs_permission"
      : kinds.has("done")
        ? "needs_input"
        : row.activity === "running"
          ? "busy"
          : "needs_input";
  return {
    state,
    source: "murmur",
    since: typeof row.updated_at === "number" ? row.updated_at : null,
    alive: true,
  };
}

async function readHerdrStates(
  agents: readonly StateAgentRef[],
  mux: Awaited<ReturnType<typeof activeMux>>,
): Promise<Map<string, StateReading>> {
  const readings = new Map<string, StateReading>();
  for (const agent of agents) {
    try {
      const status = await mux.paneStatus?.(agent.paneId);
      if (status !== undefined) {
        readings.set(agentKey(agent), {
          state: status,
          source: "herdr",
          since: null,
          alive: true,
        });
        continue;
      }
      const alive = await mux.paneExists(agent.paneId);
      readings.set(
        agentKey(agent),
        alive
          ? unknown(UNKNOWN_REASON.herdrNone, true, "herdr")
          : unknown(UNKNOWN_REASON.paneGone, false),
      );
    } catch (error) {
      readings.set(
        agentKey(agent),
        unknown(`herdr: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }
  return readings;
}

/**
 * Read the runtime state of each agent. Order per agent: control socket
 * (pi agents) → murmur pane option → murmur remote → herdr. A pi agent
 * whose socket does not answer reads `unknown` with reason `ctl missing`
 * or `ctl refused`, never a murmur reading, so the gap stays visible.
 * `stateDir` roots the derived socket path (spawn uses the DB's directory).
 */
export async function readAgentStates(
  agents: readonly StateAgentRef[],
  opts: { now?: number; stateDir?: string } = {},
): Promise<Map<string, StateReading>> {
  const ctlAgents = agents.filter((a) => a.cli !== undefined && expectsCtl({ cli: a.cli }));
  const probes = await Promise.all(
    ctlAgents.map((a) =>
      ctlProbe(ctlSocketPath(a.workstreamName, a.name, opts.stateDir), CTL_STATE_PROBE_MS),
    ),
  );
  const readings = new Map<string, StateReading>();
  const failed = new Map<string, "missing" | "refused">();
  ctlAgents.forEach((agent, i) => {
    const probe = probes[i];
    if (probe?.kind === "ok") {
      readings.set(agentKey(agent), {
        state: ctlRuntimeState(probe.status.state),
        source: "ctl",
        since: probe.status.since,
        alive: true,
        ctl: "ok",
      });
    } else {
      failed.set(agentKey(agent), probe?.kind === "missing" ? "missing" : "refused");
    }
  });
  const rest = agents.filter((a) => !readings.has(agentKey(a)));
  if (rest.length === 0) return readings;
  for (const [key, reading] of await readBaseStates(rest, opts)) {
    const ctl = failed.get(key);
    if (ctl === undefined) readings.set(key, reading);
    else if (!reading.alive) readings.set(key, { ...reading, ctl });
    else {
      const reason = ctl === "missing" ? UNKNOWN_REASON.ctlMissing : UNKNOWN_REASON.ctlRefused;
      readings.set(key, { ...unknown(reason), ctl });
    }
  }
  return readings;
}

async function readBaseStates(
  agents: readonly StateAgentRef[],
  opts: { now?: number },
): Promise<Map<string, StateReading>> {
  const readings = new Map<string, StateReading>();
  let mux: Awaited<ReturnType<typeof activeMux>>;
  try {
    mux = await activeMux();
  } catch (error) {
    const reason = `mux: ${error instanceof Error ? error.message : String(error)}`;
    for (const agent of agents) readings.set(agentKey(agent), unknown(reason));
    return readings;
  }
  if (mux.paneStatus !== undefined) return await readHerdrStates(agents, mux);

  let stdout: string;
  try {
    stdout = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{@murmur_pane_state}\t#{@murmur_pane_since}",
    ]);
  } catch (error) {
    const reason = `tmux: ${error instanceof Error ? error.message : String(error)}`;
    for (const agent of agents) readings.set(agentKey(agent), unknown(reason));
    return readings;
  }

  const local = new Map<string, { token: string; since: number | null }>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [paneId, token = "", since] = line.split("\t");
    if (paneId !== undefined) local.set(paneId, { token, since: parseSince(since) });
  }

  const remoteCandidates: StateAgentRef[] = [];
  for (const agent of agents) {
    const pane = local.get(agent.paneId);
    if (pane === undefined) {
      readings.set(agentKey(agent), unknown(UNKNOWN_REASON.paneGone, false));
    } else if (pane.token.length > 0) {
      readings.set(agentKey(agent), mapMurmurState(pane.token, pane.since));
    } else {
      remoteCandidates.push(agent);
    }
  }

  if (remoteCandidates.length === 0) return readings;
  const remoteStdout = await readMurmur(opts.now ?? Date.now());
  if (remoteStdout === null) {
    const reason = murmurAvailable()
      ? UNKNOWN_REASON.noRow
      : murmurOnPath()
        ? UNKNOWN_REASON.extensionMissing
        : UNKNOWN_REASON.murmurMissing;
    for (const agent of remoteCandidates) readings.set(agentKey(agent), unknown(reason));
    return readings;
  }

  const panes = remotePanes(remoteStdout);
  for (const agent of remoteCandidates) readings.set(agentKey(agent), remoteReading(agent, panes));
  return readings;
}
