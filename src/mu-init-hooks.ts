// mu — mu's `mu hook stop` entry in each harness's own hook config: the
// matcher that tells mu's entries from everyone else's, the merge-safe write
// `mu init` makes, and the read-only check `mu doctor` runs through the same
// matcher (spec "Every harness first-class", D7, D13). The rules are in
// src/mu-init.ts's header.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { FleetHazard } from "./fleet-hazards.js";
import {
  HARNESS_TABLE,
  HARNESSES,
  type Harness,
  harnessHomePath,
  homeHookConfig,
  hookConfigPath,
  takesMuStopHook,
} from "./harnesses.js";
import { STOP_HOOK_TIMEOUT_S } from "./hook-stop.js";
import type { InitItem } from "./mu-init.js";

/** The command of mu's hook entry for `h`. `|| true`: a Stop hook's exit 2 is
 *  "block, and hand stderr to the model" to claude and codex, and a mu on PATH
 *  older than the verb exits 2 on it. */
export function muHookCommand(h: Harness): string {
  return `mu hook stop ${h} --timeout ${STOP_HOOK_TIMEOUT_S} || true`;
}

export const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** True for a command `init` wrote for `h`, in this or an older form. */
export function isMuWrittenHook(command: unknown, h: Harness): boolean {
  if (typeof command !== "string") return false;
  const name = h.replace(RE_SPECIAL, "\\$&");
  return new RegExp(`^mu hook stop ${name}( --timeout \\d+)? \\|\\| true$`).test(command.trim());
}

/** True for any command that runs `mu hook stop`, however it is spelled. */
function runsMuHookStop(command: unknown): boolean {
  return typeof command === "string" && /(^|[\s/;&|(])mu\s+hook\s+stop(\s|$)/.test(command);
}

/** How a config file nests its handlers: Claude Code's `hooks.<Event>[].hooks[]` (codex too), or cursor's flat `hooks.<event>[]`. */
type Shape = "grouped" | "flat";

function hookShape(h: Harness): Shape {
  return h === "cursor-agent" ? "flat" : "grouped";
}

/** The native event mu's entry hangs on: the row's stop event (`Stop`, cursor's `stop`). */
function stopEvent(h: Harness): string {
  return HARNESS_TABLE[h].events.turn_stopped[0]?.name ?? "Stop";
}

/** The handler `init` writes. cursor's own cap on stop follow-ups (`loop_limit`)
 *  is lifted: mu caps its own blocks (`MU_KEEP_DRIVING_MAX`). */
function muHandler(h: Harness): Record<string, unknown> {
  const command = muHookCommand(h);
  return hookShape(h) === "flat"
    ? { command, timeout: STOP_HOOK_TIMEOUT_S, loop_limit: null }
    : { type: "command", command, timeout: STOP_HOOK_TIMEOUT_S };
}

/** The file holds something mu will not guess its way through. */
class Unworkable extends Error {}

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What bringing one file in line takes. */
export interface HookPlan {
  changes: string[];
  /** The command of an entry mu did not write that runs `mu hook stop`. */
  foreign?: string;
}

/**
 * Bring `root`, one parsed config file, in line with mu's entry for `h`, in
 * place. The first handler mu wrote on the stop event is kept, wherever it
 * sits, and its fields set to what `init` writes; any further one is removed
 * (a group mu emptied goes with it). With none, a new one is appended. A
 * handler mu did not write that runs `mu hook stop` wins: mu removes every
 * handler of its own and adds none, so two consuming waits never run.
 */
export function planMuHook(h: Harness, root: Json): HookPlan {
  const plan: HookPlan = { changes: [] };
  if (root.hooks !== undefined && !isObject(root.hooks)) {
    throw new Unworkable("its `hooks` is not an object");
  }
  const hooks: Json = isObject(root.hooks) ? root.hooks : {};
  const event = stopEvent(h);
  const shape = hookShape(h);
  const entries = hooks[event] ?? [];
  if (!Array.isArray(entries)) throw new Unworkable(`its \`hooks.${event}\` is not a list`);

  const lists: { group: Json | null; list: unknown[] }[] =
    shape === "flat"
      ? [{ group: null, list: entries }]
      : entries
          .filter((g): g is Json => isObject(g) && Array.isArray(g.hooks))
          .map((group) => ({ group, list: group.hooks as unknown[] }));
  for (const { list } of lists) {
    for (const handler of list) {
      if (!isObject(handler) || isMuWrittenHook(handler.command, h)) continue;
      if (runsMuHookStop(handler.command)) plan.foreign ??= String(handler.command);
    }
  }
  let kept: Json | undefined;
  for (const { group, list } of lists) {
    const before = list.length;
    for (let i = 0; i < list.length; i++) {
      const handler = list[i];
      if (!isObject(handler) || !isMuWrittenHook(handler.command, h)) continue;
      if (kept === undefined && plan.foreign === undefined) {
        kept = handler;
        continue;
      }
      list.splice(i, 1);
      i--;
      plan.changes.push(
        plan.foreign === undefined
          ? `removed a duplicate ${event} entry`
          : `removed its ${event} entry: one mu did not write already runs it (\`${plan.foreign}\`)`,
      );
    }
    if (group !== null && before > 0 && list.length === 0)
      entries.splice(entries.indexOf(group), 1);
  }

  if (kept !== undefined) {
    const want = muHandler(h);
    if (Object.entries(want).some(([k, v]) => kept[k] !== v)) {
      Object.assign(kept, want);
      plan.changes.push(`updated ${event}`);
    }
  } else if (plan.foreign === undefined) {
    const handler = muHandler(h);
    entries.push(shape === "flat" ? handler : { hooks: [handler] });
    plan.changes.push(`added ${event}`);
  }
  if (plan.changes.length > 0) {
    hooks[event] = entries;
    root.hooks = hooks;
    // The Cursor CLI reads no hook file without its schema version.
    if (shape === "flat" && root.version === undefined) root.version = 1;
  }
  return plan;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Unworkable(`cannot read it: ${(err as Error).message}`);
  }
}

/** The parsed file, `{}` when it does not exist or is empty. */
function readConfig(path: string): { root: Json; text: string | null } {
  const text = readText(path);
  if (text === null || text.trim() === "") return { root: {}, text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Unworkable(`it is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(parsed)) throw new Unworkable("it is not a JSON object");
  return { root: parsed, text };
}

/** The end of `path`'s symlink chain, so a dotfiles checkout keeps its link. */
function writeTarget(path: string): string {
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    let link: boolean;
    try {
      link = lstatSync(current).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw new Unworkable(`cannot read it: ${(err as Error).message}`);
    }
    if (!link) return current;
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw new Unworkable("its symlinks loop");
}

/** The file changed under mu between its read and its write. */
class Raced extends Error {}

/** Test seam: runs after the new contents are staged, before the re-read that guards the rename. */
let beforeCommit: ((path: string) => void) | undefined;

export function setInitBeforeCommitForTests(hook: ((path: string) => void) | undefined): void {
  beforeCommit = hook;
}

/**
 * Replace the file in one rename, through a symlink to its target, keeping
 * the target's mode. The file's other writers lock nothing either, so it is
 * read again just before the rename: if it is no longer the text the plan was
 * made from, nothing is written (Raced) and the caller plans again.
 */
function writeConfig(path: string, root: Json, readFrom: string | null): void {
  const real = writeTarget(path);
  mkdirSync(dirname(real), { recursive: true });
  let mode = 0o600; // a new file: settings can carry secrets
  try {
    mode = statSync(real).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = join(dirname(real), `.${basename(real)}.mu-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, { mode });
    beforeCommit?.(path);
    if (readText(real) !== readFrom) throw new Raced();
    renameSync(tmp, real);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const WRITE_ATTEMPTS = 3;

export function installHook(h: Harness, path: string): Pick<InitItem, "state" | "detail"> {
  for (let attempt = 1; ; attempt++) {
    const { root, text } = readConfig(path);
    const plan = planMuHook(h, root);
    if (plan.changes.length === 0) {
      return plan.foreign !== undefined
        ? {
            state: "kept",
            detail: `an entry mu did not write already runs it (\`${plan.foreign}\`): left as found`,
          }
        : { state: "unchanged", detail: `\`${muHookCommand(h)}\` on ${stopEvent(h)}` };
    }
    try {
      writeConfig(path, root, text);
      return { state: "written", detail: [...new Set(plan.changes)].join("; ") };
    } catch (err) {
      if (!(err instanceof Raced)) throw err;
      if (attempt >= WRITE_ATTEMPTS) {
        throw new Unworkable("another program kept changing it; run `mu init` again");
      }
    }
  }
}

/** The config directory whose presence says the harness is set up here, where its variable moves it. */
export function setupPath(h: Harness, home: string, env: NodeJS.ProcessEnv): string | undefined {
  const dir = homeHookConfig(h)?.split("/")[0];
  return dir === undefined ? undefined : harnessHomePath(h, dir, home, env);
}

export function isSetUp(h: Harness, home: string, env: NodeJS.ProcessEnv): boolean {
  const dir = setupPath(h, home, env);
  return dir !== undefined && existsSync(dir);
}

/**
 * `mu doctor`'s hooks step (D13: each tool checks its own entries): for each
 * harness mu writes a Stop entry for and that is set up here, whether its
 * config holds mu's entry as `init` writes it. Read-only, through `init`'s own
 * matcher (`planMuHook` on a fresh parse, never written): `missing` (init would add one), `drifted`
 * (init would update or deduplicate it), `foreign` (an entry mu did not write
 * runs `mu hook stop`; init leaves it). Warn rows only: an orchestrator of
 * that harness loses keep-driving, and nothing else breaks.
 */
export function checkMuHooks(home: string, env: NodeJS.ProcessEnv = process.env): FleetHazard[] {
  const rows: FleetHazard[] = [];
  for (const h of HARNESSES) {
    const path = hookConfigPath(h, home, env);
    if (!takesMuStopHook(h) || path === undefined) continue;
    if (!isSetUp(h, home, env) && !existsSync(path)) continue;
    const fix = [`run \`mu init --harness ${h}\` (it touches only mu's own entry in ${path})`];
    let plan: HookPlan;
    try {
      plan = planMuHook(h, readConfig(path).root);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      rows.push({ name: h, severity: "warn", detail: `${path}: cannot check it: ${why}` });
      continue;
    }
    const added = plan.changes.some((c) => c.startsWith("added"));
    if (plan.foreign !== undefined) {
      rows.push({
        name: h,
        severity: "warn",
        detail: `foreign: an entry mu did not write runs \`mu hook stop\` in ${path} (\`${plan.foreign}\`)${plan.changes.length > 0 ? ", beside mu's own" : ""}`,
        remediation: [
          plan.changes.length > 0
            ? "two consuming waits would run: `mu init` removes mu's own and leaves yours"
            : "mu init leaves it as found: check it exits 0 on every path, or remove it and run `mu init`",
        ],
      });
    } else if (added) {
      rows.push({
        name: h,
        severity: "warn",
        detail: `missing: no \`${muHookCommand(h)}\` on ${stopEvent(h)} in ${path}: an orchestrator of this harness gets no keep-driving`,
        remediation: fix,
      });
    } else if (plan.changes.length > 0) {
      rows.push({
        name: h,
        severity: "warn",
        detail: `drifted: mu init would change ${path} (${[...new Set(plan.changes)].join("; ")})`,
        remediation: fix,
      });
    } else {
      rows.push({
        name: h,
        severity: "ok",
        detail: `\`${muHookCommand(h)}\` on ${stopEvent(h)} in ${path}`,
      });
    }
  }
  return rows;
}
