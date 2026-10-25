// A long non-pi gate runs in a pane on a host that allows ONE ssh session at a time, and the
// orchestrator must wait for it (not hold an exec, not open a second session) before it runs a
// worker on that host and merges.
//
// Fixture: host dev (sshShim, maxSessions 1). `remote-gate` (in dev's PATH) runs 6s, writes
// ~/gate-result.txt ("GATE-<nonce> exit 0") on dev and exits; its pane holds dev's only session
// while it runs. g1 is a worker task done on dev by a pi worker (no self-close: the AUT closes it).
//
// Judged from the shim's sessions.log (open, REFUSED, END per session), the host's files, the DB,
// runs.log and the sandbox's mu-call record, never from how a wait or an ssh was spelled:
//  - no REFUSED session (channel accounting: nothing opened a session while the gate held it);
//  - the gate really ran (gate-result.txt on dev, a remote-gate session in sessions.log) and
//    gate-report.txt carries exactly its nonce line, written after the gate finished;
//  - a mu call that BLOCKED (any verb) and returned when the gate pane ended (its call window
//    contains gate-result.txt's write, and it did not report a timeout) observed the gate's end; a
//    long call that did not block in mu (a sleep) stands in for nothing;
//  - g1 ran once in a worker on dev, its commit is on main as that worker's commit, and the AUT
//    closed g1 after the worker's run;
//  - the remote-gate session came from the pane of the mu agent named gate (sessions.log records
//    the opener's TMUX_PANE, the DB the agent's pane), never from an AUT tool call; and no session
//    opened by an AUT tool call (no pane) stayed open longer than 5s (the gate runs 6s: a long exec
//    is the pane's job).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateScript,
  hostProfile,
  makeRepo,
  nonce,
  runsLog,
  sandboxFamily,
  seedViaMu,
  sshShim,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { prodWrong, waitWindows } from "../lifecycle.ts";
import {
  endedByEvent,
  idleCalls,
  muOut,
  sessions as parseSessions,
  timedOut,
  verdictFx,
} from "../observe.ts";
import { openProbe } from "../probe.ts";
import {
  closeMoment,
  fileMoment,
  orderWrong,
  runMoment,
  workerCommitOnMain,
} from "../provenance.ts";
import { sh } from "../sandbox.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "wait_remote_gate",
  title: "wait for a long pane command on a one-session host, then run and merge a worker there",
  tokenCap: 500_000,
  timeoutMs: 600_000,
  prompt:
    'Host dev allows exactly one ssh session at a time (ssh dev works; the repo is ~/repo there). Two jobs on dev: (1) `remote-gate` is a long non-pi check (about 10s, it ends by itself and leaves its one-line result in ~/gate-result.txt on dev). Run it in a mu pane named gate, e.g. `mu agent spawn gate -w eval --command "ssh dev -t remote-gate" --no-ctl` (a non-pi pane: its end shows as the pane dying), and do not run anything else on dev while it runs. (2) Do task g1 (workstream eval) on dev with a pi worker and merge its commit into main here. When both are done write gate-report.txt in the repo root containing exactly the line from ~/gate-result.txt. Work until it is done; do not ask me questions.',
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb, { closeMode: "none" });
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      [
        "task",
        "add",
        "g1",
        "-w",
        "eval",
        "-t",
        "add g1.txt (one line, committed as g1) on dev",
        "-i",
        "50",
        "-e",
        "0.1",
      ],
    ]);
    await workerTask(sb, "g1", {
      sh: "sleep 3; echo g1 >> g1.txt && git add g1.txt && git commit -qm g1",
    });
    const { hostRoot } = await sshShim(sb, { host: "dev", maxSessions: 1 });
    // mu-next stores the host as a profile; 3.x spells the ssh command out
    if (sandboxFamily(sb) === "next") await hostProfile(sb, "dev", { maxSessions: 1 });
    const n = await nonce(sb);
    writeFileSync(
      join(hostRoot, "bin", "remote-gate"),
      `#!/bin/sh\necho gate running\nsleep 6\necho "GATE-${n} exit 0" > "$HOME/gate-result.txt"\necho gate done\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(sb.dir, "setup-head"), (await sh(sb, "git rev-parse HEAD")).stdout.trim());
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const n = await nonce(sb);
    const runs = await runsLog(sb);
    const hostRoot = join(sb.dir, "hosts", "dev");
    const setupHead = readFileSync(join(sb.dir, "setup-head"), "utf8").trim();
    const wrong: string[] = [];
    let completed = true;
    // channel accounting
    const sessions = readFileSync(join(hostRoot, "sessions.log"), "utf8")
      .split("\n")
      .filter(Boolean);
    for (const l of sessions.filter((x) => / REFUSED /.test(x)))
      wrong.push(`ssh session refused on the one-channel host: ${l.slice(0, 100)}`);
    const gateSessions = sessions.filter((l) => /remote-gate/.test(l) && !/REFUSED/.test(l));
    if (gateSessions.length !== 1) {
      completed = false;
      wrong.push(`${gateSessions.length} remote-gate session(s) on dev (want 1)`);
    }
    const gatePane = probe.agentPanes("eval").get("gate");
    const openedBy = /\bpane=(\S+)/.exec(gateSessions[0] ?? "")?.[1];
    if (gateSessions.length === 1 && (gatePane === undefined || openedBy !== gatePane)) {
      completed = false;
      wrong.push(
        `the remote-gate session was not opened from the mu pane named gate (pane ${openedBy ?? "?"}, agent gate: ${gatePane ?? "none"})`,
      );
    }
    // the gate's result and the report
    let gateDone: { label: string; ms: number } | null = null;
    try {
      const p = join(hostRoot, "home", "gate-result.txt");
      gateDone = { label: "gate finished on dev", ms: statSync(p).mtimeMs };
      if (readFileSync(p, "utf8").trim() !== `GATE-${n} exit 0`)
        wrong.push("gate-result.txt is not the gate's line");
    } catch {
      completed = false;
      wrong.push("the gate never completed on dev (no gate-result.txt)");
    }
    const report = (await sh(sb, "cat gate-report.txt", { allowFail: true })).stdout.trim();
    if (report !== `GATE-${n} exit 0`) {
      completed = false;
      wrong.push(`gate-report.txt: ${report === "" ? "missing" : `"${report.slice(0, 60)}"`}`);
    }
    const file = fileMoment(join(sb.repoDir, "gate-report.txt"));
    if (file && gateDone && report === `GATE-${n} exit 0`)
      wrong.push(...orderWrong(gateDone, file, "gate-report.txt written after the gate finished"));
    // g1: a worker on dev, its commit on main, closed after its run
    const t = probe.task("eval", "g1");
    const closed = t?.status === "CLOSED" && t.substate === "done";
    const doneRun = runs.find((r) => r.task === "g1" && r.action === "done");
    const proof = await workerCommitOnMain(sb, "g1", runs, {
      since: setupHead,
      remoteRoot: hostRoot,
    });
    if (!doneRun) wrong.push("g1 has no remote worker run (not done on dev)");
    if (!proof.ok) wrong.push(proof.why);
    wrong.push(
      ...orderWrong(doneRun ? runMoment(doneRun) : null, closeMoment(sb, "eval", "g1"), "g1 close"),
    );
    if (!(closed && doneRun && proof.ok)) completed = false;
    // no long exec of the AUT over ssh: a session opened outside any mu pane held the host > 5s
    // (the gate runs 6s: a long exec is the pane's job). Read from the shim's session ends.
    const all = parseSessions(readFileSync(join(hostRoot, "sessions.log"), "utf8"));
    for (const x of all)
      if (!x.refused && x.pane === "-" && (x.end ?? Date.now()) - x.start > 5000)
        wrong.push(
          `an ssh session held the host for ${(x.end ?? Date.now()) - x.start}ms: ${x.command.slice(0, 80)}`,
        );
    // the gate's end was observed through mu: a mu call that BLOCKED and returned while the gate
    // ran its last moment (its window contains gate-result.txt's write), that did not report a
    // timeout, whatever verb or exit code (ended by the pane dying counts). A fixed sleep long
    // enough for the fixture is the wait this scenario measures.
    const waited = gateDone
      ? waitWindows(sb).some(
          ({ mu, start, end }) =>
            !timedOut(muOut(sb, mu)) &&
            start <= (gateDone?.ms ?? 0) &&
            (gateDone?.ms ?? 0) <= end + 500,
        )
      : false;
    if (gateDone && !waited) {
      completed = false;
      wrong.push("no blocked mu call was running when the gate finished on dev");
    }
    for (const c of idleCalls(sb, run))
      wrong.push(
        `a long call that did not wait in mu stands in for a wait: ${String(c.args.command ?? "").slice(0, 80)}`,
      );
    wrong.push(...prodWrong(run));
    return await verdictFx(sb, run, completed, {
      wrong,
      // the non-pi gate pane ends by itself: a wait on it may return a failing status, whatever
      // the code, once the gate has finished on dev (its result file exists)
      expectFail: [
        {
          re: /./,
          why: "the gate pane ended",
          when: (c) => gateDone !== null && endedByEvent(sb, run, c, gateDone.ms, "gate"),
        },
      ],
      notes: [
        `sessions=${sessions.length} gateSessions=${gateSessions.length} g1 closed=${closed} report=${report ? "yes" : "no"}`,
      ],
    });
  },
};

export default scenario;
