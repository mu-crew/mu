// Needs a built dist/ (integration tier: npm run build runs first).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mu-sdk-entry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("published entry exports addTasks", () => {
  const entry = resolve(__dirname, "..", "dist", "index.js");
  it.skipIf(!existsSync(entry))("dist/index.js exposes addTasks and it works", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as sdk from ${JSON.stringify(entry)};
         const db = sdk.openDb({ path: ${JSON.stringify(join(dir, "sdk.db"))} });
         sdk.ensureWorkstream(db, "w");
         const r = sdk.addTasks(db, [{ id: "a", title: "A" }], { workstream: "w" });
         console.log(typeof sdk.addTasks, JSON.stringify(r.ids));`,
      ],
      { encoding: "utf8", env: { ...process.env, MU_SYNC_DIR: "" } },
    );
    expect(out.trim()).toBe('function ["a"]');
  });
});
