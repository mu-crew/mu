// The real CLI under SIGINT with a plugin call in flight (plugins spec D13; the
// P6b review's bare-SIGINT finding): `mu host check` on a `--plugin` host whose
// check hangs. mu sends the plugin `$/cancel`, allows one grace, kills its
// group and dies by the signal. Needs dist/ (npm run build).

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_GRACE_MS } from "../src/hosts.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin } from "./_plugin.js";

const BIN = resolve("dist/cli.js");

let dir: string;
let f: FakePlugin;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpsg-"));
  f = fakePlugin(dir);
  env = {
    ...process.env,
    MU_DB_PATH: join(dir, "mu.db"),
    MU_STATE_DIR: join(dir, "state"),
    MU_SYNC_DIR: "",
  };
});

afterEach(() => {
  rmFixtureDir(dir);
});

const mu = (...args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mu under SIGINT with a plugin call in flight", () => {
  it.each([false, true])(
    "cancels, allows one grace, kills the group, dies by SIGINT (plugin ignores EOF: %s)",
    async (ignoreEof) => {
      expect(mu("plugin", "add", "fake", "--", ...f.argv).status).toBe(0);
      expect(mu("host", "add", "box", "--plugin", "fake", "--fetch", "true").status).toBe(0);
      f.set({ ignoreEof, faults: { "link.checkSteps": ["hang"] } });
      const child = spawn(process.execPath, [BIN, "host", "check", "box"], {
        env,
        stdio: "ignore",
      });
      const exit = new Promise<{ code: number | null; signal: string | null }>((r) =>
        child.once("exit", (code, signal) => r({ code, signal })),
      );
      for (let i = 0; i < 250 && !f.calls().some((c) => c.method === "link.checkSteps"); i++)
        await sleep(20);
      const pgid = Number(
        spawnSync("pgrep", ["-f", f.configPath], { encoding: "utf8" }).stdout.trim().split("\n")[0],
      );
      const t0 = Date.now();
      child.kill("SIGINT");
      const status = await exit;
      const took = Date.now() - t0;
      expect(status).toEqual({ code: null, signal: "SIGINT" });
      expect(f.calls().map((c) => c.method)).toContain("$/cancel");
      expect(took).toBeLessThan(HOST_GRACE_MS + 2000);
      if (ignoreEof) expect(took).toBeGreaterThanOrEqual(HOST_GRACE_MS - 100);
      expect(() => process.kill(-pgid, 0)).toThrow();
    },
    20_000,
  );
});
