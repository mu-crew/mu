// A live run's isolation from the user's real mu state: enforced where the rig can, watched where it
// cannot (docs/eval/every-harness.md, "What a live run changes").
//
// - Pins. The sandbox's mu, murmur and muzzle shims set every isolation variable to the sandbox's
//   value, baked in when the sandbox is made, whatever the caller's environment says: a harness's
//   shell tool re-sources the user's shell startup files, which may export MU_SYNC_DIR=$HOME/mu.
// - Shell startup. A live sandbox points ZDOTDIR at wrappers that source the user's own zsh files
//   and then apply the same pins (and drop a mu, murmur, muzzle or tmux alias or function), sandbox
//   bin/ first on PATH; so a zsh that reads its startup files through ZDOTDIR (codex's login shell)
//   ends with them. claude's shell snapshot does not: it sources `$HOME/.zshrc` itself (read from
//   claude 2.x's binary), so for claude the enforcing layer is CLAUDE_ENV_FILE, a copy of the pins
//   it sources after the snapshot before each Bash command. Only a session-env file a user's own
//   SessionStart hook writes runs after it.
// - Watch. A mu that bypasses both (an absolute path to the user's install, a bash login shell
//   whose profile puts it first) is caught by a before/after look at the user's real sync dirs, DB,
//   murmur and muzzle state. The rig only reads them: it never deletes or changes a user's file.
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The variables that keep mu, murmur, pi and tmux inside the sandbox. */
export const ISOLATION_VARS = [
  "MU_DB_PATH",
  "MU_STATE_DIR",
  "MU_SYNC_DIR",
  "MU_TMUX_SOCKET",
  "MU_MUX",
  "MURMUR_STATE_DIR",
  "TMUX_TMPDIR",
  "PI_CODING_AGENT_DIR",
] as const;

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * POSIX sh (also zsh and bash) that sets every ISOLATION_VARS entry to its value in `env` (a blank
 * value stays blank, an absent one is unset), drops every MU_<CLI>_COMMAND the sandbox did not set
 * (a user's own would launch a harness by a path outside the sandbox bin), and puts `binDir` first
 * on PATH. A no-op on the eval ssh host (EVAL_HOST set), whose environment is its own.
 */
export function pinScript(env: Record<string, string | undefined>, binDir: string): string {
  const lines = [
    `if [ -z "\${EVAL_HOST:-}" ]; then`,
    `  for __mu_eval_v in $(env | sed -n 's/^\\(MU_[A-Za-z0-9_]*_COMMAND\\)=.*/\\1/p'); do unset "$__mu_eval_v"; done`,
    "  unset __mu_eval_v",
  ];
  const commands = Object.keys(env).filter((k) => /^MU_[A-Za-z0-9_]*_COMMAND$/.test(k));
  for (const k of [...ISOLATION_VARS, ...commands]) {
    const v = env[k];
    lines.push(v === undefined ? `  unset ${k}` : `  export ${k}=${sq(v)}`);
  }
  lines.push(
    `  case "$PATH" in ${sq(`${binDir}:`)}*) ;; *) PATH=${sq(binDir)}:"$PATH"; export PATH ;; esac`,
    "fi",
  );
  return `${lines.join("\n")}\n`;
}

/** zsh's startup files, in the order a login interactive shell reads them. */
const ZSH_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const;

/**
 * One ZDOTDIR wrapper: the user's own file (their ZDOTDIR, else HOME, as a plain zsh would read
 * it), then the pins. ZDOTDIR is the user's while their file runs and the wrapper dir again after,
 * so zsh reads the next startup file from here too.
 */
export function zshWrapper(file: string, pinFile: string): string {
  return `# mu eval: the user's own ${file}, then the sandbox's pins (tools/eval/isolation.ts)
__mu_eval_zd=$ZDOTDIR
ZDOTDIR=\${__mu_eval_user_zd:-\${EVAL_USER_ZDOTDIR:-$HOME}}
[ -r "$ZDOTDIR/${file}" ] && . "$ZDOTDIR/${file}"
__mu_eval_user_zd=$ZDOTDIR
ZDOTDIR=$__mu_eval_zd
unset __mu_eval_zd
. ${sq(pinFile)}
`;
}

/** Where a live sandbox keeps its shell startup files. */
export function shellDir(dir: string): string {
  return join(dir, "shell");
}

/** The environment a live sandbox adds for the startup files `writeShellStartup` writes. */
export function shellStartupEnv(dir: string, base: NodeJS.ProcessEnv): Record<string, string> {
  const userZd = base.ZDOTDIR?.trim() || base.HOME?.trim() || homedir();
  return {
    ZDOTDIR: join(shellDir(dir), "zdotdir"),
    EVAL_USER_ZDOTDIR: userZd,
    CLAUDE_ENV_FILE: join(shellDir(dir), "claude-env.sh"),
  };
}

/** The names a user's rc must not alias or define as a function in a live sandbox's shells. */
export const PINNED_COMMANDS = ["mu", "murmur", "muzzle", "tmux"] as const;

/**
 * A shell startup file's pins: `pin`, after dropping any alias or function of PINNED_COMMANDS
 * (zsh and bash resolve both before PATH; claude's snapshot carries the rc's). The names are quoted
 * so a zsh global alias cannot expand them.
 */
export function shellPinScript(pin: string): string {
  const names = PINNED_COMMANDS.map(sq).join(" ");
  return `for __mu_eval_n in ${names}; do unalias "$__mu_eval_n" 2>/dev/null; unset -f "$__mu_eval_n" 2>/dev/null; done
unset __mu_eval_n
${pin}`;
}

/** Write the pins, the zsh wrappers and claude's env file of a live sandbox. */
export function writeShellStartup(dir: string, pin: string): void {
  const sd = shellDir(dir);
  const zd = join(sd, "zdotdir");
  mkdirSync(zd, { recursive: true });
  const pinFile = join(sd, "pin.sh");
  const shellPin = shellPinScript(pin);
  writeFileSync(pinFile, shellPin);
  for (const f of ZSH_FILES) writeFileSync(join(zd, f), zshWrapper(f, pinFile));
  // a copy: claude lets hooks append exports to this file, which must not reach pin.sh
  writeFileSync(join(sd, "claude-env.sh"), shellPin);
}

// ---- the watch ------------------------------------------------------------------------------------

/** The user's real state a live run must not change. */
export interface RealState {
  /** Sync dirs: the rig's own MU_SYNC_DIR and ~/mu (a shell rc's usual export). */
  syncDirs: string[];
  /** DB files (and their WAL): this build's, and the 4.x and 3.x defaults. */
  dbFiles: string[];
  /** murmur's and muzzle's real state dirs, listed like the sync dirs. */
  stateDirs: string[];
}

const absVal = (v: string | undefined): string | null => {
  const t = v?.trim() ?? "";
  return t !== "" && isAbsolute(t) ? resolve(t) : null;
};

const unique = (xs: (string | null)[]): string[] => [
  ...new Set(xs.filter((x): x is string => x !== null)),
];

/** The rig's launch env names the real state; ~/mu and the default DBs are watched anyway. */
export function realStatePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): RealState {
  const homeState = join(home, ".local", "state");
  const xdg = absVal(env.XDG_STATE_HOME) ?? homeState;
  const db =
    absVal(env.MU_DB_PATH) ?? join(absVal(env.MU_STATE_DIR) ?? join(xdg, "mu-next"), "mu.db");
  const dbs = unique([db, join(xdg, "mu-next", "mu.db"), join(xdg, "mu", "mu.db")]);
  return {
    syncDirs: unique([absVal(env.MU_SYNC_DIR), join(home, "mu")]),
    dbFiles: dbs.flatMap((d) => [d, `${d}-wal`]),
    // murmur 2: MURMUR_STATE_DIR, else its store under XDG_STATE_HOME and its inbox under HOME
    stateDirs: unique([
      absVal(env.MURMUR_STATE_DIR),
      join(xdg, "murmur2"),
      join(homeState, "murmur2"),
      join(xdg, "muzzle"),
    ]),
  };
}

/** path -> "<size> <mtime ms>" of every file under the sync and state dirs and every DB file that exists. */
export type RealStateSnapshot = Map<string, string>;

function fileStamp(p: string): string | null {
  try {
    const st = statSync(p);
    return st.isFile() ? `${st.size} ${st.mtimeMs}` : null;
  } catch {
    return null;
  }
}

/** Read-only: lists and stats, never opens a file. */
export function snapshotRealState(s: RealState): RealStateSnapshot {
  const out: RealStateSnapshot = new Map();
  for (const d of [...s.syncDirs, ...s.stateDirs]) {
    let names: string[];
    try {
      names = readdirSync(d, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(d, n);
      const st = fileStamp(p);
      if (st !== null) out.set(p, st);
    }
  }
  for (const f of s.dbFiles) {
    const st = fileStamp(f);
    if (st !== null) out.set(f, st);
  }
  return out;
}

export interface RealStateChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

export function realStateChanges(
  before: RealStateSnapshot,
  after: RealStateSnapshot,
): RealStateChanges {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [p, v] of after) {
    const b = before.get(p);
    if (b === undefined) added.push(p);
    else if (b !== v) changed.push(p);
  }
  const removed = [...before.keys()].filter((p) => !after.has(p));
  return { added, changed, removed };
}

/**
 * A leak's signature: a new segment (`<machine_id>.jsonl`, the only file mu writes there) at the top
 * of a real sync dir, i.e. a machine id that was not there before, such as a sandbox DB's.
 */
export function isLeakedSegment(paths: RealState, p: string): boolean {
  return paths.syncDirs.some((d) => dirname(p) === d && p.endsWith(".jsonl"));
}

/** What a watch found: leaked segments (destructive) and every other change (notes). */
export interface RealStateVerdict {
  destructive: string[];
  notes: string[];
  /** The stderr report; empty when nothing changed. */
  report: string;
}

/**
 * Judge a watch's changes. Only a new segment in a sync dir counts as contamination: the user's own
 * mu (its dashboard, its harness hooks) rewrites its own segment and DB all the time, a sync
 * transport updates peers' segments, and murmur and muzzle write their state for every session;
 * a leak through the user's own env looks the same, so those are notes, listed loudly, not
 * verdicts.
 */
export function judgeRealState(paths: RealState, c: RealStateChanges): RealStateVerdict {
  const leaked = c.added.filter((p) => isLeakedSegment(paths, p));
  const other: [string, string[]][] = [
    ["appeared", c.added.filter((p) => !isLeakedSegment(paths, p))],
    ["changed", c.changed],
    ["disappeared", c.removed],
  ];
  const why = "a mu outside the sandbox (or the user's own mu meanwhile)";
  const destructive = leaked.map(
    (p) => `contamination: ${p}: a new sync segment appeared during the live run (${why})`,
  );
  const notes = other.flatMap(([what, ps]) =>
    ps.map((p) => `real state: ${p} ${what} during the live run (the user's own tools, or a leak)`),
  );
  const list = (what: string, ps: string[]) =>
    ps.length === 0 ? "" : `eval:   ${what}:\n${ps.map((p) => `eval:     ${p}\n`).join("")}`;
  let report = "";
  if (leaked.length > 0)
    report +=
      `eval: CONTAMINATED: ${leaked.length} new segment${leaked.length === 1 ? "" : "s"} in the user's real sync dir during this live run; the run is marked destructive\n` +
      list("new segments", leaked);
  const n = notes.length;
  if (n > 0)
    report +=
      `eval: the user's real mu, murmur or muzzle state changed during this live run (${n} path${n === 1 ? "" : "s"}; noted, not counted: the user's own tools write these too)\n` +
      other.map(([what, ps]) => list(what, ps)).join("");
  if (report !== "")
    report +=
      "eval:   the rig deleted and changed nothing: check these files and remove the sandbox's by hand\n";
  return { destructive, notes, report };
}

export interface RealStateWatch {
  paths: RealState;
  check: () => RealStateChanges;
}

/** Snapshot now; `check()` compares with a second snapshot and returns the changes. */
export function watchRealState(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): RealStateWatch {
  const paths = realStatePaths(env, home);
  const before = snapshotRealState(paths);
  return { paths, check: () => realStateChanges(before, snapshotRealState(paths)) };
}

const armed = new Set<RealStateWatch>();
let exitHooked = false;

/** Check every armed watch and report on stderr: a run that ended without settling its watch. */
export function reportArmedWatches(): void {
  for (const w of armed) {
    const { report } = judgeRealState(w.paths, w.check());
    if (report !== "")
      process.stderr.write(
        `${report}eval:   (the run was interrupted or crashed: no result line holds this)\n`,
      );
  }
  armed.clear();
}

/**
 * Arm a watch so a run that never reaches `settleWatch` (SIGINT, SIGTERM, a crash: the sandbox's
 * handlers exit the process) still reports, from an `exit` listener (the check is synchronous).
 * Arm it after `createSandbox`, so the sandbox's own exit cleanup, which kills its tmux servers
 * and with them the harnesses, runs first.
 */
export function armWatch(w: RealStateWatch): void {
  armed.add(w);
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", reportArmedWatches);
}

/** Check a watch once, disarm it, report on stderr, and add its entries to `verdict` (when the run has one). */
export function settleWatch(
  w: RealStateWatch,
  verdict?: { destructive: string[]; notes: string[] },
): RealStateVerdict {
  armed.delete(w);
  const v = judgeRealState(w.paths, w.check());
  if (v.report !== "") process.stderr.write(v.report);
  verdict?.destructive.push(...v.destructive);
  verdict?.notes.push(...v.notes);
  return v;
}
