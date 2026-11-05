// mu — anchor files: who a harness process is, for hooks that cannot see mu's env.
//
// A harness may start its hooks with a cleared environment (Muse Code keeps
// a fixed allowlist: no `TMUX*`, no `MU_*`), so a hook cannot read the agent's
// name, workstream or role from its env. It can read the process table and
// files. So mu starts the harness through a small `sh` wrapper that writes
// `~/.local/state/mu-next/anchors/<pid>.json` for its own pid and then `exec`s
// the harness, which keeps the pid. A hook walks its parents and takes the
// first ancestor whose anchor matches (murmur's `src/anchors.ts` is the
// reader; mu owns the format). Spec "Every harness first-class", D3.
//
// `start_time` is the wrapper's own `ps -o lstart=` in seconds since the
// epoch, the value murmur parses from its process table: a reused pid with an
// anchor left behind by a dead agent never matches a stranger. `exec` keeps
// the start time as well as the pid.
//
// The directory is D3's literal `~/.local/state/mu-next/anchors`, never
// `MU_STATE_DIR`'s or `XDG_STATE_HOME`'s alone: a hook may have neither (Muse
// Code's allowlist keeps `HOME` and drops both), so only a HOME-based path is
// found from every hook. murmur's reader honours `XDG_STATE_HOME` when its hook
// has it, so the wrapper also writes there when it is set elsewhere.

import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "./shell-quote.js";
import { xdgStateHome } from "./state-dir.js";

/** One anchor file, as murmur's reader parses it. */
export interface AnchorRecord {
  agent_name: string;
  workstream: string;
  /** `orchestrator` or `worker`. */
  role: "orchestrator" | "worker";
  /** The harness (`claude`, `codex`, …), else the cli key. */
  cli: string;
  orchestrator: boolean;
  /** `<origin host>/<origin pane key>` for a remote worker (D11); null locally. */
  remote_key: string | null;
}

/** Where anchors live: `~/.local/state/mu-next/anchors`, whatever the env (D3). */
export function anchorDir(): string {
  return join(homedir(), ".local", "state", "mu-next", "anchors");
}

/**
 * Every directory the wrapper writes and prunes: `anchorDir()`, plus the XDG
 * state home's when `XDG_STATE_HOME` points elsewhere, for a reader whose
 * hook env still has it.
 */
export function anchorDirs(): string[] {
  const xdg = join(xdgStateHome(homedir()), "mu-next", "anchors");
  return xdg === anchorDir() ? [anchorDir()] : [anchorDir(), xdg];
}

/**
 * The pane command that writes `anchor` (into each of `dirs`) for its own pid
 * and then runs `command`. The anchor is written by `/bin/sh` whatever the
 * user's default shell is; the command then runs as `$SHELL -c <command>`
 * (tmux sets `SHELL` to its default-shell in a pane, else `/bin/sh`), the
 * shell it ran in unwrapped, so bash or zsh syntax keeps working. A shell
 * execs a simple command in place, so the harness keeps the anchored pid (a
 * compound command runs under that shell, still the anchored ancestor). A
 * failed write never stops the launch.
 *
 * The start time is converted by GNU `date -d`, else BSD `date -j -f`, else
 * read from the clock (the wrapper is the process's first moment, inside
 * murmur's one-second slack on an idle host).
 */
export function anchorWrapper(
  command: string,
  anchor: AnchorRecord,
  dirs: readonly string[] = anchorDirs(),
): string {
  // The fields are mu's own values; the start time is spliced in by the shell.
  const head = JSON.stringify(anchor).replace(/}$/, ',"start_time":');
  const script = [
    'c="$1"',
    "s=$(LC_ALL=C ps -o lstart= -p $$ 2>/dev/null | awk '{$1=$1};1')",
    `t=$(LC_ALL=C date -d "$s" +%s 2>/dev/null || LC_ALL=C date -j -f '%a %b %e %T %Y' "$s" +%s 2>/dev/null)`,
    'case "$t" in ""|*[!0-9]*) t=$(date +%s) ;; esac',
    `for d in ${dirs.map(shellQuote).join(" ")}; do`,
    `  mkdir -p "$d" 2>/dev/null && printf '%s%s}\\n' ${shellQuote(head)} "$t" > "$d/$$.json.tmp" 2>/dev/null && mv -f "$d/$$.json.tmp" "$d/$$.json" 2>/dev/null`,
    "done",
    '[ -n "$SHELL" ] || SHELL=/bin/sh',
    'exec "$SHELL" -c "$c"',
  ].join("\n");
  return `exec /bin/sh -c ${shellQuote(script)} mu-anchor ${shellQuote(command)}`;
}

/** True when `pid` names a live process (EPERM: alive, not ours). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove the anchors of dead processes. Best effort, at spawn: one file per
 * spawned harness would otherwise pile up. A live pid's file is kept even if
 * the pid was reused, since its start time already makes it inert.
 */
export function pruneAnchors(dirs: readonly string[] = anchorDirs()): void {
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^(\d+)\.json(\.tmp)?$/.exec(name);
      if (m === null || pidAlive(Number(m[1]))) continue;
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // best effort
      }
    }
  }
}
