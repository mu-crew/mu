// mu — the remote half of `agent spawn --host` (docs/VOCABULARY.md § remote worker).
//
// The PANE is the transport. The local pane runs the profile's filled `shell`
// template, which starts the remote pi and forwards its ctl socket to the
// derived LOCAL path; pane death is agent death, exactly as for a local agent
// (reconcile, close and teardown need no remote case). mu never connects: every
// remote effect here is the user's `exec` template running one short command.
//
// Order, all under ONE channel lease (spawn.ts holds it; at cap 1 the lease is
// never released between steps, and an exec is reaped before the shell opens):
//   prepare (exec: resolve the cwd, or make a detached worktree) -> placeholder
//   row claims the name -> pane opens (the lease is bound to its id + pane) ->
//   ctl handshake through the forward.
// Rollback removes only what this spawn made: the remote worktree is removed
// only while it is still clean and still at the recorded base.

import type { AgentRow } from "./agents.js";
import { remoteCtlSocketPath } from "./ctl/path.js";
import type { Db } from "./db.js";
import {
  expandHostTemplate,
  type HostLease,
  type HostProfile,
  hostEnvWords,
  remotePathWord,
  runHostTemplate,
  runLeasedTemplate,
  withHostChannel,
} from "./hosts.js";
import { activeMux } from "./mux.js";
import { shellQuote, shellWord } from "./shell-quote.js";
import type { ReleasedWorktree } from "./worktree.js";

/** A remote exec step failed or answered nothing mu can use. Exit 5 (substrate). */
export class RemotePrepareError extends Error {
  override readonly name = "RemotePrepareError";
  constructor(
    public readonly host: string,
    what: string,
    detail: string,
  ) {
    super(`host ${host}: ${what}${detail === "" ? "" : `: ${detail}`}`);
  }
  errorNextSteps(): { intent: string; command: string }[] {
    return [
      { intent: "Check the host answers and has the repo", command: `mu host check ${this.host}` },
    ];
  }
}

/** Budget for the one remote step that may clone-sized work (a worktree add). */
export const REMOTE_PREPARE_TIMEOUT_MS = 120_000;

const firstLine = (s: string): string =>
  s
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

/** A remote `sh -c` script as the one word the exec template's `{cmd}` carries. */
const script = (body: string): string => `sh -c ${shellQuote(body)}`;

/** Where a remote worktree lives: under the remote user's state dir, never inside the repo. */
function remoteWorktreeWord(workstream: string, name: string): string {
  return `"$HOME"/.local/state/mu/remote-worktrees/${shellWord(workstream)}/${shellWord(name)}`;
}

export interface RemoteSite {
  /** The remote working directory the agent starts in (absolute). */
  cwd: string;
  /** The commit a worktree was made at; null without `--worktree`. */
  base: string | null;
}

/**
 * The remote half of a spawn, under `lease`: with `worktree`, one exec makes a
 * detached `git worktree add` of `from` (default the repo's HEAD) at a fixed
 * path and prints its base and absolute path; otherwise one exec resolves the
 * cwd (`cwd`, default the profile's repo; a leading `~` expands remotely).
 * The answer is a tagged line, because a login shell may print noise first;
 * no answer is an error, never a guessed path.
 */
export async function prepareRemote(
  db: Db,
  lease: HostLease,
  profile: HostProfile,
  opts: { workstream: string; name: string; worktree: boolean; from?: string; cwd?: string },
): Promise<RemoteSite> {
  const root = remotePathWord(profile.repo);
  const body = opts.worktree
    ? [
        `root=${root}`,
        `wt=${remoteWorktreeWord(opts.workstream, opts.name)}`,
        `[ ! -e "$wt" ] || { echo "$wt already exists" >&2; exit 4; }`,
        `base=$(git -C "$root" rev-parse --verify ${shellQuote(`${opts.from ?? "HEAD"}^{commit}`)}) || exit 5`,
        `mkdir -p "$(dirname "$wt")" || exit 6`,
        `git -C "$root" worktree add --detach "$wt" "$base" >&2 || { git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1; rm -rf "$wt"; exit 7; }`,
        `printf 'MU_WT %s %s\\n' "$base" "$(cd "$wt" && pwd -P)"`,
      ].join("\n")
    : `cd ${remotePathWord(opts.cwd ?? profile.repo)} && printf 'MU_CWD %s\\n' "$(pwd -P)"`;
  const r = await runLeasedTemplate(
    db,
    lease,
    profile,
    "exec",
    { cmd: script(body), cwd: profile.repo },
    REMOTE_PREPARE_TIMEOUT_MS,
  );
  const what = opts.worktree
    ? "creating the remote worktree failed"
    : "the remote cwd is unreachable";
  if (r.exitCode === null) {
    throw new RemotePrepareError(
      profile.name,
      what,
      `timed out after ${REMOTE_PREPARE_TIMEOUT_MS}ms`,
    );
  }
  if (r.exitCode !== 0) {
    const why = firstLine(r.stderr) || firstLine(r.stdout);
    throw new RemotePrepareError(
      profile.name,
      what,
      `exit ${r.exitCode}${why === "" ? "" : `: ${why}`}`,
    );
  }
  const lines = r.stdout.split("\n").map((l) => l.trim());
  if (opts.worktree) {
    for (const l of lines.reverse()) {
      const m = /^MU_WT ([0-9a-f]{40,64}) (\/.+)$/.exec(l);
      if (m?.[1] !== undefined && m[2] !== undefined) return { cwd: m[2], base: m[1] };
    }
  } else {
    for (const l of lines.reverse()) {
      const m = /^MU_CWD (\/.+)$/.exec(l);
      if (m?.[1] !== undefined) return { cwd: m[1], base: null };
    }
  }
  throw new RemotePrepareError(profile.name, what, "the host's answer named no path");
}

/**
 * Remove a remote worktree THIS spawn made: only while it is still clean and
 * still at `base` (anything else is left for the user and said so on stderr).
 * Best-effort, one exec under its own channel (the caller has already freed
 * the pane's). Returns whether the removal command ran clean.
 */
export async function removeRemoteWorktree(
  db: Db,
  host: string,
  holder: string,
  wt: { path: string; base: string; root: string },
): Promise<boolean> {
  const p = shellQuote(wt.path);
  const body = [
    `wt=${p}`,
    `[ -d "$wt" ] || exit 0`,
    `[ "$(git -C "$wt" rev-parse HEAD 2>/dev/null)" = ${shellQuote(wt.base)} ] || { echo "$wt is not at its base: left alone" >&2; exit 0; }`,
    `[ -z "$(git -C "$wt" status --porcelain 2>/dev/null)" ] || { echo "$wt has changes: left alone" >&2; exit 0; }`,
    `git -C ${remotePathWord(wt.root)} worktree remove --force "$wt"`,
  ].join("\n");
  const r = await runHostTemplate(db, host, "exec", holder, { cmd: script(body), cwd: wt.root });
  return r.exitCode === 0;
}

/** `agent close` refused to remove a remote worktree: nothing was removed. Exit 4. */
export class RemoteCloseRefusedError extends Error {
  override readonly name = "RemoteCloseRefusedError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly reason: "dirty" | "uncollected" | "moved" | "unreadable" | "branch",
    detail: string,
  ) {
    super(`agent ${agentName}: remote worktree kept: ${detail}`);
  }
  errorNextSteps(): { intent: string; command: string }[] {
    const ws = this.workstream;
    const n = this.agentName;
    if (this.reason === "uncollected" || this.reason === "moved") {
      return [
        { intent: "Bring its commits home", command: `mu agent collect ${n} -w ${ws}` },
        {
          intent: "Or keep them on a remote branch and remove the worktree",
          command: `mu agent close ${n} -w ${ws} --keep-branch`,
        },
      ];
    }
    return [{ intent: "Preview the close again", command: `mu agent close ${n} -w ${ws}` }];
  }
}

const REMOTE_STATE_RE = /^MU_STATE (clean|dirty|gone)(?: ([0-9a-f]{40,64}))?$/;
const REMOTE_RM_RE = /^MU_RM (removed|gone|moved|dirty|branch-collision|branch-failed|failed)$/;
const lastMatch = (out: string, re: RegExp): RegExpExecArray | null => {
  for (const l of out.split("\n").reverse()) {
    const m = re.exec(l.trim());
    if (m !== null) return m;
  }
  return null;
};

/**
 * The close rule for a remote worktree `spawn --host --worktree` made, run
 * AFTER the agent's pane is dead (the caller frees the channel first; at cap 1
 * the pane held it): under one lease, one exec observes the state (clean or
 * dirty, HEAD, and that the path is still a worktree of the profile's repo),
 * the rule is applied here, and a second exec re-checks HEAD and cleanliness
 * immediately before `git worktree remove` WITHOUT --force. Never removes
 * dirty files, whatever the flags; a HEAD that is neither the base nor the
 * last collected one refuses unless `keepBranch`, which makes (or verifies)
 * `mu/<ws>/<agent>-<sha12>` at the observed HEAD first. Any doubt refuses.
 */
export async function closeRemoteWorktree(
  db: Db,
  agent: Pick<AgentRow, "name" | "workstreamName" | "host" | "cwd" | "base" | "collectedHead">,
  opts: { keepBranch?: boolean; paneAlive?: (paneId: string) => Promise<boolean> } = {},
): Promise<ReleasedWorktree> {
  const { name, workstreamName: ws, host, cwd: path, base, collectedHead } = agent;
  if (host === null || path === null || base === null) {
    throw new Error(`agent ${name} has no remote worktree`);
  }
  const refuse = (reason: RemoteCloseRefusedError["reason"], detail: string): never => {
    throw new RemoteCloseRefusedError(name, ws, reason, detail);
  };
  return withHostChannel(
    db,
    host,
    `close:${ws}/${name}`,
    async (profile, lease) => {
      const root = remotePathWord(profile.repo);
      const wt = shellQuote(path);
      const run = async (body: string): Promise<{ out: string; why: string }> => {
        const r = await runLeasedTemplate(
          db,
          lease,
          profile,
          "exec",
          { cmd: script(body), cwd: profile.repo },
          REMOTE_PREPARE_TIMEOUT_MS,
        );
        if (r.exitCode === null) refuse("unreadable", `host ${host} timed out`);
        if (r.exitCode !== 0) {
          const why = firstLine(r.stderr) || firstLine(r.stdout);
          refuse("unreadable", `host ${host}: exit ${r.exitCode}${why === "" ? "" : `: ${why}`}`);
        }
        return { out: r.stdout, why: firstLine(r.stderr) };
      };
      const observed = await run(
        [
          `root=${root}`,
          `wt=${wt}`,
          `[ -d "$wt" ] || { echo 'MU_STATE gone'; exit 0; }`,
          `[ "$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)" = "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)" ] || { echo "$wt is not a worktree of $root" >&2; exit 8; }`,
          `head=$(git -C "$wt" rev-parse --verify HEAD) || exit 5`,
          `st=$(git -C "$wt" status --porcelain) || exit 6`,
          `if [ -z "$st" ]; then s=clean; else s=dirty; fi`,
          `printf 'MU_STATE %s %s\\n' "$s" "$head"`,
        ].join("\n"),
      );
      const m = lastMatch(observed.out, REMOTE_STATE_RE);
      if (m === null) return refuse("unreadable", `host ${host} named no worktree state`);
      if (m[1] === "gone") return { path, action: "gone" };
      const head = m[2];
      if (head === undefined) return refuse("unreadable", `host ${host} named no HEAD`);
      const short = head.slice(0, 12);
      if (m[1] === "dirty") {
        // A branch keeps commits, not files: no flag overrides this.
        return refuse("dirty", `uncommitted work in ${path}; commit or remove it on the host`);
      }
      const known = head === base || (collectedHead !== null && head === collectedHead);
      if (!known && opts.keepBranch !== true) {
        return refuse(
          "uncollected",
          `HEAD ${short} was never collected (base ${base.slice(0, 12)}); collect it, or close with --keep-branch`,
        );
      }
      const branch = known ? undefined : `mu/${ws}/${name}-${short}`;
      const removed = await run(
        [
          `root=${root}`,
          `wt=${wt}`,
          `want=${shellQuote(head)}`,
          `[ -d "$wt" ] || { echo 'MU_RM gone'; exit 0; }`,
          `[ "$(git -C "$wt" rev-parse --verify HEAD)" = "$want" ] || { echo 'MU_RM moved'; exit 0; }`,
          `[ -z "$(git -C "$wt" status --porcelain)" ] || { echo 'MU_RM dirty'; exit 0; }`,
          ...(branch === undefined
            ? []
            : [
                `br=${shellQuote(`refs/heads/${branch}`)}`,
                `if have=$(git -C "$root" rev-parse --verify -q "$br"); then`,
                `  [ "$have" = "$want" ] || { echo 'MU_RM branch-collision'; exit 0; }`,
                `else`,
                `  git -C "$root" update-ref "$br" "$want" "" || { echo 'MU_RM branch-failed'; exit 0; }`,
                `fi`,
                `[ "$(git -C "$root" rev-parse --verify -q "$br")" = "$want" ] || { echo 'MU_RM branch-failed'; exit 0; }`,
                `[ "$(git -C "$wt" rev-parse --verify HEAD)" = "$want" ] || { echo 'MU_RM moved'; exit 0; }`,
              ]),
          `git -C "$root" worktree remove "$wt" >&2 || { echo 'MU_RM failed'; exit 0; }`,
          `echo 'MU_RM removed'`,
        ].join("\n"),
      );
      const r = lastMatch(removed.out, REMOTE_RM_RE)?.[1];
      if (r === "removed") {
        return branch === undefined
          ? { path, action: "removed" }
          : { path, action: "kept-branch", branch };
      }
      if (r === "gone") return { path, action: "gone" };
      if (r === "moved")
        return refuse("moved", `HEAD moved while closing (was ${short}); nothing was removed`);
      if (r === "dirty")
        return refuse("dirty", `${path} changed while closing; nothing was removed`);
      if (r === "branch-collision") {
        return refuse(
          "branch",
          `branch ${branch} already exists at another commit; nothing was removed`,
        );
      }
      return refuse(
        r === "branch-failed" ? "branch" : "unreadable",
        `${r === "branch-failed" ? `could not make branch ${branch}` : "git worktree remove failed"}${removed.why === "" ? "" : `: ${removed.why}`}; nothing was removed`,
      );
    },
    opts.paneAlive === undefined ? {} : { paneAlive: opts.paneAlive },
  );
}

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
] as const;

/**
 * The command the LOCAL pane runs: the profile's `shell` template filled with
 * the remote identity (never the local DB, state or sync dir), the user's
 * command and the two socket paths, as one `sh -c` word, run with the local-only mu variables unset.
 */
export function remoteShellCommand(
  profile: HostProfile,
  a: { workstream: string; name: string; command: string; localSock: string; cwd: string },
): string {
  const remoteSock = remoteCtlSocketPath(a.workstream, a.name, process.getuid?.() ?? 0);
  const env = hostEnvWords({
    MU_MANAGED_AGENT: "1",
    MU_AGENT_NAME: a.name,
    MU_WORKSTREAM: a.workstream,
    MU_CTL_SOCK: remoteSock,
    MU_REMOTE: "1",
  });
  const filled = expandHostTemplate(profile.shell, {
    env,
    cmd: a.command,
    local_sock: a.localSock,
    remote_sock: remoteSock,
    cwd: a.cwd,
  });
  const unset = LOCAL_ONLY_ENV.map((k) => `-u ${k}`).join(" ");
  return `exec env ${unset} /bin/sh -c ${shellQuote(filled)}`;
}

/** The local pane's liveness probe for channel admission: unknown (a throw) keeps the channel. */
export async function localPaneAlive(paneId: string): Promise<boolean> {
  return (await activeMux()).paneAlive(paneId);
}
