// mu — `mu sync`: a PEER STATUS REPORT (who are my peers, how far behind
// am I, when did I last hear from them). Every mu invocation already
// flushes and ingests via the ambient hook in src/cli/handle.ts, so the
// verb adds only the report, plus two flags nothing else can express:
//
//   --from <path>    a different reader: a peer's `mu.db` ops table via
//                    SQLite rather than a JSONL segment (sshfs mount or a
//                    copied file).
//   --repair <peer>  reset that peer's watermark and re-read its segment
//                    from zero. Safe: ingest is idempotent via
//                    UNIQUE (machine_id, hlc).
//
// No `--push` / `--pull`: mu reads and writes files; the operator owns
// transport (a standing ROADMAP pledge). A one-off directory needs no flag:
// `MU_SYNC_DIR=/mnt/usb mu state`.
//
// The verb opts OUT of the ambient hook (`ambientSync: false`) and runs the
// pass itself, for honest counts: a hook pass first would consume everything
// and the report would print "ingested 0" right after doing the opposite.

import { emitJson, handle, JSON_OPT } from "../cli.js";
import type { Db } from "../db.js";
import { muTable, pc } from "../output.js";
import { type IngestResult, syncDir, syncPass } from "../segments.js";
import {
  foreignVersionMessage,
  type IngestFromDbResult,
  ingestFromDb,
  type PeerStatus,
  peerStatuses,
  repairPeer,
} from "../sync.js";
import { relTime } from "./format.js";
import { UsageError } from "./handle.js";

export interface SyncCmdOptions {
  json?: boolean;
  from?: string;
  repair?: string;
}

/** Relative time, or a marker when transport never delivered anything. */
function lastSeen(peer: PeerStatus): string {
  if (peer.ageMs === null) return "—";
  return `${relTime(peer.ageMs)} ago`;
}

/** Peer advice in prose (stale transport, a damaged segment): the data is in `peers`. */
function peerAdvice(peers: readonly PeerStatus[]): string[] {
  const out: string[] = [];
  const stale = peers.filter((p) => p.stale).length;
  if (stale > 0) {
    out.push(
      `${stale} stale peer${stale === 1 ? "" : "s"}: move their segments in (Syncthing, rsync, a USB stick)`,
    );
  }
  const damaged = peers.find((p) => p.behind > 0);
  if (damaged !== undefined) {
    out.push(`re-read a damaged segment from zero: mu sync --repair ${damaged.short}`);
  }
  return out;
}

function renderPeerTable(peers: readonly PeerStatus[]): string {
  if (peers.length === 0) {
    return pc.dim("  (no peers yet — drop another machine's segment in the sync dir)");
  }
  const table = muTable({
    head: [pc.bold("machine"), pc.bold("last seen"), pc.bold("behind"), pc.bold("")],
  });
  for (const peer of peers) {
    const flags: string[] = [];
    if (peer.stale) flags.push(pc.yellow("← stale"));
    if (peer.conflictCopy) flags.push(pc.dim("(conflict copy)"));
    table.push([peer.short, lastSeen(peer), String(peer.behind), flags.join(" ")]);
  }
  return table.toString();
}

/** "ingested 22 from 2 peers", or the honest nothing-happened form. */
function describeIngest(results: readonly IngestResult[]): string {
  const total = results.reduce((sum, r) => sum + r.applied, 0);
  const from = results.filter((r) => r.applied > 0).length;
  if (total === 0) return "ingested 0";
  return `ingested ${total} from ${from} peer${from === 1 ? "" : "s"}`;
}

export async function cmdSync(db: Db, opts: SyncCmdOptions = {}): Promise<void> {
  const dir = syncDir();

  // `--from <path>` is the one shape that works with sync unconfigured:
  // it names its source outright, so there is no dir to need.
  if (opts.from !== undefined) {
    const result = ingestFromDb(db, opts.from);
    // Flush afterwards, as a normal pass does.
    const flushed = dir === null ? null : await syncPass(db, dir);
    emitFrom(db, result, flushed?.flushed.appended ?? 0, dir, opts);
    return;
  }

  if (dir === null) {
    // A repair has no peer to reset: a success here would read as done.
    if (opts.repair !== undefined) {
      throw new UsageError("--repair needs a sync dir: set MU_SYNC_DIR to the shared folder", {
        showHelp: false,
      });
    }
    if (opts.json === true) {
      emitJson({
        syncDir: null,
        enabled: false,
        flushed: 0,
        ingested: [],
        peers: [],
      });
      return;
    }
    console.log(
      pc.dim(
        "sync is off: export MU_SYNC_DIR=<folder> on every machine, then share that folder (Syncthing, rsync, a USB stick)",
      ),
    );
    return;
  }

  // `--repair` is just "reset the watermark"; the pass below then
  // re-reads that peer's segment from zero. Resolved BEFORE the pass so a
  // bad ref errors without half-doing anything.
  const repaired = opts.repair === undefined ? null : repairPeer(db, opts.repair, dir);

  const pass = await syncPass(db, dir);
  const peers = peerStatuses(db, dir);
  if (pass.flushed.lockBusy === true && opts.json !== true) {
    process.stderr.write(
      "mu: sync: own segment is locked by another mu process; local ops stay pending and the next flush appends them\n",
    );
  }

  if (opts.json === true) {
    emitJson({
      syncDir: dir,
      enabled: true,
      repaired: repaired === null ? null : repaired.machineId,
      flushed: pass.flushed.appended,
      skippedLocal: pass.flushed.skippedLocal,
      selfRepaired: pass.flushed.selfRepaired,
      lockBusy: pass.flushed.lockBusy === true,
      foreignVersionAt: pass.flushed.foreignVersionAt,
      foreignVersion: pass.flushed.foreignVersion,
      ingested: pass.ingested.map((r) => ({
        machineId: r.machineId,
        applied: r.applied,
        changed: r.changed,
        watermark: r.watermark,
        defects: r.defects,
      })),
      peers,
    });
    return;
  }

  if (repaired !== null) {
    console.log(pc.dim(`repaired ${repaired.short}: watermark reset, re-reading from zero`));
  }
  if (pass.flushed.selfRepaired !== null) {
    const d = pass.flushed.selfRepaired;
    console.log(
      pc.yellow(
        `  own segment was defective past line ${d.line} (${d.kind}: ${d.detail}) — truncated to the last good line and regenerated from the ops table`,
      ),
    );
  }
  if (pass.flushed.foreignVersionAt !== null) {
    console.log(pc.yellow(`  ${foreignVersionMessage(pass.flushed)}`));
  }
  console.log(`flushed ${pass.flushed.appended} ops · ${describeIngest(pass.ingested)}`);
  console.log(renderPeerTable(peers));
  for (const result of pass.ingested) {
    for (const defect of result.defects) {
      console.log(
        pc.yellow(
          `  ${result.machineId.slice(0, 8)}: ${defect.kind} at line ${defect.line} — ${defect.detail}`,
        ),
      );
    }
  }
  for (const line of peerAdvice(peers)) console.log(pc.dim(line));
}

function emitFrom(
  db: Db,
  result: IngestFromDbResult,
  flushed: number,
  dir: string | null,
  opts: SyncCmdOptions,
): void {
  const peers = dir === null ? [] : peerStatuses(db, dir);
  if (opts.json === true) {
    emitJson({
      from: result.path,
      read: result.read,
      changed: result.changed,
      skippedLocal: result.skippedLocal,
      flushed,
      peers,
    });
    return;
  }
  console.log(
    `read ${result.read} ops from ${pc.bold(result.path)} · ${result.changed} changed rows`,
  );
  if (result.skippedLocal > 0) {
    console.log(pc.dim(`  skipped ${result.skippedLocal} machine-local ops (they never travel)`));
  }
}

// ─── commander wiring ────────────────────────────────────────────────

import { type Command, Option } from "commander";

export function wireSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Report peer status (flush + ingest happen on every mu invocation anyway)")
    .option(...JSON_OPT)
    .option("--from <path>", "ingest from a peer's mu.db directly (sshfs mount or copied file)")
    // --from returns before a repair would run: together, one is dropped.
    .addOption(
      new Option(
        "--repair <peer>",
        "reset that peer's watermark and re-read its segment from zero",
      ).conflicts("from"),
    )
    .action(function () {
      const opts = (this as Command).opts() as SyncCmdOptions;
      // ambientSync: false — this verb IS the pass, and running it twice
      // would print "ingested 0" for work the hook had just done.
      return handle((db) => cmdSync(db, opts), this as Command, { ambientSync: false })();
    });
}
