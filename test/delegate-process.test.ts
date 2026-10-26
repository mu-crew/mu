// The mux-free delegate runner's refusals that need no child process.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { runDelegateProcess } from "../src/delegate-process.js";
import {
  DelegateNotFoundError,
  DelegateStateError,
  getDelegateCall,
  markDelegate,
  registerDelegateCall,
} from "../src/delegates.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-dp-unit-"));
  db = openDb({ path: join(dir, "mu.db") });
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

const reg = (request: object = {}) =>
  registerDelegateCall(db, {
    callId: "pi:s:1",
    caller: "pi:s",
    workstream: "scratch",
    request: { text: "check it", ...request },
    state: "starting",
  });

describe("runDelegateProcess", () => {
  it("rejects an unknown call and a call that is running", async () => {
    await expect(runDelegateProcess(db, "pi:s:nope")).rejects.toBeInstanceOf(DelegateNotFoundError);
    reg();
    markDelegate(db, "pi:s:1", "running");
    await expect(runDelegateProcess(db, "pi:s:1")).rejects.toBeInstanceOf(DelegateStateError);
  });

  it("refuses a non-pi cli with nothing spawned (reissuable)", async () => {
    reg({ cli: "claude" });
    const r = await runDelegateProcess(db, "pi:s:1", { extension: "x" });
    expect(r).toMatchObject({
      outcome: "refused",
      state: "refused",
      transport: "process",
      attach: null,
    });
    expect(r.error).toContain("pi only");
    expect(getDelegateCall(db, "pi:s:1")?.state).toBe("refused");
  });

  it("refuses a pi that cannot start, with the command named", async () => {
    const prev = process.env.MU_PI_COMMAND;
    process.env.MU_PI_COMMAND = join(dir, "no-such-pi");
    try {
      reg();
      const r = await runDelegateProcess(db, "pi:s:1", { extension: "x" });
      expect(r).toMatchObject({ outcome: "refused", state: "refused" });
      expect(r.error).toContain("no-such-pi");
    } finally {
      if (prev === undefined) delete process.env.MU_PI_COMMAND;
      else process.env.MU_PI_COMMAND = prev;
    }
  });
});
