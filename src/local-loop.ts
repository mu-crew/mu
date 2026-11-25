// A local-loop worker owns only the mule jobs under its registry incarnation's key prefix.
// Use mule's short, bounded control calls: no extra SSH session for a master check.
import type { Db } from "./db.js";
import { execGroupCapture } from "./exec-file.js";
import { HostHandbackError, LOCAL_LOOP_TRANSPORT } from "./hosts.js";
import { localMachineId } from "./segments.js";
import { shellWord } from "./shell-quote.js";
import { awaitExit, type PaneProcesses } from "./worktree.js";

export const MULE_JOB_PREFIX_ENV = "MULE_PI_JOB_PREFIX";

export function muleJobPrefix(db: Db, incarnation: number): string {
  return `mu.${localMachineId(db)}.${incarnation}.`;
}

export function workspaceHost(agent: {
  host?: string | null;
  hostTransport?: string | null;
}): string | undefined {
  return agent.hostTransport === LOCAL_LOOP_TRANSPORT ? (agent.host ?? undefined) : undefined;
}

/** A local workspace check failed before any prompt was written. Never a liveness verdict. */
export class LocalLoopHandbackError extends HostHandbackError {}

function remedy(host: string): string {
  return `check the SSH master with mule host info --host ${shellWord(host)} and open it if needed`;
}

async function muleCommand(args: string[], signal?: AbortSignal) {
  return execGroupCapture(process.env.MULE_PI_BIN || "mule", ["--quiet", ...args], {
    timeoutMs: 5000,
    maxStreamBytes: 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
}

function decodeObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const json: unknown = JSON.parse(stdout);
    if (json !== null && typeof json === "object" && !Array.isArray(json)) {
      return json as Record<string, unknown>;
    }
  } catch {
    // Unreadable is never evidence that the host or its jobs are gone.
  }
}

/** A workspace is usable for new work only once mule reports its SSH master up. */
export async function requireMuleMaster(
  hosts: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (hosts.length === 0) return;
  const run = await muleCommand(["host", "list", "--json"], signal);
  signal?.throwIfAborted();
  const rows = run.exitCode === 0 && !run.truncated ? decodeObject(run.stdout)?.items : undefined;
  for (const host of hosts) {
    if (!Array.isArray(rows) || !rows.some((r) => r?.name === host && r.master === true)) {
      throw new LocalLoopHandbackError(host, "exec", remedy(host));
    }
  }
}

/** A local close conflict, not a host hand-back. Exit 4. */
export class MuleDispatchStillExitingError extends Error {
  override readonly name = "MuleDispatchStillExitingError";
  constructor(
    public readonly remaining: readonly number[],
    retry?: string,
  ) {
    super(
      `local dispatch processes are still exiting (PID/group: ${remaining.join(", ")}); mule jobs were not checked${retry === undefined ? "" : `; retry after a fresh preview: ${retry}`}`,
    );
  }
}

export function muleDispatchProbes(pane: PaneProcesses): number[] {
  return [...pane.tree, ...[...pane.groups].map((g) => -g)];
}

/** Wait at most five seconds after the pane kill, before listing mule jobs. */
export async function awaitMuleDispatchExit(
  probes: Iterable<number>,
  retry?: string,
): Promise<void> {
  // A reparented helper still holds its process group. Probe groups too, without
  // signalling or killing anything: a pid may have been reused since the snapshot.
  const remaining = await awaitExit(probes, 5000);
  if (remaining.length > 0) throw new MuleDispatchStillExitingError(remaining, retry);
}

export function muleClosePreview(workstream: string, name: string, recoveryId: number): string {
  return `mu agent close ${shellWord(name)} -w ${shellWord(workstream)} --recovery ${recoveryId}`;
}

/** List after the local pane and its dispatchers are gone. Remove only positively identified outstanding jobs. */
export async function stopMuleJobs(db: Db, host: string, incarnation: number): Promise<void> {
  const prefix = muleJobPrefix(db, incarnation);
  const refuse = (why?: string): never => {
    throw new HostHandbackError(
      host,
      "stop",
      `${why ? `${why}; ` : ""}${remedy(host)}; mule jobs not verified stopped`,
    );
  };
  const result = await muleCommand(["ls", "--host", host, "--key-prefix", prefix, "--json"]);
  const list = result.exitCode === 0 && !result.truncated ? decodeObject(result.stdout) : undefined;
  if (!Array.isArray(list?.items) || !Array.isArray(list.unreachable)) return refuse();
  if (list.unreachable.length !== 0) return refuse(list.unreachable[0]?.remedy);
  const outstanding = new Set<string>();
  for (const job of list.items) {
    if (job?.host !== host || typeof job.key !== "string" || !job.key.startsWith(prefix)) {
      return refuse("mule returned a job without a matching host and key");
    }
    if (job.state === "done" || job.state === "orphan" || job.state === "missing") continue;
    if (typeof job.id !== "string" || !/^[0-9a-f]{6}$/.test(job.id))
      return refuse("invalid mule job id");
    outstanding.add(job.id);
  }
  for (const id of outstanding) {
    // Unlike `kill`, `rm` proves both the job and its watchdog are gone.
    const stopped = await muleCommand(["rm", "--host", host, id]);
    if (stopped.exitCode !== 0) return refuse(`could not stop mule job ${id}`);
  }
}
