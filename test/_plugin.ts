// The fake plugin (test/_fake-plugin.mjs) installed as a real executable for a
// test: `<dir>/bin/mu-plugin-<name>`, a 0755 shell script that runs the fake
// under this node with its JSON config. `calls()` reads the requests it got.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "_fake-plugin.mjs");

export interface FakePlugin {
  readonly name: string;
  /** The executable: `<dir>/bin/mu-plugin-<name>`. */
  readonly path: string;
  /** What `mu plugin add <name> --` takes. */
  readonly argv: string[];
  readonly configPath: string;
  /** Replace keys of the config (re-read by the fake on every request). */
  set(patch: Record<string, unknown>): void;
  /** Every request the fake got, in order (initialize included). */
  calls(): Array<{ method: string; params: Record<string, unknown> }>;
}

export function fakePlugin(
  dir: string,
  config: Record<string, unknown> = {},
  name = "fake",
): FakePlugin {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, `mu-plugin-${name}`);
  const configPath = join(dir, `${name}-config.json`);
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(path, 0o755);
  let current: Record<string, unknown> = { name, home: dir, ...config };
  writeFileSync(configPath, JSON.stringify(current));
  return {
    name,
    path,
    argv: [path, configPath],
    configPath,
    set(patch) {
      current = { ...current, ...patch };
      writeFileSync(configPath, JSON.stringify(current));
    },
    calls() {
      try {
        return readFileSync(`${configPath}.log`, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
      } catch {
        return [];
      }
    },
  };
}

/** The fake's link seam with `patch` applied. */
export function linkSeam(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    link: {
      fetch: true,
      slots: "self",
      remoteOnTimeout: "stopped",
      quiescence: "provable",
      maxScriptBytes: 131072,
      checks: ["reach"],
      ...patch,
    },
  };
}
