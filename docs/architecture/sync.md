# Sync

Machines share a workstream by exchanging ops through a shared folder
(`MU_SYNC_DIR`) kept in step by any folder syncer, such as Syncthing. The ops
themselves are described in [ops-log.md](ops-log.md). Overview:
[ARCHITECTURE.md](../ARCHITECTURE.md). Why segments and not
Litestream, cr-sqlite or a peer list, and why the DB must never sit in
`MU_SYNC_DIR`:
[ROADMAP § Rejected sync substrates](../ROADMAP.md#rejected-sync-substrates).

## Segments

`src/segments.ts` is the transport.

- `flushSegment` appends this machine's unflushed ops to
  `<MU_SYNC_DIR>/<machine_id>.jsonl`.
- `ingestSegment` reads a peer segment from its watermark into
  `applyOp`. Ambient ingest skips a peer that is caught up: the manifest
  counts the watermark, the size matches, the segment is not newer than
  its manifest, and the last line decodes to the manifest's `lastHlc`.
  A rewrite after the manifest fails that check, so the full read hashes
  the file and reports the mismatch. `mu sync` always reads every line.
- Peer discovery is implicit: every non-self `*.jsonl` is a peer. A
  peer disappears only when its segment is deleted.
- A Syncthing conflict copy (`<machine>.sync-conflict-….jsonl`) is
  ingested too, with its own watermark keyed by the file stem: it can
  diverge from the original, so line counts are not comparable.

**Single writer per file.** A machine appends only to its own segment,
so nothing is contended and any folder syncer is adequate. Segments
are regenerable, so there is no fsync. `src/file-lock.ts` stops two
local `mu` processes from interleaving partial lines. A flush never
appends without that lock: if another process still holds it after
2 s (15 s for `mu sync`), the flush writes nothing, the ops stay
pending in `ops`, and the next invocation appends them. A stale lock
(holder crashed, older than 30 s) is broken as before.

**Only `SYNCED_ENTITIES` and only this machine's ops are flushed.**
Pane ids and absolute paths never leave the machine, and peers never
echo each other's history.

**Payload encoding.** `ops.payload` is TEXT that is usually JSON, but
`mu log "text"` writes prose. The encoder passes valid JSON through
verbatim, so the crc covers those exact bytes, and JSON-encodes
anything else, unwrapping on ingest.

## Robustness layers

The first three checks stop ingest at the first bad record and advance
the watermark only that far. The fourth is whole-file: it reports the
defect without halting, because every line still present is valid, and
only a fresh copy of the file clears it:

| Layer | Catches |
| --- | --- |
| `JSON.parse` | a torn write (line lacks its trailing `,"crc"…}` framing) or a malformed shape (framing present). Same failure, different remediation: a cut transfer vs a writer bug |
| crc32 per line | bit rot |
| monotonic HLC | reorder, duplicate, truncation |
| `.manifest` sidecar | truncation exactly on a line boundary |

**Damage halts; refusal skips.** Halting is right for damage, where a
gap looks the same as reordering. It is wrong for a well-formed line
mu declines to project: a refusal leaves no hole, and halting would
freeze the peer's watermark for good, since `mu sync --repair` only
resets the watermark and re-reads into the same line. Ingest
distinguishes three cases:

| Line | Result |
| --- | --- |
| damaged (including a blank line) | halt |
| a known machine-local entity | reported defect, skipped |
| a historical log-only intent (`workstream.export` prose from mu < 1.1) | skipped silently, as flush and `--from` skip it |
| an unrecognised entity | applied as a no-op, no defect (a reader behind the writer is normal in a mixed fleet) |

`mu sync` suggests `--repair` only for defects a re-read can clear.

**Sync never fails a command.** A truncated segment, a garbage segment,
a sync dir that is a file, or a vanished directory warns on stderr and
returns.

## The ambient hook

Sync is ambient, not a daemon: no watcher, no background process, no
poll outliving a command. It happens because you already run `mu`
constantly.

The seam is `handle()` (`src/cli/handle.ts`), which every verb passes
through and which is already async. It awaits `ambientIngest` and
`ambientFlush`; the flush is async because it takes the file lock,
while most verb bodies are synchronous
better-sqlite3 code. One `await` before `fn(db)` and one after cover
every verb.

- **Ingest before the body**, so the verb reads the freshest state.
- **Flush after the body**, so this invocation's ops reach the segment
  now.
- **Flush on the error path too.** A verb may commit ops before
  throwing. Those ops are canonical, so withholding them would make
  this machine's history depend on the exit code.

`src/sync.ts` holds `ambientIngest`, `ambientFlush`, `ambientSyncPass`,
`peerStatuses`, `ingestFromDb` (`mu sync --from <path>`) and
`repairPeer` (`mu sync --repair <peer>`, a unique prefix; ambiguity is
exit 4). A prefix names a machine, so it resets the watermark of the
peer's segment and of every conflict copy of it.

### Carve-outs

| Surface | Behaviour | Why |
| --- | --- | --- |
| `MU_SYNC_DIR` unset | one `if` on one env var; no filesystem touch | the single-machine case pays nothing (measured: baseline; about 3ms with one peer) |
| `mu sql` | opts out (`handle(..., { ambientSync: false })`) | an ingest changing a row count mid-inspection reads as a mu bug |
| `mu sync` | opts out and runs the pass itself | otherwise the report prints "ingested 0" right after ingesting |
| the TUI | slow tick only (10s), one pass per beat across tabs, `quiet: true` | the fast tick can go to 100ms; the TUI owns the screen, so problems show on the Doctor card |

## Out-of-order arrival

An `edge` or `note` put whose task has not arrived yet skips as
`absent`, correctly. Ingest still advances the watermark past it, so
without a second pass it would never land. Peers are discovered by
`localeCompare` over random-UUID filenames, so the arrival order is a
coin flip per fleet.

`reprojectDeferredOps` (`src/apply.ts`) re-queries the log for note and
edge puts that are resolvable now but unprojected. It skips ops whose
parent task is gone and keys with a newer `del`, so a deleted edge is
never resurrected and an orphan is not retried forever. It runs once
per ingest pass, not per peer, because an edge in one segment may name
a task in another. Ambient ingest runs it only while SQLite's
`user_version` is 1. An ingest that applies ops sets that marker in the
same transaction, and the repair clears it. A process that dies between
the two leaves the marker set, so the next invocation runs the repair.
`mu sync` and `--from` always run it.

There is no retry queue. A queue would be a second source of truth and
would not survive a short-lived `mu` process when the parent arrives
days later.

## Mixed-fleet hazards

`src/fleet-hazards.ts` adds three checks to the default `mu doctor`,
all no-ops when `MU_SYNC_DIR` is unset:

| Check | Severity |
| --- | --- |
| `MU_DB_PATH` inside `MU_SYNC_DIR` | fail |
| DB on a network mount | warn |
| two workstream names differing only by case | warn |
