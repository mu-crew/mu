// A task spawn of w1 for t1 on host `box` (built mu, the test's DB: argv[2]) that
// pauses at the first read of its job record once its job.start effect is left
// unknown (between the start's rejection and the spawn's catch), until the file
// `<argv[3]>.go` exists. `argv[3]` is written when it pauses: the barrier a
// concurrent `mu agent check` runs inside.
import { existsSync, writeFileSync } from "node:fs";
import { openDb, setMuxForTests, spawnForTask, tmuxBackend } from "../dist/index.js";

const db = openDb({ path: process.argv[2] });
const marker = process.argv[3];
const prepare = db.prepare.bind(db);
let paused = false;
db.prepare = (sql) => {
  const statement = prepare(sql);
  if (sql !== "SELECT * FROM carrier_jobs WHERE token = ?") return statement;
  const get = statement.get.bind(statement);
  statement.get = (...args) => {
    const row = get(...args);
    const effect = prepare("SELECT state FROM effects WHERE key = ?").get(args[0]);
    if (paused || !row?.first_msg_id || row.job !== null || effect?.state !== "unknown") return row;
    paused = true;
    writeFileSync(marker, String(args[0]));
    const until = Date.now() + 30_000;
    while (!existsSync(`${marker}.go`)) {
      if (Date.now() > until) throw new Error("barrier timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return get(...args);
  };
  return statement;
};
setMuxForTests({
  ...tmuxBackend,
  runsShellCommand: true,
  spawnAgentWaitsReady: false,
  anchorsPanes: false,
  ensureSession: async () => ({ created: false }),
  spawnAgent: async (o) => {
    o.onPaneCreated?.("%child");
    return "%child";
  },
  paneAlive: async () => true,
  paneResult: async () => ({ state: "running" }),
  capture: async () => "",
  listPanes: async () => [],
  killPane: async () => {},
});
try {
  const out = await spawnForTask(db, {
    spawn: { name: "w1", workstream: "ws", host: "box", cli: "claude" },
    task: "t1",
    text: "do the t1 work",
  });
  console.log(JSON.stringify({ state: out.state }));
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
