// mu — `agent collect`: bring a remote worker's commits home (v_remote_collect).
//
// The PANE is the transport (src/remote-agent.ts), so a live worker holds its
// host's channel: at `--max-sessions 1` collect is refused beside it by the one
// admission every remote command passes (a one-line HostChannelBusyError naming
// the holder), and works once the pane is gone or the cap is raised. mu never
// connects: the work is the profile's `fetch` template, run LOCALLY with the
// local repo as its working directory, under one transient channel.
//
// What "collected" means, so a template cannot fake it: FETCH_HEAD is removed
// first, the template runs, and the commit is whatever `FETCH_HEAD^{commit}`
// resolves to afterwards (no commit: a failed collect, nothing recorded). That
// commit is pinned under `refs/mu/collect/<ws>/<agent>` (a ref git's gc keeps)
// and only then recorded as `agents.collected_head` (compare-and-set on the
// agent's id, pane, host, cwd and base). The merge command printed names the
// exact sha, never FETCH_HEAD. A per-repo lock stops two collects from sharing
// one FETCH_HEAD. mu never merges.

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AgentLockBusyError, AgentNotFoundError, AgentReplacedError } from "./agents/errors.js";
import { withAgentLock } from "./agents/lock.js";
import { type AgentRow, getAgent } from "./agents.js";
import type { Db } from "./db.js";
import { locksDir, withFileLock } from "./file-lock.js";
import { runLeasedTemplate, withHostChannel } from "./hosts.js";
import { localPaneAlive } from "./remote-agent.js";
import {
  assertRecoveryProfile,
  assertRecoveryUnchanged,
  assertRecoveryUsable,
  pinnedByOthers,
  type RemoteRecovery,
  RemoteRecoveryRefusedError,
  recoveryGone,
  recoveryHolds,
  selectRemoteRecovery,
  setRecoveryCollectedHead,
} from "./remote-recovery.js";
import { git } from "./vcs/git.js";

/** Budget for the local fetch (it moves objects, so it may take a while). */
export const REMOTE_COLLECT_TIMEOUT_MS = 300_000;

/** `agent collect` on an agent that has no remote worktree to collect from. Exit 2. */
export class RemoteCollectUnsupportedError extends Error {
  override readonly name = "RemoteCollectUnsupportedError";
  constructor(agent: string, why: string) {
    super(`agent ${agent}: nothing to collect: ${why}`);
  }
}

/** The fetch failed or produced no commit: nothing was recorded. Exit 5 (substrate). */
export class RemoteCollectError extends Error {
  override readonly name = "RemoteCollectError";
  constructor(
    public readonly host: string,
    detail: string,
  ) {
    super(`host ${host}: collect failed: ${detail}`);
  }
  errorNextSteps(): { intent: string; command: string }[] {
    return [
      { intent: "Check the host answers and has the repo", command: `mu host check ${this.host}` },
    ];
  }
}

export interface CollectResult {
  /** The collected commit, as fetched. */
  head: string;
  /** The durable ref holding it in the local repo. */
  ref: string;
  /** A command for the user to run; mu never runs it. */
  merge: string;
  /** False when this HEAD is the one already collected (or still the base). */
  changed: boolean;
  /** Set when the commits were collected for a removed agent's recovery record (its id), not a live agent. */
  recoveryId?: number;
}

/** What a collect works on: a live agent's row, or a removed agent's recovery record. */
interface CollectTarget {
  host: string;
  cwd: string;
  base: string;
  collectedHead: string | null;
  /** The agent or record id: never another incarnation's pin owner. */
  ownerId: number;
  /** Record `head` as the collected one (compare-and-set on the captured identity); false when it moved. */
  record(head: string): boolean;
  /** Refuse (throw) unless the target is still exactly what was captured. */
  recheck(): void;
  /** The refusal for a target that changed between the capture and the write. */
  lost(): Error;
}

/** The record a collect on `<workstream>/<name>` means, when there is no live agent (or one is asked for by id). */
function recoveryTarget(db: Db, rec: RemoteRecovery): CollectTarget {
  return {
    host: rec.host,
    cwd: rec.cwd,
    base: rec.base,
    collectedHead: rec.collectedHead,
    ownerId: rec.agentId,
    record: (head) =>
      head === rec.collectedHead ? recoveryHolds(db, rec) : setRecoveryCollectedHead(db, rec, head),
    recheck: () => {
      assertRecoveryUnchanged(db, rec);
      assertRecoveryUsable(db, rec);
    },
    lost: () =>
      new RemoteRecoveryRefusedError(
        rec.workstream,
        rec.name,
        "changed",
        `recovery ${rec.agentId} changed while its commits were being collected; the pin was restored`,
        [rec.agentId],
      ),
  };
}

export function collectRef(workstream: string, name: string): string {
  return `refs/mu/collect/${workstream}/${name}`;
}

const firstLine = (s: string): string =>
  s
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

function repoLockPath(db: Db, repo: string): string {
  const base = db.memory || db.name === "" ? locksDir() : join(dirname(db.name), "locks");
  return join(base, `collect-${createHash("sha256").update(repo).digest("hex").slice(0, 16)}.lock`);
}

/**
 * Fetch `name`'s remote worktree into the local repo `opts.repo` (a git
 * checkout) and record the collected HEAD. Idempotent: the same remote HEAD
 * twice records once and says `changed: false`.
 */
export async function collectRemoteAgent(
  db: Db,
  opts: { workstream: string; name: string; repo: string; recoveryId?: number },
): Promise<CollectResult> {
  const { workstream, name, repo } = opts;
  return withAgentLock(db, workstream, name, () =>
    withFileLock(
      repoLockPath(db, repo),
      `collect ${repo}`,
      async () => {
        const agent = getAgent(db, name, workstream);
        // A removed agent's worktree (`remote_recovery`): by id, or the one
        // left when no agent holds the name. A live agent beside a named id
        // refuses in assertRecoveryUsable.
        const rec =
          opts.recoveryId !== undefined || agent === undefined
            ? selectRemoteRecovery(db, workstream, name, opts.recoveryId)
            : undefined;
        if (rec === undefined && opts.recoveryId !== undefined) {
          throw recoveryGone(workstream, name, opts.recoveryId);
        }
        let target: CollectTarget;
        if (rec !== undefined) {
          assertRecoveryUsable(db, rec);
          target = recoveryTarget(db, rec);
        } else if (agent !== undefined) {
          target = agentTarget(db, agent);
        } else {
          throw new AgentNotFoundError(name, workstream);
        }
        const { host, cwd, base } = target;
        const r = await withHostChannel(
          db,
          host,
          `collect:${workstream}/${name}`,
          async (profile, lease) => {
            if (rec !== undefined) assertRecoveryProfile(rec, profile);
            // Under the lease, so a refused collect touches nothing. A stale
            // FETCH_HEAD must not pass for this fetch's answer.
            const fetchHead = await git(["rev-parse", "--git-path", "FETCH_HEAD"], repo);
            await rm(resolve(repo, fetchHead), { force: true });
            return runLeasedTemplate(
              db,
              lease,
              profile,
              "fetch",
              { cwd },
              REMOTE_COLLECT_TIMEOUT_MS,
              repo,
            );
          },
          { paneAlive: localPaneAlive },
        );
        if (r.exitCode === null) {
          throw new RemoteCollectError(
            host,
            `timed out after ${REMOTE_COLLECT_TIMEOUT_MS}ms; nothing recorded`,
          );
        }
        if (r.exitCode !== 0) {
          const why = firstLine(r.stderr) || firstLine(r.stdout);
          throw new RemoteCollectError(
            host,
            `fetch exited ${r.exitCode}${why === "" ? "" : `: ${why}`}; nothing recorded`,
          );
        }
        let head: string;
        try {
          head = await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], repo);
        } catch {
          throw new RemoteCollectError(
            host,
            "the fetch template succeeded but left no commit in FETCH_HEAD (does it `git fetch`?); nothing recorded",
          );
        }
        // The fetch was slow: the identity must still hold before a ref is moved.
        target.recheck();
        const ref = collectRef(workstream, name);
        const prior = await git(["rev-parse", "--verify", "-q", ref], repo).catch(() => undefined);
        // The ref is ONE per (workstream, name), not per incarnation: moving it
        // would drop the pin another unresolved recovery's commit relies on.
        if (prior !== undefined && prior !== head) {
          const holders = pinnedByOthers(db, { workstream, name, agentId: target.ownerId }, prior);
          if (holders.length > 0) {
            throw new RemoteRecoveryRefusedError(
              workstream,
              name,
              "pin",
              `${ref} pins ${prior.slice(0, 12)}, the collected HEAD of recovery ${holders.join(", ")}; close that recovery first, then collect`,
              holders,
            );
          }
        }
        await git(["update-ref", ref, head], repo);
        if ((await git(["rev-parse", "--verify", ref], repo)) !== head) {
          throw new RemoteCollectError(host, `could not pin ${ref}; nothing recorded`);
        }
        const changed = head !== (target.collectedHead ?? base);
        await recordCollected(target, head, ref, repo, prior);
        return {
          head,
          ref,
          merge: `git merge ${head}`,
          changed,
          ...(rec === undefined ? {} : { recoveryId: rec.agentId }),
        };
      },
      {
        strict: true,
        onUnavailable: () => {
          throw new AgentLockBusyError(name, workstream);
        },
      },
    ),
  );
}

/** A live agent as a collect target: remote worktree rows only. */
function agentTarget(db: Db, agent: AgentRow): CollectTarget {
  const { host, cwd, base } = agent;
  if (host === null || cwd === null) {
    throw new RemoteCollectUnsupportedError(agent.name, "it is a local agent");
  }
  if (base === null) {
    throw new RemoteCollectUnsupportedError(
      agent.name,
      "it was spawned with --cwd, not --worktree: there is no remote worktree of its own",
    );
  }
  const fence = "id = ? AND pane_id = ? AND host IS ? AND cwd IS ? AND base IS ?";
  const who = [agent.incarnation, agent.paneId, agent.host, agent.cwd, agent.base];
  return {
    host,
    cwd,
    base,
    collectedHead: agent.collectedHead,
    ownerId: agent.incarnation,
    // An unchanged head writes nothing, but is still fenced: success names this incarnation.
    record: (head) =>
      head === agent.collectedHead
        ? db.prepare(`SELECT 1 FROM agents WHERE ${fence}`).all(...who).length === 1
        : db
            .prepare(`UPDATE agents SET collected_head = ?, updated_at = ? WHERE ${fence}`)
            .run(head, new Date().toISOString(), ...who).changes === 1,
    recheck: () => {
      const now = getAgent(db, agent.name, agent.workstreamName);
      if (now?.incarnation !== agent.incarnation || now.paneId !== agent.paneId) {
        throw new AgentReplacedError(agent.name, agent.workstreamName, "collected");
      }
    },
    lost: () => new AgentReplacedError(agent.name, agent.workstreamName, "collected"),
  };
}

/** Compare-and-set the record on the target captured before the awaits (also for an unchanged head: the fence is the same); restore the ref when it was replaced. */
async function recordCollected(
  target: CollectTarget,
  head: string,
  ref: string,
  repo: string,
  prior: string | undefined,
): Promise<void> {
  if (target.record(head)) return;
  // Undo only this attempt's pin: the ref goes back to what it held (an earlier collect's commit stays pinned).
  await (prior === undefined
    ? git(["update-ref", "-d", ref, head], repo)
    : git(["update-ref", ref, prior, head], repo)
  ).catch(() => {});
  throw target.lost();
}
