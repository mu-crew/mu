// mu — the words for the events of one `mu wait --json` result, shared by the Stop hook
// (src/hook-stop.ts) and pi's settle (extension/nudge.ts): which events a result consumed
// (a superseded one only what it marks delivered), one line per event, and the owed line.
// Pure: it reads the printed result, never the DB.

export type Rec = Record<string, unknown>;
export const recs = (v: unknown): Rec[] =>
  Array.isArray(v) ? v.filter((x): x is Rec => typeof x === "object" && x !== null) : [];
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `task w/t`, `agent w/a`, `delegate <call id>`: a typed ref (`task:w/t`) in words. */
export const refWords = (ref: string): string => ref.replace(/^(task|agent|delegate):/, "$1 ");

/** One event as a line: what happened to which ref, from its snapshot. */
export function eventLine(e: Rec, snaps: readonly Rec[]): string {
  const ref = str(e.ref) ?? "";
  const s = snaps.find((x) => x.ref === ref);
  const who = refWords(ref);
  switch (e.kind) {
    case "closed":
      return `- ${who} ${str(s?.status) ?? "CLOSED"}`;
    case "settled":
      return `- ${who} settled${typeof e.runs === "number" ? ` (run ${e.runs})` : ""}`;
    case "exited":
      return `- ${who} exited ${typeof s?.exit === "number" ? s.exit : "?"}`;
    case "delegate":
      return `- ${who} ${str(s?.status) ?? "done"}${str(s?.verdict) !== undefined ? ` (${str(s?.verdict)})` : ""}`;
    default:
      return `- ${who} ${String(e.kind)}`;
  }
}

/** Up to this many owed refs are named on the owed line, then `+N more`. */
const OWED_NAMED = 5;

/** `2 more ready, not yet delivered: task w/b CLOSED, ... (the next Stop delivers them; ...)`, or undefined. */
export function owedLine(data: Rec, next: string): string | undefined {
  const n = typeof data.owed === "number" ? data.owed : 0;
  if (n <= 0) return undefined;
  const owed = recs(data.snapshots).filter((s) => s.owed === true);
  const named = owed
    .slice(0, OWED_NAMED)
    .map(
      (s) =>
        `${refWords(str(s.ref) ?? "")}${str(s.status) !== undefined ? ` ${str(s.status)}` : ""}`,
    );
  const more = n - named.length;
  const list = [...named, ...(more > 0 ? [`+${more} more`] : [])].join(", ");
  return `${n} more ready, not yet delivered: ${list} (${next} delivers them; or run mu wait --ready)`;
}

/**
 * The events a result consumed: `events` (a ready batch), else `firing`; on a superseded result
 * only the firing event when `eventConsumed` is not false, and the members marked `delivered`.
 */
export function consumedEvents(data: Rec): Rec[] {
  const firing =
    typeof data.firing === "object" && data.firing !== null ? (data.firing as Rec) : undefined;
  const events = (
    data.events !== undefined ? recs(data.events) : firing !== undefined ? [firing] : []
  ).filter((e) => typeof e.ref === "string");
  if (data.superseded !== true) return events;
  const delivered = new Set(
    recs(data.snapshots)
      .filter((s) => s.delivered === true)
      .map((s) => s.ref),
  );
  const kept = events.filter((e) =>
    e.ref === firing?.ref && e.kind === firing?.kind
      ? data.eventConsumed !== false
      : delivered.has(e.ref),
  );
  // A member consumed beside an unconsumed firing (`--all`, no `events`): named from its snapshot.
  const named = new Set(kept.map((e) => e.ref));
  for (const ref of delivered) {
    if (typeof ref !== "string" || named.has(ref)) continue;
    const kind = ref.startsWith("task:")
      ? "closed"
      : ref.startsWith("agent:")
        ? "settled"
        : "delegate";
    kept.push({ kind, ref });
  }
  return kept;
}
