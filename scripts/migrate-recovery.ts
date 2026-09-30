// scripts/migrate-recovery.ts — legacy substate recovery for migrate.ts.
//
// Split out of scripts/migrate.ts (AGENTS.md 1500-LOC cap). Used by the
// v10/v11 migration paths and by `migrate.ts --recover`. Like the rest
// of the sidecar it writes captured ops, never raw rows behind the log.

import { randomUUID } from "node:crypto";
import type { Db } from "../src/db.js";
import { LEGACY_LOG_ONLY_SQL_EXCLUSION } from "../src/legacy-ops.js";
import { withOpContext } from "../src/op-context.js";
import {
  formatPair,
  mapLegacyStatus,
  type TaskPair,
  type TaskStatus,
  type TaskSubstate,
} from "../src/tasks/status.js";

/** Intent of every recovery write. Excluded from the "last status
 *  writer" search, and its presence on a key makes recovery a no-op. */
const RECOVERY_INTENT = "migrate.substate";
/** Intents that replay an older value rather than make a decision. */
const NON_DECISION_INTENTS = ["undo", RECOVERY_INTENT] as const;
const MIGRATION_NOTE = /^MIGRATION: previous status was (REJECTED|DEFERRED)$/;

export interface RecoveryRow {
  workstream: string;
  localId: string;
  /** formatPair of the pair before recovery. */
  from: string;
  /** formatPair of the recovered pair. */
  to: string;
  /** "ops": a legacy status op; "note": a MIGRATION: note;
   *  "replay": the v11 apply path derived it (migration report only). */
  source: "ops" | "note" | "replay";
  /** Direct dependents now in the ready view (CLOSED recoveries only). */
  unblocked: string[];
}

/**
 * Recover a retired REJECTED / DEFERRED status that the current pair
 * hides behind a non-decision write, as ONE captured op per task.
 *
 * v10 folded both statuses to OPEN. The v11 apply path maps a legacy
 * status op onto its pair, so a task whose newest status writer IS the
 * legacy op needs nothing here. What remains are tasks at OPEN/todo whose
 * newest status write is an `undo` restore (replays an older value) or a
 * migrate.* OPEN put with a MIGRATION: note beside it. For those:
 *
 *   a. last status writer = newest task put carrying $.status, excluding
 *      intents 'undo' and 'migrate.substate';
 *   b. its status is legacy -> the mapped pair, source "ops";
 *   c. else a MIGRATION: note, and the writer is a migrate.* OPEN put or
 *      older than the note -> the pair the note names, source "note";
 *   d. else skip: a later real decision wins.
 *
 * Each recovery is one UPDATE of status + substate + updated_at under
 * intent 'migrate.substate', captured so it syncs and survives rebuild,
 * and repairTaskPair later sees it as the newest substate writer.
 * Idempotent: a key that already has a migrate.substate op is skipped.
 */
export function recoverLegacySubstates(db: Db, workstream?: string): RecoveryRow[] {
  const candidates = db
    .prepare(
      `SELECT t.id, w.name AS workstream, t.local_id
         FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        WHERE t.status = 'OPEN' AND t.substate = 'todo'
          AND (@ws IS NULL OR w.name = @ws)
        ORDER BY w.name, t.local_id`,
    )
    .all({ ws: workstream ?? null }) as Array<{ id: number; workstream: string; local_id: string }>;

  const recovered = db.prepare(
    `SELECT 1 AS x FROM ops WHERE entity = 'task' AND key = ? AND intent = '${RECOVERY_INTENT}' LIMIT 1`,
  );
  const lastWriter = db.prepare(
    `SELECT hlc, intent, json_extract(payload, '$.status') AS status FROM ops
      WHERE entity = 'task' AND key = ? AND op = 'put'
        AND ${LEGACY_LOG_ONLY_SQL_EXCLUSION}
        AND (intent IS NULL OR intent NOT IN (${NON_DECISION_INTENTS.map((i) => `'${i}'`).join(", ")}))
        AND json_type(payload, '$.status') IS NOT NULL
      ORDER BY hlc DESC LIMIT 1`,
  );
  const migrationNotes = db.prepare(
    `SELECT hlc, json_extract(payload, '$.content') AS content FROM ops
      WHERE entity = 'note' AND op = 'put'
        AND substr(key, 1, length(@prefix)) = @prefix
        AND ${LEGACY_LOG_ONLY_SQL_EXCLUSION}
        AND json_extract(payload, '$.content') LIKE 'MIGRATION: previous status was %'
      ORDER BY hlc DESC`,
  );

  const plan: Array<{ id: number; row: RecoveryRow; pair: TaskPair }> = [];
  for (const task of candidates) {
    const key = `${task.workstream}/${task.local_id}`;
    if (recovered.get(key) !== undefined) continue;
    const writer = lastWriter.get(key) as
      | { hlc: string; intent: string | null; status: unknown }
      | undefined;
    let pair: TaskPair | null = null;
    let source: RecoveryRow["source"] = "ops";
    if (writer && typeof writer.status === "string") pair = mapLegacyStatus(writer.status);
    if (pair === null) {
      const note = (
        migrationNotes.all({ prefix: `${key}#` }) as Array<{ hlc: string; content: unknown }>
      ).find((n) => typeof n.content === "string" && MIGRATION_NOTE.test(n.content));
      const match = typeof note?.content === "string" ? MIGRATION_NOTE.exec(note.content) : null;
      const noteWins =
        note !== undefined &&
        (writer === undefined ||
          (writer.intent?.startsWith("migrate.") === true && writer.status === "OPEN") ||
          writer.hlc < note.hlc);
      if (match?.[1] && noteWins) {
        pair = mapLegacyStatus(match[1]);
        source = "note";
      }
    }
    if (pair === null) continue;
    plan.push({
      id: task.id,
      pair,
      row: {
        workstream: task.workstream,
        localId: task.local_id,
        from: formatPair({ status: "OPEN", substate: "todo" }),
        to: formatPair(pair),
        source,
        unblocked: [],
      },
    });
  }
  plan.push(...planRejectedRemap(db, workstream));
  if (plan.length === 0) return [];

  const group = `migrate-substate-${randomUUID()}`;
  const update = db.prepare(
    "UPDATE tasks SET status = ?, substate = ?, updated_at = ? WHERE id = ?",
  );
  const run = db.transaction(() => {
    withOpContext(db, { intent: RECOVERY_INTENT, actor: "migration", group }, () => {
      const now = new Date().toISOString();
      for (const p of plan) update.run(p.pair.status, p.pair.substate, now, p.id);
    });
    for (const p of plan) {
      // A CLOSED -> CLOSED re-map unblocks nothing new.
      const wasClosed = p.row.from.startsWith("CLOSED");
      if (p.pair.status === "CLOSED" && !wasClosed) p.row.unblocked = readyDependents(db, p.id);
    }
  });
  run();
  return plan.map((p) => p.row);
}

/**
 * mu 3.0.0 mapped legacy REJECTED onto CLOSED/wontfix; 3.1 maps it onto
 * CLOSED/rejected. A rebuild or migration re-derives the new pair from
 * the ops, but a 3.0.0 `mu undo` restore wrote `wontfix` explicitly, and
 * that write outranks the legacy op. Re-map a CLOSED/wontfix task when:
 *
 *   - its newest substate writer is NOT a decision (intent 'undo' or
 *     migrate.*): a `task close --as wontfix` is a choice and stays;
 *   - and its history holds a legacy REJECTED status op.
 *
 * The already-recovered guard (any migrate.substate op on the key) does
 * not apply here: a 3.0.0 recovery may have written the old pair.
 * Idempotent anyway: after the re-map the task is no longer wontfix.
 */
function planRejectedRemap(
  db: Db,
  workstream: string | undefined,
): Array<{ id: number; row: RecoveryRow; pair: TaskPair }> {
  const candidates = db
    .prepare(
      `SELECT t.id, w.name AS workstream, t.local_id
         FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        WHERE t.status = 'CLOSED' AND t.substate = 'wontfix'
          AND (@ws IS NULL OR w.name = @ws)
        ORDER BY w.name, t.local_id`,
    )
    .all({ ws: workstream ?? null }) as Array<{ id: number; workstream: string; local_id: string }>;
  const substateWriter = db.prepare(
    `SELECT intent FROM ops
      WHERE entity = 'task' AND key = ? AND op = 'put'
        AND ${LEGACY_LOG_ONLY_SQL_EXCLUSION}
        AND json_extract(payload, '$.substate') = 'wontfix'
      ORDER BY hlc DESC LIMIT 1`,
  );
  const legacyRejected = db.prepare(
    `SELECT 1 AS x FROM ops
      WHERE entity = 'task' AND key = ? AND op = 'put'
        AND json_extract(payload, '$.status') = 'REJECTED'
      LIMIT 1`,
  );
  const rejected = mapLegacyStatus("REJECTED");
  if (rejected === null) return [];
  const plan: Array<{ id: number; row: RecoveryRow; pair: TaskPair }> = [];
  for (const task of candidates) {
    const key = `${task.workstream}/${task.local_id}`;
    const writer = substateWriter.get(key) as { intent: string | null } | undefined;
    const intent = writer?.intent ?? "";
    const replayed = intent === "undo" || intent.startsWith("migrate.");
    if (!replayed || legacyRejected.get(key) === undefined) continue;
    plan.push({
      id: task.id,
      pair: rejected,
      row: {
        workstream: task.workstream,
        localId: task.local_id,
        from: formatPair({ status: "CLOSED", substate: "wontfix" }),
        to: formatPair(rejected),
        source: "ops",
        unblocked: [],
      },
    });
  }
  return plan;
}

/** Direct dependents of `taskId` that sit in the ready view. */
function readyDependents(db: Db, taskId: number): string[] {
  return (
    db
      .prepare(
        `SELECT w.name || '/' || r.local_id AS key
           FROM task_edges e
           JOIN ready r ON r.id = e.to_task_id
           JOIN workstreams w ON w.id = r.workstream_id
          WHERE e.from_task_id = ?
          ORDER BY key`,
      )
      .all(taskId) as { key: string }[]
  ).map((r) => r.key);
}

/** Tasks whose v11 pair differs from the v10 source projection — the
 *  recoveries the replay itself made (legacy op as newest writer). */
export function replayChanges(src: Db, target: Db): RecoveryRow[] {
  // v10 has no substate column; v11 does. Compare full pairs when present.
  const hasSubstate = (src.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).some(
    (c) => c.name === "substate",
  );
  const before = new Map(
    (
      src
        .prepare(
          `SELECT w.name || '/' || t.local_id AS key, t.status,
                  ${hasSubstate ? "t.substate" : "NULL"} AS substate
             FROM tasks t JOIN workstreams w ON w.id = t.workstream_id`,
        )
        .all() as { key: string; status: TaskStatus; substate: TaskSubstate | null }[]
    ).map((r) => [
      r.key,
      r.substate === null ? r.status : formatPair({ status: r.status, substate: r.substate }),
    ]),
  );
  const rows: RecoveryRow[] = [];
  const after = target
    .prepare(
      `SELECT t.id, w.name AS workstream, t.local_id, t.status, t.substate
         FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        ORDER BY w.name, t.local_id`,
    )
    .all() as Array<{
    id: number;
    workstream: string;
    local_id: string;
    status: TaskStatus;
    substate: TaskSubstate;
  }>;
  for (const t of after) {
    const was = before.get(`${t.workstream}/${t.local_id}`);
    if (was === undefined) continue;
    const to = formatPair({ status: t.status, substate: t.substate });
    if (to === was) continue;
    rows.push({
      workstream: t.workstream,
      localId: t.local_id,
      from: was,
      to,
      source: "replay",
      unblocked: t.status === "CLOSED" ? readyDependents(target, t.id) : [],
    });
  }
  return rows;
}

export function reportRecovery(
  rows: readonly RecoveryRow[],
  say: (text: string) => void,
  table: (rows: readonly (readonly [string, string, string])[]) => string,
): void {
  say(`LEGACY SUBSTATE RECOVERY  ${rows.length} task(s)`);
  if (rows.length > 0) {
    say(
      table([
        ["  workstream", "task", "from -> to  (source)"],
        ...rows.map(
          (r) => [`  ${r.workstream}`, r.localId, `${r.from} -> ${r.to}  (${r.source})`] as const,
        ),
      ]),
    );
  }
  const unblocked = rows.flatMap((r) => r.unblocked);
  say("unblocked by recovery:");
  say(unblocked.length > 0 ? unblocked.map((k) => `  ${k}`).join("\n") : "  (none)");
}
