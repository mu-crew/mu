// mu — `mu db backup | compact | forget`: whole-DB file commands.
//
// mu once had `mu db export / import / replay` — a whole-DB sync
// mechanism with manifests, per-workstream drift detection, and
// divergence sidecars (1500+ LOC). All three are gone: sync is ambient over
// segments, and disaster recovery is `mu rebuild`.
//
// `backup` survives for the one case those verbs were actually used for
// — "give me one file I can scp" — which SQLite already implements as a
// single `VACUUM INTO`, so it has no SDK module. A backup file is a
// convenience copy that starts going stale the moment it is written.
//
// `compact` and `forget` shrink mu.db. Their policy lives in the SDK
// (src/compact.ts); this file adds the dry run, the backup beside the
// DB, the VACUUM, and the drift check after.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import { emitJson, handle, JSON_OPT } from "../cli.js";
import {
  compact,
  type ForgetPlan,
  forget,
  listForgetCandidates,
  planCompact,
  planForget,
} from "../compact.js";
import type { Db } from "../db.js";
import { formatBytes } from "../disk-recon.js";
import { checkDrift, DriftDetectedError } from "../drift.js";
import { muTable, pc, printNextSteps } from "../output.js";
import { UsageError } from "./handle.js";

export function cmdDbBackup(db: Db, file: string, opts: { json?: boolean } = {}): void {
  const target = resolve(file);
  // VACUUM INTO refuses an existing target itself, but its error is a
  // raw SQLite string; a typed UsageError gets the operator an exit code
  // and a next step instead.
  if (existsSync(target)) {
    throw new UsageError(`${target} already exists: mu db backup never overwrites`);
  }
  mkdirSync(dirname(target), { recursive: true });
  db.prepare("VACUUM INTO ?").run(target);

  const nextSteps = [
    {
      intent: "Inspect the copy without touching the live DB",
      command: `MU_DB_PATH=${target} mu state`,
    },
    { intent: "Disaster recovery is a rebuild, not a copy", command: "mu rebuild <file>" },
  ];
  if (opts.json === true) {
    emitJson({ path: target, nextSteps });
    return;
  }
  console.log(`Backed up to ${pc.bold(target)}`);
  printNextSteps(nextSteps);
}

/** Backup next to the DB, named so it sorts with it: `mu.db.pre-<verb>-<ts>`. */
function backupBeside(db: Db, verb: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${db.name}.pre-${verb}-${ts}`;
  db.prepare("VACUUM INTO ?").run(target);
  return target;
}

/** Reclaim the freed pages, then prove the log still explains the tables. */
function vacuumAndCheck(db: Db, backup: string): { before: number; after: number } {
  const before = statSync(db.name).size;
  db.exec("VACUUM");
  // WAL mode: VACUUM's rewritten pages sit in the -wal file until a
  // checkpoint, so without one the main file reports the old size.
  db.pragma("wal_checkpoint(TRUNCATE)");
  const after = statSync(db.name).size;
  const report = checkDrift(db);
  if (!report.clean) {
    console.error(
      pc.red(`drift after the rewrite (${report.totalDrift}); the backup is ${backup}`),
    );
    throw new DriftDetectedError(report.totalDrift, report.records);
  }
  return { before, after };
}

export function cmdDbCompact(db: Db, opts: { yes?: boolean; json?: boolean } = {}): void {
  const plan = planCompact(db);
  if (opts.yes !== true || plan.tombstones === 0) {
    const nextSteps =
      plan.tombstones === 0 ? [] : [{ intent: "Apply it", command: "mu db compact --yes" }];
    if (opts.json === true) {
      emitJson({ dryRun: true, ...plan, nextSteps });
      return;
    }
    console.log(
      plan.tombstones === 0
        ? pc.dim("nothing to compact: no redundant note tombstones")
        : `${plan.tombstones} note tombstones repeat a put already in the log (${formatBytes(plan.bytes)}). Dry run; nothing changed.`,
    );
    printNextSteps(nextSteps);
    return;
  }
  const backup = backupBeside(db, "compact");
  compact(db);
  const size = vacuumAndCheck(db, backup);
  if (opts.json === true) {
    emitJson({ dryRun: false, ...plan, backup, ...size });
    return;
  }
  console.log(
    `Compacted ${plan.tombstones} note tombstones: ${formatBytes(size.before)} → ${formatBytes(size.after)}. Drift check clean.`,
  );
  console.log(pc.dim(`backup: ${backup}`));
}

function printForgetTable(plan: ForgetPlan): void {
  const t = muTable({ head: ["workstream", "torn down", "ops", "size"].map((h) => pc.bold(h)) });
  for (const c of plan.candidates)
    t.push([c.name, c.tornDownAt.slice(0, 10), String(c.ops), formatBytes(c.bytes)]);
  console.log(t.toString());
}

export function cmdDbForget(
  db: Db,
  names: string[],
  opts: { yes?: boolean; json?: boolean } = {},
): void {
  const plan = planForget(db, names);
  if (plan.refused.length > 0) {
    const why = plan.refused
      .map((r) => `${r.name} (${r.why === "live" ? "is live" : "was never torn down"})`)
      .join(", ");
    throw new UsageError(`cannot forget: ${why}. Only torn-down workstreams can be forgotten.`);
  }
  const ops = plan.candidates.reduce((n, c) => n + c.ops, 0);
  const bytes = plan.candidates.reduce((n, c) => n + c.bytes, 0);
  if (opts.yes !== true) {
    const nextSteps = [
      { intent: "Forget them (NOT undoable)", command: `mu db forget ${names.join(" ")} --yes` },
    ];
    if (opts.json === true) {
      emitJson({ dryRun: true, candidates: plan.candidates, ops, bytes, nextSteps });
      return;
    }
    printForgetTable(plan);
    console.log(
      `${ops} ops (${formatBytes(bytes)} of payload). Forgetting deletes their history: mu undo can no longer restore these teardowns. Dry run; nothing changed.`,
    );
    printNextSteps(nextSteps);
    return;
  }
  const backup = backupBeside(db, "forget");
  const r = forget(db, plan);
  const size = vacuumAndCheck(db, backup);
  if (opts.json === true) {
    emitJson({
      dryRun: false,
      forgotten: plan.candidates.map((c) => c.name),
      ops: r.ops,
      backup,
      ...size,
    });
    return;
  }
  console.log(
    `Forgot ${plan.candidates.length} workstream(s), ${r.ops} ops: ${formatBytes(size.before)} → ${formatBytes(size.after)}. Drift check clean.`,
  );
  console.log(pc.dim(`backup (the only way back): ${backup}`));
}

/** Doctor's hint: the largest forgettable workstreams, or undefined when
 *  they are too small to be worth a line. */
export function forgetHint(
  db: Db,
): { total: number; ops: number; bytes: number; top: string[] } | undefined {
  const all = listForgetCandidates(db);
  const bytes = all.reduce((n, c) => n + c.bytes, 0);
  if (bytes < FORGET_HINT_MIN_BYTES) return undefined;
  return {
    total: all.length,
    ops: all.reduce((n, c) => n + c.ops, 0),
    bytes,
    top: all.slice(0, 3).map((c) => c.name),
  };
}

/** Below this much torn-down history, doctor says nothing. */
const FORGET_HINT_MIN_BYTES = 5 * 1024 * 1024;

export function wireDbCommands(program: Command): void {
  const dbCmd = program.command("db").description("Whole-DB file commands");
  dbCmd
    .command("backup <file>")
    .description(
      "VACUUM INTO copy of the whole DB — the 'one file I can scp' convenience. Never overwrites. Real disaster recovery is `mu rebuild`.",
    )
    .option(...JSON_OPT)
    .action(function (file: string) {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle(async (db) => cmdDbBackup(db, file, opts), this as Command)();
    });
  dbCmd
    .command("compact")
    .description(
      "Shrink mu.db: blank note tombstones that repeat a put already in the log, then VACUUM. Dry run without --yes; --yes backs up beside the DB first and runs the drift check after. Local only; sync segments are untouched.",
    )
    .option("--yes", "apply (default: dry run)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { yes?: boolean; json?: boolean };
      return handle(async (db) => cmdDbCompact(db, opts), this as Command)();
    });
  dbCmd
    .command("forget <workstreams...>")
    .description(
      "Delete every op of torn-down workstreams to shrink mu.db. NOT undoable: mu undo can no longer restore them. Dry run without --yes; --yes backs up beside the DB first, VACUUMs, and runs the drift check. List candidates: mu workstream list --torn-down.",
    )
    .option("--yes", "apply (default: dry run)")
    .option(...JSON_OPT)
    .action(function (names: string[]) {
      const opts = (this as Command).opts() as { yes?: boolean; json?: boolean };
      return handle(async (db) => cmdDbForget(db, names, opts), this as Command)();
    });
}
