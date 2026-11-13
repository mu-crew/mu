// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Real mu + tmux: the hill-r2 fixtures (spec §2) on the built checkout. Skips without dist/ or tmux.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANSWER_ID,
  chromePane,
  delegateDefault,
  delegateDelay,
  makeRepo,
  nonce,
  openGate,
  seedDelegate,
  seedViaMu,
  workerEvidence,
  workerTask,
  writeWorkerDriver,
} from "../../tools/eval/fixtures.ts";
import { answersServed } from "../../tools/eval/observe.ts";
import { createSandbox, REAL_PI, sh } from "../../tools/eval/sandbox.ts";
import { surfaceFromDir } from "../../tools/eval/surface.ts";
import type { Sandbox } from "../../tools/eval/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
// Seeds spawn real pi agents (ctl handshake): no real pi, no run.
const ready = existsSync(join(ROOT, "dist", "cli.js")) && hasTmux() && REAL_PI !== "pi";
const surface = () => ({ ...surfaceFromDir("checkout", ROOT), family: "next" as const });

const ANSWER = "All four fixes are in place. I found no real problems.";

function rows<T>(sb: Sandbox, sql: string, ...args: unknown[]): T[] {
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

async function seedReview(sb: Sandbox): Promise<string> {
  await seedViaMu(sb, [
    ["workstream", "init", "auth"],
    ["task", "add", "t4", "-w", "auth", "-t", "four fixes"],
  ]);
  const { task } = await seedDelegate(sb, {
    callId: "rv-n1",
    caller: "pi:nextstep-orch",
    wave: "w1",
    label: "review-t4",
    record: "auth/t4",
    brief: "Review t4's four fixes. BRIEF-n1",
    agent: "delegate-review-t4",
    answer: ANSWER,
  });
  return task;
}

describe.skipIf(!ready)("hill-r2 fixtures", () => {
  let sb: Sandbox | undefined;
  afterEach(async () => {
    try {
      await sb?.close();
    } catch {}
    sb = undefined;
  });

  it("a gated task script waits for go, then its delay", async () => {
    sb = await createSandbox(surface());
    await writeWorkerDriver(sb);
    await workerTask(sb, "g1", { sh: "echo ran > ran.txt", gate: { delayMs: 300 } });
    await sh(sb, `(bash "$EVAL_WORKER_DIR/tasks/g1.sh" &) >/dev/null 2>&1`);
    await new Promise((r) => setTimeout(r, 700));
    expect(existsSync(join(sb.repoDir, "ran.txt")), "ran before go").toBe(false);
    const go = Date.now();
    await openGate(sb);
    let at = 0;
    for (let i = 0; i < 40 && at === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (existsSync(join(sb.repoDir, "ran.txt"))) at = Date.now();
    }
    expect(at, "never ran after go").toBeGreaterThan(0);
    expect(at - go).toBeGreaterThanOrEqual(300);
  }, 30_000);

  it("seedDelegate writes what the delegate path writes, and no checks row", async () => {
    sb = await createSandbox(surface());
    const task = await seedReview(sb);
    expect(task).toMatch(/^delegate_review-t4_[0-9a-f]{8}$/);
    const tasks = rows<{ id: string; kind: string; status: string; wave: string | null }>(
      sb,
      "SELECT local_id AS id, kind, status, wave FROM tasks ORDER BY id",
    );
    expect(tasks).toEqual([
      { id: task, kind: "delegate", status: "CLOSED", wave: "w1" },
      { id: "t4", kind: "work", status: "OPEN", wave: null },
    ]);
    const calls = rows(
      sb,
      "SELECT caller, state, verdict, record_workstream AS ws, record_task AS rt FROM delegate_calls",
    );
    expect(calls).toEqual([
      { caller: "pi:nextstep-orch", state: "done", verdict: null, ws: "auth", rt: "t4" },
    ]);
    const notes = (id: string) =>
      rows<{ kind: string; content: string }>(
        sb as Sandbox,
        "SELECT n.kind AS kind, n.content AS content FROM task_notes n JOIN tasks t ON t.id = n.task_id WHERE t.local_id = ? ORDER BY n.id",
        id,
      );
    expect(notes(task).map((n) => n.kind)).toEqual(["brief", "report", "close"]);
    expect(notes(task)[0]?.content).toBe("Review t4's four fixes. BRIEF-n1");
    expect(notes(task)[1]?.content).toBe(ANSWER);
    const t4 = notes("t4");
    expect(t4.map((n) => n.kind)).toEqual(["verdict"]);
    expect(t4[0]?.content).toMatch(
      new RegExp(
        `^REFUTER review-t4 \\(delegate-review-t4, [^)]*\\):\\nNO VERDICT LINE: ${ANSWER}$`,
      ),
    );
    expect(rows(sb, "SELECT * FROM checks")).toEqual([]);
  }, 60_000);

  it("mu wait --wave w1 as pi:nextstep-orch fires at once, auth/t4 unverified 1", async () => {
    sb = await createSandbox(surface());
    await seedReview(sb);
    const t = Date.now();
    const r = await sh(sb, "PI_SESSION_ID=nextstep-orch mu wait --wave w1 -w auth --json");
    expect(Date.now() - t).toBeLessThan(10_000);
    const d = JSON.parse(r.stdout).data;
    expect(d.exit).toBe(0);
    expect(d.tally.findings).toEqual([
      { id: "auth/t4", confirmed: 0, refuted: 0, unverified: 1, pending: 0 },
    ]);
  }, 60_000);

  it("delegateDefault replaces a keyless delegate's generated answer", async () => {
    sb = await createSandbox(surface());
    await writeWorkerDriver(sb);
    await delegateDelay(sb, 0);
    await seedViaMu(sb, [["workstream", "init", "auth"]]);
    const ask = "MU_AGENT_NAME=delegate-rr MU_WORKSTREAM=auth eval-worker";
    const before = await sh(sb, ask);
    expect(before.stdout).toMatch(/^VERDICT: CONFIRMED\nEVIDENCE: asked:/);
    await delegateDefault(sb, "VERDICT: CONFIRMED\nEVIDENCE: RV-n1 re-read the four fixes");
    const after = await sh(sb, ask);
    expect(after.stdout).toBe("VERDICT: CONFIRMED\nEVIDENCE: RV-n1 re-read the four fixes\n");
  }, 60_000);

  it("each default answer carries its own id, logged in answers.log", async () => {
    const box = await createSandbox(surface());
    sb = box;
    await writeWorkerDriver(box);
    await delegateDelay(box, 0);
    await seedViaMu(box, [["workstream", "init", "auth"]]);
    await delegateDefault(box, `VERDICT: CONFIRMED\nEVIDENCE: counted (check ${ANSWER_ID})`);
    const ask = (n: string) => sh(box, `MU_AGENT_NAME=${n} MU_WORKSTREAM=auth eval-worker`);
    const a = (await ask("delegate-a")).stdout;
    const b = (await ask("delegate-b")).stdout;
    const ids = answersServed(box).map((x) => x.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(a).toBe(`VERDICT: CONFIRMED\nEVIDENCE: counted (check ${ids[0]})\n`);
    expect(b).toContain(`(check ${ids[1]})`);
  }, 60_000);

  it("a worker sees its claim while no mu process holds the DB open", async () => {
    sb = await createSandbox(surface());
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "auth"],
      ["task", "add", "t1", "-w", "auth", "-t", "one"],
    ]);
    await workerTask(sb, "t1", { sh: "echo t1 done" });
    await seedViaMu(sb, [
      ["agent", "spawn", "worker-1", "-w", "auth", "--task", "t1", "--send", "do t1"],
    ]);
    // no mu call from here on: the WAL's -shm file is gone, as when an orchestrator sleeps
    let log = "";
    for (let i = 0; i < 60 && !/ worker-1 t1 block /.test(log); i++) {
      await new Promise((r) => setTimeout(r, 250));
      const f = join(sb.workerDir, "runs.log");
      log = existsSync(f) ? readFileSync(f, "utf8") : "";
    }
    expect(log).toMatch(/ worker-1 t1 block /);
  }, 60_000);

  it("a worker's close evidence names its commit, never a script outside the repo", async () => {
    sb = await createSandbox(surface());
    await makeRepo(sb, { "a.txt": "a\n" });
    await writeWorkerDriver(sb, { closeMode: "verb" });
    await seedViaMu(sb, [
      ["workstream", "init", "auth"],
      ["task", "add", "t1", "-w", "auth", "-t", "one"],
    ]);
    await workerTask(sb, "t1", { sh: "echo t1 > t1.txt && git add t1.txt && git commit -qm t1" });
    await seedViaMu(sb, [
      ["agent", "spawn", "worker-1", "-w", "auth", "--task", "t1", "--send", "do t1"],
    ]);
    let log = "";
    for (let i = 0; i < 60 && !/ worker-1 t1 close /.test(log); i++) {
      await new Promise((r) => setTimeout(r, 250));
      const f = join(sb.workerDir, "runs.log");
      log = existsSync(f) ? readFileSync(f, "utf8") : "";
    }
    const db = new Database(sb.dbPath, { readonly: true });
    const notes = (db.prepare("SELECT content FROM task_notes").all() as { content: string }[])
      .map((r) => r.content)
      .join("\n");
    db.close();
    expect(notes).toMatch(workerEvidence("t1", await nonce(sb)));
    expect(notes).toMatch(/t1: committed [0-9a-f]{7} run=/);
    expect(notes).not.toMatch(/\.sh\b/);
  }, 60_000);

  it("chromePane prints pi-like chrome, then the lines, and stays alive", async () => {
    sb = await createSandbox(surface());
    await seedViaMu(sb, [["workstream", "init", "auth"]]);
    await chromePane(sb, "worker-1", ["PANE-n1: tests 41 passed, red fox blue sky"]);
    let read = "";
    for (let i = 0; i < 20 && !read.includes("PANE-n1"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      read = (await sh(sb, "mu agent read worker-1 -w auth")).stdout;
    }
    const lines = read.split("\n");
    const at = lines.findIndex((l) => l.includes("PANE-n1: tests 41 passed, red fox blue sky"));
    expect(at).toBeGreaterThan(30);
    const before = lines.slice(0, at);
    expect(before.filter((l) => l.trim() === "").length).toBeGreaterThanOrEqual(25);
    expect(before.some((l) => /^─+$/.test(l.trim()))).toBe(true);
    expect(before.some((l) => l.includes("↑"))).toBe(true);
    expect(before.some((l) => l.includes("Working…"))).toBe(true);
    const listed = (await sh(sb, "mu agent list -w auth --json")).stdout;
    expect(JSON.parse(listed).data.agents.map((a: { name: string }) => a.name)).toEqual([
      "worker-1",
    ]);
  }, 60_000);
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
