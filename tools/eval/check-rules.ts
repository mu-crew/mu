// Pure rules of `main.ts check`: script file names and what a golden / bad run must show.
import { existsSync, readdirSync } from "node:fs";
import type { Family, Verdict } from "./types.ts";

export type { Family };

/** <id>.golden.<family>.json or <id>.bad.<family>.json */
export function scriptFile(id: string, kind: "golden" | "bad", family: Family): string {
  return `${id}.${kind}.${family}.json`;
}

/** Extra controls of a scenario: <id>.<kind>-<name>.<family>.json in `dir`, sorted. kind: bad (must be flagged) or golden (must be clean). */
export function extraScripts(
  dir: string,
  id: string,
  family: Family,
  kind: "golden" | "bad",
): string[] {
  if (!existsSync(dir)) return [];
  const prefix = `${id}.${kind}-`;
  const suffix = `.${family}.json`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort();
}

/** Extra negative controls of a scenario: <id>.bad-<name>.<family>.json in `dir`, sorted. */
export const extraBadScripts = (dir: string, id: string, family: Family): string[] =>
  extraScripts(dir, id, family, "bad");

/**
 * Scenarios whose `next` golden is written against the PLANNED surface (the unified `mu wait`, the
 * settle hook): their scripts are `<id>.<kind>[-name].next.pending.json`, and `check --family next`
 * skips them. The unit that ships the verb flips its scenarios in its own commit: `git mv` each
 * `.next.pending.json` to `.next.json`, delete the id here, and run its tier-1 gate (see
 * tools/eval/README.md, "Pending scenarios"). 3x is never affected.
 */
export const PENDING_NEXT: readonly string[] = [];

/** Pending script files of a scenario in `dir`: <id>.(golden|bad)[-name].next.pending.json, sorted. */
export function pendingScripts(dir: string, id: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${id}.`) && f.endsWith(".next.pending.json"))
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
