// mu — the `pane` job kind (spec 2026-11-09-mu-plugins.md, D8): a local agent
// or a `session` profile's pane. The pane is the job and its id the handle, so
// its liveness is whether the pane still holds a running agent (`paneUp`).

import type { JobKind, JobLiveness, JobRef } from "./types.js";
import { viewRunning } from "./view.js";

/**
 * Whether the pane still holds a running agent: tmux and Rex, the pane runs
 * (an exited retained pane does not); herdr, an agent still occupies it (the
 * pane outlives its occupant as a shell). `undefined` when the multiplexer
 * cannot say: unknown, never a death.
 */
export async function paneUp(paneId: string): Promise<boolean | undefined> {
  try {
    return await viewRunning(paneId, { occupied: true });
  } catch {
    return undefined;
  }
}

export const paneKind: JobKind = {
  name: "pane",
  caps: { view: "bound", handle: "pane" },
  answer: "running",
  async status(_db, job: JobRef): Promise<JobLiveness> {
    const up = await paneUp(job.viewPaneId);
    if (up === undefined) return { state: "unknown", reason: "the multiplexer cannot say" };
    return up ? { state: "running" } : { state: "lost", reason: "pane gone" };
  },
};
