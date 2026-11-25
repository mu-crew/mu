// mu — the remote worktree contract (spec 2026-11-09-mu-plugins.md, D7): mu's
// own POSIX sh + git scripts, run on a host through its link's `exec`
// (src/host-link.ts). One implementation: a module, not a seam.
//
// Each operation keeps its exec boundaries and its channel:
//   prepare   ONE exec under the spawn's held channel (spawn.ts admits it; at
//             cap 1 it is never released between steps, and the exec is
//             reaped before the shell opens): resolve the cwd, or make a
//             detached worktree claimed by mkdir and marked with the DB's id
//             (a lost answer's leftover is reclaimed only by that DB, while unused).
//   rollback  ONE exec under its own channel: remove only what this spawn
//             made, while it is still clean and still at the recorded base.
//   close     TWO execs under ONE channel: observe, then aside + quiescence
//             proof + re-checks + removal. The profile guard (`checkProfile`)
//             runs on the admitted snapshot before either.

import type { AgentRow } from "./agents.js";
import type { Db } from "./db.js";
import type { LinkCall } from "./host-link.js";
import { admittedView, type HostView, resolveHost, withHostView } from "./host-provider.js";
import { HOST_COMMAND_TIMEOUT_MS, type HostProfile, remotePathWord } from "./hosts.js";
import { say } from "./messages.js";
import { localMachineId } from "./segments.js";
import { shellQuote, shellWord } from "./shell-quote.js";
import { PEER_SHORT_LEN } from "./sync.js";
import { git } from "./vcs/git.js";
import type { ReleasedWorktree } from "./worktree.js";

/** A remote exec step failed or answered nothing mu can use. Exit 5 (substrate). */
export class RemotePrepareError extends Error {
  override readonly name: string = "RemotePrepareError";
  constructor(
    public readonly host: string,
    what: string,
    detail: string,
  ) {
    super(say("remote.prepare", host, what, detail));
  }
}

/** Prepare refused an existing remote path without changing it. Exit 4. */
export class RemoteWorktreeConflictError extends Error {
  override readonly name: string = "RemoteWorktreeConflictError";
  constructor(
    public readonly host: string,
    detail: string,
    peerPrefix?: string,
  ) {
    const peer = peerPrefix === undefined ? "" : ` (sync peer ${peerPrefix})`;
    super(
      say(
        "remote.prepare",
        host,
        "creating the remote worktree refused",
        `${detail}; close it from the owning DB${peer}, or verify it is unused and remove it by hand`,
      ),
    );
  }
}

/**
 * The host's repo lacks a `--worktree` spawn's base commit: a provider host's after its push
 * (D7 G3), or a static host's, which mu never pushes to (ladder placement spec §3.3). Exit 5;
 * names host, repo and the sha, and the fix. `rev` is the sha; `from`, the ref it resolved from.
 */
export class RemoteBaseMissingError extends RemotePrepareError {
  override readonly name: string = "RemoteBaseMissingError";
  constructor(
    host: string,
    public readonly rev: string,
    public readonly repo: string,
    /** `pushed`: a provider link's push reported success; `nopush`: a provider link with none; `static`: a static host. */
    how: "pushed" | "nopush" | "static" = "nopush",
    public readonly from?: string,
  ) {
    super(
      host,
      "creating the remote worktree failed",
      baseMissingDetail(host, rev, repo, how, from),
    );
  }
}

function baseMissingDetail(
  host: string,
  rev: string,
  repo: string,
  how: "pushed" | "nopush" | "static",
  from: string | undefined,
): string {
  if (how === "pushed") {
    return `${repo} on ${host} lacks commit ${rev} although its link's push reported success: the plugin's push is broken; push ${rev} to ${repo} by hand, then spawn again`;
  }
  if (how === "nopush") {
    return `${repo} on ${host} lacks commit ${rev}, and its link cannot push: push ${rev} to ${repo} on ${host}, then spawn again`;
  }
  const named = from === undefined || from === rev ? "" : ` (--from ${from})`;
  return [
    `${repo} on ${host} lacks commit ${rev}${named}; mu never fetches or pushes for a static host.`,
    `If ${rev} is published (a remote the host can fetch has it): mu host exec ${host} -- git -C ${shellWord(repo)} fetch <remote> ${rev}.`,
    `If it is local-only: push it to a remote the host can fetch, then run that fetch on the host; or spawn from a published commit.`,
    `Then spawn again with --from ${rev}.`,
  ].join(" ");
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
  /** The absolute toplevel of the repo the worktree was added to; null without `--worktree`. */
  repo: string | null;
}

/** In the worktree's own Git directory, so `git worktree remove` takes it along. */
const PREPARED_MARK = "mu-prepared";
const PREPARE_CONFLICT_RE = /^MU_WT_CONFLICT (.+)$/;

/**
 * Only this DB's unused leftover is reclaimable. After the ownership check,
 * prove it is a worktree of `$root`, is clean and at `$base`, and nothing has
 * its cwd or an open file in it (the close rule's scan).
 */
function reclaimLines(): string[] {
  return [
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
interface PrepareOpts {
  workstream: string;
  name: string;
  worktree: boolean;
  from?: string;
  cwd?: string;
  /** May this DB take over its unused leftover at the path rather than just create a new tree? */
  reclaim?: boolean;
  /** The remote repo: the worktree is added to it, and it is the default cwd without one. */
  root?: string;
  /** A static `--worktree` spawn's base, resolved from `from` in the local checkout (§3.3). */
  rev?: string;
}

export async function prepareRemote(
  db: Db,
  call: LinkCall,
  profile: HostProfile,
  opts: PrepareOpts,
): Promise<RemoteSite> {
  return prepareOn(db, admittedView(db, profile), call, opts, opts.rev, "static");
}

/**
 * A `--worktree` site on a provider host (D7 G3): `from` resolves in the local checkout, a link
 * with `push` seeds the host's repo with it, and the worktree is made from that sha.
 */
export async function prepareProviderWorktree(
  db: Db,
  h: HostView,
  opts: Omit<PrepareOpts, "worktree" | "cwd"> & { localRepo: string },
): Promise<RemoteSite> {
  const root = opts.root ?? h.record?.repo ?? undefined;
  const what = "creating the remote worktree failed";
  if (root === undefined) {
    throw new RemotePrepareError(
      h.name,
      what,
      `host ${h.name} has no repo: pass --root <remote repo path>`,
    );
  }
  const from = opts.from ?? "HEAD";
  const rev = await git(["rev-parse", "--verify", `${from}^{commit}`], opts.localRepo).catch(() => {
    throw new RemotePrepareError(h.name, what, `${from} names no commit in ${opts.localRepo}`);
  });
  const call = { holder: `spawn:${opts.workstream}/${opts.name}` };
  if (h.link.caps.push === true && h.link.push !== undefined) {
    const r = await h.link.push(
      h,
      { localRepo: opts.localRepo, remoteRepo: root, rev, timeoutMs: REMOTE_PREPARE_TIMEOUT_MS },
      call,
    );
    if (r.exitCode !== 0) {
      const why = r.exitCode === null ? "timed out" : `exit ${r.exitCode}: ${firstLine(r.stderr)}`;
      throw new RemotePrepareError(h.name, what, `pushing ${rev} to ${root} failed (${why})`);
    }
  }
  return prepareOn(
    db,
    h,
    call,
    { ...opts, worktree: true, root },
    rev,
    h.link.push !== undefined ? "pushed" : "nopush",
  );
}

/** The prepare exec on view `h` under `call`; `rev`, a provider host's base sha (no `from` lookup remotely). */
async function prepareOn(
  db: Db,
  h: HostView,
  call: LinkCall,
  opts: PrepareOpts,
  rev?: string,
  how: "pushed" | "nopush" | "static" = "nopush",
): Promise<RemoteSite> {
  if (opts.worktree && opts.root === undefined) {
    throw new RemotePrepareError(
      h.name,
      "creating the remote worktree failed",
      `host ${h.name} has no default repo: pass --root <remote repo path>`,
    );
  }
  const root = remotePathWord(opts.root ?? "~");
  // The root as an absolute physical path (bare repos too: no --show-toplevel), hex-encoded so
  // no byte of it (a trailing space, a newline) is lost to the line parse. The row records it,
  // and close, rollback and recovery run against it.
  const answer = `printf 'MU_REPO %s\\nMU_WT %s %s\\n' "$(printf '%s' "$r" | od -An -v -tx1 | tr -d ' \\n')" "$base" "$(cd "$wt" && pwd -P)"`;
  const body = opts.worktree
    ? [
        `root=${root}`,
        `wt=${remoteWorktreeWord(opts.workstream, opts.name)}`,
        `db_id=${shellQuote(localMachineId(db))}`,
        `fail() { printf 'MU_WT_CONFLICT %s already exists (%s); owner %s\\n' "$wt" "$*" "$owner" >&2; exit 4; }`,
        `read_owner() {`,
        `  owner=unknown`,
        `  [ ! -L "$wt" ] && [ -f "$wt/.git" ] && [ ! -L "$wt/.git" ] || return`,
        `  gd=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null) || return`,
        `  mark="$gd/${PREPARED_MARK}"`,
        `  [ -f "$mark" ] && [ ! -L "$mark" ] || return`,
        `  id=$(cat "$mark" 2>/dev/null) || return`,
        `  case "$id" in ''|*[!a-zA-Z0-9-]*) ;; *) owner="$id" ;; esac`,
        `}`,
        `existing=false`,
        `if [ -e "$wt" ] || [ -L "$wt" ]; then`,
        `  read_owner`,
        ...(opts.reclaim === true
          ? [
              `  [ "$owner" != unknown ] || fail "not made by mu or missing its DB marker"`,
              `  [ "$owner" = "$db_id" ] || fail "belongs to another DB"`,
              `  existing=true`,
            ]
          : [`  fail "reclaim not allowed"`]),
        `fi`,
        rev === undefined
          ? `base=$(git -C "$root" rev-parse --verify ${shellQuote(`${opts.from ?? "HEAD"}^{commit}`)}) || exit 5`
          : `base=${rev}; git -C "$root" rev-parse -q --verify "$base^{commit}" >/dev/null || exit 8`,
        // Keep even a trailing newline in the absolute repo path.
        `r=$(CDPATH= cd "$root" && pwd -P && printf '.') || exit 5`,
        `r=\${r%??}`,
        ...(opts.reclaim === true
          ? [`if "$existing"; then`, ...reclaimLines(), answer, `exit 0`, `fi`]
          : []),
        `mkdir -p "$(dirname "$wt")" || exit 6`,
        `mkdir "$wt" || { read_owner; fail "could not claim the path"; }`,
        // Pin our mkdir's inode as the subshell's cwd. Git may remove the path on
        // failure and another DB may claim it before Git returns. Only rmdir our
        // original directory, and only if it is still empty.
        `(`,
        `  cd "$wt" || exit 7`,
        `  git -C "$r" worktree add --detach "$wt" "$base" >&2 && exit 0`,
        `  if [ "$wt" -ef . ]; then rmdir "$wt" 2>/dev/null; fi`,
        `  exit 7`,
        `) || exit 7`,
        `undo() { git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1; exit 7; }`,
        `gd=$(git -C "$wt" rev-parse --absolute-git-dir) && printf '%s\\n' "$db_id" > "$gd/${PREPARED_MARK}" || undo`,
        answer,
      ].join("\n")
    : `cd ${remotePathWord(opts.cwd ?? opts.root ?? "~")} && printf 'MU_CWD %s\\n' "$(pwd -P)"`;
  const r = await h.link.exec(
    h,
    // `.`, not `~`, without a repo: a template's `cd {cwd:sh}` stays where the login shell
    // started (a quoted `~` never expands); the script itself resolves --cwd and "$HOME".
    {
      script: script(body),
      cwd: rev === undefined || how === "static" ? (opts.root ?? ".") : ".",
      timeoutMs: REMOTE_PREPARE_TIMEOUT_MS,
    },
    call,
  );
  const what = opts.worktree
    ? "creating the remote worktree failed"
    : "the remote cwd is unreachable";
  // No answer after the exec may have made the tree: mention retry only when reclaim is allowed.
  const lost =
    opts.worktree && opts.reclaim === true
      ? `; if it made the worktree, spawning ${opts.name} again reclaims it while it is unused and marked by this DB`
      : "";
  if (r.exitCode === null) {
    throw new RemotePrepareError(
      h.name,
      what,
      `timed out after ${REMOTE_PREPARE_TIMEOUT_MS}ms${lost}`,
    );
  }
  if (rev !== undefined && r.exitCode === 8)
    throw new RemoteBaseMissingError(h.name, rev, opts.root ?? "", how, opts.from ?? "HEAD");
  if (opts.worktree && r.exitCode === 4) {
    const detail =
      lastMatch(r.stderr, PREPARE_CONFLICT_RE)?.[1] ??
      lastMatch(r.stdout, PREPARE_CONFLICT_RE)?.[1] ??
      `remote worktree ${opts.workstream}/${opts.name} already exists; owner unknown`;
    const owner = /; owner ([a-zA-Z0-9-]+)$/.exec(detail)?.[1];
    const peerPrefix =
      owner !== undefined &&
      owner !== "unknown" &&
      db.prepare("SELECT 1 FROM sync_peers WHERE machine_id = ?").get(owner) !== undefined
        ? owner.slice(0, PEER_SHORT_LEN)
        : undefined;
    throw new RemoteWorktreeConflictError(h.name, detail, peerPrefix);
  }
  if (r.exitCode !== 0) {
    const why = firstLine(r.stderr) || firstLine(r.stdout);
    throw new RemotePrepareError(h.name, what, `exit ${r.exitCode}${why === "" ? "" : `: ${why}`}`);
  }
  const lines = r.stdout.split("\n").map((l) => l.trim());
  if (opts.worktree) {
    const repo = decodeRepo(
      [...lines]
        .reverse()
        .find((l) => /^MU_REPO [0-9a-f]+$/.test(l))
        ?.slice("MU_REPO ".length),
    );
    for (const l of lines.reverse()) {
      const m = /^MU_WT ([0-9a-f]{40,64}) (\/.+)$/.exec(l);
      if (m?.[1] !== undefined && m[2] !== undefined && repo !== undefined) {
        return { cwd: m[2], base: m[1], repo };
      }
    }
  } else {
    for (const l of lines.reverse()) {
      const m = /^MU_CWD (\/.+)$/.exec(l);
      if (m?.[1] !== undefined) return { cwd: m[1], base: null, repo: null };
    }
  }
  throw new RemotePrepareError(h.name, what, `the host's answer named no path${lost}`);
}

/** The hex-encoded absolute path of a `MU_REPO` line, or undefined when it is not one. */
function decodeRepo(hex: string | undefined): string | undefined {
  if (hex === undefined || hex.length % 2 !== 0) return undefined;
  const path = Buffer.from(hex, "hex").toString("utf8");
  return path.startsWith("/") ? path : undefined;
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
  const h = resolveHost(db, host);
  const r = await h.link.exec(
    h,
    { script: script(body), cwd: wt.root, timeoutMs: HOST_COMMAND_TIMEOUT_MS },
    { holder },
  );
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

const REMOTE_STATE_RE = /^MU_STATE (clean|dirty|gone)(?: ([0-9a-f]{40,64}))?( merged)?$/;
/** What the removal exec answered (`MU_RM <outcome>`): the 11 outcomes `REMOTE_RM_RE` reads. */
export type RemoteRemoval =
  | "removed"
  | "gone"
  | "moved"
  | "dirty"
  | "unmerged"
  | "branch-collision"
  | "branch-failed"
  | "failed"
  | "stuck"
  | "unproven"
  | "held";
const REMOTE_RM_RE =
  /^MU_RM (removed|gone|moved|dirty|unmerged|branch-collision|branch-failed|failed|stuck|unproven|held(?: (\d+)(?: (\S+) (.+))?)?)$/;
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
 * How long a refusing scan re-checks a holder (seconds, one scan a second)
 * before naming it: short-lived tools (a harness's guardrail helper draining
 * its spool) stay in a tree for up to about half a minute after the pane dies,
 * and a refusal then turns every close into two. The loop runs inside the same
 * exec (one lease), well inside REMOTE_PREPARE_TIMEOUT_MS.
 */
const SETTLE_SECONDS = 30;
let settleSeconds = SETTLE_SECONDS;
export function setRemoteSettleForTests(seconds: number | null): void {
  settleSeconds = seconds ?? SETTLE_SECONDS;
}

/**
 * Remote shell lines proving nothing holds `$aside`: no process of this user
 * has its cwd or an open file at or under it, and the scan demonstrably ran
 * (it must see this very shell, else `fail unproven`). Reads /proc, else
 * `lsof`, else refuses. A holder is re-scanned once a second for up to
 * `settleSeconds`; one still there fails as `held <pid> [<etime> <args>]`
 * (from `ps`, when it answers). With `force` (the caller asserts nothing uses
 * the tree) neither refuses nor waits: each is printed as `MU_WARN unproven` /
 * `MU_WARN held <pid>` and the removal goes on. `proc` and `lsof` are test seams.
 */
function quiescenceLines(probe: { proc: string; lsof: string }, force = false): string[] {
  const proc = shellQuote(probe.proc);
  const lsof = shellQuote(probe.lsof);
  // Prints "H<pid>" per holder and "S<pid>" per process whose cwd it could read.
  const procAwk = `A="$aside" awk 'BEGIN{a=ENVIRON["A"]} { i=index($0," -> "); if (i==0) next; t=substr($0,i+4); n=split(substr($0,1,i-1),f," "); n=split(f[n],q,"/"); if (q[n]=="cwd") print "S" q[n-1]; h=(t==a || index(t,a "/")==1); if (h && q[n]=="cwd") print "H" q[n-1]; else if (h && q[n-1]=="fd") print "H" q[n-2] }'`;
  const lsofAwk = `A="$aside" awk 'BEGIN{a=ENVIRON["A"]} /^p/{p=substr($0,2)} /^f/{f=substr($0,2)} /^n/{t=substr($0,2); if (f=="cwd") print "S" p; if (t==a || index(t,a "/")==1) print "H" p}'`;
  const scan = [
    `scan=`,
    `if [ -d ${proc}/self ]; then scan=$(find ${proc}/[0-9]*/cwd ${proc}/[0-9]*/fd -maxdepth 1 -type l -exec ls -ld {} + 2>/dev/null | ${procAwk})`,
    `elif command -v ${lsof} >/dev/null 2>&1; then scan=$(${lsof} -w -Fpfn 2>/dev/null | ${lsofAwk}); fi`,
    `printf '%s\\n' "$scan" | grep -qx "S$$" || ${force ? "echo 'MU_WARN unproven'" : "fail unproven"}`,
  ];
  if (force)
    return [
      ...scan,
      `printf '%s\\n' "$scan" | sed -n 's/^H//p' | sort -u | sed 's/^/MU_WARN held /'`,
    ];
  return [
    `tries=0`,
    `while :; do`,
    ...scan.map((l) => `  ${l}`),
    `  held=$(printf '%s\\n' "$scan" | sed -n 's/^H//p' | head -n 1)`,
    `  [ -n "$held" ] && [ "$tries" -lt ${settleSeconds} ] || break`,
    `  tries=$((tries + 1)); sleep 1`,
    `done`,
    `if [ -n "$held" ]; then`,
    `  info=$(ps -o etime= -o args= -p "$held" 2>/dev/null | head -n 1 | sed 's/^ *//')`,
    `  if [ -n "$info" ]; then fail held "$held" "$info"; else fail held "$held"; fi`,
    `fi`,
  ];
}

/** `ps` etime (`[[dd-]hh:]mm:ss`) in seconds, or null when it is not one. */
export function etimeSeconds(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (m === null) return null;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [
    number,
    number,
    number,
    number,
  ];
  return ((d * 24 + h) * 60 + min) * 60 + s;
}

/** `process <pid>`, with `(<command, cut>, <age>s old)` when the host's `ps` named them. */
function holderLabel(pid: string | undefined, etime?: string, args?: string): string {
  if (pid === undefined) return "a process";
  if (args === undefined || etime === undefined) return `process ${pid}`;
  const cmd = args.length > 60 ? `${args.slice(0, 59)}…` : args;
  const age = etimeSeconds(etime);
  return `process ${pid} (${cmd}${age === null ? "" : `, ${age}s old`})`;
}

/**
 * The close rule for a remote worktree `spawn --host --worktree` made, run
 * AFTER the agent's pane is dead (the caller frees the channel first; at cap 1
 * the pane held it): under one lease, one exec observes the state (clean or
 * dirty, HEAD, and that the path is still a worktree of the repo the row recorded),
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
    "name" | "workstreamName" | "host" | "cwd" | "base" | "collectedHead" | "incarnation" | "repo"
  >,
  opts: CloseRemoteWorktreeOptions = {},
): Promise<ReleasedWorktree> {
  return remoteClose(db, agent, opts);
}

type RemoteTree = Parameters<typeof closeRemoteWorktree>[1];

interface CloseRemoteWorktreeOptions {
  keepBranch?: boolean;
  paneAlive?: (paneId: string) => Promise<boolean>;
  /** Runs between the observation and the removal; throws to stop (an identity re-check). */
  beforeRemove?: () => void;
  /** The removed agent's recovery record (src/remote-recovery.ts) when there is no row: refusals name it. */
  recoveryId?: number;
  /** Runs on the ADMITTED view before any exec; throws to stop (a recovery pins the host identity it was made for). */
  checkProfile?: (h: HostView) => void;
  /** Test seam: where the quiescence scan looks (default /proc, then `lsof`). */
  probe?: { proc: string; lsof: string };
  /** Remove past a holder or an unprovable scan (each becomes a warning). Never past dirt or a moved HEAD. */
  force?: boolean;
}

/** A read-only close preflight, available when the loop does not hold a host channel. */
export async function assertRemoteWorktreeReleasable(
  db: Db,
  tree: RemoteTree,
  keepBranch: boolean,
  extra: Pick<CloseRemoteWorktreeOptions, "checkProfile" | "recoveryId" | "probe"> = {},
): Promise<void> {
  await remoteClose(db, tree, { ...extra, keepBranch }, true);
}

function remoteClose(
  db: Db,
  agent: RemoteTree,
  opts: CloseRemoteWorktreeOptions,
): Promise<ReleasedWorktree>;
function remoteClose(
  db: Db,
  agent: RemoteTree,
  opts: CloseRemoteWorktreeOptions,
  checkOnly: true,
): Promise<ReleasedWorktree | undefined>;
async function remoteClose(
  db: Db,
  agent: RemoteTree,
  opts: CloseRemoteWorktreeOptions,
  checkOnly = false,
): Promise<ReleasedWorktree | undefined> {
  const { name, workstreamName: ws, host, cwd: path, base, collectedHead, repo } = agent;
  if (host === null || path === null || base === null || repo === null) {
    throw new Error(say("remote.no_worktree", name));
  }
  const asidePath = asideOf(path, agent.incarnation);
  const probe = opts.probe ?? { proc: "/proc", lsof: "lsof" };
  const refuse = (reason: RemoteCloseRefusedError["reason"], detail: string): never => {
    throw new RemoteCloseRefusedError(name, ws, reason, detail, opts.recoveryId);
  };
  const holder = `close:${ws}/${name}`;
  return withHostView(
    db,
    host,
    holder,
    async (h, lease) => {
      opts.checkProfile?.(h);
      const root = shellQuote(repo);
      const wt = shellQuote(path);
      const aside = shellQuote(asidePath);
      // Both execs run under this one channel, from the admitted snapshot.
      const run = async (body: string): Promise<{ out: string; why: string }> => {
        const r = await h.link.exec(
          h,
          { script: script(body), cwd: repo, timeoutMs: REMOTE_PREPARE_TIMEOUT_MS },
          lease === undefined ? { holder } : { lease },
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
          // A crash after the move leaves the aside. Only apply puts it back.
          `if [ -d "$aside" ]; then`,
          `  [ ! -e "$wt" ] || { echo "$aside is parked beside $wt" >&2; exit 9; }`,
          checkOnly
            ? `  wt="$aside"`
            : `  git -C "$root" worktree move "$aside" "$wt" >&2 || { echo "could not move $aside back to $wt" >&2; exit 10; }`,
          `fi`,
          `[ -d "$wt" ] || { echo 'MU_STATE gone'; exit 0; }`,
          `[ "$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)" = "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)" ] || { echo "$wt is not a worktree of $root" >&2; exit 8; }`,
          `head=$(git -C "$wt" rev-parse --verify HEAD) || exit 5`,
          `st=$(git -C "$wt" status --porcelain) || exit 6`,
          `if [ -z "$st" ]; then s=clean; else s=dirty; fi`,
          // Already on a branch of the root (a merge there, a push): nothing to lose.
          `m=; [ -z "$(git -C "$root" for-each-ref --contains "$head" --count=1 --format=x refs/heads refs/remotes 2>/dev/null)" ] || m=' merged'`,
          `printf 'MU_STATE %s %s%s\\n' "$s" "$head" "$m"`,
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
      const known =
        head === base || (collectedHead !== null && head === collectedHead) || m[3] !== undefined;
      if (!known && opts.keepBranch !== true) {
        return refuse(
          "uncollected",
          `HEAD ${short} was never collected (base ${base.slice(0, 12)}); collect it, or close with --keep-branch`,
        );
      }
      if (checkOnly) return;
      const branch = known ? undefined : `mu/${ws}/${name}-${short}`;
      // Kept only because a branch of the root held it: that branch may move
      // before the removal, so the removal checks again (fail unmerged).
      const viaRef = head !== base && (collectedHead === null || head !== collectedHead);
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
          ...(branch === undefined && viaRef
            ? [
                `[ -n "$(git -C "$root" for-each-ref --contains "$want" --count=1 --format=x refs/heads refs/remotes 2>/dev/null)" ] || fail unmerged`,
              ]
            : []),
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
      const r = lastMatch(removed.out, REMOTE_RM_RE)?.[1] as RemoteRemoval | undefined;
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
      if (r === "unmerged") {
        return refuse(
          "uncollected",
          `HEAD ${short} is no longer on any branch of the root (it moved while closing); nothing was removed. Collect it, or close with --keep-branch`,
        );
      }
      if (r?.startsWith("held")) {
        const held = lastMatch(removed.out, REMOTE_RM_RE);
        return refuse(
          "held",
          `${holderLabel(held?.[2], held?.[3], held?.[4])} on ${host} is still inside ${path}; nothing was removed. Stop it and${force}`,
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
