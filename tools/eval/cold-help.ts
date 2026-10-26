// What a cold reader is given, and what the request may not say (e_cold_guess round 2).
// `helpBundle` is the SAME depth for every surface: `mu --help` plus `mu <ns> --help` for every
// command that has subcommands, so a subcommand is visible on both or on neither. `surfaceVocab` is
// every command, subcommand and flag name at any depth; `neutralityLeaks` fails an intent whose
// request uses one of them (a leaked verb supplies the answer; round 1's `collect` supplied the
// whole gap).
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Surface } from "./types.ts";

/** `mu <args> --help`, in a private env (no DB, no sync folder); "" when the command does not exist. */
export function runHelp(surface: Surface, args: string[]): string {
  try {
    return execFileSync("node", [surface.cli, ...args, "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmpdir(),
        MU_SYNC_DIR: "",
        MU_DB_PATH: join(tmpdir(), `cold-help-${process.pid}.db`),
        MU_STATE_DIR: join(tmpdir(), `cold-help-${process.pid}`),
      },
    });
  } catch {
    return "";
  }
}

/** The subcommand names a help text lists under `Commands:` (commander's `help` pseudo-command left out). */
export function subcommands(help: string): string[] {
  const i = help.indexOf("\nCommands:\n");
  if (i < 0) return [];
  return [...help.slice(i).matchAll(/^ {2}([a-z][\w-]*)/gm)]
    .map((m) => m[1] ?? "")
    .filter((c) => c !== "help");
}

/** Long option names (`--tail` -> `tail`) a help text lists. */
export function optionNames(help: string): string[] {
  return [...help.matchAll(/^\s+(?:-\w, )?--([\w-]+)/gm)].map((m) => m[1] ?? "");
}

interface HelpNode {
  path: string[];
  help: string;
}

function walk(surface: Surface, path: string[] = []): HelpNode[] {
  const help = runHelp(surface, path);
  return [
    { path, help },
    ...subcommands(help).flatMap((c) => (path.length < 3 ? walk(surface, [...path, c]) : [])),
  ];
}

/** `mu --help` followed by `mu <namespace> --help` for every command that has subcommands. */
export function helpBundle(surface: Surface): string {
  return walk(surface)
    .filter((n) => n.path.length === 0 || subcommands(n.help).length > 0)
    .map((n) => `$ mu ${[...n.path, "--help"].join(" ")}\n${n.help.trimEnd()}`)
    .join("\n\n");
}

/** Every command, subcommand and long-flag name of a surface, and the hyphen-separated parts of each. */
export function surfaceVocab(surface: Surface): Set<string> {
  const names = new Set<string>();
  for (const n of walk(surface)) {
    for (const w of [...subcommands(n.help), ...optionNames(n.help), ...n.path]) {
      names.add(w);
      for (const p of w.split("-")) if (p !== "") names.add(p);
    }
  }
  return names;
}

/**
 * Words a request may use although a surface has a flag or command of that name: bare prepositions
 * and determiners (`--for`, `--from`, `--by`, `--on`, `--if`, `--as`, `--no`, `--all`, `--only`).
 * Anything with a content meaning is not here; add a word only if it is grammar.
 */
export const GRAMMAR = new Set([
  "for",
  "from",
  "by",
  "on",
  "if",
  "as",
  "no",
  "all",
  "only",
  "of",
  "and",
]);

export interface Leak {
  intent: string;
  word: string;
  surfaces: string[];
}

const plural = (a: string, b: string): boolean =>
  a === b || (Math.min(a.length, b.length) >= 3 && (a === `${b}s` || b === `${a}s`));

/** The words of each request (its quoted payload left out) that are names on a surface, plural or not. */
export function neutralityLeaks(
  intents: { id: string; text: string; payload?: string }[],
  vocab: Record<string, Set<string>>,
): Leak[] {
  const leaks: Leak[] = [];
  for (const i of intents) {
    const text = (
      i.payload === undefined ? i.text : i.text.split(i.payload).join(" ")
    ).toLowerCase();
    for (const word of new Set(text.match(/[a-z]+/g) ?? [])) {
      if (GRAMMAR.has(word)) continue;
      const surfaces = Object.entries(vocab)
        .filter(([, v]) => v.has(word) || [...v].some((n) => plural(n, word)))
        .map(([s]) => s);
      if (surfaces.length > 0) leaks.push({ intent: i.id, word, surfaces });
    }
  }
  return leaks;
}
