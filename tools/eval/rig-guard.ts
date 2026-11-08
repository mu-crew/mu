// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// What an AUT must never read: the rig (tools/eval with its scenario and holdout sources, goldens
// and judges; test/eval), the rows and transcripts, and other runs' sandboxes. The layers, each
// with what it leaves (tools/eval/README.md says the same at more length):
// - the sandbox names no rig path (stageRig; prepareSurface strips the rig from a surface).
//   Leaves the staged copies (legitimate) and a surface given by path;
// - path rules: a pi AUT loads aut-guard.ts, which refuses a tool call that names the rig
//   (BLOCKED) and cuts every line that names it from a tool result (`ps`, a grep above HOME).
//   What names the rig: a root (every checkout of the repo, the transcripts, the private stores of
//   rig-private.ts, the surface's rig dirs) in any spelling (realpath, /private/tmp), a rig segment
//   (`tools/eval`, also relative: `HEAD:tools/eval/x`), another run's sandbox, and for a bash
//   command every path its running cwd resolves (`cd a && cd tools && cat eval/x`,
//   shell-paths.ts). A live run's HOME is the user's, so `~/` there expands to the user's home.
//   Leaves a path computed at run time, a glob, a symlink, and output that names no root;
// - the canary (rig-private.ts) on every rig file's first and last line: a whole-file read, a
//   `git show`, a head or tail prints it (aut-guard withholds the result). Leaves every range
//   that skips both ends (`sed -n 5,15p`, a grep of a middle line);
// - the fingerprint (rig-fingerprint.ts, judge-side only, never imported here so stageRig never
//   copies it): one of the rig's own names (ids, declared names) that no legitimate output carries.
//   Leaves the lines that carry only mu's words (about 30% of 11-line ranges, 84% of single
//   lines), the golden and bad scripts (mu commands), a listing of plainly named files, and any
//   encoding (base64, gzip, rev, tr);
// - rigReads, the judge-side backstop: a call that names a rig path and was not refused, or whose
//   output carries a rig file's grep line or its canary, makes the run a "rig read" (commands.ts
//   adds the fingerprint's). A rig read is an invalid row, never a hit (R4: completed false and
//   left out of every count; probe: invalid). It is found after the run: the row is dropped.
// A pane AUT (claude, codex, …) has only the backstop: the hook observer flags a payload or
// transcript that carries the canary and names the transcript the judge scans for the fingerprint.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasCanary, privateStores, stripCanary } from "./rig-private.ts";
import { commandPaths } from "./shell-paths.ts";
import type { Sandbox, ToolCall } from "./types.ts";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

/** A path's one spelling: its realpath (macOS's /tmp is /private/tmp), else as resolved. */
export function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The checkout this rig runs from. */
export const RIG_REPO: string = canonical(resolve(EVAL_DIR, "..", ".."));

/** Every eval row, log and prompt dir lives under here (tournament.ts rowDir, B5 rows). */
export const TRANSCRIPTS_DIR: string = join(
  homedir(),
  ".local",
  "state",
  "mu-next",
  "eval-transcripts",
);

/** The subdirs of a checkout or a surface that hold the rig, not the product. */
export const RIG_SUBDIRS: readonly string[] = [
  "tools",
  "test",
  "docs/eval",
  "docs/specs",
  "docs/history",
];

/** Path segments that name the rig or its logs in any checkout or copy (TRANSCRIPTS_DIR is a root: a sandbox HOME has its own `.local/state`). */
const RIG_SEGMENTS: readonly string[] = ["tools/eval", "test/eval", ".eval-results"];

let checkouts: string[] | undefined;

/** This checkout, its main repo and every other worktree of it (`git worktree list`). */
export function rigCheckouts(): string[] {
  if (checkouts !== undefined) return checkouts;
  const out = new Set([RIG_REPO]);
  try {
    const list = execFileSync("git", ["-C", RIG_REPO, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const l of list.split("\n"))
      if (l.startsWith("worktree ")) out.add(canonical(l.slice(9).trim()));
  } catch {
    // not a git checkout (an exported copy): this dir alone
  }
  checkouts = [...out];
  return checkouts;
}

export interface RigGuard {
  /** Absolute paths a tool call must not name (each also matched as its realpath). */
  roots: string[];
  /** The private stores (rig-private.ts): named as a reason only when no root is. */
  stores?: string[];
  /** Where the AUT's bash starts (its sandbox repo): a relative path resolves from here. */
  cwd?: string;
  /** The run's own sandbox: the one `mu-eval-*` dir it may name. */
  ownSandbox?: string;
  /** What `~` and `$HOME` mean in the AUT's shell (the sandbox HOME; the user's in a live run). */
  home?: string;
}

/** The guard of one run: every rig checkout, the transcripts, the surface's rig subdirs, `extra`. */
export function rigGuard(o: {
  surfaceRoot?: string;
  ownSandbox?: string;
  home?: string;
  cwd?: string;
  extra?: readonly string[];
}): RigGuard {
  const roots = [
    ...rigCheckouts(),
    TRANSCRIPTS_DIR,
    ...(o.surfaceRoot ? RIG_SUBDIRS.map((d) => join(o.surfaceRoot as string, d)) : []),
    ...(o.extra ?? []),
  ];
  const stores = privateStores(homedir(), process.env.EVAL_MUSEUM_DIR).map((s) => s.dir);
  return { roots, stores, ownSandbox: o.ownSandbox, home: o.home, cwd: o.cwd };
}

/** The log root of a run log (`<root>/.eval-results/<stamp>/<file>`, commands.ts logPath). */
export function logRootOf(log: string): string {
  const abs = resolve(log);
  const i = abs.lastIndexOf("/.eval-results/");
  return i >= 0 ? abs.slice(0, i) : dirname(abs);
}

/** The guard of one AUT run in `sb`: its surface, its HOME, its log root. */
export function sandboxGuard(
  sb: Pick<Sandbox, "dir" | "env" | "surface" | "repoDir">,
  log?: string,
): RigGuard {
  return rigGuard({
    surfaceRoot: sb.surface.root,
    ownSandbox: sb.dir,
    home: sb.env.HOME,
    cwd: sb.repoDir,
    extra: log ? [logRootOf(log)] : [],
  });
}

/** A path, its realpath, and macOS's /private-less spelling. */
function spellings(p: string): string[] {
  const out = new Set([resolve(p)]);
  try {
    if (existsSync(p)) out.add(realpathSync(p));
  } catch {
    // unreadable: the spelling given
  }
  for (const s of [...out]) if (s.startsWith("/private/")) out.add(s.slice("/private".length));
  return [...out].filter((s) => s !== "/" && s !== "");
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A sandbox dir name (sandbox.ts createSandbox). */
const SANDBOX_RE = /mu-eval-\d+-\d+-[0-9a-f]+/g;

/** A rig segment's left edge: a path's `/`, or a token's start (`HEAD:tools/eval/x`, `cat tools/eval`). */
const EDGE = "(?:^|[\\s\"'`=:(/])";

interface Root {
  /** The one spelling a reason names (canonical). */
  label: string;
  /** Every spelling it may be written in. */
  spell: string[];
  /** A path named: not followed by more of a name (w-b5 is not w-b5x). */
  re: RegExp;
  /** A private store: a reason only when no rig root matched. */
  store: boolean;
}

interface Compiled {
  roots: Root[];
  segs: { seg: string; re: RegExp }[];
  /** A grep line of a file under a root or a rig segment: `<path>:<n>:` or `-<n>-`. */
  grepLine: RegExp[];
  own: string | undefined;
  home: string | undefined;
  cwd: string;
}

function compile(g: RigGuard): Compiled {
  const roots: Root[] = [];
  const grepLine: RegExp[] = [];
  const ownDirs = g.ownSandbox ? spellings(g.ownSandbox) : [];
  // a root holding the run's own sandbox (a log root of /tmp) would flag every call
  const holdsOwn = (root: string): boolean =>
    ownDirs.some((d) => d === root || d.startsWith(`${root}/`));
  const seen = new Set<string>();
  const add = (r: string, store: boolean): void => {
    const label = canonical(r);
    const spell = spellings(r);
    if (seen.has(label) || spell.some(holdsOwn)) return;
    seen.add(label);
    const alt = spell.map(esc).join("|");
    roots.push({ label, spell, store, re: new RegExp(`(?:${alt})(?![\\w.-])`) });
    grepLine.push(new RegExp(`(?:${alt})/[^\\s:]+(?::\\d+:|-\\d+-)`));
  };
  for (const r of g.roots) add(r, false);
  for (const r of g.stores ?? []) add(r, true);
  // any copy of the rig, wherever it lives (a removed worktree, an exported dir): its segments
  const segs = RIG_SEGMENTS.map((seg) => ({
    seg,
    re: new RegExp(`${EDGE}${esc(seg)}(?![\\w.-])`, "m"),
  }));
  for (const seg of RIG_SEGMENTS)
    grepLine.push(new RegExp(`${EDGE}${esc(seg)}/[^\\s:]+(?::\\d+:|-\\d+-)`, "m"));
  const own = g.ownSandbox ? (g.ownSandbox.match(SANDBOX_RE) ?? [])[0] : undefined;
  return { roots, segs, grepLine, own, home: g.home, cwd: g.cwd ?? g.ownSandbox ?? "/" };
}

/** `~/x`, `$HOME/x`, `${HOME}/x` as the AUT's shell expands them. */
function expandHome(text: string, home: string | undefined): string {
  if (home === undefined || home === "") return text;
  return text.replace(/(^|[\s"'=:(`])(?:~|\$HOME|\$\{HOME\})(?=\/|$|[\s"'])/g, `$1${home}`);
}

/**
 * The reasons for what matched: the outermost rig roots (a checkout surface's tools/ is inside the
 * checkout), else the innermost private stores (worktrees, not the whole mu state), else the
 * segments.
 */
function reasons(roots: readonly Root[], segs: readonly string[]): string[] {
  const rig = [...new Set(roots.filter((r) => !r.store).map((r) => r.label))];
  if (rig.length > 0) return rig.filter((r) => !rig.some((o) => r.startsWith(`${o}/`)));
  const st = [...new Set(roots.filter((r) => r.store).map((r) => r.label))];
  if (st.length > 0) return st.filter((r) => !st.some((o) => o.startsWith(`${r}/`)));
  return [...new Set(segs)];
}

/** The roots and segments one absolute path lies in. */
function pathHits(p: string, c: Compiled): { roots: Root[]; segs: string[] } {
  return {
    roots: c.roots.filter((r) => r.spell.some((s) => p === s || p.startsWith(`${s}/`))),
    segs: c.segs.filter((s) => s.re.test(p)).map((s) => s.seg),
  };
}

/**
 * Why one text (a tool input, an output line) names the rig ([] when it does not). With `command`
 * (a bash command), also every path its running cwd resolves: a `cd` chain into the checkout, a
 * relative path after a `cd`, `$PWD/…`.
 */
function namesRig(text: string, c: Compiled, command?: string): string[] {
  const t = expandHome(text, c.home);
  const roots = c.roots.filter((r) => r.re.test(t));
  const segs = c.segs.filter((s) => s.re.test(t)).map((s) => s.seg);
  if (command !== undefined) {
    const w = commandPaths(expandHome(command, c.home), c.cwd);
    for (const p of [...w.paths.map((x) => x.path), ...w.cwds]) {
      const h = pathHits(p, c);
      roots.push(...h.roots);
      segs.push(...h.segs);
    }
  }
  const why = reasons(roots, segs);
  for (const m of t.matchAll(SANDBOX_RE)) if (m[0] !== c.own) why.push(`other sandbox ${m[0]}`);
  return [...new Set(why)];
}

const callText = (args: unknown): string =>
  typeof args === "string" ? args : (JSON.stringify(args) ?? "");

/** A bash call's command, when the input is one. */
const commandOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === "string" ? cmd : undefined;
};

/** The reason aut-guard.ts gives for a refused tool call: the whole result of that call. */
export const BLOCKED = "refused: that path is outside this sandbox";

/** What aut-guard.ts puts in place of a tool result that carried a rig file's canary. */
export const WITHHELD = "refused: that output came from outside this sandbox";

/** What aut-guard.ts refuses: a tool input that names the rig ([] when it does not). */
export function rigInInput(input: unknown, g: RigGuard): string[] {
  return namesRig(callText(input), compile(g), commandOf(input));
}

/** A tool result's text without the lines that name the rig, and how many were cut. */
export function redactRig(text: string, g: RigGuard): { text: string; cut: number } {
  const c = compile(g);
  const lines = text.split("\n");
  const kept = lines.filter((l) => namesRig(l, c).length === 0);
  const cut = lines.length - kept.length;
  if (cut === 0) return { text, cut };
  return { text: [...kept, `[${cut} line(s) outside this sandbox cut]`].join("\n"), cut };
}

/** A call aut-guard.ts refused: it never ran, so it read nothing. */
const refused = (call: ToolCall): boolean => call.isError && call.output.trim() === BLOCKED;

/** An output that carried a rig file's canary (aut-guard.ts withheld it, or no guard ran). */
const canaryIn = (output: string): boolean => hasCanary(output) || output.trim() === WITHHELD;

/**
 * The rig reads of one AUT run, one line per offending tool call: `#<i> <tool>: <what>`. A call
 * names a rig root in its input (and was not refused), or prints a grep line of a rig file or a
 * rig file's canary in its output.
 */
export function rigReads(calls: readonly ToolCall[], g: RigGuard): string[] {
  const c = compile(g);
  const out: string[] = [];
  calls.forEach((call, i) => {
    if (refused(call)) return;
    // JSON escapes a quote inside a command as \", which would hide a path's end
    const why = namesRig(callText(call.args).replace(/\\"/g, '"'), c, commandOf(call.args));
    const output = typeof call.output === "string" ? call.output : "";
    if (canaryIn(output)) why.push("rig canary in output");
    else if (why.length === 0 && c.grepLine.some((re) => re.test(output)))
      why.push("rig file in output");
    if (why.length > 0) out.push(`#${i} ${call.name}: ${why.join(", ")}`);
  });
  return out;
}

/** The rig reads of a probe answer's commands (run in the sandbox; output never shown back). */
export function rigReadsInCommands(commands: readonly string[], g: RigGuard): string[] {
  const c = compile(g);
  return commands.flatMap((cmd, i) => {
    const why = namesRig(cmd, c, cmd);
    return why.length > 0 ? [`command ${i + 1}: ${why.join(", ")}`] : [];
  });
}

/** The probe answer's commands whose output carried a rig file's canary (they ran: a read). */
export function canaryInOutputs(outputs: readonly string[]): string[] {
  return outputs.flatMap((o, i) => (canaryIn(o) ? [`command ${i + 1}: rig canary in output`] : []));
}

/**
 * Copy rig module `entry` (a file of tools/eval) and every relative import it reaches into
 * `<dir>/.rt/lib`, and return the copy's path. What runs inside the sandbox (the faux workers' pi
 * extension, the ssh shim, a fake harness) then names a sandbox path, never the rig's checkout,
 * whose scenarios, goldens and judges the AUT must not find.
 */
export function stageRig(dir: string, entry: string): string {
  const lib = join(dir, ".rt", "lib");
  mkdirSync(lib, { recursive: true });
  const seen = new Set<string>();
  for (let f = entry as string | undefined, todo: string[] = []; f !== undefined; f = todo.pop()) {
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(join(EVAL_DIR, f), "utf8");
    // the copy is the sandbox's own file: an AUT that reads it read no rig file
    writeFileSync(join(lib, f), stripCanary(src));
    for (const m of src.matchAll(/(?:from|import)\s+"\.\/([\w.-]+)"/g)) if (m[1]) todo.push(m[1]);
  }
  return join(lib, entry);
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
