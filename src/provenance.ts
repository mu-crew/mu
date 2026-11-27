// mu — who and where an op came from (docs/VOCABULARY.md § provenance).
//
// `actorSession` names the harness session behind an op; `actorAnchor`
// names the exact assistant turn (and tool call) that ran the verb. Both
// are stamped on every op by the op-context layer, so a reader can link
// a task change back to the conversation that caused it. Both are
// advisory and best-effort: any failure yields null, never an error.
//
// `actorRole` records the capacity the session acted in ('orchestrator' |
// 'worker'), decided where mu knows it (resolveActorRole) rather than
// inferred later from intents by a reader. Rex/tmux pane tags can read
// the same function when they learn roles (ROADMAP rex-mu-role-parity).

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Db } from "./db.js";

export interface Provenance {
  actorSession: string | null;
  actorAnchor: string | null;
}

/** How much of a session file's tail is searched for the latest assistant entry. */
const TAIL_BYTES = 64 * 1024;

/** The tail of `path` as text, or null on any I/O error. */
function readTail(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** `<entry id>[:<toolCallId>]` of the last assistant entry in a pi session file's tail. */
function latestAssistantAnchor(sessionFile: string): string | null {
  const tail = readTail(sessionFile);
  if (tail === null) return null;
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || !line.includes('"assistant"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the tail's first line may be cut mid-entry
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { id, message } = entry as { id?: unknown; message?: unknown };
    if (typeof id !== "string" || typeof message !== "object" || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "assistant") continue;
    const calls = Array.isArray(content)
      ? content.filter(
          (c): c is { type: "toolCall"; id: string } =>
            typeof c === "object" && c !== null && (c as { type?: unknown }).type === "toolCall",
        )
      : [];
    const only = calls.length === 1 ? calls[0] : undefined;
    return only !== undefined && typeof only.id === "string" ? `${id}:${only.id}` : id;
  }
  return null;
}

/**
 * The provenance of the calling process, from its env: an explicit
 * `MU_ACTOR_SESSION` / `MU_ACTOR_ANCHOR` wins, else a pi session
 * (`pi:<PI_SESSION_ID>`, the latest assistant entry of `PI_SESSION_FILE`).
 */
export function resolveProvenance(env: NodeJS.ProcessEnv = process.env): Provenance {
  const actorSession =
    env.MU_ACTOR_SESSION || (env.PI_SESSION_ID ? `pi:${env.PI_SESSION_ID}` : null);
  const actorAnchor =
    env.MU_ACTOR_ANCHOR ||
    (env.PI_SESSION_FILE ? latestAssistantAnchor(env.PI_SESSION_FILE) : null);
  return { actorSession: actorSession || null, actorAnchor: actorAnchor || null };
}

/** The capacity an op's session acted in; `ops.actor_role`. */
export type ActorRole = "orchestrator" | "worker";

/** Intents only an orchestrating session issues: workers note, claim and
 *  close their own task, they do not plan or drive a crew. */
export const ORCHESTRATION_INTENTS: ReadonlySet<string> = new Set([
  "task.add",
  "agent.spawn",
  "agent.send",
  "agent.close",
  "workstream.init",
  "task.reap",
]);

/**
 * The role to stamp on an op with `intent`, from the caller's env:
 *   - `MU_ORCHESTRATOR=1` (spawned `--orchestrator`, `mu orchestrate`): orchestrator.
 *   - a managed agent (`MU_MANAGED_AGENT=1`, `MU_WORKSTREAM`, `MU_AGENT_NAME`)
 *     with a row in `agents` of its workstream: worker, whatever the intent.
 *   - anyone else issuing an orchestration intent: orchestrator.
 *   - otherwise null (unknown; a plain note or close says nothing about capacity).
 * Best-effort like the rest of provenance: a failed lookup yields null.
 */
export function resolveActorRole(
  db: Db,
  intent: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ActorRole | null {
  if (env.MU_ORCHESTRATOR === "1") return "orchestrator";
  const { MU_MANAGED_AGENT: managed, MU_WORKSTREAM: ws, MU_AGENT_NAME: name } = env;
  if (managed === "1" && ws && name && isRegisteredAgent(db, ws, name)) return "worker";
  return intent !== null && ORCHESTRATION_INTENTS.has(intent) ? "orchestrator" : null;
}

function isRegisteredAgent(db: Db, workstream: string, name: string): boolean {
  try {
    return (
      db
        .prepare(
          "SELECT 1 FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE w.name = ? AND a.name = ?",
        )
        .get(workstream, name) !== undefined
    );
  } catch {
    return false;
  }
}
