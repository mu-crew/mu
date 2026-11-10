// A task spawn of w1 for t1 on host `box`, in its own process, that hangs once its
// view reported a pane (the mux stub never completes it): the crash point the
// first-turn crash tests SIGKILL at. Built mu (dist/), the test's DB: argv[2].
import { openDb, setMuxForTests, spawnForTask, tmuxBackend } from "../dist/index.js";

setInterval(() => {}, 1000);
const db = openDb({ path: process.argv[2] });
setMuxForTests({
  ...tmuxBackend,
  runsShellCommand: true,
  spawnAgentWaitsReady: false,
  anchorsPanes: false,
  ensureSession: async () => ({ created: false }),
  spawnAgent: async (o) => {
    o.onPaneCreated?.("%1");
    return new Promise(() => {});
  },
  paneAlive: async () => true,
  paneResult: async () => ({ state: "running" }),
  capture: async () => "",
  listPanes: async () => [],
  killPane: async () => {},
});
await spawnForTask(db, {
  spawn: { name: "w1", workstream: "ws", host: "box", cli: "claude" },
  task: "t1",
  text: process.argv[3] ?? "do the t1 work",
});
