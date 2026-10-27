// The runner's per-call env and its one terminate path (SIGTERM, resolve once
// the child EXITED, SIGKILL after the drain bound), against real children: a
// fake `mu` on PATH (extension/mu-run.ts runs `mu` when no dist/cli.js sits
// next to it, as from source).

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultRunner, runChild } from "../extension/mu-run.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
const FAKE = `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === "env") {
  process.stdout.write(JSON.stringify({ sid: process.env.PI_SESSION_ID ?? null, m: process.env.MU_MANAGED_AGENT ?? null, keep: process.env.KEEP ?? null }));
  process.exit(0);
}
// "wait": block until a signal; "term" prints its final document, "stubborn" ignores it.
process.on("SIGTERM", () => {
  if (mode === "stubborn") return;
  process.stdout.write(JSON.stringify({ ok: true, data: { interrupted: true, exit: 143 } }));
  process.exit(143);
});
process.stdout.write("");
setInterval(() => {}, 1000);
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-run-"));
  const bin = join(dir, "mu");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
});
afterAll(() => {
  try {
    rmFixtureDir(dir);
  } catch {}
});

const onPath = (fn: () => Promise<void>) => withEnv("PATH", `${dir}:${process.env.PATH}`, fn);
const started = () => new Promise((r) => setTimeout(r, 300));

describe("defaultRunner", () => {
  it("per-call env reaches only that child; undefined deletes a key", () =>
    onPath(async () => {
      await withEnv("MU_MANAGED_AGENT", "1", () =>
        withEnv("KEEP", "k", async () => {
          const run = defaultRunner();
          const a = await run(["env"], undefined, undefined, {
            env: { PI_SESSION_ID: "s1", MU_MANAGED_AGENT: undefined },
          });
          expect(JSON.parse(a.stdout)).toEqual({ sid: "s1", m: null, keep: "k" });
          expect(process.env.PI_SESSION_ID).not.toBe("s1");
          const b = await run(["env"]);
          expect(JSON.parse(b.stdout)).toMatchObject({ m: "1", keep: "k" });
        }),
      );
    }));

  it("drainMs: an abort is SIGTERM, and the child's final document survives", () =>
    onPath(async () => {
      const ctl = new AbortController();
      const p = defaultRunner()(["term"], ctl.signal, undefined, { drainMs: 3000 });
      await started();
      ctl.abort();
      const r = await p;
      expect(r.code).toBe(143);
      expect(JSON.parse(r.stdout)).toEqual({ ok: true, data: { interrupted: true, exit: 143 } });
    }));

  it("drainMs: a child that ignores SIGTERM is killed after the drain bound", () =>
    onPath(async () => {
      const ctl = new AbortController();
      const p = defaultRunner()(["stubborn"], ctl.signal, undefined, { drainMs: 200 });
      await started();
      const t0 = Date.now();
      ctl.abort();
      const r = await p;
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(r.stdout).toBe("");
    }));

  it("an already-aborted signal with drainMs still terminates the child", () =>
    onPath(async () => {
      const ctl = new AbortController();
      ctl.abort();
      const r = await defaultRunner()(["term"], ctl.signal, undefined, { drainMs: 200 });
      expect(r.code).not.toBe(0);
    }));

  // runChild directly (real `sh`): a child that traps TERM finishes its cleanup first.
  it("waits for a child that traps TERM to finish its cleanup", async () => {
    const ctl = new AbortController();
    const done = runChild(
      "sh",
      // the trap also kills the background sleep: left alive it holds the stdout pipe and execFile
      // would not call back until it exits (10 s), which is not the thing under test
      [
        "-c",
        "trap 'kill $p; sleep 0.3; echo rolled-back; exit 143' TERM; echo up; sleep 10 & p=$!; wait",
      ],
      ctl.signal,
    );
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    ctl.abort();
    const r = await done;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r.code).toBe(143);
    expect(r.stdout).toContain("rolled-back");
  });

  it("an already-aborted signal still runs and reaps the child", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await runChild("sh", ["-c", "sleep 10"], ctl.signal);
    expect(r.code).not.toBe(0);
  });
});
