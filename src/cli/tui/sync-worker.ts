// worker_thread entry for the TUI's ambient sync pass (built to
// dist/tui-sync-worker.js). ingest and flush are synchronous SQLite and
// file work (seconds on a first read, hundreds of ms per peer append on
// a 40 MB segment), so on ink's thread they froze input and repaints.
// Here they block only this thread. The worker owns its own connection
// to the same DB file: WAL serves the TUI's reads meanwhile, and the
// TUI sees the result on its next read.
//
// Protocol: the parent posts any message to start one pass, and the
// worker replies with the pass's result (`null` if it threw) when the
// pass is over. ambientSyncPass is total, and `quiet` keeps stderr off
// the alternate screen.

import { parentPort, workerData } from "node:worker_threads";
import { openDb } from "../../db.js";
import { ambientSyncPass } from "../../sync.js";

const port = parentPort;
if (port === null) throw new Error("tui-sync-worker must run as a worker_thread");
const db = openDb({ path: (workerData as { dbPath: string }).dbPath });
port.on("message", () => {
  void ambientSyncPass(db, { quiet: true })
    .catch(() => null)
    .then((result) => port.postMessage(result));
});
