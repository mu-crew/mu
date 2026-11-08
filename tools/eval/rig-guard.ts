// What an AUT must never read: the rig (tools/eval with its scenario and holdout sources, goldens
// and judges; test/eval), the rows and transcripts, and other runs' sandboxes. Three layers:
// - the sandbox names no rig path (stageRig; prepareSurface strips the rig from a surface);
// - a pi AUT loads aut-guard.ts, which refuses a tool call that names the rig (BLOCKED) and cuts
//   every line that names it from a tool result (`ps`, a grep above HOME);
// - the judge-side backstop, rigReads: a call that names a rig path and was not refused, or whose
//   output still carries a rig file's grep line, makes the run a "rig read". A rig read is an
//   invalid row, never a hit (R4: completed false and left out of every count; probe: invalid).
//
// Limits: a path built at run time (`cd ..` up to the checkout, `$VAR/…`) is not seen in a call's
// input; its output is cut only where a line names a root or a rig segment. A live run's HOME is
// the user's, so `~/` there expands to the user's home. A pane AUT (claude, codex, …) has only the
// backstop.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox, ToolCall } from "./types.ts";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

/** The checkout this rig runs from. */
export const RIG_REPO: string = resolve(EVAL_DIR, "..", "..");

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
    for (const l of list.split("\n")) if (l.startsWith("worktree ")) out.add(l.slice(9).trim());
  } catch {
    // not a git checkout (an exported copy): this dir alone
  }
  checkouts = [...out];
  return checkouts;
}

export interface RigGuard {
  /** Absolute paths a tool call must not name (each also matched as its realpath). */
  roots: string[];
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
  extra?: readonly string[];
}): RigGuard {
  const roots = [
    ...rigCheckouts(),
    TRANSCRIPTS_DIR,
    ...(o.surfaceRoot ? RIG_SUBDIRS.map((d) => join(o.surfaceRoot as string, d)) : []),
    ...(o.extra ?? []),
  ];
  return { roots, ownSandbox: o.ownSandbox, home: o.home };
}

/** The log root of a run log (`<root>/.eval-results/<stamp>/<file>`, commands.ts logPath). */
export function logRootOf(log: string): string {
  const abs = resolve(log);
  const i = abs.lastIndexOf("/.eval-results/");
  return i >= 0 ? abs.slice(0, i) : dirname(abs);
}

/** The guard of one AUT run in `sb`: its surface, its HOME, its log root. */
export function sandboxGuard(sb: Pick<Sandbox, "dir" | "env" | "surface">, log?: string): RigGuard {
  return rigGuard({
    surfaceRoot: sb.surface.root,
    ownSandbox: sb.dir,
    home: sb.env.HOME,
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

interface Compiled {
  /** A root named as a path: not followed by more of a name (w-b5 is not w-b5x). */
  named: { root: string; re: RegExp }[];
  /** A grep line of a file under a root: `<root>/<path>:<n>:` or `-<n>-`. */
  grepLine: RegExp[];
  own: string | undefined;
  home: string | undefined;
}

function compile(g: RigGuard): Compiled {
  const named: Compiled["named"] = [];
  const grepLine: RegExp[] = [];
  const ownDirs = g.ownSandbox ? spellings(g.ownSandbox) : [];
  // a root holding the run's own sandbox (a log root of /tmp) would flag every call
  const holdsOwn = (root: string): boolean =>
    ownDirs.some((d) => d === root || d.startsWith(`${root}/`));
  for (const root of new Set(g.roots.flatMap(spellings).filter((r) => !holdsOwn(r)))) {
    named.push({ root, re: new RegExp(`${esc(root)}(?![\\w.-])`) });
    grepLine.push(new RegExp(`${esc(root)}/[^\\s:]+(?::\\d+:|-\\d+-)`));
  }
  // any copy of the rig, wherever it lives (a removed worktree, an exported dir): its segments
  for (const seg of RIG_SEGMENTS) {
    named.push({ root: seg, re: new RegExp(`/${esc(seg)}(?![\\w.-])`) });
    grepLine.push(new RegExp(`/${esc(seg)}/[^\\s:]+(?::\\d+:|-\\d+-)`));
  }
  const own = g.ownSandbox ? (g.ownSandbox.match(SANDBOX_RE) ?? [])[0] : undefined;
  return { named, grepLine, own, home: g.home };
}

/** `~/x`, `$HOME/x`, `${HOME}/x` as the AUT's shell expands them. */
function expandHome(text: string, home: string | undefined): string {
  if (home === undefined || home === "") return text;
  return text.replace(/(^|[\s"'=:(`])(?:~|\$HOME|\$\{HOME\})(?=\/|$|[\s"'])/g, `$1${home}`);
}

/** Why one command or tool input names the rig ([] when it does not). */
function namesRig(text: string, c: Compiled): string[] {
  const t = expandHome(text, c.home);
  const hit = c.named.filter((n) => n.re.test(t)).map((n) => n.root);
  // the outermost root only: a checkout surface's tools/ is inside the checkout
  // a segment only when no root matched
  const roots = hit.filter((r) => r.startsWith("/"));
  const why = (roots.length > 0 ? roots : hit).filter(
    (r) => !hit.some((o) => r.startsWith(`${o}/`)),
  );
  for (const m of t.matchAll(SANDBOX_RE)) if (m[0] !== c.own) why.push(`other sandbox ${m[0]}`);
  return [...new Set(why)];
}

const callText = (args: unknown): string =>
  typeof args === "string" ? args : (JSON.stringify(args) ?? "");

/** The reason aut-guard.ts gives for a refused tool call: the whole result of that call. */
export const BLOCKED = "refused: that path is outside this sandbox";

/** What aut-guard.ts refuses: a tool input that names the rig ([] when it does not). */
export function rigInInput(input: unknown, g: RigGuard): string[] {
  return namesRig(callText(input), compile(g));
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

/**
 * The rig reads of one AUT run, one line per offending tool call: `#<i> <tool>: <what>`. A call
 * names a rig root in its input (and was not refused), or prints a grep line of a rig file in its
 * output.
 */
export function rigReads(calls: readonly ToolCall[], g: RigGuard): string[] {
  const c = compile(g);
  const out: string[] = [];
  calls.forEach((call, i) => {
    if (refused(call)) return;
    // JSON escapes a quote inside a command as \", which would hide a path's end
    const why = namesRig(callText(call.args).replace(/\\"/g, '"'), c);
    const output = typeof call.output === "string" ? call.output : "";
    if (why.length === 0 && c.grepLine.some((re) => re.test(output)))
      why.push("rig file in output");
    if (why.length > 0) out.push(`#${i} ${call.name}: ${why.join(", ")}`);
  });
  return out;
}

/** The rig reads of a probe answer's commands (run in the sandbox; output never shown back). */
export function rigReadsInCommands(commands: readonly string[], g: RigGuard): string[] {
  const c = compile(g);
  return commands.flatMap((cmd, i) => {
    const why = namesRig(cmd, c);
    return why.length > 0 ? [`command ${i + 1}: ${why.join(", ")}`] : [];
  });
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
    writeFileSync(join(lib, f), src);
    for (const m of src.matchAll(/(?:from|import)\s+"\.\/([\w.-]+)"/g)) if (m[1]) todo.push(m[1]);
  }
  return join(lib, entry);
}
