// mu — `mu init`: mu's hook entries and mu's skill, written where each
// harness reads them (spec "Every harness first-class", D13, D17).
//
// Hook entries. claude, codex and cursor-agent get one `mu hook stop
// <harness>` entry on their stop event, in their own config file (D6
// `hookConfig`): `~/.claude/settings.json`, `~/.codex/hooks.json`,
// `~/.cursor/hooks.json`. Muse Code gets none (its Stop block does not deliver
// the reason, D7), and pi has its settle nudge in the pi package. Those files
// are shared with murmur, museum, muzzle and the user, so mu touches only the
// entries it wrote: a handler whose command is one of the forms below. Every
// other handler, group and key stays as it was found, in place. An entry mu did
// not write that already runs `mu hook stop` (a wrapper, an absolute path, a
// hand-tuned timeout) is left alone, and mu keeps none of its own beside it:
// two would both run a consuming wait. A file mu cannot read as the shape it expects is
// reported and never rewritten.
//
// The skill. `skills/mu`, as the package ships it, is copied to each
// harness's own skill directory (D6 `skillLocation`): `~/.claude/skills/mu`,
// `~/.codex/skills/mu`, `~/.cursor/skills/mu`. A marker file inside records
// the digest of what mu wrote, so a later `init` replaces only a copy it wrote
// and nobody edited. Never `~/.agents/skills` (or `~/.pi/agent/skills`): pi
// reads those as well, and a second `mu` skill there collides with the pi
// package's. A skill directory that resolves into one of them is refused, and
// a skill mu did not write is left as found wherever it resolves.
// cursor-agent also reads Claude Code's and Codex's skill directories (its
// third-party skills, on by default), so it gets its own copy only when
// neither of those holds a `mu` skill: it sees exactly one.
//
// The prompts. Each of `prompts/*.md`, which pi loads as a command
// (`/mu-review`), goes to claude's and cursor-agent's skill directories as a
// skill of the same name (`~/.claude/skills/mu-review`), which the user invokes
// as `/mu-review`. A prompt starts a crew, so only the user may start one: each
// copy carries `disable-model-invocation`, which claude (D6) and cursor-agent
// (read from its installed build) honour. codex has no verified switch of the
// kind, so it gets none. The text is pi's, with the argument (`$@`) named in
// words, since only claude substitutes one. The copies follow the skill's
// rules: marker, ownership, cursor-agent, never pi's directories; and a copy
// of its own, unedited, that this mu no longer ships is removed.
//
// Without `harnesses`, only a harness set up here (its config directory
// exists) is written, so a machine with no Cursor CLI grows no `~/.cursor`.
// A second `init` changes nothing, not even formatting.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_TABLE,
  HARNESSES,
  type Harness,
  homeHookConfig,
  takesMuStopHook,
} from "./harnesses.js";
import { STOP_HOOK_TIMEOUT_S } from "./hook-stop.js";
import { skillDirDigest, skillFilesDigest } from "./pi-migrate.js";

/**
 * What `init` did for one harness's hook entry or skill.
 *
 * - `written`: added or updated (`detail` says which).
 * - `unchanged`: already as `init` writes it; the file was not touched.
 * - `skipped`: not asked for: not set up here, or left out of `harnesses`.
 * - `kept`: something mu did not write is there; left as found, nothing added.
 * - `covered`: cursor-agent's skill: it reads the copy in another harness's directory.
 * - `refused`: unreadable, or a skill directory pi also reads; not touched.
 * - `none`: mu installs nothing of this kind for the harness.
 */
export type InitState =
  | "written"
  | "unchanged"
  | "skipped"
  | "kept"
  | "covered"
  | "refused"
  | "none";

export interface InitItem {
  harness: Harness;
  /** The config file or skill directory; null for `none`. */
  path: string | null;
  state: InitState;
  detail: string;
}

export interface InitResult {
  home: string;
  hooks: InitItem[];
  skills: InitItem[];
  /** The shipped prompts as skills: one item per harness and prompt (and per dropped prompt removed), or one `none`/`skipped`/`refused` item per harness. */
  prompts: InitItem[];
}

export interface InitOptions {
  /** Default: `MU_INIT_HOME`, else the home directory. */
  home?: string;
  /** Write these even when not set up here. Default: each harness set up here. */
  harnesses?: readonly Harness[];
  /** This install's root (holds skills/mu). Default: the package root. */
  packageRoot?: string;
}

/** The file inside a skill copy that says `mu init` wrote it, and what. */
export const SKILL_MARKER = ".mu-init";

/** The home directory `init` writes under. Tests redirect it. */
export function initHome(): string {
  const env = process.env.MU_INIT_HOME?.trim() ?? "";
  return env !== "" ? env : homedir();
}

/** The command of mu's hook entry for `h`. `|| true`: a Stop hook's exit 2 is
 *  "block, and hand stderr to the model" to claude and codex, and a mu on PATH
 *  older than the verb exits 2 on it. */
export function muHookCommand(h: Harness): string {
  return `mu hook stop ${h} --timeout ${STOP_HOOK_TIMEOUT_S} || true`;
}

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

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

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What bringing one file in line takes. */
interface HookPlan {
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

function installHook(h: Harness, path: string): Pick<InitItem, "state" | "detail"> {
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

/** This file's package root: src/ and the bundled dist/ both sit one level below it. */
function defaultPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The directories pi discovers user skills in. mu never writes into them. */
export function piSkillDirs(home: string): string[] {
  return [join(home, ".agents", "skills"), join(home, ".pi", "agent", "skills")];
}

/** `path` with its deepest existing ancestor resolved through symlinks. */
function realish(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The harness's skill directory, home-relative (D6 `skillLocation`); undefined: not a directory mu writes. */
function skillDir(h: Harness): string | undefined {
  const loc = HARNESS_TABLE[h].skillLocation;
  if (loc === null || !loc.startsWith("~/")) return undefined;
  return loc.slice(2).replace(/\/+$/, "");
}

/** The config directory whose presence says the harness is set up here. */
function setupDir(h: Harness): string | undefined {
  const cfg = homeHookConfig(h);
  return cfg === undefined ? undefined : cfg.split("/")[0];
}

/** The digest a skill copy's marker records, or undefined: no marker, or not mu's. */
function markerDigest(dest: string): string | undefined {
  try {
    const doc: unknown = JSON.parse(readFileSync(join(dest, SKILL_MARKER), "utf8"));
    if (isObject(doc) && doc.writer === "mu init" && typeof doc.digest === "string") {
      return doc.digest;
    }
  } catch {
    // absent or unreadable: not mu's
  }
  return undefined;
}

/** A skill copy mu wrote and nobody edited since. */
function isOwnSkillCopy(dest: string): boolean {
  const st = lstatOrUndefined(dest);
  if (st === undefined || !st.isDirectory()) return false;
  const recorded = markerDigest(dest);
  return recorded !== undefined && skillDirDigest(dest, SKILL_MARKER) === recorded;
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** True unless `pid` is certainly gone (ESRCH). EPERM means it exists. */
function pidMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Remove the staging copies an `init` that died mid-copy left beside `dest`:
 *  each holds a SKILL.md, which a harness that scans dot-directories would list
 *  as a second `mu`. A live `init`'s are left to it. */
function removeStaleStaging(parent: string, name: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  const re = new RegExp(`^\\.${name.replace(RE_SPECIAL, "\\$&")}\\.mu-(\\d+)\\.(tmp|old)$`);
  for (const e of entries) {
    const pid = Number(re.exec(e)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid !== process.pid && pidMayBeAlive(pid)) continue;
    rmSync(join(parent, e), { recursive: true, force: true });
  }
}

/** A skill to write: `fill` creates the directory it is handed with the skill's files, whose digest is `digest`. */
interface SkillSource {
  fill: (dir: string) => void;
  digest: string;
}

/** A skill copied from a directory (skills/mu as shipped). */
function dirSource(src: string, digest: string): SkillSource {
  return { fill: (dir) => cpSync(src, dir, { recursive: true }), digest };
}

/** Write `source` over `dest` in two renames, the marker inside. */
function copySkill(source: SkillSource, dest: string): void {
  const { digest } = source;
  const parent = dirname(dest);
  mkdirSync(parent, { recursive: true });
  removeStaleStaging(parent, basename(dest));
  const tmp = join(parent, `.${basename(dest)}.mu-${process.pid}.tmp`);
  const old = join(parent, `.${basename(dest)}.mu-${process.pid}.old`);
  try {
    source.fill(tmp);
    writeFileSync(join(tmp, SKILL_MARKER), `${JSON.stringify({ writer: "mu init", digest })}\n`);
    const replacing = existsSync(dest);
    if (replacing) renameSync(dest, old);
    renameSync(tmp, dest);
    if (replacing) rmSync(old, { recursive: true, force: true });
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

function installSkill(
  source: SkillSource,
  dest: string,
  home: string,
): Pick<InitItem, "state" | "detail"> {
  const real = realish(dest);
  const pi = piSkillDirs(home).find((d) => within(real, realish(d)) || within(resolve(dest), d));
  const st = lstatOrUndefined(dest);
  // Something mu did not write (a symlink included, such as an old
  // `npx skills add` install linking into ~/.agents/skills) is skipped,
  // wherever it resolves: mu writes nothing there.
  if (st !== undefined && (!st.isDirectory() || markerDigest(dest) === undefined)) {
    return {
      state: "kept",
      detail:
        pi === undefined
          ? "a skill mu did not write is there: left as found"
          : `a skill mu did not write is there, in ${pi}: left as found; pi lists it beside the pi package's \`mu\` unless you remove it`,
    };
  }
  if (pi !== undefined) {
    return {
      state: "refused",
      detail: `it resolves into ${pi}, which pi also reads: a second \`mu\` skill there collides with the pi package's`,
    };
  }
  if (st !== undefined) {
    if (!isOwnSkillCopy(dest)) {
      return { state: "kept", detail: "edited since mu init wrote it: left as found" };
    }
    if (skillDirDigest(dest, SKILL_MARKER) === source.digest) {
      return { state: "unchanged", detail: "the skill this mu ships" };
    }
  }
  copySkill(source, dest);
  return { state: "written", detail: st === undefined ? "installed" : "updated" };
}

/** Why mu writes no entry or skill for a harness, as a clause. */
function noHook(h: Harness): string {
  return h === "pi"
    ? "pi's settle nudge ships in the pi package"
    : `${HARNESS_TABLE[h].displayName} does not follow a stop block's reason: it keeps driving by the skill's rule`;
}

function noSkill(h: Harness): string {
  return h === "pi"
    ? "the pi package ships it (pi install npm:@mu-crew/mu)"
    : `${HARNESS_TABLE[h].displayName} installs skills through \`${HARNESS_TABLE[h].skillLocation ?? "its own tooling"}\``;
}

/** The harnesses whose skill directories cursor-agent reads too (third-party skills, on by default). */
const CURSOR_ALSO_READS: readonly Harness[] = ["claude", "codex"];

/**
 * cursor-agent's item for skill `name` when Claude Code's or Codex's skill
 * directory already holds one (it reads those too): its own copy is removed if
 * mu wrote it, so it sees exactly one. undefined: it needs its own copy.
 */
function cursorCovered(
  home: string,
  name: string,
  dest: string,
): Pick<InitItem, "state" | "detail"> | undefined {
  const other = CURSOR_ALSO_READS.map((o) => skillDir(o))
    .filter((d): d is string => d !== undefined)
    .map((d) => join(home, d, name))
    .find((d) => existsSync(join(d, "SKILL.md")));
  if (other === undefined) return undefined;
  const own = isOwnSkillCopy(dest);
  if (own) rmSync(dest, { recursive: true, force: true });
  const kept = !own && lstatOrUndefined(dest) !== undefined;
  // The directory, not the copy, so one line can name every skill it covers.
  const where = dirname(other);
  return {
    state: kept ? "kept" : own ? "written" : "covered",
    detail: kept
      ? `cursor-agent also reads ${where}, and a skill mu did not write is here: left as found`
      : `${own ? "removed: " : ""}cursor-agent reads ${where} (its third-party skills)`,
  };
}

/** How a prompt's argument reads in a skill: only claude substitutes `$ARGUMENTS`, and it appends the text when the skill names none. */
export const PROMPT_ARGUMENT = "the text the user gave with this skill";

/**
 * The harnesses that get the prompts as skills: those whose skill format has
 * a verified way to keep a skill from the model (`disable-model-invocation`:
 * claude per D6, cursor-agent read from its installed build). codex has none
 * verified, and a prompt skill its model picks by description would start a
 * crew on its own (VISION: recursion is opt-in).
 */
const PROMPT_SKILL_HARNESSES: readonly Harness[] = ["claude", "cursor-agent"];

/**
 * One shipped pi prompt (`prompts/<name>.md`) as a SKILL.md, or undefined
 * when it has no frontmatter description. The body is pi's, with `$@` named
 * in words (`${@:-x}` becomes "…, else x"); the copy is for the user to
 * invoke, never the model.
 */
export function promptAsSkill(name: string, text: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  const description = /^description:[ \t]*(\S.*)$/m.exec(m?.[1] ?? "")?.[1]?.trim();
  if (m === null || description === undefined) return undefined;
  const body = (m[2] ?? "")
    .replace(/\$\{@:-([^}]*)\}/g, (_all, dflt: string) => `${PROMPT_ARGUMENT}, else ${dflt}`)
    .replace(/\$@/g, PROMPT_ARGUMENT);
  const head = [`name: ${name}`, `description: ${description}`, "disable-model-invocation: true"];
  return `---\n${head.join("\n")}\n---\n${body}`;
}

/** A shipped prompt: its skill source, or why it cannot be read. */
type PromptSource = { name: string; source: SkillSource } | { name: string; error: string };

/** Every shipped prompt, in name order, as a skill source each. No prompts directory: none. */
function promptSources(packageRoot: string): PromptSource[] {
  const dir = join(packageRoot, "prompts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file): PromptSource => {
      const name = file.slice(0, -".md".length);
      const path = join(dir, file);
      let skill: string | undefined;
      try {
        skill = promptAsSkill(name, readFileSync(path, "utf8"));
      } catch (err) {
        return { name, error: `cannot read the shipped prompt ${path}: ${(err as Error).message}` };
      }
      if (skill === undefined) {
        return {
          name,
          error: `cannot read the shipped prompt ${path}: no frontmatter description`,
        };
      }
      const text = skill;
      const fill = (at: string): void => {
        mkdirSync(at);
        writeFileSync(join(at, "SKILL.md"), text);
      };
      return { name, source: { fill, digest: skillFilesDigest({ "SKILL.md": text }) } };
    });
}

/**
 * Remove each unedited copy of mu's own in `parent` that is neither `mu` nor
 * one of `shipped`: a prompt skill an earlier mu wrote and this one no longer
 * ships, whose recipe the updated `mu` copy beside it may lack. Never in a
 * directory pi reads, and never anything mu did not write or that was edited.
 */
function removeDroppedPrompts(
  h: Harness,
  parent: string,
  shipped: ReadonlySet<string>,
  home: string,
): InitItem[] {
  if (lstatOrUndefined(parent)?.isDirectory() !== true) return [];
  const real = realish(parent);
  if (piSkillDirs(home).some((d) => within(real, realish(d)) || within(resolve(parent), d))) {
    return [];
  }
  return readdirSync(parent)
    .filter((e) => !e.startsWith(".") && e !== "mu" && !shipped.has(e))
    .sort()
    .map((e) => join(parent, e))
    .filter((dest) => isOwnSkillCopy(dest))
    .map((dest): InitItem => {
      rmSync(dest, { recursive: true, force: true });
      return {
        harness: h,
        path: dest,
        state: "written",
        detail: "removed: a prompt skill an earlier mu wrote, no longer shipped",
      };
    });
}

function noPrompts(h: Harness): string {
  if (h === "pi") return "the pi package ships them as commands";
  if (h === "codex") {
    return "codex has no verified way to keep a skill from its model, and a prompt skill starts a crew: none installed";
  }
  return noSkill(h);
}

/**
 * Add or update mu's hook entries and skill for each harness. One harness's
 * failure never stops the others: it comes back `refused`.
 */
export function runInit(opts: InitOptions = {}): InitResult {
  const home = opts.home ?? initHome();
  const packageRoot = opts.packageRoot ?? defaultPackageRoot();
  const src = join(packageRoot, "skills", "mu");
  const srcDigest = skillDirDigest(src);
  const wanted = (h: Harness): boolean => {
    if (opts.harnesses !== undefined) return opts.harnesses.includes(h);
    const dir = setupDir(h);
    return dir !== undefined && existsSync(join(home, dir));
  };
  const notSetUp = (h: Harness): string =>
    opts.harnesses !== undefined
      ? "not named in --harness"
      : `not set up here (no ~/${setupDir(h) ?? ""}); --harness ${h} writes it`;
  const failed = (err: unknown): Pick<InitItem, "state" | "detail"> => ({
    state: "refused",
    detail: `left untouched: ${err instanceof Error ? err.message : String(err)}`,
  });

  const hooks = HARNESSES.map((h): InitItem => {
    const cfg = homeHookConfig(h);
    if (!takesMuStopHook(h) || cfg === undefined) {
      return { harness: h, path: null, state: "none", detail: noHook(h) };
    }
    const path = join(home, cfg);
    if (!wanted(h)) return { harness: h, path, state: "skipped", detail: notSetUp(h) };
    try {
      return { harness: h, path, ...installHook(h, path) };
    } catch (err) {
      return { harness: h, path, ...failed(err) };
    }
  });

  const skills: InitItem[] = [];
  for (const h of HARNESSES) {
    const rel = skillDir(h);
    if (rel === undefined) {
      skills.push({ harness: h, path: null, state: "none", detail: noSkill(h) });
      continue;
    }
    const dest = join(home, rel, "mu");
    if (!wanted(h)) {
      skills.push({ harness: h, path: dest, state: "skipped", detail: notSetUp(h) });
      continue;
    }
    try {
      if (srcDigest === undefined) throw new Error(`cannot read the shipped skill at ${src}`);
      const covered = h === "cursor-agent" ? cursorCovered(home, "mu", dest) : undefined;
      skills.push({
        harness: h,
        path: dest,
        ...(covered ?? installSkill(dirSource(src, srcDigest), dest, home)),
      });
    } catch (err) {
      skills.push({ harness: h, path: dest, ...failed(err) });
    }
  }

  const prompts: InitItem[] = [];
  for (const h of HARNESSES) {
    const rel = skillDir(h);
    if (rel === undefined || !PROMPT_SKILL_HARNESSES.includes(h)) {
      prompts.push({ harness: h, path: null, state: "none", detail: noPrompts(h) });
      continue;
    }
    const parent = join(home, rel);
    if (!wanted(h)) {
      prompts.push({ harness: h, path: parent, state: "skipped", detail: notSetUp(h) });
      continue;
    }
    let sources: PromptSource[];
    try {
      sources = promptSources(packageRoot);
    } catch (err) {
      prompts.push({ harness: h, path: parent, ...failed(err) });
      continue;
    }
    // One prompt mu cannot read is refused alone; the rest are written.
    for (const p of sources) {
      const dest = join(parent, p.name);
      if ("error" in p) {
        prompts.push({ harness: h, path: dest, ...failed(new Error(p.error)) });
        continue;
      }
      try {
        const covered = h === "cursor-agent" ? cursorCovered(home, p.name, dest) : undefined;
        prompts.push({
          harness: h,
          path: dest,
          ...(covered ?? installSkill(p.source, dest, home)),
        });
      } catch (err) {
        prompts.push({ harness: h, path: dest, ...failed(err) });
      }
    }
    try {
      const shipped = new Set(sources.map((p) => p.name));
      prompts.push(...removeDroppedPrompts(h, parent, shipped, home));
    } catch (err) {
      prompts.push({ harness: h, path: parent, ...failed(err) });
    }
  }
  return { home, hooks, skills, prompts };
}

/** True when some item could not be written. */
export function initRefused(r: InitResult): boolean {
  return [...r.hooks, ...r.skills, ...r.prompts].some((i) => i.state === "refused");
}
