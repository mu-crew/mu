// remote_recovery readers (v_remote_recovery_close), fast tier: `agent close` of
// a worktree whose agent row is gone. No real git, no real host: the profile's
// exec is a canned sh shim (it answers the two tagged lines mu's remote scripts
// end in, and logs what it was asked), the mux is the fake tmux, the registry
// and the recovery table are real SQLite.
//
//   select     bare close picks the sole record; several refuse and list ids; --recovery picks one
//   preview    read only: no exec, no kill, distinct recovery id/kind, no owned tasks
//   apply      original aside, no --force, deletes ONLY that record on removed/gone/kept-branch
//   retain     dirty / uncollected / moved / held / unreadable keep the record
//   guards     live agent, shared path, profile gone/replaced/unpinned refuse before any exec
//   races      a record or agent that changes during the slow step stops the removal
//   revision   `--if` is derived from the record
//   cli        qualified refs, -w after reinit, exit codes, JSON keys

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent, deleteAgent, getAgent, insertAgent, previewClose } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, removeHost } from "../src/hosts.js";
import { asideOf, RemoteCloseRefusedError } from "../src/remote-agent.js";
import { collectRemoteAgent } from "../src/remote-collect.js";
import {
  getRemoteRecovery,
  listRemoteRecoveries,
  RemoteRecoveryRefusedError,
  recoveryHolds,
  selectRemoteRecovery,
  setRecoveryCollectedHead,
} from "../src/remote-recovery.js";
import { agentRevision, RevisionMismatchError } from "../src/revision.js";
import { reinitWorkstream, teardownWorkstream, workstreamRevision } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

const BASE = "b".repeat(40);
const COLLECTED = "c".repeat(40);
const OTHER = "d".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/auth/worker-1";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;

const execCalls = (): string[] =>
  readdirSync(join(dir, "execlog"))
    .sort((a, b) => Number(a) - Number(b))
    .map((f) => readFileSync(join(dir, "execlog", f), "utf8"));
const removals = (): string[] => execCalls().filter((c) => c.includes("worktree remove"));
const answer = (observe: string, remove = "MU_RM removed"): void => {
  writeFileSync(join(dir, "observe"), `${observe}\n`);
  writeFileSync(join(dir, "remove"), `${remove}\n`);
};
const records = () => listRemoteRecoveries(db);

/** A finalized remote row, deleted again: leaves one record. Returns its original incarnation. */
function orphaned(
  over: { name?: string; workstream?: string; cwd?: string; collectedHead?: string } = {},
): number {
  const name = over.name ?? "worker-1";
  const workstream = over.workstream ?? "auth";
  const row = insertAgent(db, {
    name,
    workstream,
    paneId: `%${900 + records().length}`,
    cwd: over.cwd ?? WT,
    base: BASE,
    host: "dev",
    ...(over.collectedHead === undefined ? {} : { collectedHead: over.collectedHead }),
  });
  expect(deleteAgent(db, name, workstream)).toBe(true);
  return row.incarnation;
}
const close = (over: Partial<Parameters<typeof closeAgent>[2]> = {}) =>
  closeAgent(db, "worker-1", { workstream: "auth", ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrrc-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  mkdirSync(join(dir, "execlog"));
  answer(`MU_STATE clean ${BASE}`);
  const fakeExec = join(dir, "fake-exec.sh");
  // `gate` (if present) holds the observation open: the window in which a test changes the world.
  writeFileSync(
    fakeExec,
    `#!/bin/sh
n=$(ls '${dir}/execlog' | wc -l)
printf '%s' "$1" > '${dir}/execlog'/$n
case "$1" in
  *MU_STATE*) if [ -f '${dir}/gate' ]; then touch '${dir}/started'; while [ -f '${dir}/gate' ]; do sleep 0.01; done; fi; cat '${dir}/observe' ;;
  *MU_RM*) cat '${dir}/remove' ;;
esac
`,
  );
  chmodSync(fakeExec, 0o755);
  addHost(db, {
    name: "dev",
    shell: "true",
    exec: `/bin/sh ${fakeExec} {cmd}`,
    fetch: "true {cwd}",
    repo: "/srv/repo",
    max_sessions: 1,
  });
  mux = installMux("tmux", mockTmux(freshMockState()).executor);
});

afterEach(() => {
  mux.restore();
  db.close();
  rmFixtureDir(dir);
});

describe("selection", () => {
  it("a bare preview selects the sole record: distinct recovery id and kind, no exec, no kill", async () => {
    const id = orphaned({ collectedHead: COLLECTED });
    const p = await previewClose(db, "worker-1", { workstream: "auth" });
    expect(p).toMatchObject({
      kind: "recovery",
      incarnation: null,
      paneId: null,
      ownedTasks: [],
      worktree: null,
      remote: { host: "dev", path: WT, base: BASE, collectedHead: COLLECTED },
      recovery: { id, aside: asideOf(WT, id), refusal: null },
    });
    expect(p.revision).not.toBe(0);
    expect(execCalls()).toEqual([]);
    expect(mux.calls.filter((c) => c[0] === "kill-pane")).toEqual([]);
    expect(records()).toHaveLength(1);
  });

  it("nothing recorded and nothing registered: kind none, close is a no-op", async () => {
    expect((await previewClose(db, "worker-1", { workstream: "auth" })).kind).toBe("none");
    expect(await close()).toMatchObject({ killedPane: false, deletedRow: false, worktree: null });
  });

  it("two removed incarnations of one name refuse, listing stable ids; --recovery picks one", async () => {
    const first = orphaned();
    const second = orphaned();
    expect(second).toBeGreaterThan(first);
    const err = await previewClose(db, "worker-1", { workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteRecoveryRefusedError);
    expect(err).toMatchObject({ reason: "ambiguous", candidates: [first, second] });
    await expect(close()).rejects.toBeInstanceOf(RemoteRecoveryRefusedError);
    expect(execCalls()).toEqual([]);
    const r = await close({ recoveryId: second });
    expect(r.worktree).toMatchObject({ action: "removed" });
    expect(records().map((x) => x.agentId)).toEqual([first]);
    // The older one is now the sole record: bare close selects it.
    expect((await previewClose(db, "worker-1", { workstream: "auth" })).recovery?.id).toBe(first);
  });

  it("a record of another name or workstream is never selected by a guess", async () => {
    const id = orphaned({ name: "worker-2", cwd: `${WT}-2` });
    expect(selectRemoteRecovery(db, "auth", "worker-1")).toBeUndefined();
    expect(() => selectRemoteRecovery(db, "auth", "worker-1", id)).toThrow(
      RemoteRecoveryRefusedError,
    );
    expect(selectRemoteRecovery(db, "other", "worker-2")).toBeUndefined();
    expect(await close()).toMatchObject({ worktree: null });
    expect(records()).toHaveLength(1);
  });

  it("an explicit recovery id that is gone is a no-op, whatever --if says", async () => {
    const id = orphaned();
    await close({ recoveryId: id });
    expect(await close({ recoveryId: id, ifRevision: 12345 })).toMatchObject({ worktree: null });
    expect(execCalls()).toHaveLength(2);
  });
});

describe("apply", () => {
  it("removes through the original aside, without --force, and deletes only that record", async () => {
    const keep = orphaned({ name: "worker-2", cwd: `${WT}-2` });
    const id = orphaned();
    const r = await close({ ifRevision: agentRevision(db, "auth", "worker-1") });
    expect(r).toMatchObject({
      killedPane: false,
      deletedRow: false,
      worktree: { path: WT, action: "removed" },
      recovery: { id, deleted: true },
    });
    const calls = execCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(`${WT}.mu-removing-${id}`);
    expect(calls[1]).toContain("worktree remove");
    expect(calls[1]).not.toContain("--force");
    expect(records().map((x) => x.agentId)).toEqual([keep]);
    expect(mux.calls.filter((c) => c[0] === "kill-pane")).toEqual([]);
  });

  it("a worktree already gone deletes the record", async () => {
    orphaned();
    answer("MU_STATE gone");
    expect((await close()).worktree).toMatchObject({ action: "gone" });
    expect(records()).toEqual([]);
  });

  it("HEAD at the last collected HEAD removes; --keep-branch at an unknown HEAD names the branch", async () => {
    orphaned({ collectedHead: COLLECTED });
    answer(`MU_STATE clean ${COLLECTED}`);
    expect((await close()).worktree).toMatchObject({ action: "removed" });
    orphaned();
    answer(`MU_STATE clean ${OTHER}`);
    const r = await close({ keepBranch: true });
    expect(r.worktree).toMatchObject({
      action: "kept-branch",
      branch: `mu/auth/worker-1-${OTHER.slice(0, 12)}`,
    });
    expect(records()).toEqual([]);
  });

  it.each([
    ["dirty", {}],
    ["dirty", { keepBranch: true }],
    ["dirty", { discard: true }],
  ] as const)("a dirty tree refuses under %j and keeps the record", async (_n, over) => {
    orphaned();
    answer(`MU_STATE dirty ${BASE}`);
    await expect(close(over)).rejects.toBeInstanceOf(RemoteCloseRefusedError);
    expect(removals()).toEqual([]);
    expect(records()).toHaveLength(1);
  });

  it("every refusal and failure keeps the record, and its hint names the recovery", async () => {
    const id = orphaned();
    for (const [observe, remove] of [
      [`MU_STATE clean ${OTHER}`, "MU_RM removed"], // uncollected
      [`MU_STATE clean ${BASE}`, "MU_RM moved"],
      [`MU_STATE clean ${BASE}`, "MU_RM dirty"],
      [`MU_STATE clean ${BASE}`, "MU_RM held 4242"],
      [`MU_STATE clean ${BASE}`, "MU_RM unproven"],
      [`MU_STATE clean ${BASE}`, "MU_RM stuck"],
      [`MU_STATE clean ${OTHER}`, "MU_RM branch-collision"],
      ["noise", "MU_RM removed"],
    ] as const) {
      answer(observe, remove);
      const err = await close({ keepBranch: remove.includes("collision") }).catch((e) => e);
      expect(err).toBeInstanceOf(RemoteCloseRefusedError);
      const steps = (err as RemoteCloseRefusedError).errorNextSteps().map((s) => s.command);
      expect(steps.every((c) => c.includes(`--recovery ${id}`))).toBe(true);
      expect(records()).toHaveLength(1);
    }
  });
});

describe("guards before any host command", () => {
  it("a current agent of the same name refuses; the record stays", async () => {
    const id = orphaned();
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%5", cwd: "/x" });
    const err = await close({ recoveryId: id }).catch((e) => e);
    expect(err).toMatchObject({ name: "RemoteRecoveryRefusedError", reason: "live-agent" });
    const p = await previewClose(db, "worker-1", { workstream: "auth", recoveryId: id });
    expect(p).toMatchObject({ kind: "recovery", recovery: { refusal: expect.any(String) } });
    expect(execCalls()).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(records()).toHaveLength(1);
  });

  it("another agent on the same host and path refuses", async () => {
    orphaned();
    insertAgent(db, {
      name: "worker-9",
      workstream: "auth",
      paneId: "%6",
      cwd: WT,
      base: BASE,
      host: "dev",
    });
    await expect(close()).rejects.toMatchObject({ reason: "resource-in-use" });
    expect(execCalls()).toEqual([]);
  });

  it("a missing, replaced or never-pinned host profile refuses; nothing runs", async () => {
    orphaned();
    removeHost(db, "dev");
    await expect(close()).rejects.toMatchObject({ reason: "profile" });
    addHost(db, {
      name: "dev",
      shell: "true",
      exec: "/bin/sh -c {cmd}",
      fetch: "true {cwd}",
      repo: "/srv/other",
      max_sessions: 1,
    });
    await expect(close()).rejects.toMatchObject({ reason: "profile" });
    expect(execCalls()).toEqual([]);
    expect(records()).toHaveLength(1);
    // A record written while the host had no profile has nothing to compare with.
    db.prepare("UPDATE remote_recovery SET host_exec = NULL, host_repo = NULL").run();
    await expect(close()).rejects.toMatchObject({ reason: "profile" });
    expect(execCalls()).toEqual([]);
  });
});

describe("races during the slow step", () => {
  async function during(change: () => void, run: () => Promise<unknown>): Promise<unknown> {
    writeFileSync(join(dir, "gate"), "");
    const pending = run().catch((e: unknown) => e);
    for (let i = 0; i < 400 && !existsSync(join(dir, "started")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(join(dir, "started"))).toBe(true);
    change();
    rmSync(join(dir, "gate"));
    return pending;
  }

  it("an agent that takes the name mid-close stops the removal before the move", async () => {
    orphaned();
    const err = await during(
      () => insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%7", cwd: "/y" }),
      () => close(),
    );
    expect(err).toMatchObject({ name: "RemoteRecoveryRefusedError", reason: "live-agent" });
    expect(removals()).toEqual([]);
    expect(records()).toHaveLength(1);
  });

  it("a record that changes mid-close stops the removal", async () => {
    orphaned();
    const err = await during(
      () => db.prepare("UPDATE remote_recovery SET collected_head = ?").run(OTHER),
      () => close(),
    );
    expect(err).toMatchObject({ name: "RemoteRecoveryRefusedError", reason: "changed" });
    expect(removals()).toEqual([]);
    expect(records()).toHaveLength(1);
  });

  it("a record deleted mid-close stops the removal", async () => {
    orphaned();
    const err = await during(
      () => db.prepare("DELETE FROM remote_recovery").run(),
      () => close(),
    );
    expect(err).toMatchObject({ reason: "changed" });
    expect(removals()).toEqual([]);
  });
});

describe("a path reused by a newer record (the newest record owns the tree)", () => {
  it("an older record refuses to close or preview as usable; the newer one closes; nothing ran before", async () => {
    const older = orphaned();
    const newer = orphaned(); // same name, same deterministic path
    const err = await close({ recoveryId: older }).catch((e) => e);
    expect(err).toMatchObject({
      name: "RemoteRecoveryRefusedError",
      reason: "resource-in-use",
      candidates: [older, newer],
    });
    expect(String(err.message)).toContain(`newer recovery ${newer}`);
    await expect(close({ recoveryId: older, keepBranch: true })).rejects.toMatchObject({
      reason: "resource-in-use",
    });
    const p = await previewClose(db, "worker-1", { workstream: "auth", recoveryId: older });
    expect(p.recovery?.refusal).toContain(`newer recovery ${newer}`);
    expect(execCalls()).toEqual([]);
    expect(records().map((r) => r.agentId)).toEqual([older, newer]);
    // The newest one owns the tree and closes; the older is then the sole owner.
    expect((await close({ recoveryId: newer })).worktree).toMatchObject({ action: "removed" });
    expect(records().map((r) => r.agentId)).toEqual([older]);
    expect((await close({ recoveryId: older })).worktree).toMatchObject({ action: "removed" });
  });

  it("a different path or host never counts as a newer owner", async () => {
    const older = orphaned();
    orphaned({ cwd: `${WT}-2` });
    expect((await close({ recoveryId: older })).worktree).toMatchObject({ action: "removed" });
  });

  it("a newer record appearing before the removal stops it (the guard reruns in beforeRemove)", async () => {
    const older = orphaned();
    writeFileSync(join(dir, "gate"), "");
    const pending = close({ recoveryId: older }).catch((e: unknown) => e);
    for (let i = 0; i < 400 && !existsSync(join(dir, "started")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    orphaned();
    rmSync(join(dir, "gate"));
    expect(await pending).toMatchObject({ reason: "resource-in-use" });
    expect(removals()).toEqual([]);
    expect(records()).toHaveLength(2);
  });

  it("collect of an older record refuses with no fetch and no state change", async () => {
    const older = orphaned();
    orphaned();
    const err = await collectRemoteAgent(db, {
      workstream: "auth",
      name: "worker-1",
      repo: dir,
      recoveryId: older,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "RemoteRecoveryRefusedError", reason: "resource-in-use" });
    expect(getRemoteRecovery(db, older)?.collectedHead).toBeNull();
    expect(execCalls()).toEqual([]);
  });
});

describe("an explicit --recovery that is gone never means the live agent", () => {
  const live = () =>
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%50",
      cwd: WT,
      base: BASE,
      host: "dev",
    });

  it("preview is kind none with revision 0 and no live fields, not the agent", async () => {
    const id = orphaned();
    await close({ recoveryId: id });
    live();
    const p = await previewClose(db, "worker-1", { workstream: "auth", recoveryId: id });
    expect(p).toMatchObject({
      kind: "none",
      revision: 0,
      incarnation: null,
      paneId: null,
      ownedTasks: [],
      remote: null,
      recovery: null,
    });
    // Without the id the live agent is what it is.
    expect((await previewClose(db, "worker-1", { workstream: "auth" })).kind).toBe("agent");
  });

  it("close is a no-op that leaves the live agent and its pane alone", async () => {
    const id = orphaned();
    await close({ recoveryId: id });
    live();
    const before = mux.calls.length;
    expect(await close({ recoveryId: id })).toMatchObject({ killedPane: false, deletedRow: false });
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(mux.calls.slice(before).filter((c) => c[0] === "kill-pane")).toEqual([]);
  });

  it("the CLI preview shows kind none and offers no apply command", async () => {
    const id = orphaned();
    await close({ recoveryId: id });
    live();
    const r = await runCliJson(
      ["agent", "close", "-w", "auth", "worker-1", "--recovery", String(id), "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ kind: "none", revision: 0, recovery_id: null });
    expect(r.data.nextSteps).toEqual([]);
  });

  it("collect refuses (gone) and does not collect the live agent", async () => {
    const id = orphaned();
    await close({ recoveryId: id });
    live();
    const err = await collectRemoteAgent(db, {
      workstream: "auth",
      name: "worker-1",
      repo: dir,
      recoveryId: id,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "RemoteRecoveryRefusedError", reason: "gone" });
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).toBeNull();
    expect(execCalls()).toHaveLength(2); // only the close's own two
  });
});

describe("guards that only a precise window or a corrupt record reaches", () => {
  /** A mux whose liveness probe (run inside host admission, after the pre-exec guards) runs `onProbe`. */
  function probeHook(onProbe: () => void): void {
    mux.restore();
    mux = installMux("tmux", async (args) => {
      if (args[0] === "display-message") {
        onProbe();
        return { stdout: `${args[2]}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    // An attached channel makes admission probe its pane; no cap, so the live pane does not block.
    db.prepare("UPDATE host_profiles SET max_sessions = NULL").run();
    db.prepare(
      "INSERT INTO host_channels (host, holder, kind, token, agent_id, pane_id, opened_at) VALUES ('dev', 'x', 'attached', 't', 99, '%77', 'now')",
    ).run();
  }
  const swapProfile = (): void => {
    db.prepare("UPDATE host_profiles SET repo = '/srv/other'").run();
  };

  it("close: a profile replaced between the pre-exec guard and admission runs nothing", async () => {
    orphaned();
    probeHook(swapProfile);
    await expect(close()).rejects.toMatchObject({ reason: "profile" });
    expect(execCalls()).toEqual([]);
    expect(records()).toHaveLength(1);
  });

  it("collect: a profile replaced between the pre-fetch guard and admission fetches nothing", async () => {
    orphaned();
    probeHook(swapProfile);
    const err = await collectRemoteAgent(db, {
      workstream: "auth",
      name: "worker-1",
      repo: dir,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "RemoteRecoveryRefusedError", reason: "profile" });
    expect(records()).toHaveLength(1);
  });

  it("a record whose aside is not its own is refused with no host command", async () => {
    const id = orphaned();
    db.prepare("UPDATE remote_recovery SET aside = '/elsewhere/x'").run();
    await expect(close({ recoveryId: id })).rejects.toMatchObject({
      name: "RemoteRecoveryRefusedError",
      reason: "changed",
    });
    expect(execCalls()).toEqual([]);
    expect(records()).toHaveLength(1);
  });

  it("recording a collected HEAD is a compare-and-set on the whole record", () => {
    const id = orphaned();
    const rec = getRemoteRecovery(db, id);
    if (rec === undefined) throw new Error("record missing");
    db.prepare("UPDATE remote_recovery SET collected_head = ? WHERE agent_id = ?").run(OTHER, id);
    expect(setRecoveryCollectedHead(db, rec, COLLECTED)).toBe(false);
    expect(recoveryHolds(db, rec)).toBe(false);
    expect(getRemoteRecovery(db, id)?.collectedHead).toBe(OTHER);
    const now = getRemoteRecovery(db, id);
    if (now === undefined) throw new Error("record missing");
    expect(setRecoveryCollectedHead(db, now, COLLECTED)).toBe(true);
    expect(getRemoteRecovery(db, id)?.collectedHead).toBe(COLLECTED);
  });
});

describe("revision", () => {
  it("is derived from the record: stable, moved by its content, 0 when nothing is there", () => {
    expect(agentRevision(db, "auth", "worker-1")).toBe(0);
    const id = orphaned();
    const rev = agentRevision(db, "auth", "worker-1");
    expect(rev).not.toBe(0);
    expect(agentRevision(db, "auth", "worker-1")).toBe(rev);
    expect(agentRevision(db, "auth", "worker-1", id)).not.toBe(0);
    db.prepare("UPDATE remote_recovery SET collected_head = ?").run(OTHER);
    expect(agentRevision(db, "auth", "worker-1")).not.toBe(rev);
    expect(agentRevision(db, "auth", "worker-1", id + 1)).toBe(0);
  });

  it("an agent that takes the name moves the selected record's revision", async () => {
    const id = orphaned();
    const rev = agentRevision(db, "auth", "worker-1", id);
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%60", cwd: "/q" });
    expect(agentRevision(db, "auth", "worker-1", id)).not.toBe(rev);
  });

  it("a stale --if refuses before any host command", async () => {
    orphaned();
    const stale = agentRevision(db, "auth", "worker-1");
    db.prepare("UPDATE remote_recovery SET collected_head = ?").run(OTHER);
    await expect(close({ ifRevision: stale })).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(execCalls()).toEqual([]);
  });
});

describe("cli", () => {
  const cli = (...argv: string[]) => runCliJson(["agent", "close", ...argv, "--json"], dbPath);

  it("preview then apply by qualified ref after a reinit (no live workstream, no -w)", async () => {
    const live = insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%1",
      cwd: WT,
      base: BASE,
      host: "dev",
    });
    await teardownWorkstream(db, {
      workstream: "auth",
      ifRevision: workstreamRevision(db, "auth"),
    });
    await reinitWorkstream(db, "auth", workstreamRevision(db, "auth"));
    expect(records().map((r) => r.agentId)).toEqual([live.incarnation]);
    const p = await cli("auth/worker-1");
    expect(p.exitCode).toBeNull();
    expect(p.data).toMatchObject({
      kind: "recovery",
      dryRun: true,
      id: null,
      recovery_id: live.incarnation,
    });
    const next = (p.data.nextSteps as { command: string }[])[0]?.command ?? "";
    expect(next).toContain(`--recovery ${live.incarnation}`);
    expect(next).toContain(`--if ${p.data.revision}`);
    const applied = await cli(
      "-w",
      "auth",
      "worker-1",
      "--recovery",
      String(live.incarnation),
      "--if",
      String(p.data.revision),
    );
    expect(applied.exitCode).toBeNull();
    expect(applied.data).toMatchObject({
      worktree: { action: "removed" },
      recovery: { deleted: true },
    });
    expect(records()).toEqual([]);
  });

  it("a second record of the name moves the unselected revision", () => {
    orphaned();
    const one = agentRevision(db, "auth", "worker-1");
    orphaned();
    expect(agentRevision(db, "auth", "worker-1")).not.toBe(one);
  });

  it("a bare name with no -w is a missing-scope usage error that offers the qualified ref", async () => {
    orphaned();
    const r = await runCliJson(["agent", "close", "worker-1", "--json"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(JSON.stringify(r.doc)).toContain("auth/worker-1");
  });

  it("a recovery in this workstream is not refused because the name lives in another", async () => {
    orphaned();
    insertAgent(db, { name: "worker-1", workstream: "other", paneId: "%8", cwd: "/z" });
    const p = await cli("-w", "auth", "worker-1");
    expect(p.exitCode).toBeNull();
    expect(p.data.kind).toBe("recovery");
  });

  it("ambiguous records exit 4 and the hints name every id", async () => {
    const a = orphaned();
    const b = orphaned();
    const r = await cli("-w", "auth", "worker-1");
    expect(r.exitCode).toBe(4);
    const text = JSON.stringify(r.doc);
    expect(text).toContain(`--recovery ${a}`);
    expect(text).toContain(`--recovery ${b}`);
  });

  it("a refusal (live agent) exits 4", async () => {
    const id = orphaned();
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%5", cwd: "/x" });
    const r = await cli("-w", "auth", "worker-1", "--recovery", String(id), "--if", "0");
    expect(r.exitCode).toBe(4);
  });
});
