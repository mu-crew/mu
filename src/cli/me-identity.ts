// mu — who is running this process, for `mu me` and `mu state --me`.
//
// One path, no guessing: a managed worker's injected identity (the exact
// `<ws>/<name>` row, looked up in THAT workstream), else a pi session
// (`pi:<PI_SESSION_ID>`, which has no agent row), else an error. `$TMUX_PANE`
// and pane titles never identify anyone here (the older `resolveSelf` still
// does, for the verbs that have not moved).

import { spawnerFromEnv } from "../agents/spawn.js";
import { type AgentRow, getAgent } from "../agents.js";
import { injectedIdentity } from "../cli.js";
import type { Db } from "../db.js";
import { UsageError } from "./handle.js";

export interface MeIdentity {
  /** `spawnerFromEnv()` form: `<ws>/<agent>` or `pi:<session>`. */
  caller: string;
  /** The managed agent's registry row; null for a pi session. */
  agent: AgentRow | null;
}

export function resolveMe(db: Db): MeIdentity {
  const injected = injectedIdentity();
  if (injected !== undefined) {
    const agent = getAgent(db, injected.name, injected.workstream);
    if (agent === undefined) {
      throw new UsageError(
        `injected identity ${injected.workstream}/${injected.name} has no agent row (closed or torn down). Use \`mu agent list -w ${injected.workstream}\`.`,
        { showHelp: false },
      );
    }
    return { caller: `${injected.workstream}/${injected.name}`, agent };
  }
  const caller = spawnerFromEnv();
  if (caller !== null) return { caller, agent: null };
  throw new UsageError(
    "no identity: mu me needs the env spawn injects (MU_MANAGED_AGENT=1, MU_WORKSTREAM, MU_AGENT_NAME) or a pi session ($PI_SESSION_ID); a tmux pane is never guessed",
    { showHelp: false },
  );
}

/** The managed agent, for `mu me tasks` / `mu me next`: they read one agent's workstream, so a pi session (no row) cannot use them. */
export function resolveMeAgent(db: Db): AgentRow {
  const me = resolveMe(db);
  if (me.agent === null) {
    throw new UsageError(
      `${me.caller} is not a managed agent: this verb needs MU_MANAGED_AGENT=1, MU_WORKSTREAM and MU_AGENT_NAME. Use \`mu state --me\` for a pi session.`,
      { showHelp: false },
    );
  }
  return me.agent;
}
