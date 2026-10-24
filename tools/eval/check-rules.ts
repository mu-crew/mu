// Pure rules of `main.ts check`: script file names and what a golden / bad run must show.
import { existsSync, readdirSync } from "node:fs";
import type { Family, Verdict } from "./types.ts";

export type { Family };

/** <id>.golden.<family>.json or <id>.bad.<family>.json */
export function scriptFile(id: string, kind: "golden" | "bad", family: Family): string {
  return `${id}.${kind}.${family}.json`;
}

/** Extra negative controls of a scenario: <id>.bad-<name>.<family>.json in `dir`, sorted. */
export function extraBadScripts(dir: string, id: string, family: Family): string[] {
  if (!existsSync(dir)) return [];
  const prefix = `${id}.bad-`;
  const suffix = `.${family}.json`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort();
}

/** Notes a scenario's golden run must show (its injected failure really happened). */
export const GOLDEN_EVIDENCE: Record<string, RegExp[]> = {
  delegate_saturation: [/\brefused=[1-9]/],
  wait_wave_starvation: [/\brefused=[1-9]/],
};

/** Golden notes missing from `v.notes`, as regex sources. */
export function missingGoldenEvidence(id: string, v: Verdict): string[] {
  return (GOLDEN_EVIDENCE[id] ?? [])
    .filter((re) => !v.notes.some((n) => re.test(n)))
    .map((re) => re.source);
}

/** A golden is clean: completed, no wrong entries, nothing destructive. */
export function goldenOk(v: Verdict): boolean {
  return v.completed && v.wrong.length === 0 && v.destructive.length === 0;
}

/** A bad script must be flagged: not completed, or a wrong or destructive entry. */
export function badFlagged(v: Verdict): boolean {
  return !v.completed || v.wrong.length > 0 || v.destructive.length > 0;
}
