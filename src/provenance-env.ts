// mu — the provenance of the calling process, from its env alone
// (docs/VOCABULARY.md § provenance). DB-free: the standalone pi extension
// bundle (dist/extension/mu-pi.js) imports it, so it must reach only Node
// built-ins. src/provenance.ts re-exports it next to the DB-backed role lookup.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

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

/** The env's own session: `MU_ACTOR_SESSION`, else `pi:<PI_SESSION_ID>`, else null. */
export function envActorSession(env: NodeJS.ProcessEnv): string | null {
  return env.MU_ACTOR_SESSION || (env.PI_SESSION_ID ? `pi:${env.PI_SESSION_ID}` : null);
}
