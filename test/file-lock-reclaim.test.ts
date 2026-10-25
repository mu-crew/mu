// withFileLock strict: the re-probe under the reclaim claim. A remover that
// probed a dead holder, then lost the race to a newer live holder, must not
// remove that holder. The pause is injected where the race happens: just
// before the O_EXCL claim file is written.

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmFixtureDir } from "./_fs.js";

const hook = vi.hoisted(() => ({ beforeClaim: undefined as undefined | (() => void) }));

vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    writeFile: (async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith(".reclaim")) hook.beforeClaim?.();
      return (real.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
    }) as typeof real.writeFile,
  };
});

import { withFileLock } from "../src/file-lock.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-lock-reclaim-"));
});
afterEach(() => {
  hook.beforeClaim = undefined;
  rmFixtureDir(dir);
});

it("a remover whose probe went stale never removes the live holder that took the path since", async () => {
  const lock = join(dir, "z.lock");
  const old = new Date(Date.now() - 3_600_000);
  mkdirSync(lock);
  writeFileSync(
    join(lock, "meta.json"),
    JSON.stringify({ pid: 2 ** 22 + 12345, label: "dead", acquiredAt: "t", token: "dead" }),
  );
  utimesSync(lock, old, old);
  // Between the probe and the claim: the dead lock is replaced by a live holder's.
  hook.beforeClaim = () => {
    hook.beforeClaim = undefined;
    writeFileSync(
      join(lock, "meta.json"),
      JSON.stringify({ pid: process.pid, label: "live", acquiredAt: "t", token: "live" }),
    );
    const now = new Date();
    utimesSync(lock, now, now);
  };
  let ran = false;
  await expect(
    withFileLock(
      lock,
      "remover",
      async () => {
        ran = true;
      },
      {
        strict: true,
        staleLockMs: 60_000,
        acquireTimeoutMs: 100,
        onUnavailable: () => {
          throw new Error("unavailable");
        },
      },
    ),
  ).rejects.toThrow("unavailable");
  expect(ran).toBe(false);
  expect(
    JSON.parse((await import("node:fs")).readFileSync(join(lock, "meta.json"), "utf8")).token,
  ).toBe("live");
});
