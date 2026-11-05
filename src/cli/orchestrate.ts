// mu — `mu orchestrate`: start an orchestrator of any harness as a managed pane.
//
//   mu orchestrate -w <ws> [--cli <key>] [--name <name>] [--command <cmd>] [--cwd <dir>]
//
// The pane is spawned like a worker (src/agents/spawn.ts), so the orchestrator
// has an explicit identity: MU_MANAGED_AGENT, MU_WORKSTREAM, MU_AGENT_NAME and
// MU_AGENT_CLI, which `currentCallers` and `spawnerFromEnv` read, plus
// MU_ORCHESTRATOR=1. That flag keeps `mu_delegate` visible to a pi
// orchestrator and leaves out what only a worker gets: the close nudge and the
// implicit `-w`. Nothing the orchestrator starts inherits it: spawn builds
// every pane's env, a mux-free delegate's child pi has it removed, and a
// remote pane unsets it (LOCAL_ONLY_ENV). Spec "Every harness first-class", D9.

import type { Command } from "commander";
import { agentToOutput, workstreamIdOf } from "../agent-output.js";
import { AgentCtlUnreachableError, spawnAgent } from "../agents.js";
import { emitJson, handle, JSON_OPT, resolveWorkstream, WORKSTREAM_OPT } from "../cli.js";
import type { Db } from "../db.js";
import { activeMux, attachShellLine } from "../mux.js";
import { pc } from "../output.js";
import { CliExitError } from "./handle.js";
import { installWaitSignals, type WaitSignals } from "./wait.js";

/** The name an orchestrator gets when none is given; taken, the next free one. */
export const DEFAULT_ORCHESTRATOR_NAME = "orchestrator-1";

export interface OrchestrateOpts {
  cli?: string;
  name?: string;
  command?: string;
  cwd?: string;
  tab?: string;
  ctl?: boolean;
  workstream?: string;
  json?: boolean;
}

export async function cmdOrchestrate(
  db: Db,
  opts: OrchestrateOpts,
  sig?: WaitSignals,
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  let agent: Awaited<ReturnType<typeof spawnAgent>>;
  try {
    agent = await spawnAgent(db, {
      name: opts.name ?? DEFAULT_ORCHESTRATOR_NAME,
      workstream,
      orchestrator: true,
      ...(opts.name === undefined ? { nextFree: true } : {}),
      ...(opts.cli !== undefined ? { cli: opts.cli } : {}),
      ...(opts.command !== undefined ? { command: opts.command } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.tab !== undefined ? { tab: opts.tab } : {}),
      ...(opts.ctl === false ? { ctl: false } : {}),
      ...(sig !== undefined ? { signal: sig.signal } : {}),
    });
  } catch (err) {
    // SIGINT/SIGTERM rolled the spawn back (pane and row).
    const which = sig?.which();
    if (which === undefined) throw err;
    const message = `${which} during mu orchestrate: rolled back (${err instanceof Error ? err.message : String(err)})`;
    if (!opts.json) console.error(message);
    throw new CliExitError(
      which === "SIGTERM" ? 143 : 130,
      opts.json ? { error: "SpawnInterruptedError", message } : undefined,
    );
  }
  const name = agent.name;
  const warnings: string[] = [];
  if (agent.ctl === "missing" || agent.ctl === "refused") {
    const warn = new AgentCtlUnreachableError(
      name,
      workstream,
      agent.ctlSocket,
      agent.ctl,
      agent.host,
    );
    warnings.push(warn.message);
    if (!opts.json) console.error(pc.yellow(`warning: ${warn.message}`));
  }
  let attach: string | undefined;
  try {
    const mux = await activeMux();
    attach = attachShellLine(
      await mux.attachCommands({
        session: `mu-${workstream}`,
        window: agent.tab ?? name,
        inside: Boolean(process.env.TMUX),
      }),
    );
  } catch {
    // no attach line
  }
  if (opts.json) {
    emitJson({
      agent: agentToOutput(agent, workstreamIdOf(db, workstream), {
        ctl: agent.ctl,
        ctlSocket: agent.ctlSocket,
      }),
      orchestrator: true,
      caller: `${workstream}/${name}`,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(attach !== undefined ? { attach } : {}),
    });
    return;
  }
  console.log(
    `Started orchestrator ${pc.bold(name)} (${agent.cli}) in window ${pc.bold(agent.tab ?? name)} of ${pc.bold(`mu-${workstream}`)}, pane ${pc.dim(agent.paneId)}`,
  );
  console.log(pc.dim(`  caller: ${workstream}/${name}`));
  if (agent.cwd !== null) console.log(pc.dim(`  cwd: ${agent.cwd}`));
  if (attach !== undefined) console.log(pc.dim(`  attach: ${attach}`));
}

export function wireOrchestrateCommand(program: Command): void {
  program
    .command("orchestrate")
    .description(
      "Start an orchestrator of any agent CLI as a managed pane: an explicit identity (caller <ws>/<name>) plus MU_ORCHESTRATOR=1, so a pi keeps mu_delegate and gets no worker close nudge or implicit -w.",
    )
    .option(
      "--cli <cli>",
      "agent CLI key (default: pi): claude, codex, cursor-agent, muse, pi, or a key whose $MU_<UPPER_CLI>_COMMAND names one",
    )
    .option(
      "--name <name>",
      `the orchestrator's agent name (default: ${DEFAULT_ORCHESTRATOR_NAME}, else the next free one)`,
    )
    .option(
      "--command <cmd>",
      "executable to run in the pane (defaults to $MU_<CLI>_COMMAND or the cli value)",
    )
    .option("--cwd <dir>", "directory the pane starts in (default: yours)")
    .option("--tab <tab>", "mux window/tab name (defaults to the name)")
    .option("--no-ctl", "skip the control-socket handshake with the mu pi extension")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).optsWithGlobals() as OrchestrateOpts;
      const sig = installWaitSignals();
      const run = handle((db) => cmdOrchestrate(db, opts, sig), this as Command);
      return run().finally(() => sig.dispose());
    });
}
