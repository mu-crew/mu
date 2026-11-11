// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The paths a bash command names, as its running cwd resolves them: the designer audit
// (tournament-design.ts) and the AUT guard (rig-guard.ts) share this walk.
import { basename, resolve, sep } from "node:path";

export const climbs = (t: string): boolean => /(?:^|\/)\.\.(?:\/|$)/.test(t);

/** Commands that read a tree from a start dir: for them a bare `/` is that dir. */
const SEARCHES = new Set(["find", "grep", "egrep", "rg", "fd", "ls", "tree", "du", "ag"]);

/** Words that run the next word as the command (`sudo find /`): skipped, with their flags, to find it. */
const WRAPPERS = new Set([
  "builtin",
  "command",
  "sudo",
  "doas",
  "env",
  "nice",
  "nohup",
  "time",
  "timeout",
  "exec",
  "stdbuf",
  "ionice",
  "xargs",
]);
/** Wrapper flags that take a value (`sudo -u root`, `nice -n 5`, `timeout -s KILL 5`). */
const VALUE_FLAGS = new Set(["-u", "-g", "-n", "-c", "-C", "-p", "-s", "-k", "-t"]);

/**
 * The word a segment runs (its tokens before the `=` split): past leading wrappers, their flags,
 * flag values, durations and `X=y` assignments (`sudo -u root find /`, `env A=1 timeout 5 rg x /`).
 */
function commandWord(toks: readonly string[]): string | undefined {
  let i = 0;
  const skippable = (t: string) => /^[A-Za-z_]\w*=/.test(t);
  while (skippable(toks[i] ?? "")) i++;
  while (i < toks.length && WRAPPERS.has(basename(toks[i] ?? ""))) {
    i++;
    for (;;) {
      const t = toks[i] ?? "";
      if (VALUE_FLAGS.has(t) && !SEARCHES.has(toks[i + 1] ?? "")) i += 2;
      else if (t.startsWith("-") || /^\d+[smhd]?$/.test(t) || skippable(t)) i++;
      else break;
    }
  }
  return toks[i];
}

/** A glob word's dir: the path up to its first segment with `*`, `?` or `[` (`/Users/*` → `/Users`). */
function globDir(w: string): string {
  const parts = w.split("/");
  const at = parts.findIndex((p) => /[*?[]/.test(p));
  if (at < 0) return w;
  const dir = parts.slice(0, at).join("/");
  return dir === "" ? (w.startsWith("/") ? "/" : ".") : dir;
}

/** `p` is a proper ancestor of `dir` (`/` is one of every other dir). */
export const ancestor = (p: string, dir: string): boolean =>
  p !== dir && (p === sep || dir.startsWith(p + sep));

/**
 * The paths one bash command names, best effort (bash cannot be fully parsed; tools/eval/README.md
 * lists the forms this misses). Per segment (split on `;`, `&&`, `||`, `|`, `&`, newlines), `cd` and
 * `pushd` move a running cwd; `$PWD`, `${PWD}`, `$(pwd)` and `` `pwd` `` stand for it. A token that
 * climbs is resolved against the running cwd, and after a `cd` so is every relative token that looks
 * like a path (has a `/` or starts with `.`). A bare `/` counts only as a search's (`find`, `grep`, `rg`, `fd`,
 * `ls`, …, also behind a wrapper: `sudo find /`) or `cd`'s argument (`tr / _` names no dir); a
 * glob names the dir above its first wild segment (`du -sh /Users/*` names `/Users`); a cwd above
 * HOME is reached only by a
 * `cd` that names it. `cd` to
 * where the audit cannot follow (`~`, `-`, `$X`) makes the cwd unknown; a variable assigned a
 * climbing value (`D=..`) makes a token using it unknown too. `unresolved` holds the tokens that
 * climb from an unknown place: the audit counts each as a climb out. `cwds` holds every dir a `cd`
 * moved to (a `cd` chain that ends in a guarded dir names no guarded path itself).
 */
export function commandPaths(
  cmd: string,
  start: string,
): { paths: { raw: string; path: string }[]; unresolved: string[]; cwds: string[] } {
  const paths: { raw: string; path: string }[] = [];
  const unresolved: string[] = [];
  const cwds: string[] = [];
  const climbVars = new Set<string>();
  let cwd: string | null = start;
  for (const seg of cmd.split(/&&|\|\||[;\n|&]/)) {
    const here: string | null = cwd;
    const text =
      here === null
        ? seg
        : seg.replace(/\$\(\s*pwd\s*\)|`\s*pwd\s*`|\$\{PWD\}|\$PWD(?![A-Za-z0-9_])/g, here);
    const toks = text.split(/[\s"'`\\)(<>,]+/).filter((t) => t !== "");
    const words: string[] = [];
    for (const t of toks) {
      const a = /^([A-Za-z_]\w*)=(.*)$/.exec(t);
      if (a) {
        if (climbs(a[2] ?? "")) climbVars.add(a[1] ?? "");
        else climbVars.delete(a[1] ?? "");
        if (a[2]) words.push(a[2]);
      } else words.push(...t.split("=").filter((w) => w !== ""));
    }
    const cmdWord = commandWord(toks);
    const head = Math.max(0, cmdWord === undefined ? 0 : words.indexOf(cmdWord));
    const isCd = words[head] === "cd" || words[head] === "pushd";
    const isSearch = SEARCHES.has(basename(words[head] ?? ""));
    const moved = here !== start;
    for (const w of words) {
      const vars = [...w.matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1] ?? "");
      if (vars.some((v) => climbVars.has(v))) {
        unresolved.push(w);
        continue;
      }
      if (/^[~$-]/.test(w)) continue;
      // the root as a plain argument (`tr / _`, a `//` comment in a heredoc) is no search
      if (/^\/+$/.test(w) && !isSearch && !isCd) continue;
      if (w.startsWith("/")) paths.push({ raw: w, path: resolve(globDir(w)) });
      else if (here === null) {
        if (climbs(w)) unresolved.push(w);
      } else if (climbs(w) || (moved && /^\.|\//.test(w)))
        paths.push({ raw: w, path: resolve(here, globDir(w)) });
    }
    if (!isCd) continue;
    const dest = words.slice(head + 1).find((w) => w === "-" || !/^-[LPe@]*$/.test(w));
    if (dest === undefined || /^[~$-]/.test(dest) || unresolved.includes(dest)) cwd = null;
    else if (dest.startsWith("/")) cwd = resolve(dest);
    else cwd = here === null ? null : resolve(here, dest);
    if (cwd !== null) cwds.push(cwd);
  }
  return { paths, unresolved, cwds };
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
