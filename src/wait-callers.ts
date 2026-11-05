// mu — who "I" am for a wait.
//
// One orchestrator is known under two names. The managed `<ws>/<agent>`
// (`MU_MANAGED_AGENT=1`) owns the workers it spawns and the human stops it
// records (`spawnerFromEnv`); `pi:<PI_SESSION_ID>` owns the delegate calls it
// makes (extension/delegate.ts, `mu delegates`). A wait must see both, so a
// caller is a SET: the union of the two when present. Neither alone, and never
// a guess (USER, TMUX_PANE) or "every caller": an empty set owns nothing.

import { isValidAgentName } from "./agents.js";
import { isValidWorkstreamName } from "./workstream.js";

/** The callers of this process, from its env: managed ws/name first, then pi:<session>. */
export function currentCallers(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const { MU_MANAGED_AGENT: managed, MU_WORKSTREAM: ws, MU_AGENT_NAME: name } = env;
  if (managed === "1" && ws && name) out.push(`${ws}/${name}`);
  if (env.PI_SESSION_ID) out.push(`pi:${env.PI_SESSION_ID}`);
  return out;
}

/**
 * Why `raw` is not a caller name for `--as`, or undefined when it is one:
 * a managed `<ws>/<agent>` or a pi session `pi:<id>`, the two forms
 * `currentCallers` produces. A verb that needs a caller outside a managed
 * pane takes it explicitly; mu never guesses one (spec D9).
 */
export function callerNameProblem(raw: string): string | undefined {
  if (raw.startsWith("pi:")) {
    return /^pi:\S+$/.test(raw)
      ? undefined
      : `--as ${JSON.stringify(raw)}: pi:<session> needs a session id`;
  }
  const [ws, name, ...rest] = raw.split("/");
  if (
    ws !== undefined &&
    name !== undefined &&
    rest.length === 0 &&
    isValidWorkstreamName(ws) &&
    isValidAgentName(name)
  ) {
    return undefined;
  }
  return `--as ${JSON.stringify(raw)}: expected <workstream>/<agent> or pi:<session>`;
}
