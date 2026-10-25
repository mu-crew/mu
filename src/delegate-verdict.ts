// mu — a delegate's answer as a verdict: the pure half of src/delegates.ts.
//
// Dependency-free on purpose: the pi extension (extension/delegate.ts) bundles
// standalone and must not pull in the DB, yet it words the same note.

/** The verdict labels a check may answer. Anything else is UNVERIFIED. */
export const VERDICT_LABELS = ["CONFIRMED", "REFUTED", "UNVERIFIED"] as const;
export type VerdictLabel = (typeof VERDICT_LABELS)[number];

/** `42s`, `3m 05s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}m ${String(t % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A `VERDICT:` line: at the start of the line, behind at most ONE role word
 *  (`REFUTER: VERDICT: …`, which is how checks write it by hand). Nothing else
 *  may precede it, so a verdict quoted mid-line in the evidence is not one. */
const VERDICT_LINE = /^(?:\w+: )?VERDICT:/;
const LABEL_RE = new RegExp(`\\b(${VERDICT_LABELS.join("|")})\\b`);

/** The index of the FIRST verdict line of `lines`, or -1. Later `VERDICT:`
 *  lines are evidence text, not a second verdict. */
function firstVerdictLine(lines: readonly string[]): number {
  return lines.findIndex((l) => VERDICT_LINE.test(l));
}

/** The label on the first `VERDICT:` line (the first known label after the
 *  colon), or undefined when there is no verdict line or no known label. */
export function parseVerdict(answer: string): VerdictLabel | undefined {
  const lines = answer.trimEnd().split("\n");
  const at = firstVerdictLine(lines);
  if (at < 0) return undefined;
  const after = (lines[at] ?? "").slice((lines[at] ?? "").indexOf("VERDICT:") + "VERDICT:".length);
  return LABEL_RE.exec(after)?.[1] as VerdictLabel | undefined;
}

/**
 * The note a delegate's answer leaves on the task it judged. A done answer
 * keeps everything from its first verdict line on, so a multi-line EVIDENCE
 * body (and any `VERDICT:` text quoted in it) survives whole (else the whole answer, marked NO VERDICT LINE); any
 * other outcome records the gap. Never cut: the note is the evidence.
 */
export function recordNote(
  label: string,
  name: string,
  outcome: string | undefined,
  lastText: string | undefined,
  elapsedMs: number,
): string {
  if (outcome !== "done" || !lastText?.trim())
    return `REFUTER ${label}: no verdict (${outcome === "done" ? "empty" : (outcome ?? "no result")})`;
  const lines = lastText.trimEnd().split("\n");
  const at = firstVerdictLine(lines);
  const body = at >= 0 ? lines.slice(at).join("\n") : `NO VERDICT LINE: ${lastText.trimEnd()}`;
  return `REFUTER ${label} (${name}, ${formatElapsed(elapsedMs)}):\n${body}`;
}
