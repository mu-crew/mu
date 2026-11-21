import { spawnSync } from "node:child_process";
import { groupAlive, pidProvenGone } from "../src/hosts.js";

/** One lazily sampled exited PID per fixture file, refreshed if the OS recycled it. */
export function cachedDeadPid(): () => number {
  let pid: number | undefined;
  return () => {
    if (pid !== undefined && pidProvenGone(pid, null) && !groupAlive(pid, null)) return pid;
    const child = spawnSync("true", { stdio: "ignore" });
    if (!child.pid || child.status !== 0) throw new Error("could not sample an exited child PID");
    pid = child.pid;
    return pid;
  };
}
