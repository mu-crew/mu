// handle() drains a backed-up stdout before it calls process.exit: the one document a
// caller is waiting for must not be truncated by an exit that races a pipe's buffer
// (the `mu wait` result is that document). A real backed-up pipe cannot be built from
// 4 KB of output, so the stream is stubbed: pending bytes, a flush callback that fires
// late, and the order of `write("")` and `process.exit` recorded.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliExitError, handle } from "../src/cli/handle.js";
import { withEnv } from "./_env.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-drain-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run `handle(fn)` with process.stdout reporting `pending` buffered bytes; returns the event order. */
async function run(pending: number): Promise<string[]> {
  const events: string[] = [];
  const out = process.stdout as unknown as {
    write: (chunk: unknown, cb?: () => void) => boolean;
  };
  const realWrite = out.write;
  const realExit = process.exit;
  const had = Object.getOwnPropertyDescriptor(process.stdout, "writableLength");
  Object.defineProperty(process.stdout, "writableLength", {
    configurable: true,
    get: () => pending,
  });
  out.write = (chunk: unknown, cb?: () => void): boolean => {
    if (chunk === "" && cb !== undefined) {
      events.push("drain-requested");
      // the pipe reader is slow: the flush completes after a real delay
      setTimeout(() => {
        events.push("drained");
        cb();
      }, 30);
      return false;
    }
    return true;
  };
  // biome-ignore lint/suspicious/noExplicitAny: test shim
  (process as any).exit = (code?: number) => {
    events.push(`exit:${code}`);
    throw new Error("__exit__");
  };
  try {
    await withEnv("MU_DB_PATH", join(dir, "mu.db"), async () => {
      await handle(async () => {
        throw new CliExitError(7);
      })().catch(() => {});
    });
  } finally {
    out.write = realWrite;
    process.exit = realExit;
    if (had !== undefined) Object.defineProperty(process.stdout, "writableLength", had);
    else delete (process.stdout as unknown as Record<string, unknown>).writableLength;
  }
  return events;
}

describe("handle() exit drain", () => {
  it("with bytes still buffered, process.exit waits for the flush", async () => {
    expect(await run(4096)).toEqual(["drain-requested", "drained", "exit:7"]);
  });

  it("with nothing buffered it exits at once (no extra write)", async () => {
    expect(await run(0)).toEqual(["exit:7"]);
  });
});
