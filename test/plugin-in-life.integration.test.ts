// In-life collects and the deadline event after review of P6e2 (plugins spec
// D10, R8; rulings 2 and 3), over the fake plugin as a provider with a pushing
// link, real git on both sides and a multiplexer stub:
//   - an in-life collect never touches final_owed, even once the job is stopped;
//   - its backoff is read and written under the collect lock: two concurrent
//     failures lose no update (the second sees the first's backoff);
//   - inside the deadline margin a successful collect backs off too;
//   - mu wait prints its result and saves its resume before it collects: a kill
//     while the collect's fetch is in flight loses no consumed event.

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpStopGen, getCarrierJobByAgent } from "../src/carrier-jobs.js";
import { cmdWait } from "../src/cli/wait.js";
import { collectAtSettles } from "../src/host-policy.js";
import type { WaitResult } from "../src/wait.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
const MARGIN = "MU_HOST_DEADLINE_MARGIN_MS";
const REF = { kind: "agent" as const, workstream: "ws", id: "w1" };
const settle = (kind: "settled" | "deadline" = "settled"): Pick<WaitResult, "event" | "refs"> => ({
  event: { kind, ref: REF },
  refs: [{ ref: REF, status: "idle", settled: true, fired: kind === "settled", dead: false }],
});

let home: string | undefined;
let cwd: string;
let local: string;
let deadlineAt: number;

beforeEach(async () => {
  home = process.env.HOME;
  cwd = process.cwd();
  process.env.HOME = h.dir;
  local = join(h.dir, "local");
  mkdirSync(local);
  local = realpathSync(local);
  git(local, "init", "-q");
  git(local, "commit", "-q", "--allow-empty", "-m", "base");
  process.chdir(local);
  deadlineAt = Date.now() + 3_600_000;
  await h.setup({ firstTurn: "at-start" }, { hostFacts: { deadlineAt } }, { push: true });
});

afterEach(() => {
  process.chdir(cwd);
  process.env.HOME = home;
  delete process.env[MARGIN];
});

const spawnW1 = () =>
  h.spawn({ firstPrompt: "hello", worktree: true, root: join(h.dir, "remote") });

describe("in-life collects (D10, ruling 2)", () => {
  it("never clear final_owed, even after the job's stop", async () => {
    const a = await spawnW1();
    const job = getCarrierJobByAgent(h.db, a.incarnation);
    bumpStopGen(h.db, job?.token ?? "");
    expect(await collectAtSettles(h.db, settle("deadline"), 1000)).toEqual([]);
    expect(h.calls("link.fetch")).toHaveLength(1);
    expect(getCarrierJobByAgent(h.db, a.incarnation)?.finalOwed).toBe(true);
  });

  it("two concurrent failures lose no backoff update: the second sees the first's", async () => {
    const a = await spawnW1();
    h.f.set({ faults: { "link.fetch": ["permanent", "permanent"] } });
    const warned = await Promise.all([
      collectAtSettles(h.db, settle(), 1000),
      collectAtSettles(h.db, settle(), 1000),
    ]);
    expect(warned.flat()).toHaveLength(1);
    expect(h.calls("link.fetch")).toHaveLength(1);
    expect(getCarrierJobByAgent(h.db, a.incarnation)).toMatchObject({
      collectDelayMs: 1000,
      finalOwed: true,
    });
  });
});

describe("inside the deadline margin (ruling 3)", () => {
  it("a successful in-life collect backs off too", async () => {
    const a = await spawnW1();
    process.env[MARGIN] = String(deadlineAt - Date.now() + 60_000);
    expect(await collectAtSettles(h.db, settle(), 1000)).toEqual([]);
    const job = getCarrierJobByAgent(h.db, a.incarnation);
    expect(job?.collectNextAt).toBeGreaterThan(Date.now());
    expect(await collectAtSettles(h.db, settle(), 1000)).toEqual([]);
    expect(h.calls("link.fetch")).toHaveLength(1);
  });

  it("mu wait prints its result and saves its resume before it collects", async () => {
    await spawnW1();
    h.f.set({ faults: { "link.fetch": ["late"] }, lateMs: 2000 });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const done = cmdWait(
        h.db,
        ["agent:w1@0"],
        { workstream: "ws", timeout: 20 },
        { signal: new AbortController().signal, which: () => undefined, dispose: () => {} },
      ).catch(() => {});
      // The window: the collect's fetch is in flight. A kill here must lose nothing.
      const until = Date.now() + 15_000;
      while (h.calls("link.fetch").length === 0 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(h.calls("link.fetch")).toHaveLength(1);
      const printed = out.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(printed).toMatch(/"kind":"settled"/);
      // Whatever the wait saves (here nothing is owed: no resume) is saved before the collect.
      const resumes = () =>
        (h.db.prepare("SELECT COUNT(*) AS n FROM wait_resumes").get() as { n: number }).n;
      const inWindow = resumes();
      await done;
      expect(resumes()).toBe(inWindow);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
