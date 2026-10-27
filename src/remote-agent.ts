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
import { say } from "./messages.js";
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
    super(say("remote.prepare", host, what, detail));
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
  return `"$HOME"/.local/state/mu-next/remote-worktrees/${shellWord(workstream)}/${shellWord(name)}`;
}

export interface RemoteSite {
  /** The remote working directory the agent starts in (absolute). */
  cwd: string;
  /** The commit a worktree was made at; null without `--worktree`. */
  base: string | null;
}

/** The file in a remote worktree's own git dir that says mu's prepare made it (`git worktree remove` takes it along). */
const PREPARED_MARK = "mu-prepared";

/**
 * Remote lines reclaiming the tree at `$wt` (exit 4 with the reason, else fall
 * through): only mu's own unused leftover, the one a lost answer leaves. It
 * carries the prepare mark, is a worktree of `$root`, is clean and at `$base`,
 * and nothing has its cwd or an open file in it (the close rule's scan).
 */
function reclaimLines(): string[] {
  return [
    `fail() { echo "$wt already exists and is not an unused mu leftover ($*)" >&2; exit 4; }`,
    `gd=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null) || fail "not a git worktree"`,
    `[ -f "$gd/${PREPARED_MARK}" ] || fail "not made by mu"`,
    `[ "$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)" = "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)" ] || fail "not a worktree of $root"`,
    `[ "$(git -C "$wt" rev-parse --verify HEAD)" = "$base" ] || fail "HEAD is not $base"`,
    `st=$(git -C "$wt" status --porcelain) || fail "git status failed"`,
    `[ -z "$st" ] || fail "uncommitted work"`,
    `aside="$wt"`,
    ...quiescenceLines({ proc: "/proc", lsof: "lsof" }),
  ];
}

/**
 * The remote half of a spawn, under `lease`: with `worktree`, one exec makes a
 * detached `git worktree add` of `from` (default the repo's HEAD) at a fixed
 * path, marks it as prepare's own, and prints its base and absolute path;
 * otherwise one exec resolves the cwd (`cwd`, default the profile's repo; a
 * leading `~` expands remotely). The answer is a tagged line, because a login
 * shell may print noise first; no answer is an error, never a guessed path.
 *
 * A tree already at the path refuses, unless `reclaim` and it is the unused
 * leftover of an earlier prepare whose answer was lost (`reclaimLines`): that
 * one is answered as if just made, so a retry of the spawn takes it over.
 */
export async function prepareRemote(
  db: Db,
  lease: HostLease,
  profile: HostProfile,
  opts: {
    workstream: string;
    name: string;
    worktree: boolean;
    from?: string;
    cwd?: string;
    /** May a leftover at the path be reclaimed (false while a recovery record names it). */
    reclaim?: boolean;
  },
): Promise<RemoteSite> {
  const root = remotePathWord(profile.repo);
  const answer = `printf 'MU_WT %s %s\\n' "$base" "$(cd "$wt" && pwd -P)"`;
  const body = opts.worktree
    ? [
        `root=${root}`,
        `wt=${remoteWorktreeWord(opts.workstream, opts.name)}`,
        `base=$(git -C "$root" rev-parse --verify ${shellQuote(`${opts.from ?? "HEAD"}^{commit}`)}) || exit 5`,
        opts.reclaim === true
          ? `if [ -e "$wt" ]; then\n${reclaimLines().join("\n")}\n${answer}\nexit 0\nfi`
          : `[ ! -e "$wt" ] || { echo "$wt already exists" >&2; exit 4; }`,
        `mkdir -p "$(dirname "$wt")" || exit 6`,
        `undo() { git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1; rm -rf "$wt"; exit 7; }`,
        `git -C "$root" worktree add --detach "$wt" "$base" >&2 || undo`,
        `gd=$(git -C "$wt" rev-parse --absolute-git-dir) && : > "$gd/${PREPARED_MARK}" || undo`,
        answer,
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
  // No answer after the exec may have made the tree: say how a retry takes it over.
  const lost = opts.worktree
    ? `; if it made the worktree, spawning ${opts.name} again reclaims it while it is unused`
    : "";
  if (r.exitCode === null) {
    throw new RemotePrepareError(
      profile.name,
      what,
      `timed out after ${REMOTE_PREPARE_TIMEOUT_MS}ms${lost}`,
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
  throw new RemotePrepareError(profile.name, what, `the host's answer named no path${lost}`);
}

/**
 * Remove a remote worktree THIS spawn made: only while it is still clean and
 * still at `base`, proven by git commands that exited 0 (a failing one is
 * unknown, never clean); anything else is left for the user and said so on stderr.
 * Best-effort, one exec under its own channel (the caller has already freed
 * the pane's). Returns whether the tree is proven gone (removed now, or
 * already absent): a tree left alone, or an answer with no `MU_RM` line, is not.
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
    `[ -d "$wt" ] || { echo "MU_RM gone"; exit 0; }`,
    // Any git that fails is unknown, never clean: the tree is left alone.
    `unknown() { echo "$wt: $1 failed: left alone" >&2; echo "MU_RM failed"; exit 0; }`,
    `head=$(git -C "$wt" rev-parse --verify HEAD) || unknown "git rev-parse HEAD"`,
    `[ "$head" = ${shellQuote(wt.base)} ] || { echo "$wt is not at its base: left alone" >&2; echo "MU_RM moved"; exit 0; }`,
    `st=$(git -C "$wt" status --porcelain) || unknown "git status"`,
    `[ -z "$st" ] || { echo "$wt has changes: left alone" >&2; echo "MU_RM dirty"; exit 0; }`,
    // No --force: git re-checks cleanliness itself, so a write that raced the check refuses.
    `git -C ${remotePathWord(wt.root)} worktree remove "$wt" && echo "MU_RM removed"`,
  ].join("\n");
  const r = await runHostTemplate(db, host, "exec", holder, { cmd: script(body), cwd: wt.root });
  const said = lastMatch(r.stdout, REMOTE_RM_RE)?.[1];
  return r.exitCode === 0 && (said === "removed" || said === "gone");
}

/** `agent close` refused to remove a remote worktree: nothing was removed. Exit 4. */
export class RemoteCloseRefusedError extends Error {
  override readonly name = "RemoteCloseRefusedError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly reason: "dirty" | "uncollected" | "moved" | "unreadable" | "branch" | "held",
    detail: string,
    /** The recovery record being closed (no agent row left): every hint then names it. */
    public readonly recoveryId?: number,
  ) {
    super(say("remote.worktree_kept", agentName, detail));
  }
}

const REMOTE_STATE_RE = /^MU_STATE (clean|dirty|gone)(?: ([0-9a-f]{40,64}))?$/;
const REMOTE_RM_RE =
  /^MU_RM (removed|gone|moved|dirty|branch-collision|branch-failed|failed|stuck|unproven|held(?: (\d+))?)$/;
const lastMatch = (out: string, re: RegExp): RegExpExecArray | null => {
  for (const l of out.split("\n").reverse()) {
    const m = re.exec(l.trim());
    if (m !== null) return m;
  }
  return null;
};

/** Where `closeRemoteWorktree` parks a tree while it proves nothing holds it. */
export const asideOf = (path: string, incarnation: number): string =>
  `${path}.mu-removing-${incarnation}`;

/**
 * Remote shell lines proving nothing holds `$aside`: no process of this user
 * has its cwd or an open file at or under it (`fail held <pid>`), and the scan
 * demonstrably ran (it must see this very shell, else `fail unproven`). Reads
 * /proc, else `lsof`, else refuses. With `force` (the caller asserts nothing
 * uses the tree) neither refuses: each is printed as `MU_WARN unproven` /
 * `MU_WARN held <pid>` and the removal goes on. `proc` and `lsof` are test seams.
 */
function quiescenceLines(probe: { proc: string; lsof: string }, force = false): string[] {
  const proc = shellQuote(probe.proc);
  const lsof = shellQuote(probe.lsof);
  // Prints "H<pid>" per holder and "S<pid>" per process whose cwd it could read.
  const procAwk = `A="$aside" awk 'BEGIN{a=ENVIRON["A"]} { i=index($0," -> "); if (i==0) next; t=substr($0,i+4); n=split(substr($0,1,i-1),f," "); n=split(f[n],q,"/"); if (q[n]=="cwd") print "S" q[n-1]; h=(t==a || index(t,a "/")==1); if (h && q[n]=="cwd") print "H" q[n-1]; else if (h && q[n-1]=="fd") print "H" q[n-2] }'`;
  const lsofAwk = `A="$aside" awk 'BEGIN{a=ENVIRON["A"]} /^p/{p=substr($0,2)} /^f/{f=substr($0,2)} /^n/{t=substr($0,2); if (f=="cwd") print "S" p; if (t==a || index(t,a "/")==1) print "H" p}'`;
  return [
    `scan=`,
    `if [ -d ${proc}/self ]; then scan=$(find ${proc}/[0-9]*/cwd ${proc}/[0-9]*/fd -maxdepth 1 -type l -exec ls -ld {} + 2>/dev/null | ${procAwk})`,
    `elif command -v ${lsof} >/dev/null 2>&1; then scan=$(${lsof} -w -Fpfn 2>/dev/null | ${lsofAwk}); fi`,
    `printf '%s\\n' "$scan" | grep -qx "S$$" || ${force ? "echo 'MU_WARN unproven'" : "fail unproven"}`,
    force
      ? `printf '%s\\n' "$scan" | sed -n 's/^H//p' | sort -u | sed 's/^/MU_WARN held /'`
      : `held=$(printf '%s\\n' "$scan" | sed -n 's/^H//p' | head -n 1); [ -z "$held" ] || fail held "$held"`,
  ];
}

/**
 * The close rule for a remote worktree `spawn --host --worktree` made, run
 * AFTER the agent's pane is dead (the caller frees the channel first; at cap 1
 * the pane held it): under one lease, one exec observes the state (clean or
 * dirty, HEAD, and that the path is still a worktree of the profile's repo),
 * the rule is applied here, and a second exec removes WITHOUT --force.
 *
 * No git lock fences every ref backend (reftable ignores HEAD.lock), so the
 * removal proves QUIESCENCE instead: the tree is renamed to a fixed aside name
 * (`asideOf`, derived from the registry incarnation, so the intent survives a
 * crash with no record to lose), every writer addressing the old path now
 * fails, and a scan of /proc (else lsof, else refusal) proves no process has
 * its cwd or an open file under the aside. Only then are HEAD and cleanliness
 * re-checked (backend-neutral git commands), the `--keep-branch` branch made
 * create-only, and the tree removed. A holder, a doubt or any mismatch moves
 * the tree back and refuses. A retry after a crash finds the aside, moves it
 * back and runs the whole rule again; `gone` means neither path exists.
 * Never removes dirty files, whatever the flags; a HEAD that is neither the
 * base nor the last collected one refuses unless `keepBranch`, which makes (or
 * verifies) `mu/<ws>/<agent>-<sha12>` at the observed HEAD first.
 */
export async function closeRemoteWorktree(
  db: Db,
  agent: Pick<
    AgentRow,
    "name" | "workstreamName" | "host" | "cwd" | "base" | "collectedHead" | "incarnation"
  >,
  opts: {
    keepBranch?: boolean;
    paneAlive?: (paneId: string) => Promise<boolean>;
    /** Runs between the observation and the removal; throws to stop (an identity re-check). */
    beforeRemove?: () => void;
    /** The removed agent's recovery record (src/remote-recovery.ts) when there is no row: refusals name it. */
    recoveryId?: number;
    /** Runs on the ADMITTED profile before any exec; throws to stop (a recovery pins the profile it was made for). */
    checkProfile?: (profile: HostProfile) => void;
    /** Test seam: where the quiescence scan looks (default /proc, then `lsof`). */
    probe?: { proc: string; lsof: string };
    /** Remove past a holder or an unprovable scan (each becomes a warning). Never past dirt or a moved HEAD. */
    force?: boolean;
  } = {},
): Promise<ReleasedWorktree> {
  const { name, workstreamName: ws, host, cwd: path, base, collectedHead } = agent;
  if (host === null || path === null || base === null) {
    throw new Error(say("remote.no_worktree", name));
  }
  const asidePath = asideOf(path, agent.incarnation);
  const probe = opts.probe ?? { proc: "/proc", lsof: "lsof" };
  const refuse = (reason: RemoteCloseRefusedError["reason"], detail: string): never => {
    throw new RemoteCloseRefusedError(name, ws, reason, detail, opts.recoveryId);
  };
  return withHostChannel(
    db,
    host,
    `close:${ws}/${name}`,
    async (profile, lease) => {
      opts.checkProfile?.(profile);
      const root = remotePathWord(profile.repo);
      const wt = shellQuote(path);
      const aside = shellQuote(asidePath);
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
          `aside=${aside}`,
          // A crash after the move leaves the aside: put it back, then judge it as usual.
          `if [ -d "$aside" ]; then`,
          `  [ ! -e "$wt" ] || { echo "$aside is parked beside $wt" >&2; exit 9; }`,
          `  git -C "$root" worktree move "$aside" "$wt" >&2 || { echo "could not move $aside back to $wt" >&2; exit 10; }`,
          `fi`,
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
      opts.beforeRemove?.();
      // Move aside, prove nothing holds the tree, THEN re-check and remove
      // (see the header): a writer that raced the observation either left a
      // changed HEAD or dirt for the re-check, or holds the tree and refuses.
      const removed = await run(
        [
          `root=${root}`,
          `wt=${wt}`,
          `aside=${aside}`,
          `want=${shellQuote(head)}`,
          `[ -d "$wt" ] || { if [ -e "$aside" ]; then echo "$aside is parked" >&2; echo 'MU_RM failed'; else echo 'MU_RM gone'; fi; exit 0; }`,
          `fail() { if [ -d "$aside" ] && [ ! -e "$wt" ]; then git -C "$root" worktree move "$aside" "$wt" >&2 || { echo 'MU_RM stuck'; exit 0; }; fi; echo "MU_RM $*"; exit 0; }`,
          `git -C "$root" worktree move "$wt" "$aside" >&2 || { echo 'MU_RM failed'; exit 0; }`,
          ...quiescenceLines(probe, opts.force === true),
          `[ "$(git -C "$aside" rev-parse --verify HEAD)" = "$want" ] || fail moved`,
          `st=$(git -C "$aside" status --porcelain) || fail failed`,
          `[ -z "$st" ] || fail dirty`,
          ...(branch === undefined
            ? []
            : [
                `br=${shellQuote(`refs/heads/${branch}`)}`,
                // Create-only (old value ""): never moves an existing branch.
                `git -C "$root" update-ref "$br" "$want" "" 2>/dev/null || [ "$(git -C "$root" rev-parse --verify -q "$br")" = "$want" ] || fail branch-collision`,
                `[ "$(git -C "$root" rev-parse --verify -q "$br")" = "$want" ] || fail branch-failed`,
              ]),
          `git -C "$root" worktree remove "$aside" >&2 || fail failed`,
          `echo 'MU_RM removed'`,
        ].join("\n"),
      );
      const r = lastMatch(removed.out, REMOTE_RM_RE)?.[1];
      const force = ` close again, or if you know nothing uses it preview with --force: mu agent close ${name} -w ${ws}${opts.recoveryId === undefined ? "" : ` --recovery ${opts.recoveryId}`} --force`;
      if (r === "removed") {
        const warnings = removed.out
          .split("\n")
          .map((l) => /^MU_WARN (unproven|held (\d+))$/.exec(l.trim()))
          .filter((m) => m !== null)
          .map((m) =>
            m[2] === undefined
              ? `host ${host} has neither /proc nor lsof to prove nothing is using ${path}; removed under --force`
              : `process ${m[2]} on ${host} was still inside ${path}; removed under --force`,
          );
        const said = warnings.length > 0 ? { warnings } : {};
        return branch === undefined
          ? { path, action: "removed", ...said }
          : { path, action: "kept-branch", branch, ...said };
      }
      if (r === "gone") return { path, action: "gone" };
      if (r === "moved")
        return refuse("moved", `HEAD moved while closing (was ${short}); nothing was removed`);
      if (r === "dirty")
        return refuse("dirty", `${path} changed while closing; nothing was removed`);
      if (r?.startsWith("held")) {
        const pid = lastMatch(removed.out, REMOTE_RM_RE)?.[2];
        return refuse(
          "held",
          `${pid === undefined ? "a process" : `process ${pid}`} on ${host} is still inside ${path}; nothing was removed. Stop it and${force}`,
        );
      }
      if (r === "unproven") {
        return refuse(
          "unreadable",
          `host ${host} has neither /proc nor lsof to prove nothing is using ${path}; nothing was removed. Fix that and${force}`,
        );
      }
      if (r === "stuck") {
        return refuse(
          "unreadable",
          `could not move ${path} back from ${asidePath}; close again to resume`,
        );
      }
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

/**
 * The local pane's liveness probe for channel admission: unknown (a throw) keeps
 * the channel. A retained pane whose command ended (a gate's transport) is not
 * alive here: it holds no channel on the host, though its handle still exists.
 */
export async function localPaneAlive(paneId: string): Promise<boolean> {
  const mux = await activeMux();
  if (mux.paneResult === undefined) return mux.paneAlive(paneId);
  return (await mux.paneResult(paneId)).state === "running";
}
