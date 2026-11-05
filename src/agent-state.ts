import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ChannelName, CtlBlocked, CtlTool } from "./channels/types.js";
import { execFileCapture } from "./exec-file.js";
import { activeMux } from "./mux/detect.js";
import type { MuxBackendName } from "./mux/types.js";
import { tmux } from "./tmux.js";

export type RuntimeState = "busy" | "needs_input" | "needs_permission" | "unknown";
export type StateSource = "murmur" | MuxBackendName | "ctl" | "none";
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
  /** ctl only: pi holds queued messages, so an idle reading is about to
   *  turn busy. */
  pending?: boolean;
  /** ctl only: pi's settled-run count (`mu agent wait --after-runs`). */
  runs?: number;
  /** ctl only: the pi process's incarnation string; absent from older extensions. */
  incarnation?: string;
  /** ctl only: the extension dialog pi is waiting on (state needs_permission). */
  blocked?: CtlBlocked;
  /** ctl only: the running tool, null when none; absent from older extensions (unknown). */
  tool?: CtlTool | null;
}

export interface StateAgentRef {
  name: string;
  workstreamName: string;
  paneId: string;
  /** When set and it names pi, the control socket is the state source. */
  cli?: string;
  /** A remote command gate (see src/agents/gate.ts): no control socket, whatever `cli` says. */
  gateToken?: string | null;
  /** The channel the row recorded at spawn; null or absent: derived (see `expectsCtl`). */
  channel?: ChannelName | null;
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
    const result = await execFileCapture("murmur", ["status", "--json"], { timeoutMs: 5_000 });
    return result.exitCode === 0 ? result.stdout : null;
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

/** An `unknown` reading with its reason; `alive` false = the pane is gone. */
export function unknownReading(
  reason: string,
  alive = true,
  source: StateSource = "none",
): StateReading {
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
    case "error":
    case "crashed":
      state = "needs_input";
      break;
    default:
      return unknownReading(`unrecognised murmur state ${token}`, true, "murmur");
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
    return unknownReading(
      murmurExtensionLinked() ? UNKNOWN_REASON.noRow : UNKNOWN_REASON.extensionMissing,
    );
  }
  if (matches.length > 1) return unknownReading(ambiguousReason(matches.length));
  const row = matches[0];
  if (row === undefined) return unknownReading(UNKNOWN_REASON.noRow);
  if (row.freshness !== "fresh") return unknownReading(UNKNOWN_REASON.stale);

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
  const state: RuntimeState =
    kinds.has("crashed") || kinds.has("error")
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

/** State from the mux's own per-pane status (herdr's classifier, Rex's OSC 7501 records). */
async function readMuxStates(
  agents: readonly StateAgentRef[],
  mux: Awaited<ReturnType<typeof activeMux>>,
): Promise<Map<string, StateReading>> {
  const readings = new Map<string, StateReading>();
  const source = mux.name;
  const none = `${mux.name} reports no state`;
  for (const agent of agents) {
    try {
      const status = await mux.paneStatus?.(agent.paneId);
      if (status !== undefined) {
        readings.set(agentKey(agent), {
          state: status,
          source,
          since: null,
          alive: true,
        });
        continue;
      }
      const alive = await mux.paneAlive(agent.paneId);
      readings.set(
        agentKey(agent),
        alive ? unknownReading(none, true, source) : unknownReading(UNKNOWN_REASON.paneGone, false),
      );
    } catch (error) {
      readings.set(
        agentKey(agent),
        unknownReading(`${source}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }
  return readings;
}

/**
 * A gate's display reading, from its pane alone (never a host exec): running
 * reads busy; an ended or gone pane reads unknown with the reason. The wait
 * path reads the exit code itself (`readGate`).
 */
export async function readGatePanes(
  gates: readonly StateAgentRef[],
): Promise<Map<string, StateReading>> {
  const readings = new Map<string, StateReading>();
  let mux: Awaited<ReturnType<typeof activeMux>> | undefined;
  let failure = "the multiplexer cannot report a pane's exit";
  try {
    mux = await activeMux();
  } catch (error) {
    failure = `mux: ${error instanceof Error ? error.message : String(error)}`;
  }
  for (const gate of gates) {
    const key = agentKey(gate);
    try {
      const pane = await mux?.paneResult?.(gate.paneId);
      if (pane === undefined) readings.set(key, unknownReading(failure));
      else if (pane.state === "running") {
        readings.set(key, { state: "busy", source: "none", since: null, alive: true });
      } else if (pane.state === "absent")
        readings.set(key, unknownReading(UNKNOWN_REASON.paneGone, false));
      else {
        const how = pane.code !== null ? `exited ${pane.code}` : `killed by signal ${pane.signal}`;
        readings.set(key, unknownReading(how, false));
      }
    } catch (error) {
      readings.set(
        key,
        unknownReading(`mux: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }
  return readings;
}

/**
 * The mux channel's state read (src/channels/mux.ts): the mux's own pane
 * status (herdr, Rex), else murmur's tmux pane option, else murmur's remote
 * snapshot. `livenessOnly` keys read only whether the pane is alive.
 */
export async function readBaseStates(
  agents: readonly StateAgentRef[],
  opts: { now?: number },
  livenessOnly: ReadonlySet<string> = new Set(),
): Promise<Map<string, StateReading>> {
  const readings = new Map<string, StateReading>();
  let mux: Awaited<ReturnType<typeof activeMux>>;
  try {
    mux = await activeMux();
  } catch (error) {
    const reason = `mux: ${error instanceof Error ? error.message : String(error)}`;
    for (const agent of agents) readings.set(agentKey(agent), unknownReading(reason));
    return readings;
  }
  if (mux.paneStatus !== undefined) return await readMuxStates(agents, mux);

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
    for (const agent of agents) readings.set(agentKey(agent), unknownReading(reason));
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
      readings.set(agentKey(agent), unknownReading(UNKNOWN_REASON.paneGone, false));
    } else if (livenessOnly.has(agentKey(agent))) {
      readings.set(agentKey(agent), unknownReading(UNKNOWN_REASON.noRow));
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
    for (const agent of remoteCandidates) readings.set(agentKey(agent), unknownReading(reason));
    return readings;
  }

  const panes = remotePanes(remoteStdout);
  for (const agent of remoteCandidates) readings.set(agentKey(agent), remoteReading(agent, panes));
  return readings;
}
