// mu — wait resumes: the stored condition set behind `mu wait --resume <id>`.
//
// A `mu wait` that ends with something still owed (a timeout, a signal, an event
// that left siblings open) prints ONE handle, `mu wait --resume <id>`, instead of
// a command that spells every ref and flag. The row (`wait_resumes`,
// machine-local) holds what the wait was: the refs still owed with the run
// baseline and pi incarnation each was last seen at, the mode, every filter, the
// deadline the caller asked for, and the callers the wait ran for. So a resume is
// lossless (no ref is dropped, an agent that restarted meanwhile is refused, not
// miscounted) and its size does not grow with the wait.
//
// Pure SQLite, one short synchronous write per saved handle. Rows older than
// RESUME_KEEP_DAYS go on the next save (no daemon). No foreign keys: a handle
// outlives the tasks and agents it names.

import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { type WaitRef, WaitRefError } from "./wait-types.js";

/** What a wait asked for, whatever spelling it came in; a resume replays exactly this. */
export interface ResumeSpec {
  refs: WaitRef[];
  mode: "first" | "all";
  scope?: string;
  status?: string;
  untilText?: string;
  stuckAfter?: number;
  onStall: "exit" | "warn" | "steer" | "release";
  wave?: string;
  blockersOf?: { workstream: string; id: string };
  /** Seconds as the caller gave them; absent = the default. */
  timeout?: number;
  /** The reaper-flip anchor (ops seq) of the wait that saved it: a worker that died since is still dead. */
  since?: number;
}

export interface StoredResume {
  id: string;
  /** The callers the wait ran for (see `currentCallers`): the identity is part of the condition set. */
  callers: string[];
  spec: ResumeSpec;
}

/** Handles older than this are dropped when the next one is saved. */
export const RESUME_KEEP_DAYS = 14;

/** `mu wait --resume <id>` names a handle that does not exist (never saved, or older than RESUME_KEEP_DAYS). */
export class WaitResumeNotFoundError extends Error {
  override readonly name = "WaitResumeNotFoundError";
  constructor(public readonly resumeId: string) {
    super(
      `no such wait resume handle: ${resumeId} (a handle is kept ${RESUME_KEEP_DAYS} days; name the refs again with \`mu wait <ref>...\`)`,
    );
  }
}

/** Save the condition set; returns the handle. */
export function saveResume(db: Db, callers: readonly string[], spec: ResumeSpec): string {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RESUME_KEEP_DAYS * 86_400_000).toISOString();
  for (let attempt = 0; ; attempt++) {
    const id = randomBytes(5).toString("hex");
    try {
      db.transaction(() => {
        db.prepare("DELETE FROM wait_resumes WHERE created_at < ?").run(cutoff);
        db.prepare(
          "INSERT INTO wait_resumes (id, callers_json, spec_json, created_at) VALUES (?, ?, ?, ?)",
        ).run(id, JSON.stringify(callers), JSON.stringify(spec), now.toISOString());
      }).immediate();
      return id;
    } catch (e) {
      // 40 bits of id: a collision is a retry, anything else is real.
      if (attempt < 3 && /UNIQUE|PRIMARY KEY/i.test(String(e))) continue;
      throw e;
    }
  }
}

/** The stored wait, or WaitResumeNotFoundError. */
export function loadResume(db: Db, id: string): StoredResume {
  const row = db
    .prepare("SELECT callers_json AS callers, spec_json AS spec FROM wait_resumes WHERE id = ?")
    .get(id) as { callers: string; spec: string } | undefined;
  if (row === undefined) throw new WaitResumeNotFoundError(id);
  try {
    const callers = JSON.parse(row.callers) as string[];
    const spec = JSON.parse(row.spec) as ResumeSpec;
    if (!Array.isArray(callers) || !Array.isArray(spec.refs)) throw new Error("bad shape");
    return { id, callers, spec };
  } catch {
    throw new WaitRefError(`wait resume handle ${id} is unreadable (its stored row is damaged)`);
  }
}
