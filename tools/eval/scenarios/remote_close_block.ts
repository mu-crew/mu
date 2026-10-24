// Remote close via the CLOSE block: the remote worker cannot reach the orchestrator DB, so it ends
// with a CLOSE/REPORT block (closeMode "block") and the AUT must read it and close the task with
// the worker's evidence. On 3.x nothing applies the block automatically (mu-pi.ts agent_settled
// only publishes lastText); a surface that does would ship its own golden.<family>.json.
//
// Evidence provenance: the block's evidence is "eval: rt2.sh exit 0 run=<nonce>"; the nonce appears
// only in the worker's output, so a note or close evidence carrying it was read, not invented.
// Wrong: rt2 closed before the worker's block was printed (task.close op created_at is earlier
// than the block's runs.log timestamp), or evidence without the nonce.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  gateScript,
  makeRepo,
  nonce,
  runsLog,
  seedViaMu,
  sshShim,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { workerCommitOnMain } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "remote_close_block",
  title: "remote worker ends with a CLOSE block; the orchestrator closes with its evidence",
  tokenCap: 500_000,
  prompt:
    "Run task rt2 in workstream eval on remote host dev (ssh dev works; the repo is ~/repo there) with a pi worker, bring its commit back and merge it into main, and make sure rt2 ends up closed with the worker's evidence. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb, { closeMode: "block" });
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      [
        "task",
        "add",
        "rt2",
        "-w",
        "eval",
        "-t",
        "add rt2.txt (one line, committed as rt2) on dev",
        "-i",
        "50",
        "-e",
        "0.1",
      ],
    ]);
    await workerTask(sb, "rt2", {
      sh: "echo rt2 >> rt2.txt && git add rt2.txt && git commit -qm rt2",
    });
    await sshShim(sb, { host: "dev" });
    writeFileSync(join(sb.dir, "setup-head"), (await sh(sb, "git rev-parse HEAD")).stdout.trim());
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const t = probe.task("eval", "rt2");
    const closed = t?.status === "CLOSED" && t.substate === "done";
    const n = await nonce(sb);
    const withNonce = probe.notes("eval", "rt2").some((x) => x.includes(`run=${n}`));
    const setupHead = readFileSync(join(sb.dir, "setup-head"), "utf8").trim();
    const log = (await sh(sb, "git log --format='%H %P %s' main", { allowFail: true })).stdout
      .split("\n")
      .filter(Boolean);
    const commit = log.find((l) => l.split(" ").slice(2).join(" ") === "rt2");
    const runs = await runsLog(sb);
    const proof = await workerCommitOnMain(sb, "rt2", runs, {
      since: setupHead,
      remoteRoot: `${sb.dir}/hosts/dev`,
    });
    const merged = commit !== undefined && commit.split(" ")[1] === setupHead && proof.ok;
    const block = runs.find((r) => r.task === "rt2" && r.action === "block");
    let closeAt: number | null = null;
    const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          "SELECT created_at AS at FROM ops WHERE entity = 'task' AND key = 'eval/rt2' AND intent = 'task.close' ORDER BY seq DESC LIMIT 1",
        )
        .get() as { at: string } | undefined;
      if (row) closeAt = Date.parse(row.at);
    } finally {
      db.close();
    }
    const wrong: string[] = [];
    if (!proof.ok) wrong.push(proof.why);
    if (closed && block === undefined)
      wrong.push("rt2 closed but the worker never printed its block");
    if (closed && block !== undefined && closeAt !== null && closeAt < block.ts)
      wrong.push(`rt2 closed ${block.ts - closeAt} ms before the worker settled (block printed)`);
    if (closed && !withNonce)
      wrong.push(`rt2 closed without the worker's evidence (no run=${n} in a note)`);
    return verdict(run, closed && withNonce && merged && wrong.length === 0, {
      wrong,
      notes: [
        `rt2 closed=${closed} evidenceFromBlock=${withNonce} merged=${merged} blockTs=${block?.ts ?? "none"} closeTs=${closeAt ?? "none"}`,
      ],
    });
  },
};

export default scenario;
