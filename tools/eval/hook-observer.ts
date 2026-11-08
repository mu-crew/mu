// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The eval observer hook: one more handler the rig installs beside murmur's, mu's and muzzle's in
// every hook harness's config (harness.ts). It appends one JSON line per hook event to the run's
// hooks.log, so a judge reads what each worker's harness reported (a prompt submitted, a turn
// stopped with its text, an interrupt) the same way from a real harness and from a fake one.
// Record-only: it reads stdin, prints nothing, and always exits 0.
//
//   node hook-observer.ts <harness> [<log>]     (<log> default: $EVAL_WORKER_DIR/hooks.log)
//
// Muse Code clears its hooks' environment, so its entry names the log; the agent then comes from
// mu's anchor file of the nearest anchored ancestor, as murmur reads it.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { observerRecord } from "./harness-observe.ts";
import { hasCanary } from "./rig-private.ts";

/** A turn-end payload's transcript path (a turn end, not every event), or null. */
function transcriptOf(body: unknown, kind: string): string | null {
  if (!["stop", "failed", "interrupt", "session_end"].includes(kind)) return null;
  const t = (body as { transcript_path?: unknown } | null)?.transcript_path;
  return typeof t === "string" && t !== "" ? t : null;
}

/**
 * The payload, or the transcript it points at, carries a rig file's canary: the agent read the rig
 * (a pane AUT has no tool stream for rig-guard.ts rigReads, so its hooks report it).
 */
function sawCanary(raw: string, body: unknown, kind: string): boolean {
  if (hasCanary(raw)) return true;
  const t = transcriptOf(body, kind);
  if (t === null) return false;
  try {
    return hasCanary(readFileSync(t, "utf8"));
  } catch {
    return false;
  }
}

function anchorAgent(home: string): string | null {
  let table = "";
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const parent = new Map<number, number>();
  for (const l of table.split("\n")) {
    const [pid, ppid] = l.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && !Number.isNaN(pid)) parent.set(pid, ppid);
  }
  let pid = process.ppid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    try {
      const doc = JSON.parse(
        readFileSync(join(home, ".local", "state", "mu-next", "anchors", `${pid}.json`), "utf8"),
      ) as { agent_name?: unknown };
      if (typeof doc.agent_name === "string") return doc.agent_name;
    } catch {
      // no anchor at this pid
    }
    pid = parent.get(pid) ?? 0;
  }
  return null;
}

function main(): void {
  const [harness = "?", logArg] = process.argv.slice(2);
  const log =
    logArg ?? (process.env.EVAL_WORKER_DIR ? join(process.env.EVAL_WORKER_DIR, "hooks.log") : "");
  if (log === "") return;
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return;
  }
  const home = process.env.HOME ?? "";
  const agent = process.env.MU_AGENT_NAME || anchorAgent(home);
  const rec = observerRecord(harness, body, {
    ms: Date.now(),
    agent,
    host: process.env.EVAL_HOST ?? /\/hosts\/([^/]+)\/home$/.exec(home)?.[1] ?? null,
    cwd: process.cwd(),
  });
  const transcript = transcriptOf(body, rec.kind);
  const out = {
    ...rec,
    ...(sawCanary(raw, body, rec.kind) ? { rigCanary: true } : {}),
    ...(transcript === null ? {} : { transcript }),
  };
  appendFileSync(log, `${JSON.stringify(out)}\n`);
}

try {
  main();
} catch {
  // the observer never fails a hook
}
process.exit(0);
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
