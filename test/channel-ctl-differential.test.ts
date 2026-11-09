// The P4 differential (review of P4, ruling 2): a ctl agent's state reading,
// the probes it makes, and CLOSE eligibility, frozen as they were at
// b577dfd8, before the channel registry. 72 ctl cases: backend (tmux,
// herdr, Rex) × job kind (pane, lease) × socket (answers, missing, refuses)
// × pane (running, ended, absent, cannot tell); each read with and without
// the job listed, plus the job kind's own liveness. Then 12 CLOSE cases: cli
// (pi, another key, claude) × recorded channel (ctl, hooks, mux, none).
// `test/fixtures/p4-ctl-differential.json` is the output at b577dfd8; set
// P4_DIFF_WRITE=<path> to write this tree's output instead.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import { insertAgent } from "../src/agents.js";
import { readAgentStates } from "../src/channels/index.js";
import { applySettledClose } from "../src/close-block.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { openDb } from "../src/db.js";
import { jobLiveness } from "../src/jobs/kinds.js";
import { type MuxBackend, setMuxForTests, tmuxBackend } from "../src/mux.js";
import { addTask, claimTask, getTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "p4-ctl-differential.json",
);

afterEach(() => {
  resetTmuxExecutor();
  setMuxForTests(undefined);
  setMurmurRunnerForTests(null);
  resetAgentStateCacheForTests();
});

it("ctl readings, their probes and CLOSE eligibility are exactly b577dfd8's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p4d-"));
  const db = openDb({ path: join(dir, "mu.db") });
  const out: unknown[] = [];
  try {
    const a = insertAgent(db, {
      name: "a",
      workstream: "w",
      paneId: "%1",
      cli: "pi",
      channel: "ctl",
      host: "box",
      hostTransport: "lease",
    });
    const socket = ctlSocketPath("w", "a", dir);
    mkdirSync(dirname(socket), { recursive: true });
    setMurmurRunnerForTests(async () => null);
    for (const backend of ["tmux", "herdr", "rex"] as const)
      for (const kind of ["pane", "lease"] as const)
        for (const ctl of ["ok", "missing", "refused"] as const)
          for (const pane of ["running", "ended", "absent", "unknown"] as const) {
            const calls: string[] = [];
            const cannotTell = (): void => {
              if (pane === "unknown") throw new Error("cannot tell");
            };
            const mux: MuxBackend = {
              ...tmuxBackend,
              name: backend,
              paneAlive: async () => {
                calls.push("present");
                cannotTell();
                return pane !== "absent";
              },
              paneResult: async () => {
                calls.push("result");
                cannotTell();
                return pane === "ended"
                  ? { state: "exited", code: 0, signal: null }
                  : pane === "absent"
                    ? { state: "absent" }
                    : { state: "running" };
              },
              ...(backend === "tmux"
                ? { paneStatus: undefined }
                : {
                    paneStatus: async () => {
                      calls.push("status");
                      cannotTell();
                      return pane === "running" ? ("busy" as const) : undefined;
                    },
                  }),
            };
            setMuxForTests(mux);
            setTmuxExecutor(async (args) => {
              calls.push(args[0] ?? "?");
              cannotTell();
              return {
                stdout: pane === "absent" ? "" : "%1\tworking\t1\n",
                stderr: "",
                exitCode: 0,
              };
            });
            resetAgentStateCacheForTests();
            let server: Server | undefined;
            if (ctl !== "missing") {
              server = createServer((sock) => {
                sock.on("error", () => {});
                const dec = new LineDecoder();
                sock.setEncoding("utf8");
                sock.on("data", (chunk: string) => {
                  for (const _line of dec.push(chunk)) {
                    sock.end(
                      encode(
                        ctl === "ok"
                          ? {
                              v: 1,
                              ok: true,
                              state: "busy",
                              since: 1,
                              runs: 3,
                              pending: false,
                              incarnation: "inc",
                            }
                          : { v: 1, ok: false, error: "no" },
                      ),
                    );
                  }
                });
              });
              const s = server;
              await new Promise<void>((resolve) => s.listen(socket, resolve));
            }
            const job = {
              kind,
              viewPaneId: "%1",
              agentId: a.incarnation,
              agent: { workstream: "w", name: "a" },
              host: { name: "box" },
            };
            const withoutJob = (await readAgentStates([a], { stateDir: dir })).get("w/a");
            const withJob = (await readAgentStates([{ ...a, job }], { stateDir: dir })).get("w/a");
            const liveness = await jobLiveness(db, job);
            out.push({ backend, kind, ctl, pane, withoutJob, withJob, liveness, calls });
            const s = server;
            if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
            rmSync(socket, { force: true });
          }
    for (const cli of ["pi", "other", "claude"])
      for (const channel of ["ctl", "hooks", "mux", null] as const) {
        const name = `${cli}-${channel ?? "null"}`;
        const agent = insertAgent(db, { name, workstream: "w", paneId: "%2", cli, channel });
        const task = `t-${name}`;
        addTask(db, { localId: task, workstream: "w", title: task, impact: 50, effortDays: 1 });
        await claimTask(db, task, { workstream: "w", agentName: name });
        const result = applySettledClose(db, {
          workstream: "w",
          agent: name,
          agentId: agent.incarnation,
          incarnation: "inc",
          runs: 1,
          settled: true,
          lastText: `CLOSE: task=${task} evidence="review reproduction"\nREPORT:\ndone`,
        });
        out.push({ close: { cli, channel, result, status: getTask(db, task, "w")?.status } });
      }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const got: unknown = JSON.parse(JSON.stringify(out));
  const write = process.env.P4_DIFF_WRITE;
  if (write !== undefined && write !== "") writeFileSync(write, JSON.stringify(got, null, 2));
  expect(out).toHaveLength(84);
  expect(got).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
});
