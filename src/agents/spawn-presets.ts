// mu — the launch command of a spawn, with its harness row's spawn presets
// (spec D6, D17): the row's model flag for `--model` (pi included); for a
// worker launched from a command mu resolved (its cli key or
// `MU_<KEY>_COMMAND`, not a literal `--command`), local or remote (approvals
// are per worker, D17: a remote worker's flags ride in its remote command),
// the row's auto-approve flags (pi has none: its `--approve` is
// folder trust); for any launch from a command mu resolved, orchestrators
// too, the row's launch flags (codex's `--no-daemon`) that the launcher's own
// `--help` lists (an older codex rejects an unknown flag before it starts):
// locally probed and cached per binary, on a host what `mu host check`
// recorded; and for a worktree mu
// just created, the row's trust flag on its real path (folder trust is per
// exact path): locally its realpath, on a host the physical path the host's
// `pwd -P` answered when it made the worktree. The argv0 is
// untouched, so every rule that reads it (speaksMuCtl, the harness) reads the
// same; the agents row keeps the command as given.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { HARNESS_TABLE, type Harness, withSpawnPresets } from "../harnesses.js";
import { hostLaunchFlags } from "../host-harnesses.js";
import type { HostProfile } from "../hosts.js";
import { defaultCacheDir } from "../state-dir.js";

/** The real path of a directory mu created (`/tmp` is `/private/tmp` on macOS); itself if unreadable. */
function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** How long a launcher's `--help` may take before its flags count as unsupported. */
const HELP_TIMEOUT_MS = 5000;

/** The `--help` text of the executable at `path`; undefined when it fails. */
function readHelp(path: string): string | undefined {
  try {
    return execFileSync(path, ["--help"], {
      encoding: "utf8",
      timeout: HELP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

type LocalFlags = (command: string, harness: Harness) => readonly string[];
let localFlagsForTests: LocalFlags | null = null;

/**
 * Replace the local launch-flag probe (null: the real one, `localLaunchFlags`).
 * test/_setup.ts installs one that finds none, so no test runs the machine's
 * own codex.
 */
export function setLocalLaunchFlagsForTests(f: LocalFlags | null): void {
  localFlagsForTests = f;
}

/** `argv0` as the pane's shell finds it: itself with a slash, else the first match on PATH. */
function onPath(argv0: string): string | undefined {
  if (argv0.includes("/")) return isAbsolute(argv0) ? argv0 : undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const p = join(dir, argv0);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // next
    }
  }
  return undefined;
}

/** Whether `help` lists `flag` as its own word. */
function listsFlag(help: string, flag: string): boolean {
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}([^A-Za-z0-9_-]|$)`, "m").test(help);
}

/**
 * The row's launch flags the local launcher of `command` lists in `--help`,
 * cached in the cache dir per binary (its real path, size and mtime: an
 * upgrade is probed again). None when the launcher is not found or its help
 * fails (not cached: the next spawn asks again).
 */
export function localLaunchFlags(command: string, harness: Harness): readonly string[] {
  const flags = HARNESS_TABLE[harness].launchFlags;
  if (flags.length === 0) return [];
  const found = onPath(command.trim().split(/\s+/)[0] ?? "");
  if (found === undefined) return [];
  let key: string;
  try {
    const real = realpathSync(found);
    const st = statSync(real);
    key = `${real}|${st.size}|${st.mtimeMs}`;
  } catch {
    return [];
  }
  const file = join(defaultCacheDir(), "launch-flags.json");
  let cache: Record<string, unknown> = {};
  try {
    const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) {
      cache = doc as Record<string, unknown>;
    }
  } catch {
    // none yet, or unreadable: probe
  }
  const hit = cache[key];
  if (Array.isArray(hit)) return flags.filter((f) => hit.includes(f));
  const help = readHelp(found);
  if (help === undefined) return [];
  const listed = flags.filter((f) => listsFlag(help, f));
  try {
    mkdirSync(defaultCacheDir(), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...cache, [key]: listed })}\n`);
  } catch {
    // a cache mu can lose
  }
  return listed;
}

export function launchCommand(
  command: string,
  harness: Harness | undefined,
  opts: { model?: string; command?: string; orchestrator?: boolean },
  where: {
    remote: boolean;
    worktree?: string;
    /** A host spawn's profile: its recorded probe says which launch flags its launcher takes. */
    profile?: Pick<HostProfile, "capabilities">;
  },
): string {
  const model = opts.model !== undefined ? { model: opts.model } : {};
  const resolved = opts.command === undefined;
  const approve = resolved && opts.orchestrator !== true;
  const launchFlags =
    !resolved || harness === undefined
      ? []
      : where.remote
        ? hostLaunchFlags(where.profile, harness, command)
        : (localFlagsForTests ?? localLaunchFlags)(command, harness);
  const trustPath =
    where.worktree === undefined
      ? undefined
      : where.remote
        ? where.worktree
        : realPathOf(where.worktree);
  return withSpawnPresets(command, harness, {
    ...model,
    approve,
    launchFlags,
    ...(trustPath !== undefined ? { trustPath } : {}),
  });
}
