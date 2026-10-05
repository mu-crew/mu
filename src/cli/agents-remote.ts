// mu — `mu agent remote-env`: print the ssh socket-forward args and the
// identity env a remote pi agent needs. Prints only; mu runs no ssh.
//
// The remote pi's extension serves its control socket at the REMOTE
// path ($MU_CTL_SOCK); `ssh -L <local>:<remote>` makes it answer at the
// LOCAL derived path, which every mu verb already connects to. One
// transport for local and remote agents.

import { dirname } from "node:path";
import type { Command } from "commander";
import { isValidAgentName } from "../agents.js";
import {
  emitJson,
  handle,
  JSON_OPT,
  resolveWorkstream,
  UsageError,
  WORKSTREAM_OPT,
} from "../cli.js";
import { CTL_SOCK_ENV, ctlSocketPath, MAX_SOCK_PATH, remoteCtlSocketPath } from "../ctl/path.js";
import type { Db } from "../db.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import { shellQuote } from "../shell-quote.js";
import { isValidWorkstreamName } from "../workstream.js";

export interface RemoteEnv {
  agent: string;
  workstream: string;
  /** The derived path mu connects to; ssh binds it. */
  localSock: string;
  /** Where the remote pi's extension listens ($MU_CTL_SOCK there). */
  remoteSock: string;
  /** ssh options, ready to splice into an ssh command line. */
  sshArgs: string;
  /** Identity env as `K=V` words, for the remote side of the command. */
  env: string;
  /** A complete example `--command` value for `mu agent spawn`. */
  command: string;
}

/** ssh options forcing a direct (non-multiplexed) connection. */
const SSH_DIRECT_OPTS = "-o ControlMaster=no -o ControlPath=none";

/** Characters that survive unquoted inside a single-quoted remote command. */
const SAFE_WORD = /^[A-Za-z0-9_./:@%+-]+$/;

/**
 * Characters allowed in --remote-sock. SAFE_WORD minus ':' (the `-L`
 * field separator) and '%' (ssh percent-expands forward paths, so the
 * forward would point at a different socket than $MU_CTL_SOCK).
 */
const REMOTE_SOCK = /^[A-Za-z0-9_./@+-]+$/;

function word(s: string): string {
  return SAFE_WORD.test(s) ? s : shellQuote(s);
}

export function buildRemoteEnv(
  db: Db,
  agent: string,
  workstream: string,
  remoteSock?: string,
): RemoteEnv {
  if (!isValidAgentName(agent)) {
    throw new UsageError(`invalid agent name ${JSON.stringify(agent)}`);
  }
  if (!isValidWorkstreamName(workstream)) {
    throw new UsageError(`invalid workstream name ${JSON.stringify(workstream)}`);
  }
  // Same base as spawn (the DB's directory), so the forward lands where
  // spawn's handshake and every later verb look.
  const localSock = ctlSocketPath(workstream, agent, dirname(db.name));
  const remote = remoteSock ?? remoteCtlSocketPath(workstream, agent, process.getuid?.() ?? 0);
  if (!remote.startsWith("/") || !REMOTE_SOCK.test(remote)) {
    throw new UsageError(
      `--remote-sock must be an absolute path of [A-Za-z0-9_./@+-] characters (got ${JSON.stringify(remote)}): it is spliced unquoted into the remote command, and ssh -L treats ':' as a separator and expands '%' tokens`,
    );
  }
  if (Buffer.byteLength(remote) > MAX_SOCK_PATH) {
    throw new UsageError(
      `--remote-sock is ${Buffer.byteLength(remote)} bytes; unix socket paths must stay within ${MAX_SOCK_PATH}`,
    );
  }
  // ControlMaster=no + ControlPath=none: a direct connection per agent.
  // With `ControlMaster auto` in ~/.ssh/config the pane's ssh becomes a
  // mux client of an existing master, and the -L unix forward never binds
  // the local socket (spawn then reports ctl missing). The connection
  // lives and dies with the pane anyway, so sharing a master buys nothing.
  const sshArgs = `${SSH_DIRECT_OPTS} -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L ${word(`${localSock}:${remote}`)}`;
  const env = `MU_MANAGED_AGENT=1 MU_AGENT_NAME=${agent} MU_WORKSTREAM=${workstream} ${CTL_SOCK_ENV}=${remote}`;
  // `$SHELL -ilc`: ssh's remote command runs in a non-interactive shell
  // that skips ~/.zshrc / ~/.bashrc, where PATH (mise, nvm) and provider
  // env usually live; pi then dies at startup. The interactive login
  // shell loads them. Single quotes keep $SHELL for the REMOTE side.
  const command = `ssh ${sshArgs} <host> -t 'cd <remote-dir> && ${env} $SHELL -ilc "pi --approve"'`;
  return { agent, workstream, localSock, remoteSock: remote, sshArgs, env, command };
}

export async function cmdRemoteEnv(
  db: Db,
  agent: string,
  opts: { workstream?: string; remoteSock?: string; shell?: boolean; json?: boolean },
): Promise<void> {
  const ws = await resolveWorkstream(opts.workstream);
  const r = buildRemoteEnv(db, agent, ws, opts.remoteSock);
  if (opts.shell) {
    // eval-safe: every value single-quoted.
    console.log(`MU_SSH_ARGS=${shellQuote(r.sshArgs)}`);
    console.log(`MU_REMOTE_ENV=${shellQuote(r.env)}`);
    return;
  }
  const nextSteps: NextStep[] = [
    {
      intent: "Spawn it (replace <host> and <remote-dir>; the host needs `mu link pi`)",
      command: `mu agent spawn ${agent} -w ${ws} --command ${shellQuote(r.command)}`,
    },
    {
      intent: "Or set MU_SSH_ARGS / MU_REMOTE_ENV in your shell",
      command: `eval "$(mu agent remote-env ${agent} -w ${ws} --shell)"`,
    },
  ];
  if (opts.json) {
    emitJson({ ...r, nextSteps });
    return;
  }
  console.log(`${pc.bold("ssh args")}  ${r.sshArgs}`);
  console.log(`${pc.bold("env")}       ${r.env}`);
  console.log(`${pc.bold("command")}   ${r.command}`);
  printNextSteps(nextSteps);
}

export function wireRemoteEnvCommand(agent: Command): void {
  agent
    .command("remote-env <name>")
    .description(
      "Print, without running anything, what a remote pi agent's ssh command needs: the socket forward (-o ControlMaster=no -o ControlPath=none -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L <local>:<remote>) and the identity env (MU_MANAGED_AGENT, MU_AGENT_NAME, MU_WORKSTREAM, MU_CTL_SOCK). mu then reaches the remote pi through the local socket exactly like a local one. ControlMaster=no / ControlPath=none give each agent a direct connection: a multiplexed ssh (ControlMaster auto in ~/.ssh/config) never binds the local end of the forward. The example command wraps pi in `$SHELL -ilc` because ssh's non-interactive shell skips ~/.zshrc / ~/.bashrc (PATH, provider env); drop the wrapper if your remote env needs no rc file. The host needs the mu extension (`mu link pi` there) and sshd must allow the forward: if spawn reports ctl refused, check AllowStreamLocalForwarding in the host's sshd_config.",
    )
    .option(
      "--remote-sock <path>",
      "socket path on the remote host (default /tmp/mu-<uid>/<ws>/<name>.sock, uid = local uid)",
    )
    .option("--shell", "print eval-able MU_SSH_ARGS=... and MU_REMOTE_ENV=... lines")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        remoteSock?: string;
        shell?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdRemoteEnv(db, name, opts), this as Command)();
    });
}
