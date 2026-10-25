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
  opts: { workstream: string; name: string; repo: string },
): Promise<CollectResult> {
  const { workstream, name, repo } = opts;
  return withAgentLock(db, workstream, name, () =>
    withFileLock(
      repoLockPath(db, repo),
      `collect ${repo}`,
      async () => {
        const agent = getAgent(db, name, workstream);
        if (agent === undefined) throw new AgentNotFoundError(name, workstream);
        const { host, cwd, base } = agent;
        if (host === null || cwd === null) {
          throw new RemoteCollectUnsupportedError(name, "it is a local agent");
        }
        if (base === null) {
          throw new RemoteCollectUnsupportedError(
            name,
            "it was spawned with --cwd, not --worktree: there is no remote worktree of its own",
          );
        }
        const r = await withHostChannel(
          db,
          host,
          `collect:${workstream}/${name}`,
          async (profile, lease) => {
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
        const ref = collectRef(workstream, name);
        const prior = await git(["rev-parse", "--verify", "-q", ref], repo).catch(() => undefined);
        await git(["update-ref", ref, head], repo);
        if ((await git(["rev-parse", "--verify", ref], repo)) !== head) {
          throw new RemoteCollectError(host, `could not pin ${ref}; nothing recorded`);
        }
        const changed = head !== (agent.collectedHead ?? base);
        await recordCollected(db, agent, head, ref, repo, prior);
        return { head, ref, merge: `git merge ${head}`, changed };
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

/** Compare-and-set the record on the agent captured before the awaits (also for an unchanged head: the fence is the same); restore the ref when it was replaced. */
async function recordCollected(
  db: Db,
  agent: AgentRow,
  head: string,
  ref: string,
  repo: string,
  prior: string | undefined,
): Promise<void> {
  const fence = "id = ? AND pane_id = ? AND host IS ? AND cwd IS ? AND base IS ?";
  const who = [agent.incarnation, agent.paneId, agent.host, agent.cwd, agent.base];
  // An unchanged head writes nothing, but is still fenced: success names this incarnation.
  const n =
    head === agent.collectedHead
      ? db.prepare(`SELECT 1 FROM agents WHERE ${fence}`).all(...who).length
      : db
          .prepare(`UPDATE agents SET collected_head = ?, updated_at = ? WHERE ${fence}`)
          .run(head, new Date().toISOString(), ...who).changes;
  if (n === 1) return;
  // Undo only this attempt's pin: the ref goes back to what it held (an earlier collect's commit stays pinned).
  await (prior === undefined
    ? git(["update-ref", "-d", ref, head], repo)
    : git(["update-ref", ref, prior, head], repo)
  ).catch(() => {});
  throw new AgentReplacedError(agent.name, agent.workstreamName, "collected");
}
