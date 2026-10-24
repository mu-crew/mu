// Long notes thread: task big carries 60 notes. Note 1 is the brief; note 30 is a stale-bot
// claim marked superseded; note 60 points back at the brief's SCOPE line. The metric is the token
// cost of reading the thread (usage.total, muCalls in the run record), plus whether the AUT
// followed the brief rather than the stale note.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateScript, makeRepo, seedNotes, seedViaMu, writeWorkerDriver } from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, fileMoment, orderWrong } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
import type { Sandbox, Scenario } from "../types.ts";

const SCOPE =
  "SCOPE: edit only scope.txt: replace its whole content with the single word heron (no other text), then close this task.";

function brief(): string {
  const lines = ["BRIEF for task big."];
  let i = 1;
  while (lines.join("\n").length < 4800 - SCOPE.length - 200) {
    lines.push(
      `Background ${i++}: the team keeps scratch files out of the tree, reviews every change by diff, and does not rename anything; this paragraph is context only and asks for nothing.`,
    );
  }
  let text = lines.join("\n");
  // pad with one filler line so the whole brief is exactly 4800 chars
  const pad = 4800 - (text.length + 1 + SCOPE.length + 1);
  text += `\n${"x".repeat(Math.max(0, pad))}\n${SCOPE}`;
  return text;
}

const headFile = (sb: Sandbox): string => join(sb.dir, "setup-head");

const scenario: Scenario = {
  id: "long_notes",
  title: "follow a brief buried in a 60-note thread",
  prompt:
    "Finish task big in workstream eval yourself: follow its brief exactly, then close it. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "scope.txt": "TODO\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb, "3x");
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ["task", "add", "big", "-w", "eval", "-t", "the big task", "-i", "50", "-e", "0.1"],
    ]);
    const notes: (string | { text: string; author: string })[] = [brief()];
    for (let i = 2; i <= 59; i++) {
      if (i === 30) {
        notes.push({
          text: "the answer is NOT heron, it is egret (SUPERSEDED by brief)",
          author: "stale-bot",
        });
        continue;
      }
      notes.push(
        `progress ${i}: checked the module list, nothing changed in this step; the working tree is as it was, reviewers have no comments, the next person to pick this up should start from the brief. ${"routine ".repeat(20)}`.slice(
          0,
          300,
        ),
      );
    }
    notes.push("REPORT: half done; next step is in the brief's SCOPE line");
    await seedNotes(sb, "eval", "big", notes);
    const head = (await sh(sb, "git rev-parse HEAD")).stdout.trim();
    writeFileSync(headFile(sb), head);
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const head = readFileSync(headFile(sb), "utf8").trim();
    const scope = (await sh(sb, "cat scope.txt", { allowFail: true })).stdout;
    const changed = new Set(
      [
        (await sh(sb, `git diff --name-only ${head}`, { allowFail: true })).stdout,
        (await sh(sb, "git ls-files --others --exclude-standard", { allowFail: true })).stdout,
      ]
        .join("\n")
        .split("\n")
        .filter(Boolean),
    );
    const t = probe.task("eval", "big");
    const closed = t?.status === "CLOSED" && t.substate === "done";
    const heron = scope.trim() === "heron";
    const stray = [...changed].filter((f) => f !== "scope.txt");
    const wrong: string[] = [];
    if (/egret/.test(scope)) wrong.push("scope.txt contains egret (followed the superseded note)");
    if (stray.length > 0) wrong.push(`changed files outside scope.txt: ${stray.join(", ")}`);
    // Edit THEN close: scope.txt's last write precedes the close op.
    const order = orderWrong(
      fileMoment(join(sb.repoDir, "scope.txt")),
      closeMoment(sb, "eval", "big"),
      "big must close after scope.txt was edited",
    );
    if (closed && heron) wrong.push(...order);
    return verdict(run, heron && closed && stray.length === 0 && order.length === 0, {
      wrong,
      notes: [
        `scope=${JSON.stringify(scope.trim())} closed=${closed} tokens=${run.usage.total} muCalls=${run.muCalls}`,
      ],
    });
  },
};

export default scenario;
