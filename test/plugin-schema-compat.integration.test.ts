import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startPlugin } from "../src/plugins/client.js";
import { loadRefusals, narrowJobStart, PLUGIN_SCHEMA_FILE } from "../src/plugins/protocol.js";
import { rmFixtureDir } from "./_fs.js";
import { validates } from "./_json-schema.js";
import { fakePlugin, jobSeams } from "./_plugin.js";

const { oldSchema, newSchema, oldDigest, newDigest, staleDigest } = await vi.hoisted(async () => {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const digest = (bytes: string | Buffer) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const bytes = readFileSync(new URL("../schemas/plugin-protocol-v1.json", import.meta.url));
  const oldSchema = JSON.parse(bytes.toString("utf8")) as {
    $defs: { jobSpec: { properties: Record<string, unknown> } };
  };
  const newSchema = structuredClone(oldSchema);
  newSchema.$defs.jobSpec.properties.label = { type: "string" };
  return {
    oldSchema,
    newSchema,
    oldDigest: digest(bytes),
    newDigest: digest(JSON.stringify(newSchema)),
    staleDigest: `sha256:${"a".repeat(64)}`,
  };
});

// Simulate publishing an additive schema and approving the previous digest for it.
vi.mock(import("../src/plugins/schema-compat.js"), async (original) => ({
  ...(await original()),
  PLUGIN_SCHEMA_DIGEST: newDigest,
  COMPATIBLE_OLDER_SCHEMA_DIGESTS: new Map([
    [newDigest, [oldDigest]],
    [oldDigest, [staleDigest]],
  ]),
}));

it("an old-digest plugin still starts a job with an unfamiliar optional field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpcompat-"));
  try {
    const f = fakePlugin(dir, { schema: oldDigest, seams: jobSeams() });
    const spec = {
      workstream: "ws",
      name: "worker",
      harness: "pi",
      role: "full-access",
      cmd: "pi",
      commandSource: "cli-key",
      cwd: "/repo",
      env: {},
    };
    const extended = { ...spec, label: "optional" };
    expect(validates(oldSchema, "jobSpec", spec)).toBe(true);
    expect(validates(oldSchema, "jobSpec", extended)).toBe(false);
    expect(validates(newSchema, "jobSpec", spec)).toBe(true);
    expect(validates(newSchema, "jobSpec", extended)).toBe(true);

    const s = await startPlugin(f.name, f.argv, { needs: ["job"], graceMs: 200 });
    try {
      expect(s.init.schema).toBe(oldDigest);
      // Approval for an older mu schema is not automatically transitive.
      expect(loadRefusals({ ...s.init, schema: staleDigest }, { name: f.name })).toEqual([
        expect.stringContaining(
          `rebuild the plugin against schema ${PLUGIN_SCHEMA_FILE} (${newDigest})`,
        ),
      ]);
      const result = await s.call(
        "job.start",
        {
          target: { host: { name: "box" }, job: { kind: "fakejob", key: "start" } },
          key: "start",
          spec: extended,
        },
        { kind: "effect", timeoutMs: 10_000 },
        narrowJobStart,
      );
      expect(result).toEqual({ handle: "job-1", view: { command: "sleep 600", env: {} } });
      expect(f.calls().find(({ method }) => method === "job.start")?.params.spec).toEqual(extended);
      expect(f.backend().starts).toBe(1);
    } finally {
      await s.shutdown();
    }
  } finally {
    rmFixtureDir(dir);
  }
});
