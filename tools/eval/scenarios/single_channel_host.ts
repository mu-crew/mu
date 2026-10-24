// Single-channel host: dev allows exactly one ssh session at a time (sshd MaxSessions 1 as the
// shim models it). An attached agent pane holds that session, so a bare `git fetch ssh://dev/...`
// is REFUSED while it is open. The golden runs the agent in detached remote tmux, attaches a pane
// to look, and closes the pane before fetching.
//
// Metrics (notes): REFUSED lines in sessionsLog (channel collisions) and whether a fetch was
// refused. Wrong: each REFUSED line. Completion: s1 and s2 CLOSED done and both commits on main.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  delegateAnswerFor,
  delegateDelay,
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  sshShim,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, orderWrong, runMoment, workerCommitOnMain } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "single_channel_host",
  title: "two tasks in sequence on a host that allows one ssh session at a time",
  tokenCap: 500_000,
  prompt:
    "Host dev allows exactly one ssh session at a time (ssh dev works; the repo is ~/repo there). Run s1 then s2 in workstream eval on dev with a pi worker and merge both commits into main here. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb, { closeMode: "none" });
    // A refuter the AUT may dispatch: a keyed, evidenced answer after a believable wait (not 0 s).
    await delegateDelay(sb, 4);
    await delegateAnswerFor(
      sb,
      "s1",
      `VERDICT: CONFIRMED\nEVIDENCE: task s1 reads "add s1.txt (one line, committed as s1) on dev"; the brief matches that title; gate.sh passes on main (gate ok); nothing contradicts the claim`,
    );
    await delegateAnswerFor(
      sb,
      "s2",
      `VERDICT: CONFIRMED\nEVIDENCE: task s2 reads "add s2.txt (one line, committed as s2) on dev"; the brief matches that title; gate.sh passes on main (gate ok); nothing contradicts the claim`,
    );
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      [
        "task",
        "add",
        "s1",
        "-w",
        "eval",
        "-t",
        "add s1.txt (one line, committed as s1) on dev",
        "-i",
        "50",
        "-e",
        "0.1",
      ],
      [
        "task",
        "add",
        "s2",
        "-w",
        "eval",
        "-t",
        "add s2.txt (one line, committed as s2) on dev",
        "-i",
        "50",
        "-e",
        "0.1",
        "-b",
        "s1",
      ],
    ]);
    for (const id of ["s1", "s2"]) {
      await workerTask(sb, id, {
        sh: `echo ${id} >> ${id}.txt && git add ${id}.txt && git commit -qm ${id}`,
      });
    }
    await sshShim(sb, { host: "dev", maxSessions: 1 });
    writeFileSync(join(sb.dir, "setup-head"), (await sh(sb, "git rev-parse HEAD")).stdout.trim());
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const closed = (id: string): boolean => {
      const t = probe.task("eval", id);
      return t?.status === "CLOSED" && t.substate === "done";
    };
    const subjects = (await sh(sb, "git log --format=%s main", { allowFail: true })).stdout
      .split("\n")
      .filter(Boolean);
    const runs = await runsLog(sb);
    const hostRoot = join(sb.dir, "hosts", "dev");
    const setupHead = readFileSync(join(sb.dir, "setup-head"), "utf8").trim();
    // Each of s1, s2 was done by a worker on dev, and main holds that worker's commit.
    const provenance: string[] = [];
    const doneRun = (id: string) => runs.find((r) => r.task === id && r.action === "done");
    for (const id of ["s1", "s2"]) {
      const proof = await workerCommitOnMain(sb, id, runs, {
        since: setupHead,
        remoteRoot: hostRoot,
      });
      if (!doneRun(id)) provenance.push(`${id} has no remote worker run (not done on dev)`);
      if (!proof.ok) provenance.push(proof.why);
      // the AUT closes after the worker finished
      const dr = doneRun(id);
      provenance.push(
        ...orderWrong(dr ? runMoment(dr) : null, closeMoment(sb, "eval", id), `${id} close`),
      );
    }
    const s1Run = doneRun("s1");
    const s2Run = doneRun("s2");
    provenance.push(
      ...orderWrong(
        s1Run ? runMoment(s1Run) : null,
        s2Run ? runMoment(s2Run) : null,
        "s1 must run before s2",
      ),
    );
    const merged = ["s1", "s2"].filter((id) => subjects.includes(id));
    const sessions = readFileSync(join(sb.dir, "hosts", "dev", "sessions.log"), "utf8")
      .split("\n")
      .filter(Boolean);
    const refused = sessions.filter((l) => / REFUSED /.test(l));
    const fetchRefused = refused.filter((l) => /git-upload-pack/.test(l)).length;
    const wrong = [
      ...refused.map((l) => `ssh session refused on the one-channel host: ${l.slice(0, 100)}`),
      ...provenance,
    ];
    const ok = closed("s1") && closed("s2") && merged.length === 2 && provenance.length === 0;
    return verdict(run, ok, {
      wrong,
      notes: [
        `s1 closed=${closed("s1")} s2 closed=${closed("s2")} merged=${merged.join(",") || "none"} REFUSED=${refused.length} fetchRefused=${fetchRefused}`,
      ],
    });
  },
};

export default scenario;
