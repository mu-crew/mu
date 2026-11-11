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
  /** Every request (and `$/cancel`) the fake got, in order (initialize included). */
  calls(): Array<{ method: string; params: Record<string, unknown> }>;
  /** How many times the fake finished its EOF cleanup and exited on its own. */
  cleanExits(): number;
  /** The fake backend: jobs by key and the effects that really happened. */
  backend(): FakeBackend;
}

export interface FakeBackend {
  jobs: Record<string, { start: { handle?: string; view: unknown }; stopped: boolean }>;
  starts: number;
  stops: number;
  deliveries: number;
  /** The host seam: hosts by acquire key, and the acquires and releases that happened. */
  hosts?: Record<string, { facts: { handle: string }; released: boolean }>;
  acquires?: number;
  releases?: number;
}

/** The log line the fake writes when it exits on EOF after its cleanup. */
const CLEAN_EXIT = "(clean exit)";

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
  const log = (): Array<{ method: string; params: Record<string, unknown> }> => {
    try {
      return readFileSync(`${configPath}.log`, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
    } catch {
      return [];
    }
  };
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
      return log().filter((e) => e.method !== CLEAN_EXIT);
    },
    cleanExits() {
      return log().filter((e) => e.method === CLEAN_EXIT).length;
    },
    backend() {
      try {
        return JSON.parse(readFileSync(`${configPath}.jobs`, "utf8")) as FakeBackend;
      } catch {
        return { jobs: {}, starts: 0, stops: 0, deliveries: 0 };
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

/** The fake's link and a bound `reply` job seam (lookup and exact dedupe), with `patch` applied. */
export function jobSeams(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...linkSeam(),
    job: {
      kind: "fakejob",
      view: "bound",
      handle: "reply",
      start: { lookup: true, dedupe: { exact: true, windowMs: 60_000 }, fenceKey: true },
      ...patch,
    },
  };
}

/** The fake as a provider: a host seam (lookup, exact dedupe, fenceKey) with its link and job seams. */
export function providerSeams(
  job: Record<string, unknown> = {},
  link: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...jobSeams(job),
    link: { ...(linkSeam().link as Record<string, unknown>), ...link },
    host: { acquire: { lookup: true, dedupe: { exact: true, windowMs: 60_000 }, fenceKey: true } },
  };
}

/** The shipped example plugin (examples/plugins/mu-plugin-ssh). */
export const SSH_EXAMPLE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "examples",
  "plugins",
  "mu-plugin-ssh",
);

/**
 * A stand-in `ssh` for the example plugin: skips ssh's options (git passes `-o`, `-p`), takes the
 * destination, and runs the remote command with /bin/sh in `home`. With `<dir>/handback` present
 * it fails as ssh does on a refused key. Returns the argv for `mu plugin add ssh --`.
 */
export function sshExample(dir: string, home: string): string[] {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, "fake-ssh");
  writeFileSync(
    fake,
    `#!/bin/sh
while :; do case "$1" in -o|-p|-J) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
[ -f '${join(dir, "handback")}' ] && { echo 'user@dev: Permission denied (publickey).' >&2; exit 255; }
cd '${home}' && exec /bin/sh -c "$*"
`,
  );
  chmodSync(fake, 0o755);
  return [SSH_EXAMPLE, fake];
}
