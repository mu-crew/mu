// mu — which channel an agent is on.
//
// Today the rule is derived: an agent that runs pi (or left its control
// socket file behind) is on `ctl`; every other pane is on `mux`. A remote
// command gate is never on `ctl`.

import { existsSync } from "node:fs";
import { resolveCliCommand, speaksMuCtl } from "../agents/spawn.js";
import type { AgentRow } from "../agents.js";
import { ctlSocketPath } from "../ctl/path.js";
import type { ChannelName } from "./types.js";

/**
 * True when the agent runs pi, so sends go through its control socket.
 * The cli key decides when it names pi (or MU_<KEY>_COMMAND here runs
 * pi). Otherwise the agent's own socket file decides: spawn removes any
 * stale file before the pane starts, so a file at the derived path was
 * bound by this agent's extension (or its ssh forward). That covers
 * `--cli helper --command "pi-meta ..."`, whose command is not stored,
 * without a schema change. `sock` defaults to the derived path; pass
 * agentCtlSocket(db, agent) when a DB is at hand. A command gate (`gateToken`)
 * never speaks ctl: the discriminator beats both rules.
 */
export function expectsCtl(
  agent: Pick<AgentRow, "cli" | "name" | "workstreamName"> & { gateToken?: string | null },
  sock: string = ctlSocketPath(agent.workstreamName, agent.name),
): boolean {
  // A remote command gate runs no pi, whatever its `cli` says or a forward leaves behind.
  if (agent.gateToken != null) return false;
  return speaksMuCtl(agent.cli, resolveCliCommand(agent.cli)) || existsSync(sock);
}

/** The channel of `agent`, its control socket rooted at `stateDir`. An agent with no cli key is on `mux`. */
export function channelOf(
  agent: Pick<AgentRow, "name" | "workstreamName"> & { cli?: string; gateToken?: string | null },
  stateDir?: string,
): ChannelName {
  if (agent.cli === undefined) return "mux";
  const ref = {
    cli: agent.cli,
    name: agent.name,
    workstreamName: agent.workstreamName,
    gateToken: agent.gateToken,
  };
  return expectsCtl(ref, ctlSocketPath(agent.workstreamName, agent.name, stateDir)) ? "ctl" : "mux";
}
