import { ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import type { Db } from "../src/db.js";
import { PluginProcess } from "../src/plugins/process.js";
import { addPlugin } from "../src/plugins/registry.js";
import type { FakePlugin } from "./_plugin.js";
import { initializeReply } from "./_plugin-initialize.mjs";

/** Setup or a scripted read over pipes, with the actual JSON-RPC parser and load rules. */
export async function withPluginPipes<T>(
  fake: FakePlugin,
  run: () => Promise<T>,
  read?: { method: string; result: unknown },
): Promise<T> {
  const start = vi.spyOn(PluginProcess, "start").mockImplementationOnce(async (argv, _, grace) => {
    const { path, configPath } = fake;
    if (argv[0] !== path || argv[1] !== configPath) throw new Error("unexpected plugin argv");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const child = new ChildProcess();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    const proc = PluginProcess.fromTestPipes(child, grace);
    stdin.on("data", (chunk: Buffer) => {
      // PluginProcess writes one complete request at a time. A peer replies after
      // that write returns, just as a separate process would.
      const { id, method, params } = JSON.parse(chunk.toString("utf8")) as {
        id: number;
        method: string;
        params: unknown;
      };
      appendFileSync(`${configPath}.log`, `${JSON.stringify({ method, params })}\n`);
      let reply: unknown;
      if (method === "initialize") reply = initializeReply(config, id, params);
      else if (method === "shutdown" || method === read?.method) {
        reply = { jsonrpc: "2.0", id, result: method === "shutdown" ? null : read?.result };
      } else throw new Error(`pipe fixture cannot answer ${method}`);
      queueMicrotask(() => {
        if (!stdout.destroyed) stdout.write(`${JSON.stringify(reply)}\n`);
      });
    });
    stdin.once("end", () => {
      stdout.end();
      stderr.end();
      child.emit("exit", 0, null);
    });
    return proc;
  });
  try {
    return await run();
  } finally {
    start.mockRestore();
  }
}

/** A fixture's registration does not test executable startup; later calls still use the real fake. */
export function registerFixturePlugin(db: Db, fake: FakePlugin) {
  return withPluginPipes(fake, () => addPlugin(db, fake.name, fake.argv));
}
