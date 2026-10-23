// Pure rules of `main.ts check`: script file names and what a golden / bad run must show.
import type { Verdict } from "./types.ts";

export type Family = "3x" | "next";

/** <id>.golden.<family>.json or <id>.bad.<family>.json */
export function scriptFile(id: string, kind: "golden" | "bad", family: Family): string {
  return `${id}.${kind}.${family}.json`;
}

/** A golden is clean: completed, no wrong entries, nothing destructive. */
export function goldenOk(v: Verdict): boolean {
  return v.completed && v.wrong.length === 0 && v.destructive.length === 0;
}

/** A bad script must be flagged: not completed, or a wrong or destructive entry. */
export function badFlagged(v: Verdict): boolean {
  return !v.completed || v.wrong.length > 0 || v.destructive.length > 0;
}
