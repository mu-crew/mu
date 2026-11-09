// mu — the remote half of `agent spawn --host` (docs/VOCABULARY.md § remote worker):
// the commands a remote agent's LOCAL pane runs.
//
// The PANE is the transport. The local pane runs the profile's filled `shell`
// template, which starts the remote pi and forwards its ctl socket to the
// derived LOCAL path; pane death is agent death, exactly as for a local agent
// (reconcile, close and teardown need no remote case). mu never connects: every
// remote effect is a script run through the host's link (src/host-link.ts);
// the remote worktree's are in src/remote-worktree.ts.

import { remoteCtlSocketPath } from "./ctl/path.js";
import { expandHostTemplate, type HostProfile, HostTemplateError, hostEnvWords } from "./hosts.js";
import { shellQuote } from "./shell-quote.js";

// The worktree half moved to src/remote-worktree.ts (plugins spec D7); its names stay
// importable from here for the SDK's and the tests' callers.
export {
  asideOf,
  closeRemoteWorktree,
  etimeSeconds,
  prepareRemote,
  REMOTE_PREPARE_TIMEOUT_MS,
  RemoteCloseRefusedError,
  RemotePrepareError,
  type RemoteSite,
  removeRemoteWorktree,
  setRemoteSettleForTests,
} from "./remote-worktree.js";

/**
 * The local mu variables a transport pane must not carry: a tmux pane inherits
 * the SERVER's env, which may be another agent's (its DB, sync dir, ctl socket,
 * identity). A template that runs `{cmd}` with the local env (a container exec,
 * `SendEnv MU_*`, a shim) would hand them to the remote pi.
 */
export const LOCAL_ONLY_ENV = [
  "MU_DB_PATH",
  "MU_STATE_DIR",
  "MU_SYNC_DIR",
  "MU_CTL_SOCK",
  "MU_AGENT_NAME",
  "MU_WORKSTREAM",
  "MU_MANAGED_AGENT",
  // An orchestrator's flag and harness never reach a remote worker (spec D9): a hook harness
  // worker's own harness and remote key travel in `{env}` instead (spec D11).
  "MU_ORCHESTRATOR",
  "MU_AGENT_CLI",
  "MU_REMOTE_KEY",
] as const;

/**
 * The command the LOCAL pane runs: the profile's `shell` template filled with
 * the remote identity (never the local DB, state or sync dir), the user's
 * command and the two socket paths, as one `sh -c` word, run with the local-only mu variables unset.
 * A hook harness worker (`hooks`) also gets its harness and remote key (spec D11).
 */
export function remoteShellCommand(
  profile: HostProfile,
  a: {
    workstream: string;
    name: string;
    command: string;
    localSock: string;
    cwd: string;
    /** A lease profile's `{job_file}`: where its carrier writes the job handle. */
    jobFile?: string;
    /** A remote hook harness worker: its harness (`MU_AGENT_CLI`) and key (`MU_REMOTE_KEY`). */
    hooks?: { cli: string; key: string };
  },
): string {
  const remoteSock = remoteCtlSocketPath(a.workstream, a.name, process.getuid?.() ?? 0);
  const env = hostEnvWords({
    MU_MANAGED_AGENT: "1",
    MU_AGENT_NAME: a.name,
    MU_WORKSTREAM: a.workstream,
    MU_CTL_SOCK: remoteSock,
    MU_REMOTE: "1",
    ...(a.hooks !== undefined ? { MU_AGENT_CLI: a.hooks.cli, MU_REMOTE_KEY: a.hooks.key } : {}),
  });
  if (profile.shell === null) {
    throw new HostTemplateError(`host ${profile.name} has no shell template: its link is a plugin`);
  }
  const filled = expandHostTemplate(profile.shell, {
    env,
    cmd: a.command,
    local_sock: a.localSock,
    remote_sock: remoteSock,
    cwd: a.cwd,
    ...(a.jobFile !== undefined ? { job_file: a.jobFile } : {}),
  });
  return wrapLocal(filled);
}

/** A filled template as the local pane runs it: one `sh -c` word, the local-only mu variables unset. */
function wrapLocal(filled: string): string {
  const unset = LOCAL_ONLY_ENV.map((k) => `-u ${k}`).join(" ");
  return `exec env ${unset} /bin/sh -c ${shellQuote(filled)}`;
}

/**
 * The command a new carrier pane runs to hold a lease job that still runs: the profile's
 * `attach` template filled with the handle, its job file and the two sockets, wrapped like
 * `remoteShellCommand`. Throws HostTemplateError when the profile has no `attach`.
 */
export function attachCommand(
  profile: HostProfile,
  a: { job: string; jobFile: string; localSock: string; remoteSock: string },
): string {
  if (profile.attach === null) {
    throw new HostTemplateError(
      `host ${profile.name} has no attach template (mu host add --attach)`,
    );
  }
  const filled = expandHostTemplate(
    profile.attach,
    {
      job: a.job,
      job_file: a.jobFile,
      local_sock: a.localSock,
      remote_sock: a.remoteSock,
      cwd: ".",
    },
    "attach",
  );
  return wrapLocal(filled);
}
