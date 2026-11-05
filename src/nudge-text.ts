// mu — the words of the keep-driving and close nudges, shared by pi's settle
// nudge (extension/nudge.ts) and the Stop hook of the other harnesses
// (src/hook-stop.ts), so every harness reads the same rule.

const MARK_START = "<!-- mu:keep-driving -->";
const MARK_END = "<!-- /mu:keep-driving -->";

/** The keep-driving paragraph from SKILL.md, one line per paragraph, or undefined without the markers. */
export function keepDrivingRule(skillMd: string): string | undefined {
  const i = skillMd.indexOf(MARK_START);
  const j = skillMd.indexOf(MARK_END);
  if (i < 0 || j < i) return undefined;
  // Unwrap the source's hard line breaks (paragraphs stay apart): the TUI wraps
  // the entry to the terminal, and kept breaks show as ragged mid-sentence cuts.
  const text = skillMd
    .slice(i + MARK_START.length, j)
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " "))
    .join("\n\n");
  return text === "" ? undefined : text;
}

/** The close-nudge text: name each task and the two ways out. */
export function closeNudgeText(workstream: string, names: string[]): string {
  const close = names
    .map((n) => `mu task close ${n} -w ${workstream} --evidence "<what you verified>"`)
    .join("\n  ");
  return [
    `[mu] You are stopping while you still own ${names.map((n) => `${workstream}/${n}`).join(", ")} (IN_PROGRESS).`,
    "If the work is done and verified, close it now:",
    `  ${close}`,
    "If you are blocked or need an answer, say so in one line and stop; the orchestrator will read your pane.",
  ].join("\n");
}
