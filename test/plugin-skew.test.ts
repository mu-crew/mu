// Protocol-version skew (plugins spec D13, D16): the fake plugin speaking 0, 1
// and 2. mu speaks 1..1; a plugin with no overlap is refused at load (exit 4),
// whether it says so or replies with a version mu does not speak.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyError } from "../src/cli/handle.js";
import { startPlugin } from "../src/plugins/client.js";
import { PluginRefusedError } from "../src/plugins/errors.js";
import { PROTOCOL_MAX, PROTOCOL_MIN } from "../src/plugins/protocol.js";
import { rmFixtureDir } from "./_fs.js";
import { fakePlugin } from "./_plugin.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpsk-"));
});

afterEach(() => {
  rmFixtureDir(dir);
});

async function load(speaks: [number, number], extra: Record<string, unknown> = {}) {
  const f = fakePlugin(dir, { speaks, ...extra });
  return { f, started: startPlugin("fake", f.argv, { graceMs: 200 }) };
}

describe("protocol skew", () => {
  it("mu offers its own range in the handshake", async () => {
    const { f, started } = await load([1, 1]);
    const s = await started;
    await s.shutdown();
    expect(f.calls()[0]).toMatchObject({
      method: "initialize",
      params: { protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX } },
    });
  });

  it("a plugin speaking 1 loads at protocol 1", async () => {
    const { started } = await load([1, 1]);
    const s = await started;
    expect(s.init.protocol).toBe(1);
    await s.shutdown();
  });

  it.each([
    [[0, 2], 1],
    [[1, 2], 1],
    [[0, 1], 1],
  ] as const)("a plugin speaking %j loads at the common version %i", async (speaks, at) => {
    const { started } = await load([speaks[0], speaks[1]]);
    const s = await started;
    expect(s.init.protocol).toBe(at);
    await s.shutdown();
  });

  it.each([[[0, 0]], [[2, 2]]] as const)(
    "a plugin speaking only %j is refused at load, exit 4",
    async (speaks) => {
      const { started } = await load([speaks[0], speaks[1]]);
      const err = await started.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PluginRefusedError);
      expect((err as Error).message).toMatch(/no common protocol version/);
      expect(classifyError(err).exitCode).toBe(4);
    },
  );

  it.each([
    [[0, 0], 0],
    [[2, 2], 2],
  ] as const)(
    "a plugin that answers %j's version anyway is refused by mu's own range",
    async (speaks, v) => {
      const { started } = await load([speaks[0], speaks[1]], { liar: true });
      const err = await started.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PluginRefusedError);
      expect((err as Error).message).toContain(`protocol ${v} is outside mu's 1..1`);
    },
  );
});
